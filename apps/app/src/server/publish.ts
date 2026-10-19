import type { ApprovalIntent, AppRoute, Scope } from '@caddie/contracts';
import { DEFAULT_APP_LIMITS } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { AppHostError, type AppHost, type AppHostBinding, type ScanResult } from './app-host.ts';
import { checkApprovalForEffect } from './approvals.ts';
import { resolveAppSecrets } from './app-secrets.ts';
import { appAuthSecret } from './app-sign-in.ts';
import { readOutputManifest, readPublishBundle, readWorkflow } from './build-workflow.ts';
import { createD1ContentStore } from './artifacts.ts';
import { splitSqlScript } from './preview-runtime.ts';
import { getProject } from './projects.ts';
import { publishedAssets } from './published-page.ts';
import { isJudgeAccount } from './judge-access.ts';
import { ScopeError, assertProjectOwner, assertProjectScope, projectScopeForUser } from './scope.ts';
import type { Keyring } from './secret-box.ts';
import { fileAbuseReport, type OperatorNotifier } from './abuse-reports.ts';

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

/**
 * The published Worker's main module. The app's own server is `app.js`; this
 * entry hands it `env.CADDIE` — the platform capability (AI) the dispatch
 * Worker passes per request in `ctx.props` (workers/dispatch) — so the app's
 * code reads env.CADDIE the same way in its tests, its preview and live.
 */
export const PUBLISHED_ENTRY_SOURCE = `import app from "./app.js";
export default {
  async fetch(request, env, ctx) {
    if (!app || typeof app.fetch !== "function") return new Response(JSON.stringify({ error: "app_has_no_server" }), { status: 500, headers: { "content-type": "application/json" } });
    const platform = ctx && ctx.props ? ctx.props.CADDIE : undefined;
    return app.fetch(request, platform ? Object.assign({}, env, { CADDIE: platform }) : env, ctx);
  },
};
`;
/** A run older than this with nothing waiting on it was interrupted. Longer than the scan timeout. */
const RUN_STALE_MS = 20 * 60_000;
const PROBE_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000];
/** Polls of the URL Scanner inside the publish request before handing over to the 5-minute sweep. */
const SCAN_WAIT_MS = [2000, 3000, 5000, 8000, 10000, 12000];
/** A scan still pending after this is treated as failed: the new version does not go live. */
export const SCAN_TIMEOUT_MS = 15 * 60_000;

export interface PublishDeps {
	host: AppHost;
	/** Caddie's apps domain, e.g. caddieapps.com (owner input). */
	appsDomain: string;
	/** Null when APP_SECRETS_KEYS is not set up. */
	keyring: Keyring | null;
	/** GET a live URL; the HTTP status, or 0 when nothing answered. */
	probe: (url: string) => Promise<number>;
	/** The operator's abuse inbox (flagged apps are reported there). */
	notifyOperator?: OperatorNotifier;
	/** Caddie's own secret (BETTER_AUTH_SECRET): each app's sign-in secret is derived from it. */
	authSecret?: string | null;
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

/**
 * Each deployment is its own user Worker, so a new version can be checked on
 * a private address while visitors keep getting the current one; the public
 * route switches scripts only after the check passes.
 */
export function scriptNameFor(projectId: string, deployment: number): string {
	const base = `app-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 54).replace(/-+$/g, '');
	return `${base}-${deployment}`;
}

/** The app's live D1 database name: one per project, created once. */
export function databaseNameFor(projectId: string): string {
	return `caddie-app-${projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60).replace(/-+$/g, '');
}

/** The private address a new version is checked at. `--` never appears in an app address. */
export function checkHostnameFor(appsDomain: string): string {
	const token = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
	return hostnameFor(`chk--${token}`, appsDomain);
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
	candidateScript: string | null;
	candidateOutputId: string | null;
	candidateManifestSha256: string | null;
	blockedReason: string | null;
	blockedBy: string | null;
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
	const text = (name: string) => (row[name] as string | null | undefined) ?? null;
	return {
		projectId: String(row['projectId']),
		slug: String(row['slug']),
		script: String(row['script']),
		databaseId: text('databaseId'),
		status: row['status'] as PublicationRow['status'],
		outputId: text('outputId'),
		manifestSha256: text('manifestSha256'),
		hasServer: Number(row['hasServer'] ?? 0) === 1,
		applied,
		publishedAt: text('publishedAt'),
		candidateScript: text('candidateScript'),
		candidateOutputId: text('candidateOutputId'),
		candidateManifestSha256: text('candidateManifestSha256'),
		blockedReason: text('blockedReason'),
		blockedBy: text('blockedBy'),
	};
}

// --- the operations log --------------------------------------------------------------

export interface PublishStep {
	step: string;
	outcome: 'ok' | 'failed' | 'skipped' | 'waiting';
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

