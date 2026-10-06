import type { Scope } from '@caddie/contracts';
import type { AuthEnv, D1Database } from './auth.ts';
import { ScopeError, assertWorkspaceScope, sessionUserId, workspaceScopeForUser } from './scope.ts';
import {
	GithubError,
	GithubRestClient,
	privateKeyFingerprint,
	readGithubConfig,
	type GithubEnv,
} from './adapters/github.ts';
import type { WorkspaceScope } from './scope.ts';

/**
 * P08 repository services: GitHub App installation binding, webhook-driven
 * state, selected-repository bookkeeping and (slice 2) import/export through
 * the P03 operations ledger.
 *
 * Authorization model (same shape as projects.ts): every service takes its
 * scope as a MANDATORY parameter and re-verifies it against D1 at entry. The
 * installation binding is an EXPLICIT user action (session + membership); the
 * webhook path is the only unauthenticated writer and is guarded by the
 * signature check + delivery-GUID dedupe BEFORE it touches any table.
 *
 * Fail-closed rules (feature-ledger C17 acceptance):
 *   - a revoked installation denies every future operation;
 *   - only repositories SELECTED for the installation may be imported or
 *     delivered to;
 *   - the binding is one-to-one: an installation already bound to a workspace
 *     cannot be re-bound elsewhere (imported-existing-app behavior is a typed
 *     conflict, never a silent takeover).
 */

export const GITHUB_PROVIDER = 'github';
/** Policy version stamped into merge-default-branch approval intents. */
export const GITHUB_POLICY_VERSION = 'policies/2026-10-05';

// --- shared helpers -------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

function requireNonEmpty(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new ScopeError(400, 'invalid_request', `${field} is required`);
	}
	return value.trim();
}

/** `owner/repo` shape guard: no traversal, no whitespace, exactly one slash. */
export function normalizeRepoFullName(input: unknown): string {
	const raw = requireNonEmpty(input, 'repoFullName');
	if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(raw)) {
		throw new ScopeError(400, 'invalid_request', 'repoFullName must look like owner/repo');
	}
	return raw;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(asRecord(value))) {
		if (typeof entry === 'string') out[key] = entry;
	}
	return out;
}

// --- views ------------------------------------------------------------------------

export type InstallationStatus = 'active' | 'revoked' | 'suspended';

export interface InstallationView {
	installationId: string;
	accountLogin: string;
	status: InstallationStatus;
	appSlug: string;
	permissions: Record<string, string>;
	workspaceId: string | null;
	boundBy: string | null;
	createdAt: string;
}

export interface RepoSelectionView {
	repoFullName: string;
	status: 'selected' | 'deselected';
	updatedAt: string;
}

