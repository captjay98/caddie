import type { ApprovalIntent, AppRoute, Scope } from '@caddie/contracts';
import { DEFAULT_APP_LIMITS } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { AppHostError, type AppHost, type AppHostBinding, type AppHostFile } from './app-host.ts';
import { checkApprovalForEffect } from './approvals.ts';
import { resolveAppSecrets } from './app-secrets.ts';
import { readOutputManifest, readPublishBundle, readWorkflow, type PublishBundle } from './build-workflow.ts';
import { createD1ContentStore } from './artifacts.ts';
import { splitSqlScript } from './preview-runtime.ts';
import { getProject } from './projects.ts';
import { ScopeError, assertProjectOwner, assertProjectScope } from './scope.ts';
import type { Keyring } from './secret-box.ts';

/**
 * Publish an app on Caddie's own Cloudflare account (Publish programme stage
 * 4). One click for the owner; everything below is Caddie's job.
 *
 *   publish   the project's CURRENT checked build, after the owner's plain
 *             confirm (the existing `deploy-production` approval, bound to the
 *             build's bundle-manifest hash and re-checked here):
 *               keys present -> live database (backend apps, created once) ->
 *               new migrations, in order (an edited migration is refused; one
 *               that deletes data needs its own approval) -> upload the user
 *               Worker (assets + server + DB + keys as secrets) -> route
 *               record -> health check
 *   unpublish the route says "paused"; code and data are kept, so publishing
 *             again is instant
 *   roll back an earlier PUBLISHED version's code, same approval rule; the
 *             data stays as it is (restoring a version never restores data)
 *
 * Every attempt is one app_publish_runs row with each step's outcome; at most
 * one runs per project at a time. Key values never reach a step, a log or a
 * response. Cloudflare is reached only through the AppHost port.
 */

export const PUBLISH_POLICY_VERSION = 'publish/2026-10-18';
const COMPATIBILITY_DATE = '2026-06-01';
const RUN_STALE_MS = 10 * 60_000;
const PROBE_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000];

export interface PublishDeps {
	host: AppHost;
	/** Caddie's apps domain, e.g. caddieapps.com (owner input). */
	appsDomain: string;
	/** Null when APP_SECRETS_KEYS is not set up. */
	keyring: Keyring | null;
	/** GET a live URL; the HTTP status, or 0 when nothing answered. */
	probe: (url: string) => Promise<number>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => string;
}

// --- addresses -------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED_SLUGS = new Set([
	'www', 'api', 'app', 'apps', 'admin', 'administrator', 'root', 'mail', 'email', 'smtp', 'ftp', 'ns1', 'ns2',
	'caddie', 'login', 'signin', 'signup', 'auth', 'account', 'accounts', 'billing', 'pay', 'payment', 'payments',
	'support', 'help', 'status', 'blog', 'docs', 'static', 'cdn', 'assets', 'media', 'dashboard', 'secure',
	'security', 'verify', 'report', 'abuse', 'legal', 'privacy', 'terms', 'test', 'staging', 'preview', 'dev',
]);
/** Names people trust; an app address may not contain them (phishing lookalikes). */
const PROTECTED_NAMES = [
	'caddie', 'cloudflare', 'nebius', 'paypal', 'google', 'gmail', 'youtube', 'apple', 'icloud', 'microsoft', 'outlook',
	'office365', 'facebook', 'instagram', 'whatsapp', 'telegram', 'amazon', 'netflix', 'binance', 'coinbase', 'metamask',
	'stripe', 'paystack', 'flutterwave', 'opay', 'palmpay', 'moniepoint', 'gtbank', 'zenithbank', 'firstbank', 'accessbank',
	'ubabank', 'mtn', 'airtel', 'github', 'dropbox', 'docusign', 'linkedin', 'twitter', 'tiktok', 'snapchat', 'visa',
	'mastercard', 'amex', 'dhl', 'fedex', 'usps', 'chase', 'wellsfargo', 'bankofamerica', 'hsbc', 'barclays', 'santander',
];