	async isRunning(): Promise<boolean> {
		return (await all(this.db, 'select 1 from "app_publish_runs" where "id" = ? and "status" = \'running\'', this.id)).length > 0;
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

// --- the published files: published-page.ts (page, manifest, home-screen icons) -------------

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
	const deployment = await nextDeployment(db, scope.projectId);
	const intent = publishIntent(scope.projectId, bundle.manifestSha256, deployment);
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
		const candidateScript = scriptNameFor(scope.projectId, deployment);
		if (!publication) {
			const at = now();
			await db
				.prepare(
					'insert into "app_publications" ("projectId","slug","script","databaseId","status","outputId","manifestSha256","hasServer","appliedMigrations","publishedBy","publishedAt","createdAt","updatedAt") values (?,?,?,null,\'paused\',null,null,?,\'{}\',null,null,?,?)',
				)
				.bind(scope.projectId, slug, candidateScript, bundle.server !== null ? 1 : 0, at, at)
				.run();
			publication = (await readPublication(db, scope.projectId))!;
		}

		current = 'database';
		let databaseId = publication.databaseId;
		if (bundle.server !== null && !databaseId) {
			databaseId = (await deps.host.createDatabase(databaseNameFor(scope.projectId))).id;
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
		const assets = await publishedAssets({ name: project.name, seed: scope.projectId }, bundle);
		// The app's own sign-in secret (template caddie/auth.ts), derived per project; never stored.
		const authSecret = bundle.server !== null ? await appAuthSecret(deps.authSecret ?? undefined, scope.projectId, 'live') : null;
		const bindings: AppHostBinding[] = [
			...(bundle.server !== null && databaseId ? [{ type: 'd1' as const, name: 'DB', databaseId }] : []),
			...Object.entries(secrets).map(([name, text]) => ({ type: 'secret_text' as const, name, text })),
			...(authSecret ? [{ type: 'secret_text' as const, name: 'CADDIE_AUTH_SECRET', text: authSecret }] : []),
		];
		await deps.host.deploy({
			script: candidateScript,
			assets,
			serverModule: bundle.server !== null ? PUBLISHED_ENTRY_SOURCE : null,
			...(bundle.server !== null ? { modules: { 'app.js': bundle.server } } : {}),
			bindings,
			tags: [`project:${scope.projectId}`, `workspace:${scope.workspaceId}`],
			compatibilityDate: COMPATIBILITY_DATE,
			compatibilityFlags: ['nodejs_compat'],
		});
		const keyCount = Object.keys(secrets).length;
		await run.step('upload', 'ok', `${assets.length} files${bundle.server !== null ? ' and the server' : ''}${keyCount ? `, ${keyCount} key${keyCount === 1 ? '' : 's'}` : ''}`);
		await db
			.prepare('update "app_publications" set "candidateScript" = ?, "candidateOutputId" = ?, "candidateManifestSha256" = ?, "updatedAt" = ? where "projectId" = ?')
			.bind(candidateScript, input.outputId, bundle.manifestSha256, now(), scope.projectId)
			.run();

		current = 'safety-check';
		const candidate: Candidate = { script: candidateScript, outputId: input.outputId, manifestSha256: bundle.manifestSha256, hasServer: bundle.server !== null };
		if (await passedCheckBefore(db, scope.projectId, bundle.manifestSha256)) {
			await run.step('safety-check', 'skipped', 'this exact version passed the safety check before');
			current = 'route';
			await goLive(db, deps, { projectId: scope.projectId, actorId: scope.actorId, candidate, run, now });
			return;
		}
		const checkHost = checkHostnameFor(deps.appsDomain);
		await deps.host.putRoute(checkHost, routeRecord({ script: candidateScript, projectId: scope.projectId, slug, status: 'live', hasServer: candidate.hasServer, now }));
		const { scanId } = await deps.host.scanUrl(`https://${checkHost}/`);
		const checkId = `chk_${crypto.randomUUID()}`;
		await db
			.prepare(
				'insert into "app_safety_checks" ("id","projectId","kind","manifestSha256","script","url","scanId","runId","status","categories","createdAt") values (?,?,\'url-scan\',?,?,?,?,?,\'pending\',\'[]\',?)',
			)
			.bind(checkId, scope.projectId, bundle.manifestSha256, candidateScript, `https://${checkHost}/`, scanId, run.id, now())
			.run();
		await run.step('safety-check', 'waiting', 'checking the new version before visitors see it');
		// Wait a little inside this request; the 5-minute sweep finishes anything slower.
		const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
		for (const ms of SCAN_WAIT_MS) {
			await sleep(ms);
			if (await settleCheck(db, deps, checkId)) return;
		}
	} catch (error) {
		const message = plainHostFailure(error);
		if (!(error instanceof ScopeError)) console.error(`publish: ${current} failed:`, error instanceof AppHostError ? `${error.code} ${error.message}` : error);
		await run.step(current, 'failed', message).catch(() => undefined);
		await run.finish('failed', message).catch(() => undefined);
		throw new ScopeError(error instanceof AppHostError && error.code === 'NOT_CONFIGURED' ? 503 : 502, 'PUBLISH_FAILED', message);
	}
}

// --- the safety gate -----------------------------------------------------------------------

interface Candidate {
	script: string;
	outputId: string;
	manifestSha256: string;
	hasServer: boolean;
}

function routeRecord(input: { script: string; projectId: string; slug: string; status: AppRoute['status']; hasServer: boolean; now: () => string }): AppRoute {
	return {
		v: 1,
		script: input.script,
		projectId: input.projectId,
		slug: input.slug,
		status: input.status,
		limits: { ...DEFAULT_APP_LIMITS },
		hasServer: input.hasServer,
		updatedAt: input.now(),
	};
}

async function passedCheckBefore(db: D1Database, projectId: string, manifestSha256: string): Promise<boolean> {
	const rows = await all(
		db,
		'select 1 from "app_safety_checks" where "projectId" = ? and "kind" = \'url-scan\' and "manifestSha256" = ? and "status" = \'clean\' limit 1',
		projectId,
		manifestSha256,
	);
	return rows.length > 0;
}

/** Switch the public address to the checked version, retire the previous one, confirm it answers. */
async function goLive(
	db: D1Database,
	deps: PublishDeps,
	input: { projectId: string; actorId: string; candidate: Candidate; run: Run; now: () => string },
): Promise<void> {
	const publication = (await readPublication(db, input.projectId))!;
	const hostname = hostnameFor(publication.slug, deps.appsDomain);
	const previous = publication.publishedAt ? publication.script : null;
	await deps.host.putRoute(hostname, routeRecord({ script: input.candidate.script, projectId: input.projectId, slug: publication.slug, status: 'live', hasServer: input.candidate.hasServer, now: input.now }));
	await input.run.step('route', 'ok', hostname);
	const at = input.now();
	await db
		.prepare(
			`update "app_publications" set "status" = 'live', "script" = ?, "outputId" = ?, "manifestSha256" = ?, "hasServer" = ?, "publishedBy" = ?, "publishedAt" = ?,
			 "candidateScript" = null, "candidateOutputId" = null, "candidateManifestSha256" = null, "updatedAt" = ? where "projectId" = ?`,
		)
		.bind(input.candidate.script, input.candidate.outputId, input.candidate.manifestSha256, input.candidate.hasServer ? 1 : 0, input.actorId, at, at, input.projectId)
		.run();
	if (previous && previous !== input.candidate.script) {
		try {
			await deps.host.removeScript(previous);
			await input.run.step('cleanup', 'ok', 'removed the previous version');
		} catch (error) {
			console.error('publish: removing the previous script failed:', error instanceof AppHostError ? error.code : error);
			await input.run.step('cleanup', 'failed', 'the previous version could not be removed yet');
		}
	}
	const health = await probeLive(deps, hostname, input.candidate.hasServer);
	await input.run.step('health', health.ok ? 'ok' : 'failed', health.detail);
	if (health.ok) await input.run.finish('succeeded');
	else await input.run.finish('failed', `The app is published but didn't answer yet (${health.detail}). Open it in a minute, or roll back.`);
}

async function dropCandidate(db: D1Database, deps: PublishDeps, check: Row, now: () => string): Promise<void> {
	const url = String(check['url'] ?? '');
	try {
		await deps.host.deleteRoute(new URL(url).hostname);
	} catch (error) {
		console.error('publish: removing the check address failed:', error instanceof AppHostError ? error.code : error);
	}
	const publication = await readPublication(db, String(check['projectId']));
	const script = check['script'] ? String(check['script']) : null;
	// Before the first go-live the publication row carries the candidate's name as a placeholder; only a
	// script that is actually being served (published and current) is kept.
	const servedScript = publication?.publishedAt ? publication.script : null;
	if (script && script !== servedScript) {
		await deps.host.removeScript(script).catch((error: unknown) => console.error('publish: removing an unchecked version failed:', error instanceof AppHostError ? error.code : error));
	}
	await db
		.prepare('update "app_publications" set "candidateScript" = null, "candidateOutputId" = null, "candidateManifestSha256" = null, "updatedAt" = ? where "projectId" = ? and "candidateScript" = ?')
		.bind(now(), String(check['projectId']), script)
		.run();
}

function abuseCategoryFor(categories: string[]): 'phishing' | 'malware' | 'scam' | 'other' {
	const text = categories.join(' ').toLowerCase();
	if (text.includes('phish')) return 'phishing';
	if (text.includes('malware') || text.includes('virus') || text.includes('trojan')) return 'malware';
	if (text.includes('scam') || text.includes('fraud')) return 'scam';
	return 'other';
}

/**
 * Move one pending URL Scanner check forward. Returns true once the check is
 * settled (clean -> the version goes live; flagged -> the app is taken down
 * and reported; failed or timed out -> the new version is dropped and the
 * current one stays).
 */
async function settleCheck(db: D1Database, deps: PublishDeps, checkId: string): Promise<boolean> {
	const now = deps.now ?? (() => new Date().toISOString());
	const check = (await all(db, 'select * from "app_safety_checks" where "id" = ?', checkId))[0];
	if (!check || check['status'] !== 'pending') return true;
	const run = new Run(db, String(check['runId']), now);
	const finishCheck = (status: 'clean' | 'flagged' | 'error', extra: { categories?: string[]; reportUrl?: string | null; detail?: string } = {}) =>
		db
			.prepare('update "app_safety_checks" set "status" = ?, "categories" = ?, "reportUrl" = ?, "detail" = ?, "finishedAt" = ? where "id" = ? and "status" = \'pending\'')
			.bind(status, JSON.stringify(extra.categories ?? []), extra.reportUrl ?? null, extra.detail ?? null, now(), checkId)
			.run();
	const failCheck = async (detail: string, message: string) => {
		await finishCheck('error', { detail });
		await dropCandidate(db, deps, check, now);
		await run.step('safety-check', 'failed', detail);
		await run.finish('failed', message);
		return true;
	};

	if (!(await run.isRunning())) return failCheck('the publish attempt ended before the check finished', 'The safety check did not finish in time, so the new version is not on the web. Try publishing again.');
	const age = Date.parse(now()) - Date.parse(String(check['createdAt']));
	let result: ScanResult;
	try {
		result = await deps.host.scanResult(String(check['scanId']));
	} catch (error) {
		if (!(error instanceof AppHostError)) throw error;
		if (age < SCAN_TIMEOUT_MS) return false;
		return failCheck(`the scanner kept failing (${error.code})`, "The safety check couldn't finish, so the new version is not on the web. Try publishing again.");
	}
	if (result.state === 'pending') {
		if (age < SCAN_TIMEOUT_MS) return false;
		return failCheck('the scan did not finish within 15 minutes', 'The safety check did not finish in time, so the new version is not on the web. Try publishing again.');
	}

	const publication = await readPublication(db, String(check['projectId']));
	if (!result.malicious) {
		await finishCheck('clean', { categories: result.categories, reportUrl: result.reportUrl, detail: 'no problems found' });
		await run.step('safety-check', 'ok', 'no problems found');
		try {
			await deps.host.deleteRoute(new URL(String(check['url'])).hostname);
		} catch (error) {
			console.error('publish: removing the check address failed:', error instanceof AppHostError ? error.code : error);
		}
		if (!publication?.candidateScript || publication.candidateScript !== check['script']) {
			return failCheck('the version waiting to go live changed', 'Something changed while the safety check ran. Try publishing again.');
		}
		const runRow = (await all(db, 'select "actorId" from "app_publish_runs" where "id" = ?', String(check['runId'])))[0];
		try {
			await goLive(db, deps, {
				projectId: publication.projectId,
				actorId: String(runRow?.['actorId'] ?? ''),
				candidate: {
					script: publication.candidateScript,
					outputId: publication.candidateOutputId ?? '',
					manifestSha256: publication.candidateManifestSha256 ?? '',
					hasServer: (await candidateHasServer(db, publication.projectId, String(runRow?.['actorId'] ?? ''), publication.candidateOutputId)) ?? publication.hasServer,
				},
				run,
				now,
			});
		} catch (error) {
			const message = plainHostFailure(error);
			await run.step('route', 'failed', message).catch(() => undefined);
			await run.finish('failed', message).catch(() => undefined);
		}
		return true;
	}

	// Flagged: the new version never goes live, and the whole app comes down until a person reviews it.
	const categories = result.categories.length > 0 ? result.categories : ['malicious'];
	await finishCheck('flagged', { categories, reportUrl: result.reportUrl, detail: 'flagged by the URL Scanner' });
	await dropCandidate(db, deps, check, now);
	await run.step('safety-check', 'failed', `flagged: ${categories.join(', ')}`);
	await takeDownApp(db, deps, String(check['projectId']), { by: 'url-scan', reason: `Caddie's safety check flagged a new version (${categories.join(', ')}).` });
	if (publication) {
		await fileAbuseReport(
			db,
			{
				slug: publication.slug,
				source: 'url-scan',
				category: abuseCategoryFor(categories),
				details: `The URL Scanner flagged version ${String(check['manifestSha256']).slice(0, 12)} (${categories.join(', ')}).${result.reportUrl ? ` Scan: ${result.reportUrl}` : ''}`,
			},
			deps.notifyOperator,
		);
	}
	await run.finish('failed', "Caddie's safety check flagged this version, so the app isn't on the web. Caddie's team will review it.");
	return true;
}

async function candidateHasServer(db: D1Database, projectId: string, actorId: string, outputId: string | null): Promise<boolean | null> {
	if (!outputId || !actorId) return null;
	try {
		const scope = await projectScopeForUser(db, actorId, projectId);
		return (await readOutputManifest(db, scope, outputId))?.hasServer ?? null;
	} catch {
		return null;
	}
}

/** Move pending safety checks forward (the 5-minute cron, and the status read of one project). */
export async function advanceSafetyChecks(db: D1Database, deps: PublishDeps, options: { projectId?: string; limit?: number } = {}): Promise<number> {
	const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
	const rows = options.projectId
		? await all(db, 'select "id" from "app_safety_checks" where "status" = \'pending\' and "kind" = \'url-scan\' and "projectId" = ? order by "createdAt" limit ?', options.projectId, limit)
		: await all(db, 'select "id" from "app_safety_checks" where "status" = \'pending\' and "kind" = \'url-scan\' order by "createdAt" limit ?', limit);
	let settled = 0;
	for (const row of rows) {
		try {
			if (await settleCheck(db, deps, String(row['id']))) settled++;
		} catch (error) {
			console.error('publish: advancing a safety check failed:', error instanceof Error ? error.message : error);
		}
	}
	return settled;
}

// --- taking an app down (and back) --------------------------------------------------------------------

/**
 * The off switch: the app's address answers with Caddie's 451 "taken down"
 * page, and the owner cannot publish until a person reviews it. Used by the
 * safety checks and by the operator.
 */
export async function takeDownApp(db: D1Database, deps: PublishDeps, projectId: string, input: { by: string; reason: string }): Promise<boolean> {
	const now = deps.now ?? (() => new Date().toISOString());
	const publication = await readPublication(db, projectId);
	if (!publication) return false;
	if (publication.publishedAt) {
		await deps.host.putRoute(hostnameFor(publication.slug, deps.appsDomain), routeRecord({ script: publication.script, projectId, slug: publication.slug, status: 'blocked', hasServer: publication.hasServer, now }));
	}
	await db
		.prepare('update "app_publications" set "status" = \'blocked\', "blockedReason" = ?, "blockedBy" = ?, "blockedAt" = ?, "updatedAt" = ? where "projectId" = ?')
		.bind(input.reason.slice(0, 500), input.by, now(), now(), projectId)
		.run();
	return true;
}

/**
 * Lift a takedown after review. The app comes back unpublished (its owner
 * publishes again in one click); a version the scanner flagged is cleared, so
 * that publish does not trip on the same false positive.
 */
export async function restoreTakenDownApp(db: D1Database, deps: PublishDeps, projectId: string, input: { by: string }): Promise<boolean> {
	const now = deps.now ?? (() => new Date().toISOString());
	const publication = await readPublication(db, projectId);
	if (!publication || publication.status !== 'blocked') return false;
	if (publication.publishedAt) {
		await deps.host.putRoute(hostnameFor(publication.slug, deps.appsDomain), routeRecord({ script: publication.script, projectId, slug: publication.slug, status: 'paused', hasServer: publication.hasServer, now }));
	}
	await db
		.prepare('update "app_safety_checks" set "status" = \'clean\', "detail" = ? where "projectId" = ? and "kind" = \'url-scan\' and "status" = \'flagged\'')
		.bind(`cleared after review by ${input.by}`, projectId)
		.run();
	await db
		.prepare('update "app_publications" set "status" = \'paused\', "blockedReason" = null, "blockedBy" = null, "blockedAt" = null, "updatedAt" = ? where "projectId" = ?')
		.bind(now(), projectId)
		.run();
	return true;
}

// --- the daily recheck -------------------------------------------------------------------------------

const RECHECK_EVERY_MS = 24 * 60 * 60_000;
/** After a failed lookup, try that app again in about an hour rather than tomorrow. */
const RECHECK_RETRY_MS = 60 * 60_000;

function threatCategory(threats: string[]): 'phishing' | 'malware' | 'other' {
	if (threats.includes('SOCIAL_ENGINEERING')) return 'phishing';
	if (threats.includes('MALWARE') || threats.includes('UNWANTED_SOFTWARE')) return 'malware';
	return 'other';
}

/**
 * Once a day per live app (a bounded batch per 5-minute tick): ask Google Web
 * Risk whether the app's address is on a known-bad list. A listed app is
 * taken down and reported to the abuse inbox; a failed lookup is retried in
 * about an hour. Every lookup is a row in app_safety_checks.
 */
export async function recheckLiveApps(
	db: D1Database,
	deps: PublishDeps,
	webRisk: { lookup(url: string): Promise<{ threats: string[] }> },
	options: { limit?: number } = {},
): Promise<{ checked: number; flagged: number; failed: number }> {
	const now = deps.now ?? (() => new Date().toISOString());
	const at = now();
	const due = new Date(Date.parse(at) - RECHECK_EVERY_MS).toISOString();
	const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
	const rows = await all(
		db,
		'select "projectId" from "app_publications" where "status" = \'live\' and "publishedAt" is not null and ("checkedAt" is null or "checkedAt" < ?) order by coalesce("checkedAt", \'\') limit ?',
		due,
		limit,
	);
	const result = { checked: 0, flagged: 0, failed: 0 };
	for (const row of rows) {
		const publication = await readPublication(db, String(row['projectId']));
		if (!publication || publication.status !== 'live') continue;
		const url = `https://${hostnameFor(publication.slug, deps.appsDomain)}/`;
		const record = (status: 'clean' | 'flagged' | 'error', categories: string[], detail: string) =>
			db
				.prepare(
					'insert into "app_safety_checks" ("id","projectId","kind","manifestSha256","script","url","scanId","runId","status","categories","detail","createdAt","finishedAt") values (?,?,\'web-risk\',?,?,?,null,null,?,?,?,?,?)',
				)
				.bind(`chk_${crypto.randomUUID()}`, publication.projectId, publication.manifestSha256, publication.script, url, status, JSON.stringify(categories), detail, at, at)
				.run();
		let threats: string[];
		try {
			threats = (await webRisk.lookup(url)).threats;
		} catch (error) {
			result.failed++;
			await record('error', [], error instanceof Error ? error.message.slice(0, 200) : 'lookup failed');
			const retryAt = new Date(Date.parse(at) - RECHECK_EVERY_MS + RECHECK_RETRY_MS).toISOString();
			await db.prepare('update "app_publications" set "checkedAt" = ? where "projectId" = ?').bind(retryAt, publication.projectId).run();
			continue;
		}
		result.checked++;
		await db.prepare('update "app_publications" set "checkedAt" = ? where "projectId" = ?').bind(at, publication.projectId).run();
		if (threats.length === 0) {
			await record('clean', [], 'on no Web Risk list');
			continue;
		}
		result.flagged++;
		await record('flagged', threats, 'listed by Google Web Risk');
		await takeDownApp(db, deps, publication.projectId, { by: 'web-risk', reason: `Google Web Risk lists this address (${threats.join(', ')}).` });
		await fileAbuseReport(
			db,
			{ slug: publication.slug, source: 'web-risk', category: threatCategory(threats), details: `Google Web Risk lists ${url} (${threats.join(', ')}). The app was taken down automatically.` },
			deps.notifyOperator,
		);
	}
	return result;
}

async function requireVerifiedEmail(db: D1Database, actorId: string): Promise<void> {
	const rows = await all(db, 'select "emailVerified" from "user" where "id" = ?', actorId);
	if (Number(rows[0]?.['emailVerified'] ?? 0) !== 1) {
		throw new ScopeError(
			403,
			'EMAIL_NOT_VERIFIED',
			"Your sign-in account's email address isn't confirmed, so Caddie can't publish for you yet. Confirm it with Google or GitHub, then sign in again.",
		);
	}
}

/**
 * D2: publishing is off for judge accounts. Checked BEFORE the confirmed-email
 * rule, because a judge's synthetic `.invalid` address can never be confirmed
 * and that message would ask them to do something impossible. Judges see this
 * sentence on publish and on roll back alike; unpublish and the publish card
 * stay available so a judge can always SEE state — they just cannot publish.
 */
async function requireNotJudgeAccount(db: D1Database, actorId: string): Promise<void> {
	if (await isJudgeAccount(db, actorId)) {
		throw new ScopeError(403, 'JUDGE_ACCOUNT', 'Publishing is turned off for judge accounts. Everything else works the same.');
	}
}

/** Publish the project's current checked build (first publish or update). */
export async function publishApp(db: D1Database, deps: PublishDeps, scope: Scope, input: { outputId: unknown; slug?: unknown }): Promise<void> {
	const verified = await assertProjectOwner(db, scope);
	await requireNotJudgeAccount(db, verified.actorId);
	await requireVerifiedEmail(db, verified.actorId);
	if (typeof input.outputId !== 'string' || input.outputId.length === 0) throw new ScopeError(400, 'invalid_input', 'outputId is required');
	if ((await currentReadyOutput(db, verified)) !== input.outputId) {
		throw new ScopeError(409, 'NOT_CURRENT_BUILD', "Only the app's latest checked version can be published. Reload and try again.");
	}
	await deployOutput(db, deps, verified, { kind: 'publish', outputId: input.outputId, slug: input.slug });
}

/** Put an earlier published version back live (code only; data stays as it is). */
export async function rollbackApp(db: D1Database, deps: PublishDeps, scope: Scope, input: { outputId: unknown }): Promise<void> {
	const verified = await assertProjectOwner(db, scope);
	await requireNotJudgeAccount(db, verified.actorId);
	await requireVerifiedEmail(db, verified.actorId);
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
	/** Caddie's apps domain, so the card can show the full address before the first publish. */
	appsDomain: string | null;
	/** A new version being checked before visitors see it. */
	pendingCheck: { startedAt: string } | null;
	publication: {
		slug: string;
		url: string;
		status: 'live' | 'paused' | 'blocked';
		outputId: string | null;
		publishedAt: string;
		hasServer: boolean;
		blockedReason: string | null;
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

	const pending = (await all(db, 'select "createdAt" from "app_safety_checks" where "projectId" = ? and "kind" = \'url-scan\' and "status" = \'pending\' order by "createdAt" desc limit 1', verified.projectId))[0];

	return {
		available: config.available,
		reason: config.available ? null : (config.reason ?? "Publishing isn't set up on this Caddie server yet."),
		appsDomain: config.appsDomain,
		pendingCheck: pending ? { startedAt: String(pending['createdAt']) } : null,
		publication:
			publication && (publication.publishedAt || publication.status === 'blocked')
				? {
						slug: publication.slug,
						url: config.appsDomain ? `https://${hostnameFor(publication.slug, config.appsDomain)}/` : '',
						status: publication.status,
						outputId: publication.outputId,
						publishedAt: publication.publishedAt ?? '',
						hasServer: publication.hasServer,
						blockedReason: publication.status === 'blocked' ? publication.blockedReason : null,
					}
				: null,
		current,
		suggestedSlug: publication ? publication.slug : suggestSlug(project.name),
		missingKeys: keys.requested,
		runs,
		versions,
	};
}