function installationFromRow(row: Record<string, unknown>): InstallationView {
	return {
		installationId: String(row['installationId']),
		accountLogin: String(row['accountLogin'] ?? ''),
		status: (row['status'] as InstallationStatus) ?? 'active',
		appSlug: String(row['appSlug'] ?? ''),
		permissions: stringRecord(safeJsonParse(String(row['permissionsJson'] ?? '{}'))),
		workspaceId: row['workspaceId'] === null || row['workspaceId'] === undefined ? null : String(row['workspaceId']),
		boundBy: row['boundBy'] === null || row['boundBy'] === undefined ? null : String(row['boundBy']),
		createdAt: String(row['createdAt'] ?? ''),
	};
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

function selectionFromRow(row: Record<string, unknown>): RepoSelectionView {
	return {
		repoFullName: String(row['repoFullName']),
		status: row['status'] === 'deselected' ? 'deselected' : 'selected',
		updatedAt: String(row['updatedAt'] ?? ''),
	};
}

/** Resolve the production adapter config + client from env (fail-closed). */
export function githubClientFromEnv(env: GithubEnv): GithubRestClient {
	return new GithubRestClient(readGithubConfig(env));
}

// --- webhook processing (the only unauthenticated writer) ---------------------------

export type WebhookResult = 'processed' | 'duplicate' | 'ignored';

const WEBHOOK_EVENTS = new Set(['installation', 'installation_repositories']);

/**
 * Apply one webhook delivery. Ordering is load-bearing: the delivery GUID is
 * inserted FIRST, so a replay is acknowledged as a duplicate and never
 * re-processed (durable replacement for the HackSteward in-process cache —
 * feature-ledger H6). The caller must have verified the signature already.
 */
export async function processGithubWebhook(
	db: D1Database,
	input: { event: string; deliveryId: string; payload: unknown },
): Promise<WebhookResult> {
	const event = requireNonEmpty(input.event, 'x-github-event');
	const deliveryId = requireNonEmpty(input.deliveryId, 'x-github-delivery');
	if (!WEBHOOK_EVENTS.has(event)) return 'ignored';
	try {
		await db
			.prepare('insert into "github_webhook_deliveries" ("deliveryId","event","receivedAt") values (?,?,?)')
			.bind(deliveryId, event, nowIso())
			.run();
	} catch (error) {
		if (String(error).includes('UNIQUE constraint failed')) {
			return 'duplicate'; // replay: acknowledge, never re-process
		}
		throw error;
	}

	const payload = asRecord(input.payload);
	const action = typeof payload['action'] === 'string' ? payload['action'] : '';

	if (event === 'installation') {
		return processInstallationEvent(db, action, payload);
	}
	return processInstallationRepositoriesEvent(db, action, payload);
}

async function processInstallationEvent(
	db: D1Database,
	action: string,
	payload: Record<string, unknown>,
): Promise<WebhookResult> {
	const installation = asRecord(payload['installation']);
	const installationId = installation['id'] === undefined ? '' : String(installation['id']);
	if (!installationId) return 'ignored';

	if (action === 'created') {
		const status = installation['suspended_at'] ? 'suspended' : 'active';
		const now = nowIso();
		// NOTE: select-then-write instead of `on conflict(...) do update` — the
		// local D1 emulator silently no-ops upserts with bound parameters, and
		// the delivery-GUID dedupe above already serializes replays, so the
		// read-modify-write window is guarded. A concurrent racing insert loses
		// with UNIQUE and is converted to the update path below.
		const accountLogin = String(asRecord(installation['account'])['login'] ?? '');
		const appSlug = String(installation['app_slug'] ?? '');
		const permissionsJson = JSON.stringify(stringRecord(installation['permissions']));
		try {
			await db
				.prepare(
					`insert into "github_installations"
					   ("id","installationId","accountLogin","appSlug","permissionsJson","workspaceId","boundBy","status","createdAt","updatedAt")
					 values (?,?,?,?,?,null,null,?,?,?)`,
				)
				.bind(newId('ghinst'), installationId, accountLogin, appSlug, permissionsJson, status, now, now)
				.run();
		} catch (error) {
			if (!String(error).includes('UNIQUE constraint failed')) throw error;
			await db
				.prepare(
					'update "github_installations" set "accountLogin" = ?, "appSlug" = ?, "permissionsJson" = ?, "status" = ?, "updatedAt" = ? where "installationId" = ?',
				)
				.bind(accountLogin, appSlug, permissionsJson, status, now, installationId)
				.run();
		}
		return 'processed';
	}
	if (action === 'renamed') {
		const res = await db
			.prepare(
				'update "github_installations" set "accountLogin" = ?, "updatedAt" = ? where "installationId" = ?',
			)
			.bind(String(asRecord(installation['account'])['login'] ?? ''), nowIso(), installationId)
			.run();
		return (res as { meta?: { changes?: number } }).meta?.changes ? 'processed' : 'ignored';
	}
	if (action === 'deleted') {
		const res = await db
			.prepare(
				'update "github_installations" set "status" = \'revoked\', "updatedAt" = ? where "installationId" = ?',
			)
			.bind(nowIso(), installationId)
			.run();
		return (res as { meta?: { changes?: number } }).meta?.changes ? 'processed' : 'ignored';
	}
	return 'ignored';
}

async function processInstallationRepositoriesEvent(
	db: D1Database,
	action: string,
	payload: Record<string, unknown>,
): Promise<WebhookResult> {
	if (action !== 'added' && action !== 'removed') return 'ignored';
	const installation = asRecord(payload['installation']);
	const installationId = installation['id'] === undefined ? '' : String(installation['id']);
	const ownerRows = await queryAll(
		db,
		'select "id" from "github_installations" where "installationId" = ?',
		installationId,
	);
	if (!ownerRows[0]) return 'ignored'; // unknown installation: nothing to select for

	const added = action === 'added';
	const list = Array.isArray(added ? payload['repositories_added'] : payload['repositories_removed'])
		? ((added ? payload['repositories_added'] : payload['repositories_removed']) as unknown[])
		: [];
	const now = nowIso();
	for (const raw of list) {
		const repo = asRecord(raw);
		const fullName =
			typeof repo['full_name'] === 'string' && repo['full_name'].includes('/')
				? String(repo['full_name'])
				: typeof repo['name'] === 'string'
					? `${String(asRecord(installation['account'])['login'] ?? '')}/${String(repo['name'])}`
					: '';
		if (!fullName || !fullName.includes('/')) continue;
		const status = added ? 'selected' : 'deselected';
		// select-then-write (see the installation.created note: local D1 upserts
		// with bound params no-op silently; replays are serialized by the dedupe).
		const existing = await queryAll(
			db,
			'select "id" from "github_repo_selections" where "installationId" = ? and "repoFullName" = ?',
			installationId,
			fullName,
		);
		if (existing[0]) {
			await db
				.prepare('update "github_repo_selections" set "status" = ?, "updatedAt" = ? where "id" = ?')
				.bind(status, now, String(existing[0]['id']))
				.run();
		} else {
			try {
				await db
					.prepare(
						`insert into "github_repo_selections" ("id","installationId","repoFullName","status","createdAt","updatedAt")
						 values (?,?,?,?,?,?)`,
					)
					.bind(newId('ghsel'), installationId, fullName, status, now, now)
					.run();
			} catch (error) {
				if (!String(error).includes('UNIQUE constraint failed')) throw error;
				await db
					.prepare('update "github_repo_selections" set "status" = ?, "updatedAt" = ? where "installationId" = ? and "repoFullName" = ?')
					.bind(status, now, installationId, fullName)
					.run();
			}
		}
	}
	return 'processed';
}

// --- installation reads + guards -------------------------------------------------------

/** List installations bound to the scoped workspace (membership re-verified). */
export async function listInstallations(
	db: D1Database,
	scope: WorkspaceScope,
): Promise<InstallationView[]> {
	const verified = await assertWorkspaceScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "github_installations" where "workspaceId" = ? order by "createdAt" desc',
		verified.workspaceId,
	);
	return rows.map(installationFromRow);
}