/** Check an address the owner chose. Throws a plain 400 when it can't be used. */
export function checkSlug(input: unknown): string {
	const slug = typeof input === 'string' ? input.trim().toLowerCase() : '';
	if (!SLUG_PATTERN.test(slug) || slug.includes('--')) {
		throw new ScopeError(400, 'invalid_slug', 'An address uses 3–32 lowercase letters, digits and single hyphens, like farm-log.');
	}
	if (RESERVED_SLUGS.has(slug)) throw new ScopeError(400, 'invalid_slug', 'That address is reserved. Pick another.');
	const squashed = slug.replace(/-/g, '');
	if (PROTECTED_NAMES.some((name) => squashed.includes(name))) {
		throw new ScopeError(400, 'invalid_slug', "Pick an address that doesn't use another company's name.");
	}
	return slug;
}

/** "Farm Log 2" -> "farm-log-2" (or a safe fallback). */
export function suggestSlug(name: string): string {
	const base = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32)
		.replace(/-+$/g, '');
	try {
		return checkSlug(base);
	} catch {
		return checkSlug(`my-app-${randomSuffix()}`);
	}
}

function randomSuffix(): string {
	return [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 5);
}

export function scriptNameFor(projectId: string): string {
	return `app-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 63).replace(/-+$/g, '');
}

export function hostnameFor(slug: string, appsDomain: string): string {
	return `${slug}.${appsDomain.toLowerCase().replace(/\.+$/, '')}`;
}

// --- approvals ---------------------------------------------------------------------

/**
 * The approval the owner's Publish click records: this project, this exact
 * version, this deployment. The deployment number (successful publishes and
 * roll backs so far, plus one) makes every deployment its own decision: an
 * approval that has been used cannot publish again, while a failed attempt can
 * be retried under the same click.
 */
export function publishIntent(projectId: string, manifestSha256: string, deployment: number): ApprovalIntent {
	return {
		projectId,
		action: 'deploy-production',
		resourceId: `app:${projectId}`,
		revisionHash: `${manifestSha256}#${deployment}`,
		policyVersion: PUBLISH_POLICY_VERSION,
	};
}

async function nextDeployment(db: D1Database, projectId: string): Promise<number> {
	const rows = await all(
		db,
		'select count(*) as "n" from "app_publish_runs" where "projectId" = ? and "kind" in (\'publish\',\'rollback\') and "status" = \'succeeded\'',
		projectId,
	);
	return Number(rows[0]?.['n'] ?? 0) + 1;
}

/** A migration that deletes data from the live app needs its own approval. */
export function destructiveMigrationIntent(projectId: string, migration: { name: string; sha256: string }): ApprovalIntent {
	return {
		projectId,
		action: 'destructive-database-change',
		resourceId: `app:${projectId}:${migration.name}`,
		revisionHash: migration.sha256,
		policyVersion: PUBLISH_POLICY_VERSION,
	};
}

const DESTRUCTIVE_SQL = [/\bdrop\s+table\b/i, /\balter\s+table\b[^;]*\bdrop\b/i, /\bdelete\s+from\b/i, /\btruncate\b/i];

export function isDestructiveSql(sql: string): boolean {
	const withoutComments = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
	return DESTRUCTIVE_SQL.some((pattern) => pattern.test(withoutComments));
}

// --- rows --------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface PublicationRow {
	projectId: string;
	slug: string;
	script: string;
	databaseId: string | null;
	status: 'live' | 'paused' | 'blocked';
	outputId: string | null;
	manifestSha256: string | null;
	hasServer: boolean;
	applied: Record<string, string>;
	publishedAt: string | null;
}

async function all(db: D1Database, sql: string, ...params: unknown[]): Promise<Row[]> {
	return (await db.prepare(sql).bind(...params).all<Row>()).results ?? [];
}

async function readPublication(db: D1Database, projectId: string): Promise<PublicationRow | null> {
	const row = (await all(db, 'select * from "app_publications" where "projectId" = ?', projectId))[0];
	if (!row) return null;
	let applied: Record<string, string> = {};
	try {
		applied = JSON.parse(String(row['appliedMigrations'] ?? '{}')) as Record<string, string>;
	} catch {
		applied = {};
	}
	return {
		projectId: String(row['projectId']),
		slug: String(row['slug']),
		script: String(row['script']),
		databaseId: (row['databaseId'] as string | null) ?? null,
		status: row['status'] as PublicationRow['status'],
		outputId: (row['outputId'] as string | null) ?? null,
		manifestSha256: (row['manifestSha256'] as string | null) ?? null,
		hasServer: Number(row['hasServer'] ?? 0) === 1,
		applied,
		publishedAt: (row['publishedAt'] as string | null) ?? null,
	};
}

// --- the operations log --------------------------------------------------------------

export interface PublishStep {
	step: string;
	outcome: 'ok' | 'failed' | 'skipped';
	detail?: string;
	at: string;
}

class Run {
	constructor(
		private readonly db: D1Database,
		readonly id: string,
		private readonly now: () => string,
	) {}

	async step(step: string, outcome: PublishStep['outcome'], detail?: string): Promise<void> {
		const entry: PublishStep = { step, outcome, ...(detail ? { detail } : {}), at: this.now() };
		await this.db.prepare('update "app_publish_runs" set "steps" = json_insert("steps", \'$[#]\', json(?)) where "id" = ?').bind(JSON.stringify(entry), this.id).run();
	}

	async finish(status: 'succeeded' | 'failed', error?: string): Promise<void> {
		await this.db
			.prepare('update "app_publish_runs" set "status" = ?, "error" = ?, "finishedAt" = ? where "id" = ? and "status" = \'running\'')
			.bind(status, error ?? null, this.now(), this.id)
			.run();
	}
}

async function startRun(
	db: D1Database,
	now: () => string,
	input: { projectId: string; kind: 'publish' | 'unpublish' | 'rollback'; actorId: string; outputId: string | null; manifestSha256: string | null; approvalId: string | null },
): Promise<Run> {
	const startedAt = now();
	const staleBefore = new Date(Date.parse(startedAt) - RUN_STALE_MS).toISOString();
	await db
		.prepare('update "app_publish_runs" set "status" = \'failed\', "error" = \'Interrupted before it finished.\', "finishedAt" = ? where "projectId" = ? and "status" = \'running\' and "startedAt" < ?')
		.bind(startedAt, input.projectId, staleBefore)
		.run();
	const id = `pub_${crypto.randomUUID()}`;
	try {
		await db
			.prepare(
				'insert into "app_publish_runs" ("id","projectId","kind","outputId","manifestSha256","status","steps","error","approvalId","actorId","startedAt","finishedAt") values (?,?,?,?,?,\'running\',\'[]\',null,?,?,?,null)',
			)
			.bind(id, input.projectId, input.kind, input.outputId, input.manifestSha256, input.approvalId, input.actorId, startedAt)
			.run();
	} catch (error) {
		if (/unique/i.test(String((error as Error)?.message ?? error))) {
			throw new ScopeError(409, 'PUBLISH_IN_PROGRESS', 'Caddie is already updating this app. Wait for it to finish.');
		}
		throw error;
	}
	return new Run(db, id, now);
}

// --- plain failures --------------------------------------------------------------------