/** Installation by id, visible only to members of the workspace it is bound to. */
export async function getInstallationForActor(
	db: D1Database,
	env: AuthEnv,
	headers: Headers,
	installationId: string,
): Promise<InstallationView> {
	const id = requireNonEmpty(installationId, 'installationId');
	const userId = await sessionUserId(env, headers);
	if (!userId) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
	const rows = await queryAll(db, 'select * from "github_installations" where "installationId" = ?', id);
	const row = rows[0];
	if (!row || row['workspaceId'] === null || row['workspaceId'] === undefined) {
		throw new ScopeError(404, 'installation_not_found', 'no such bound installation');
	}
	// Membership authority over the OWNING workspace — never caller-supplied.
	await workspaceScopeForUser(db, userId, String(row['workspaceId']));
	return installationFromRow(row);
}

/** List the selected repositories of an installation the actor may see. */
export async function listSelectedRepos(
	db: D1Database,
	env: AuthEnv,
	headers: Headers,
	installationId: string,
): Promise<RepoSelectionView[]> {
	const installation = await getInstallationForActor(db, env, headers, installationId);
	const rows = await queryAll(
		db,
		'select * from "github_repo_selections" where "installationId" = ? order by "repoFullName" asc',
		installation.installationId,
	);
	return rows.map(selectionFromRow);
}

/**
 * THE installation guard for every consequential operation (import/export):
 * the installation must exist, be bound to the SCOPED workspace, and be
 * active. Revocation denies everything (typed 403), fail-closed.
 */
export async function requireActiveInstallation(
	db: D1Database,
	scope: Scope,
	installationId: string,
): Promise<InstallationView> {
	const id = requireNonEmpty(installationId, 'installationId');
	const rows = await queryAll(db, 'select * from "github_installations" where "installationId" = ?', id);
	const row = rows[0];
	if (!row || row['workspaceId'] === null || row['workspaceId'] === undefined) {
		throw new ScopeError(404, 'installation_not_found', 'no such bound installation');
	}
	if (String(row['workspaceId']) !== scope.workspaceId) {
		throw new ScopeError(403, 'installation_out_of_scope', 'the installation is bound to another workspace');
	}
	const view = installationFromRow(row);
	if (view.status === 'revoked') {
		throw new ScopeError(403, 'installation_revoked', 'the installation was removed — all operations are denied');
	}
	if (view.status === 'suspended') {
		throw new ScopeError(403, 'installation_suspended', 'the installation is suspended at the provider');
	}
	return view;
}

/** Only SELECTED repositories of the installation may be imported/delivered. */
export async function requireSelectedRepo(
	db: D1Database,
	installationId: string,
	repoFullName: string,
): Promise<RepoSelectionView> {
	const full = normalizeRepoFullName(repoFullName);
	const rows = await queryAll(
		db,
		'select * from "github_repo_selections" where "installationId" = ? and "repoFullName" = ?',
		installationId,
		full,
	);
	const row = rows[0];
	if (!row || row['status'] !== 'selected') {
		throw new ScopeError(403, 'repo_not_selected', `${full} is not selected for this installation`);
	}
	return selectionFromRow(row);
}