function plainHostFailure(error: unknown): string {
	if (error instanceof AppHostError) {
		switch (error.code) {
			case 'NOT_CONFIGURED':
				return "Publishing isn't set up on this Caddie server yet.";
			case 'UNAUTHORIZED':
				return "Caddie couldn't sign in to its hosting account. This is on Caddie's side.";
			case 'RATE_LIMITED':
				return 'The hosting service is busy. Try again in a minute.';
			case 'TIMEOUT':
				return "The hosting service didn't answer in time. Try again.";
			default:
				return "The hosting service didn't accept the app. Try again; if it keeps failing, Caddie's team will look at it.";
		}
	}
	if (error instanceof ScopeError) return error.message;
	return 'Something went wrong while publishing. Try again.';
}

// --- the published files ------------------------------------------------------------------

function escapeText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** index.html + main.js + main.css: the page loads its own files only (the dispatch Worker's CSP forbids inline scripts). */
export function publishedAssets(title: string, bundle: Pick<PublishBundle, 'js' | 'css'>): AppHostFile[] {
	const html =
		'<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
		`<title>${escapeText(title.slice(0, 120))}</title>\n<link rel="stylesheet" href="/main.css">\n</head>\n<body>\n<div id="root"></div>\n` +
		'<script type="module" src="/main.js"></script>\n</body>\n</html>\n';
	const encode = (text: string) => new TextEncoder().encode(text);
	return [
		{ path: '/index.html', bytes: encode(html), contentType: 'text/html; charset=utf-8' },
		{ path: '/main.js', bytes: encode(bundle.js), contentType: 'text/javascript; charset=utf-8' },
		{ path: '/main.css', bytes: encode(bundle.css), contentType: 'text/css; charset=utf-8' },
	];
}

async function probeLive(deps: PublishDeps, hostname: string, hasServer: boolean): Promise<{ ok: boolean; detail: string }> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
	let page = 0;
	let api = 0;
	for (let attempt = 0; attempt <= PROBE_BACKOFF_MS.length; attempt++) {
		page = await deps.probe(`https://${hostname}/`);
		api = hasServer ? await deps.probe(`https://${hostname}/api/health`) : 200;
		if (page === 200 && api === 200) return { ok: true, detail: hasServer ? 'home page and /api/health answered' : 'home page answered' };
		if (attempt < PROBE_BACKOFF_MS.length) await sleep(PROBE_BACKOFF_MS[attempt]!);
	}
	return { ok: false, detail: hasServer ? `home page answered ${page || 'nothing'}, /api/health answered ${api || 'nothing'}` : `home page answered ${page || 'nothing'}` };
}

// --- the effects ------------------------------------------------------------------------------

async function currentReadyOutput(db: D1Database, scope: Scope): Promise<string | null> {
	const workflow = await readWorkflow(db, scope);
	return workflow?.phase === 'ready' && workflow.previewId ? workflow.previewId : null;
}

async function requestedKeyNames(db: D1Database, projectId: string): Promise<{ requested: string[]; set: string[] }> {
	const rows = await all(db, 'select "name","status" from "app_secrets" where "projectId" = ? order by "name"', projectId);
	return {
		requested: rows.filter((r) => r['status'] === 'requested').map((r) => String(r['name'])),
		set: rows.filter((r) => r['status'] === 'set').map((r) => String(r['name'])),
	};
}

async function keysForPublish(db: D1Database, deps: PublishDeps, projectId: string): Promise<Record<string, string>> {
	const names = await requestedKeyNames(db, projectId);
	if (names.requested.length > 0) {
		throw new ScopeError(409, 'KEYS_MISSING', `Add the keys this app needs first: ${names.requested.join(', ')}.`);
	}
	if (names.set.length === 0) return {};
	if (!deps.keyring) throw new ScopeError(503, 'KEYS_UNAVAILABLE', "This app's keys can't be read on this Caddie server, so it can't be published yet.");
	const resolved = await resolveAppSecrets(db, deps.keyring, projectId);
	if (resolved.unreadable.length > 0) throw new ScopeError(409, 'KEYS_UNREADABLE', `Paste these keys again: ${resolved.unreadable.join(', ')}.`);
	return resolved.values;
}

async function deployOutput(
	db: D1Database,
	deps: PublishDeps,
	scope: Scope,
	input: { kind: 'publish' | 'rollback'; outputId: string; slug?: unknown },
): Promise<void> {
	const now = deps.now ?? (() => new Date().toISOString());
	const bundle = await readPublishBundle(db, scope, input.outputId);
	const project = await getProject(db, scope);
	let publication = await readPublication(db, scope.projectId);
	if (publication?.status === 'blocked') {
		throw new ScopeError(403, 'APP_BLOCKED', "This app was taken down for breaking Caddie's rules, so it can't be published.");
	}

	// The address: chosen once, at the first publish.
	let slug: string;
	if (publication) {
		if (input.slug !== undefined && input.slug !== null && input.slug !== '' && checkSlug(input.slug) !== publication.slug) {
			throw new ScopeError(409, 'SLUG_LOCKED', "This app's address is already set.");
		}
		slug = publication.slug;
	} else {
		slug = input.slug !== undefined && input.slug !== null && input.slug !== '' ? checkSlug(input.slug) : suggestSlug(project.name);
		if ((await all(db, 'select 1 from "app_publications" where "slug" = ?', slug)).length > 0) {
			throw new ScopeError(409, 'SLUG_TAKEN', 'That address is taken. Try another.');
		}
	}

	const secrets = await keysForPublish(db, deps, scope.projectId);

	// Migrations: edited ones are refused; new ones that delete data need their own approval.
	const applied = { ...(publication?.applied ?? {}) };
	for (const migration of bundle.migrations) {
		const ran = applied[migration.name];
		if (ran !== undefined && ran !== migration.sha256) {
			throw new ScopeError(409, 'MIGRATION_CHANGED', `"${migration.name}" already ran on the live app and was changed afterwards. Add a new migration instead.`);
		}
	}
	const pending = input.kind === 'publish' && bundle.server !== null ? bundle.migrations.filter((m) => applied[m.name] === undefined) : [];

	// THE gate, immediately before any effect: the owner's confirm for this exact version and deployment.
	const intent = publishIntent(scope.projectId, bundle.manifestSha256, await nextDeployment(db, scope.projectId));
	const approval = await checkApprovalForEffect(db, { actorId: scope.actorId, ...intent });
	for (const migration of pending.filter((m) => isDestructiveSql(m.sql))) {
		try {
			await checkApprovalForEffect(db, { actorId: scope.actorId, ...destructiveMigrationIntent(scope.projectId, migration) });
		} catch (error) {
			if (error instanceof ScopeError) {
				throw new ScopeError(409, 'DESTRUCTIVE_MIGRATION_NEEDS_APPROVAL', `"${migration.name}" deletes data from the live app. Confirm that before publishing.`);
			}
			throw error;
		}
	}

	const run = await startRun(db, now, { projectId: scope.projectId, kind: input.kind, actorId: scope.actorId, outputId: input.outputId, manifestSha256: bundle.manifestSha256, approvalId: approval.id });
	let current = 'prepare';
	try {
		await run.step('approval', 'ok', `confirmed by the owner (${approval.id})`);
		if (!publication) {
			const at = now();
			await db
				.prepare(
					'insert into "app_publications" ("projectId","slug","script","databaseId","status","outputId","manifestSha256","hasServer","appliedMigrations","publishedBy","publishedAt","createdAt","updatedAt") values (?,?,?,null,\'paused\',null,null,?,\'{}\',null,null,?,?)',
				)
				.bind(scope.projectId, slug, scriptNameFor(scope.projectId), bundle.server !== null ? 1 : 0, at, at)
				.run();
			publication = (await readPublication(db, scope.projectId))!;
		}
		const hostname = hostnameFor(slug, deps.appsDomain);

		current = 'database';
		let databaseId = publication.databaseId;
		if (bundle.server !== null && !databaseId) {
			databaseId = (await deps.host.createDatabase(`caddie-${publication.script}`)).id;
			await db.prepare('update "app_publications" set "databaseId" = ?, "updatedAt" = ? where "projectId" = ?').bind(databaseId, now(), scope.projectId).run();
			await run.step('database', 'ok', 'created the app’s database');
		} else {
			await run.step('database', 'skipped', bundle.server === null ? 'this app has no server' : 'already exists');
		}

		current = 'migrations';
		for (const migration of pending) {
			const statements = splitSqlScript(migration.sql).map((sql) => ({ sql }));
			if (statements.length > 0) await deps.host.query(databaseId!, statements);
			applied[migration.name] = migration.sha256;
			await db
				.prepare('update "app_publications" set "appliedMigrations" = ?, "updatedAt" = ? where "projectId" = ?')
				.bind(JSON.stringify(applied), now(), scope.projectId)
				.run();
			await run.step('migration', 'ok', migration.name);
		}
		if (pending.length === 0) await run.step('migration', 'skipped', 'no new migrations');

		current = 'upload';
		const assets = publishedAssets(project.name, bundle);
		const bindings: AppHostBinding[] = [
			...(bundle.server !== null && databaseId ? [{ type: 'd1' as const, name: 'DB', databaseId }] : []),
			...Object.entries(secrets).map(([name, text]) => ({ type: 'secret_text' as const, name, text })),
		];
		await deps.host.deploy({
			script: publication.script,
			assets,
			serverModule: bundle.server,
			bindings,
			tags: [`project:${scope.projectId}`, `workspace:${scope.workspaceId}`],
			compatibilityDate: COMPATIBILITY_DATE,
			compatibilityFlags: ['nodejs_compat'],
		});
		const keyCount = Object.keys(secrets).length;
		await run.step('upload', 'ok', `${assets.length} files${bundle.server !== null ? ' and the server' : ''}${keyCount ? `, ${keyCount} key${keyCount === 1 ? '' : 's'}` : ''}`);

		current = 'route';
		const route: AppRoute = {
			v: 1,
			script: publication.script,
			projectId: scope.projectId,
			slug,
			status: 'live',
			limits: { ...DEFAULT_APP_LIMITS },
			hasServer: bundle.server !== null,
			updatedAt: now(),
		};
		await deps.host.putRoute(hostname, route);
		await run.step('route', 'ok', hostname);

		current = 'health';
		const health = await probeLive(deps, hostname, bundle.server !== null);
		await run.step('health', health.ok ? 'ok' : 'failed', health.detail);
		const at = now();
		await db
			.prepare('update "app_publications" set "status" = \'live\', "outputId" = ?, "manifestSha256" = ?, "hasServer" = ?, "publishedBy" = ?, "publishedAt" = ?, "updatedAt" = ? where "projectId" = ?')
			.bind(input.outputId, bundle.manifestSha256, bundle.server !== null ? 1 : 0, scope.actorId, at, at, scope.projectId)
			.run();
		if (health.ok) await run.finish('succeeded');
		else await run.finish('failed', `The app is published but didn't answer yet (${health.detail}). Open it in a minute, or roll back.`);
	} catch (error) {
		const message = plainHostFailure(error);
		if (!(error instanceof ScopeError)) console.error(`publish: ${current} failed:`, error instanceof AppHostError ? `${error.code} ${error.message}` : error);
		await run.step(current, 'failed', message).catch(() => undefined);
		await run.finish('failed', message).catch(() => undefined);
		throw new ScopeError(error instanceof AppHostError && error.code === 'NOT_CONFIGURED' ? 503 : 502, 'PUBLISH_FAILED', message);
	}
}