// --- binding (explicit user action) ------------------------------------------------------

/**
 * Bind an installation to the scoped workspace. The binding is EXPLICIT: the
 * session actor must hold workspace membership, and the installation's
 * metadata is resolved live from the GitHub App API (never from the request
 * body). One installation binds to exactly one workspace: a second binding
 * attempt is a typed 409 (imported-existing-app behavior).
 */
export async function bindInstallation(
	db: D1Database,
	client: GithubRestClient,
	scope: WorkspaceScope,
	installationId: string,
): Promise<InstallationView & { fingerprint: string }> {
	const verified = await assertWorkspaceScope(db, scope);
	const id = requireNonEmpty(installationId, 'installationId');

	let info;
	try {
		info = await client.getInstallation(id);
	} catch (error) {
		if (error instanceof GithubError && error.code === 'GITHUB_NOT_FOUND') {
			throw new ScopeError(404, 'installation_not_found', 'no such installation for this GitHub App');
		}
		throw error;
	}
	if (info.suspended) {
		throw new ScopeError(409, 'installation_suspended', 'the installation is suspended at the provider');
	}
	if (!info.permissions['contents'] || !info.permissions['pull_requests']) {
		throw new ScopeError(
			409,
			'installation_missing_permissions',
			'the installation must grant contents:read and pull_requests:write (docs/setup/github-app.md)',
		);
	}

	const now = nowIso();
	const existing = await queryAll(db, 'select * from "github_installations" where "installationId" = ?', id);
	if (existing[0]) {
		const boundWorkspace =
			existing[0]['workspaceId'] === null || existing[0]['workspaceId'] === undefined
				? null
				: String(existing[0]['workspaceId']);
		if (boundWorkspace !== null) {
			if (boundWorkspace === verified.workspaceId) {
				// idempotent re-bind by the same workspace
				return {
					...installationFromRow(existing[0]),
					fingerprint: await privateKeyFingerprint(client.config.privateKeyPem),
				};
			}
			throw new ScopeError(
				409,
				'installation_already_bound',
				'this installation is already bound to another workspace — one installation serves one workspace',
			);
		}
		// The webhook already recorded this installation (imported-existing-app):
		// CLAIM the unbound row with a conditional update so a concurrent binding
		// race can never double-claim (changes = 0 loses, then re-read decides).
		const claim = (await db
			.prepare(
				`update "github_installations"
				   set "workspaceId" = ?, "boundBy" = ?, "accountLogin" = ?, "appSlug" = ?,
				       "permissionsJson" = ?, "status" = 'active', "updatedAt" = ?
				 where "installationId" = ? and "workspaceId" is null`,
			)
			.bind(
				verified.workspaceId,
				verified.actorId,
				info.accountLogin,
				info.appSlug,
				JSON.stringify(info.permissions),
				now,
				id,
			)
			.run()) as { meta?: { changes?: number } };
		const rows = await queryAll(db, 'select * from "github_installations" where "installationId" = ?', id);
		const claimed = rows[0]!;
		if ((claim.meta?.changes ?? 0) === 0) {
			if (claimed['workspaceId'] === verified.workspaceId) {
				return {
					...installationFromRow(claimed),
					fingerprint: await privateKeyFingerprint(client.config.privateKeyPem),
				};
			}
			throw new ScopeError(
				409,
				'installation_already_bound',
				'this installation was bound to another workspace while this binding was in flight',
			);
		}
		return {
			...installationFromRow(claimed),
			fingerprint: await privateKeyFingerprint(client.config.privateKeyPem),
		};
	}

	await db
		.prepare(
			`insert into "github_installations"
			   ("id","installationId","accountLogin","appSlug","permissionsJson","workspaceId","boundBy","status","createdAt","updatedAt")
			 values (?,?,?,?,?,?,?,?,?,?)`,
		)
		.bind(
			newId('ghinst'),
			id,
			info.accountLogin,
			info.appSlug,
			JSON.stringify(info.permissions),
			verified.workspaceId,
			verified.actorId,
			'active',
			now,
			now,
		);
	const rows = await queryAll(db, 'select * from "github_installations" where "installationId" = ?', id);
	return {
		...installationFromRow(rows[0]!),
		fingerprint: await privateKeyFingerprint(client.config.privateKeyPem),
	};
}