/** Publish the project's current checked build (first publish or update). */
export async function publishApp(db: D1Database, deps: PublishDeps, scope: Scope, input: { outputId: unknown; slug?: unknown }): Promise<void> {
	const verified = await assertProjectOwner(db, scope);
	if (typeof input.outputId !== 'string' || input.outputId.length === 0) throw new ScopeError(400, 'invalid_input', 'outputId is required');
	if ((await currentReadyOutput(db, verified)) !== input.outputId) {
		throw new ScopeError(409, 'NOT_CURRENT_BUILD', "Only the app's latest checked version can be published. Reload and try again.");
	}
	await deployOutput(db, deps, verified, { kind: 'publish', outputId: input.outputId, slug: input.slug });
}

/** Put an earlier published version back live (code only; data stays as it is). */
export async function rollbackApp(db: D1Database, deps: PublishDeps, scope: Scope, input: { outputId: unknown }): Promise<void> {
	const verified = await assertProjectOwner(db, scope);
	if (typeof input.outputId !== 'string' || input.outputId.length === 0) throw new ScopeError(400, 'invalid_input', 'outputId is required');
	const publication = await readPublication(db, verified.projectId);
	if (!publication?.publishedAt) throw new ScopeError(409, 'NOT_PUBLISHED', "This app hasn't been published yet.");
	const earlier = await all(
		db,
		'select 1 from "app_publish_runs" where "projectId" = ? and "outputId" = ? and "kind" in (\'publish\',\'rollback\') and "status" = \'succeeded\' limit 1',
		verified.projectId,
		input.outputId,
	);
	if (earlier.length === 0) throw new ScopeError(409, 'NOT_A_PUBLISHED_VERSION', 'Only a version that was published before can be put back.');
	await deployOutput(db, deps, verified, { kind: 'rollback', outputId: input.outputId });
}

/** Take the app offline. Code, data and keys are kept; publishing again brings it back. */
export async function unpublishApp(db: D1Database, deps: PublishDeps, scope: Scope): Promise<void> {
	const verified = await assertProjectOwner(db, scope);
	const now = deps.now ?? (() => new Date().toISOString());
	const publication = await readPublication(db, verified.projectId);
	if (!publication?.publishedAt || publication.status !== 'live') throw new ScopeError(409, 'NOT_LIVE', "This app isn't live.");
	const run = await startRun(db, now, { projectId: verified.projectId, kind: 'unpublish', actorId: verified.actorId, outputId: publication.outputId, manifestSha256: publication.manifestSha256, approvalId: null });
	try {
		const hostname = hostnameFor(publication.slug, deps.appsDomain);
		await deps.host.putRoute(hostname, {
			v: 1,
			script: publication.script,
			projectId: verified.projectId,
			slug: publication.slug,
			status: 'paused',
			limits: { ...DEFAULT_APP_LIMITS },
			hasServer: publication.hasServer,
			updatedAt: now(),
		});
		await run.step('route', 'ok', `${hostname} now says the app isn't published`);
		await db.prepare('update "app_publications" set "status" = \'paused\', "updatedAt" = ? where "projectId" = ?').bind(now(), verified.projectId).run();
		await run.finish('succeeded');
	} catch (error) {
		const message = plainHostFailure(error);
		await run.step('route', 'failed', message).catch(() => undefined);
		await run.finish('failed', message).catch(() => undefined);
		throw new ScopeError(502, 'PUBLISH_FAILED', message);
	}
}

// --- what the Publish card shows ------------------------------------------------------------------

export interface PublishRunView {
	id: string;
	kind: 'publish' | 'unpublish' | 'rollback';
	status: 'running' | 'succeeded' | 'failed';
	outputId: string | null;
	error: string | null;
	steps: PublishStep[];
	startedAt: string;
	finishedAt: string | null;
}

export interface PublishStatus {
	available: boolean;
	reason: string | null;
	publication: {
		slug: string;
		url: string;
		status: 'live' | 'paused' | 'blocked';
		outputId: string | null;
		publishedAt: string;
		hasServer: boolean;
	} | null;
	/** The latest checked build, and what publishing it needs. */
	current: {
		outputId: string;
		publishable: boolean;
		upToDate: boolean;
		intent: ApprovalIntent | null;
		destructive: { name: string; intent: ApprovalIntent }[];
	} | null;
	suggestedSlug: string | null;
	missingKeys: string[];
	runs: PublishRunView[];
	/** Earlier published versions that can be put back, newest first. */
	versions: { outputId: string; publishedAt: string; live: boolean; intent: ApprovalIntent | null }[];
}

export async function getPublishStatus(
	db: D1Database,
	config: { appsDomain: string | null; available: boolean; reason?: string | null },
	scope: Scope,
): Promise<PublishStatus> {
	const verified = await assertProjectScope(db, scope);
	const project = await getProject(db, verified);
	const publication = await readPublication(db, verified.projectId);
	const keys = await requestedKeyNames(db, verified.projectId);
	const deployment = await nextDeployment(db, verified.projectId);

	let current: PublishStatus['current'] = null;
	const ready = await currentReadyOutput(db, verified);
	if (ready) {
		const manifest = await readOutputManifest(db, verified, ready);
		if (manifest) {
			const applied = publication?.applied ?? {};
			const store = createD1ContentStore(db);
			const destructive: { name: string; intent: ApprovalIntent }[] = [];
			if (manifest.publishable && manifest.hasServer) {
				for (const migration of manifest.migrations.filter((m) => applied[m.name] === undefined)) {
					const bytes = await store.get(migration.sha256);
					if (bytes && isDestructiveSql(new TextDecoder().decode(bytes))) destructive.push({ name: migration.name, intent: destructiveMigrationIntent(verified.projectId, migration) });
				}
			}
			current = {
				outputId: ready,
				publishable: manifest.publishable,
				upToDate: publication?.status === 'live' && publication.manifestSha256 === manifest.manifestSha256,
				intent: manifest.publishable ? publishIntent(verified.projectId, manifest.manifestSha256, deployment) : null,
				destructive,
			};
		}
	}

	const runRows = await all(db, 'select * from "app_publish_runs" where "projectId" = ? order by "startedAt" desc limit 5', verified.projectId);
	const runs = runRows.map((row) => ({
		id: String(row['id']),
		kind: row['kind'] as PublishRunView['kind'],
		status: row['status'] as PublishRunView['status'],
		outputId: (row['outputId'] as string | null) ?? null,
		error: (row['error'] as string | null) ?? null,
		steps: JSON.parse(String(row['steps'] ?? '[]')) as PublishStep[],
		startedAt: String(row['startedAt']),
		finishedAt: (row['finishedAt'] as string | null) ?? null,
	}));

	const versionRows = await all(
		db,
		`select "outputId", "manifestSha256", max("startedAt") as "publishedAt" from "app_publish_runs"
		 where "projectId" = ? and "kind" in ('publish','rollback') and "status" = 'succeeded' and "outputId" is not null
		 group by "outputId" order by "publishedAt" desc limit 10`,
		verified.projectId,
	);
	const versions = versionRows.map((row) => ({
		outputId: String(row['outputId']),
		publishedAt: String(row['publishedAt']),
		live: publication?.status === 'live' && publication.outputId === row['outputId'],
		intent: row['manifestSha256'] ? publishIntent(verified.projectId, String(row['manifestSha256']), deployment) : null,
	}));

	return {
		available: config.available,
		reason: config.available ? null : (config.reason ?? "Publishing isn't set up on this Caddie server yet."),
		publication:
			publication && publication.publishedAt
				? {
						slug: publication.slug,
						url: config.appsDomain ? `https://${hostnameFor(publication.slug, config.appsDomain)}/` : '',
						status: publication.status,
						outputId: publication.outputId,
						publishedAt: publication.publishedAt,
						hasServer: publication.hasServer,
					}
				: null,
		current,
		suggestedSlug: publication ? publication.slug : suggestSlug(project.name),
		missingKeys: keys.requested,
		runs,
		versions,
	};
}
