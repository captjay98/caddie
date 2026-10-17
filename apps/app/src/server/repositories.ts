import type { ApprovalIntent, Scope } from '@caddie/contracts';
import type { ExternalOperation } from '@caddie/contracts';
import type { AuthEnv, D1Database } from './auth.ts';
import { ScopeError, assertProjectScope, assertWorkspaceScope, sessionUserId, workspaceScopeForUser } from './scope.ts';
import { checkApprovalForEffect } from './approvals.ts';
import {
	getOperation,
	markDispatched,
	markReconciliationRequired,
	prepareOperation,
	recordReceipt,
} from './operations.ts';
import {
	GithubError,
	GithubRestClient,
	privateKeyFingerprint,
	readGithubConfig,
	type GithubEnv,
	type GithubMergeMethod,
	type GithubMergeOutcome,
	type GithubPullRequestStatus,
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
		)
		.run();
	const rows = await queryAll(db, 'select * from "github_installations" where "installationId" = ?', id);
	return {
		...installationFromRow(rows[0]!),
		fingerprint: await privateKeyFingerprint(client.config.privateKeyPem),
	};
}

// --- import (repo/ref/root through the server boundary) -------------------------------

/** Import quotas (audit: unbounded imports are a denial-of-wallet vector). */
export interface ImportCaps {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

export const DEFAULT_IMPORT_CAPS: ImportCaps = {
	maxFiles: 200,
	maxFileBytes: 512 * 1024,
	maxTotalBytes: 8 * 1024 * 1024,
};

export interface ManifestEntry {
	path: string;
	size: number;
	/** Git blob sha at the provider (provenance, not integrity). */
	blobSha: string;
	/** sha256 hex of the exact bytes stored content-addressed. */
	contentHash: string;
}

export interface SkippedEntry {
	path: string;
	reason: 'submodule';
	gitSha: string;
}

export interface ImportView {
	id: string;
	projectId: string;
	installationId: string;
	repoFullName: string;
	ref: string;
	commitSha: string;
	rootPath: string;
	fileCount: number;
	totalBytes: number;
	manifest: ManifestEntry[];
	skipped: SkippedEntry[];
	createdBy: string;
	createdAt: string;
}

/**
 * Path safety (contract: reject traversal BEFORE any provider call). Returns
 * the normalized relative path or throws a typed 400. Rules: no absolute
 * paths, no '..'/'.' segments, no backslashes, no empty or repeated segments,
 * no control characters.
 */
export function normalizeImportPath(input: unknown, field: string): string {
	if (typeof input !== 'string') {
		throw new ScopeError(400, 'invalid_path', `${field} must be a string`);
	}
	if (input.includes('\\') || input.includes('\0')) {
		throw new ScopeError(400, 'invalid_path', `${field} contains a forbidden character`);
	}
	const segments = input.split('/').filter((s) => s.length > 0);
	if (segments.length === 0) {
		throw new ScopeError(400, 'invalid_path', `${field} resolves to an empty path`);
	}
	if (input.startsWith('/')) {
		throw new ScopeError(400, 'invalid_path', `${field} must be a relative path`);
	}
	for (const segment of segments) {
		if (segment === '.' || segment === '..') {
			throw new ScopeError(400, 'invalid_path', `${field} must not contain '.' or '..' segments`);
		}
		if (/[\x00-\x1f\x7f]/.test(segment)) {
			throw new ScopeError(400, 'invalid_path', `${field} contains a control character`);
		}
	}
	return segments.join('/');
}

/** Root normalization: empty means the whole repo; leading/trailing '/' collapse. */
function normalizeRoot(input: unknown): string {
	if (input === undefined || input === null || (typeof input === 'string' && input.trim() === '')) {
		return '';
	}
	const stripped = String(input).replace(/^\/+/, '').replace(/\/+$/, '');
	return normalizeImportPath(stripped, 'root');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const IMPORT_INPUT_SHAPE = 'installationId/repoFullName (strings), optional ref and root';

/**
 * Import the selected repo/ref/root through the server boundary. Only content
 * of SELECTED repositories under an ACTIVE installation can ever be read
 * (guards re-verified against D1). Behavior translated from the HackSteward
 * reference's safe-handling rules:
 *   - symlinks are REJECTED (typed 422), never followed or stored;
 *   - submodules (gitlinks) are skipped and recorded in the import record;
 *   - size/file-count caps are enforced from the tree listing before any blob
 *     is fetched;
 *   - the manifest stores sha256 hashes and the exact bytes are stored
 *     content-addressed (deduplicated by hash).
 */
export async function importRepoSnapshot(
	db: D1Database,
	client: GithubRestClient,
	scope: Scope,
	input: unknown,
): Promise<ImportView> {
	const verified = await assertProjectScope(db, scope);
	const raw = asRecord(input);
	const installationId = requireNonEmpty(raw['installationId'], 'installationId');
	const fullName = normalizeRepoFullName(raw['repoFullName']);
	const root = normalizeRoot(raw['root']);

	const installation = await requireActiveInstallation(db, verified, installationId);
	await requireSelectedRepo(db, installation.installationId, fullName);

	const repo = await client.getRepo(installation.installationId, fullName);
	const ref =
		raw['ref'] === undefined || raw['ref'] === null || String(raw['ref']).trim() === ''
			? repo.defaultBranch
			: normalizeImportPath(String(raw['ref']), 'ref');
	const commit = await client.getCommit(installation.installationId, fullName, ref);
	if (!commit.sha || !commit.treeSha) {
		throw new ScopeError(404, 'ref_not_found', `ref ${ref} does not resolve at ${fullName}`);
	}
	const tree = await client.getTree(installation.installationId, fullName, commit.treeSha);
	if (tree.truncated) {
		throw new ScopeError(
			502,
			'github_tree_truncated',
			'the provider truncated the tree listing — refusing a partial import',
		);
	}

	const manifest: ManifestEntry[] = [];
	const skipped: SkippedEntry[] = [];
	let totalBytes = 0;
	for (const entry of tree.entries) {
		if (entry.type === 'commit') {
			skipped.push({ path: entry.path, reason: 'submodule', gitSha: entry.sha });
			continue;
		}
		if (entry.type === 'tree') continue; // recursive listings are flat; ignore dirs defensively
		if (entry.mode === '120000') {
			throw new ScopeError(
				422,
				'symlink_rejected',
				`${entry.path} is a symlink — symlinks are never followed or imported`,
			);
		}
		if (root && entry.path !== root && !entry.path.startsWith(`${root}/`)) continue;
		const relative = root ? entry.path.slice(root.length + 1) : entry.path;
		if (relative === '') continue;
		const safePath = normalizeImportPath(relative, 'manifest path');
		if (entry.size > DEFAULT_IMPORT_CAPS.maxFileBytes) {
			throw new ScopeError(
				422,
				'import_file_size_cap_exceeded',
				`${entry.path} is ${entry.size} bytes (cap ${DEFAULT_IMPORT_CAPS.maxFileBytes})`,
			);
		}
		totalBytes += entry.size;
		if (totalBytes > DEFAULT_IMPORT_CAPS.maxTotalBytes) {
			throw new ScopeError(
				422,
				'import_total_size_cap_exceeded',
				`total import exceeds ${DEFAULT_IMPORT_CAPS.maxTotalBytes} bytes`,
			);
		}
		if (manifest.length >= DEFAULT_IMPORT_CAPS.maxFiles) {
			throw new ScopeError(
				422,
				'import_file_count_cap_exceeded',
				`import exceeds ${DEFAULT_IMPORT_CAPS.maxFiles} files`,
			);
		}
		const bytes = await client.getBlob(installation.installationId, fullName, entry.sha);
		const contentHash = await sha256Hex(bytes);
		manifest.push({ path: safePath, size: bytes.byteLength, blobSha: entry.sha, contentHash });
	}
	if (manifest.length > DEFAULT_IMPORT_CAPS.maxFiles) {
		throw new ScopeError(
			422,
			'import_file_count_cap_exceeded',
			`import exceeds ${DEFAULT_IMPORT_CAPS.maxFiles} files`,
		);
	}

	// content-addressed store: dedupe within this import first, then only
	// insert hashes that are not already stored (select-then-insert — see the
	// D1 upsert note above).
	for (const entry of manifest) {
		const existing = await queryAll(db, 'select "hash" from "content_blobs" where "hash" = ?', entry.contentHash);
		if (existing[0]) continue;
		const bytes = await client.getBlob(installation.installationId, fullName, entry.blobSha);
		await db
			.prepare('insert into "content_blobs" ("hash","bytes","size","createdAt") values (?,?,?,?)')
			.bind(entry.contentHash, bytes, bytes.byteLength, nowIso())
			.run();
	}

	const id = newId('ghimp');
	const createdAt = nowIso();
	await db
		.prepare(
			`insert into "github_imports"
			   ("id","projectId","installationId","repoFullName","ref","commitSha","rootPath","fileCount","totalBytes","manifestJson","skippedJson","createdBy","createdAt")
			 values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.bind(
			id,
			verified.projectId,
			installation.installationId,
			fullName,
			ref,
			commit.sha,
			root,
			manifest.length,
			totalBytes,
			JSON.stringify(manifest),
			JSON.stringify(skipped),
			verified.actorId,
			createdAt,
		)
		.run();
	return {
		id,
		projectId: verified.projectId,
		installationId: installation.installationId,
		repoFullName: fullName,
		ref,
		commitSha: commit.sha,
		rootPath: root,
		fileCount: manifest.length,
		totalBytes,
		manifest,
		skipped,
		createdBy: verified.actorId,
		createdAt,
	};
}

/** List the scoped project's imports, newest first. */
export async function listImports(db: D1Database, scope: Scope): Promise<ImportView[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "github_imports" where "projectId" = ? order by "createdAt" desc',
		verified.projectId,
	);
	return rows.map((row) => ({
		id: String(row['id']),
		projectId: String(row['projectId']),
		installationId: String(row['installationId']),
		repoFullName: String(row['repoFullName']),
		ref: String(row['ref']),
		commitSha: String(row['commitSha']),
		rootPath: String(row['rootPath'] ?? ''),
		fileCount: Number(row['fileCount']),
		totalBytes: Number(row['totalBytes']),
		manifest: safeJsonParse(String(row['manifestJson'] ?? '[]')) as ManifestEntry[],
		skipped: safeJsonParse(String(row['skippedJson'] ?? '[]')) as SkippedEntry[],
		createdBy: String(row['createdBy']),
		createdAt: String(row['createdAt']),
	}));
}

// --- project ↔ repo link (guided join → build → GitHub step) ----------------------------

export interface ProjectRepoView {
	projectId: string;
	installationId: string;
	repoFullName: string;
	visibility: 'private' | 'public';
	origin: 'created' | 'adopted' | 'connected';
	htmlUrl: string;
}

function projectRepoFromRow(row: Record<string, unknown>): ProjectRepoView {
	return {
		projectId: String(row['projectId']),
		installationId: String(row['installationId']),
		repoFullName: String(row['repoFullName']),
		visibility: (row['visibility'] as 'private' | 'public') ?? 'private',
		origin: (row['origin'] as 'created' | 'adopted' | 'connected') ?? 'connected',
		htmlUrl: String(row['htmlUrl'] ?? ''),
	};
}

/** The project's connected repo, or null when none — the honest hasRepo signal. */
export async function getProjectRepo(db: D1Database, scope: Scope): Promise<ProjectRepoView | null> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(db, 'select * from "github_project_repos" where "projectId" = ?', verified.projectId);
	return rows[0] ? projectRepoFromRow(rows[0]) : null;
}

/** Record (or replace) the project's connected repo. One repo per project. */
async function linkProjectRepo(
	db: D1Database,
	projectId: string,
	actorId: string,
	link: { installationId: string; repoFullName: string; visibility: 'private' | 'public'; origin: 'created' | 'adopted' | 'connected'; htmlUrl: string },
): Promise<void> {
	const now = nowIso();
	const existing = await queryAll(db, 'select "projectId" from "github_project_repos" where "projectId" = ?', projectId);
	if (existing[0]) {
		await db
			.prepare('update "github_project_repos" set "installationId" = ?, "repoFullName" = ?, "visibility" = ?, "origin" = ?, "htmlUrl" = ?, "updatedAt" = ? where "projectId" = ?')
			.bind(link.installationId, link.repoFullName, link.visibility, link.origin, link.htmlUrl, now, projectId)
			.run();
		return;
	}
	await db
		.prepare(
			`insert into "github_project_repos" ("projectId","installationId","repoFullName","visibility","origin","htmlUrl","createdBy","createdAt","updatedAt")
			 values (?,?,?,?,?,?,?,?,?)`,
		)
		.bind(projectId, link.installationId, link.repoFullName, link.visibility, link.origin, link.htmlUrl, actorId, now, now)
		.run();
}

/** Ensure a repo is a SELECTED repo of the installation (select-then-write). */
async function ensureRepoSelected(db: D1Database, installationId: string, repoFullName: string): Promise<void> {
	const now = nowIso();
	const existing = await queryAll(
		db,
		'select "id" from "github_repo_selections" where "installationId" = ? and "repoFullName" = ?',
		installationId,
		repoFullName,
	);
	if (existing[0]) {
		await db
			.prepare('update "github_repo_selections" set "status" = ?, "updatedAt" = ? where "id" = ?')
			.bind('selected', now, String(existing[0]['id']))
			.run();
		return;
	}
	try {
		await db
			.prepare(
				`insert into "github_repo_selections" ("id","installationId","repoFullName","status","createdAt","updatedAt")
				 values (?,?,?,?,?,?)`,
			)
			.bind(newId('ghsel'), installationId, repoFullName, 'selected', now, now)
			.run();
	} catch (error) {
		if (!String(error).includes('UNIQUE constraint failed')) throw error;
		await db
			.prepare('update "github_repo_selections" set "status" = ?, "updatedAt" = ? where "installationId" = ? and "repoFullName" = ?')
			.bind('selected', now, installationId, repoFullName)
			.run();
	}
}

const CREATE_REPO_INPUT_SHAPE = 'installationId (string), name (1..100), visibility ("private"|"public")';

/**
 * Create a NEW repo under a bound installation and link it to the project
 * (guided GitHub step, "initialise a repo directly").
 *
 * Fail-closed order: the installation must be active + bound to the scoped
 * workspace (requireActiveInstallation), THEN the adapter refuses up front when
 * the App lacks `administration: write` (typed 503). A name collision adopts
 * the existing repo rather than erroring. The created/adopted repo is marked
 * selected and linked to the project; a freshly-created empty repo is NOT
 * snapshot-imported (no commit exists yet) — the link alone is the connected
 * signal, and the first delivery populates it.
 */
export async function createAndLinkRepo(
	db: D1Database,
	client: GithubRestClient,
	scope: Scope,
	input: unknown,
): Promise<ProjectRepoView> {
	const verified = await assertProjectScope(db, scope);
	const raw = asRecord(input);
	const installationId = requireNonEmpty(raw['installationId'], 'installationId');
	const name = requireNonEmpty(raw['name'], 'name');
	if (name.length > 100 || /[\s/]/.test(name)) {
		throw new ScopeError(400, 'invalid_request', `name must be 1..100 chars with no spaces or '/'; expected ${CREATE_REPO_INPUT_SHAPE}`);
	}
	const visibility = raw['visibility'] === 'public' ? 'public' : raw['visibility'] === 'private' ? 'private' : null;
	if (!visibility) {
		throw new ScopeError(400, 'invalid_request', `visibility must be "private" or "public"; expected ${CREATE_REPO_INPUT_SHAPE}`);
	}

	const installation = await requireActiveInstallation(db, verified, installationId);
	const created = await client.createRepository(installation.installationId, { name, visibility });
	await ensureRepoSelected(db, installation.installationId, created.fullName);
	await linkProjectRepo(db, verified.projectId, verified.actorId, {
		installationId: installation.installationId,
		repoFullName: created.fullName,
		visibility: created.visibility,
		origin: created.adopted ? 'adopted' : 'created',
		htmlUrl: created.htmlUrl || `https://github.com/${created.fullName}`,
	});
	return {
		projectId: verified.projectId,
		installationId: installation.installationId,
		repoFullName: created.fullName,
		visibility: created.visibility,
		origin: created.adopted ? 'adopted' : 'created',
		htmlUrl: created.htmlUrl || `https://github.com/${created.fullName}`,
	};
}

/**
 * Connect an EXISTING repo to the project (the other guided path). The repo
 * must be a selected repo of an active bound installation; we verify it
 * resolves (getRepo) and record the link. Content import stays a separate,
 * explicit step (importRepoSnapshot) — connecting does not force a snapshot.
 */
export async function connectAndLinkRepo(
	db: D1Database,
	client: GithubRestClient,
	scope: Scope,
	input: unknown,
): Promise<ProjectRepoView> {
	const verified = await assertProjectScope(db, scope);
	const raw = asRecord(input);
	const installationId = requireNonEmpty(raw['installationId'], 'installationId');
	const repoFullName = normalizeRepoFullName(raw['repoFullName']);

	const installation = await requireActiveInstallation(db, verified, installationId);
	await requireSelectedRepo(db, installation.installationId, repoFullName);
	const repo = await client.getRepo(installation.installationId, repoFullName); // 404s honestly if gone
	await linkProjectRepo(db, verified.projectId, verified.actorId, {
		installationId: installation.installationId,
		repoFullName: repo.fullName,
		visibility: 'private',
		origin: 'connected',
		htmlUrl: `https://github.com/${repo.fullName}`,
	});
	return {
		projectId: verified.projectId,
		installationId: installation.installationId,
		repoFullName: repo.fullName,
		visibility: 'private',
		origin: 'connected',
		htmlUrl: `https://github.com/${repo.fullName}`,
	};
}



export type DeliveryMode = 'pull-request' | 'merge-default-branch';

export interface DeliveryView {
	operationKey: string;
	mode: DeliveryMode;
	repoFullName: string;
	baseBranch: string;
	headBranch: string;
	contentHash: string;
	pullRequestNumber: number | null;
	headSha: string | null;
	htmlUrl: string | null;
}

/**
 * The approval gate refused a default-branch effect. Carries the operation key
 * and exact content revision so the USER can approve the EXACT intent without
 * the delivery route ever trusting a re-request.
 */
export class DeliveryGateError extends Error {
	constructor(
		readonly gate: ScopeError,
		readonly operationKey: string,
		readonly revisionHash: string,
	) {
		super(gate.message);
		this.name = 'DeliveryGateError';
	}
}

interface DeliveryRow {
	id: string;
	headSha: string | null;
	pullRequestNumber: number | null;
}

async function deliveryRowByKey(db: D1Database, operationKey: string): Promise<DeliveryRow | null> {
	const rows = await queryAll(db, 'select * from "github_deliveries" where "operationKey" = ?', operationKey);
	const row = rows[0];
	return row
		? {
				id: String(row['id']),
				headSha: row['headSha'] === null || row['headSha'] === undefined ? null : String(row['headSha']),
				pullRequestNumber:
					row['pullRequestNumber'] === null || row['pullRequestNumber'] === undefined
						? null
						: Number(row['pullRequestNumber']),
			}
		: null;
}

async function latestDeliveryForBranch(
	db: D1Database,
	fullName: string,
	headBranch: string,
): Promise<{ operationKey: string; headSha: string | null } | null> {
	const rows = await queryAll(
		db,
		'select "operationKey", "headSha" from "github_deliveries" where "repoFullName" = ? and "headBranch" = ? order by "createdAt" desc, "rowid" desc limit 1',
		fullName,
		headBranch,
	);
	const row = rows[0];
	if (!row) return null;
	return {
		operationKey: String(row['operationKey']),
		headSha: row['headSha'] === null || row['headSha'] === undefined ? null : String(row['headSha']),
	};
}

async function upsertDeliveryRow(
	db: D1Database,
	values: {
		operationKey: string;
		projectId: string;
		installationId: string;
		repoFullName: string;
		baseBranch: string;
		headBranch: string;
		mode: DeliveryMode;
		contentHash: string;
		headSha: string | null;
		pullRequestNumber: number | null;
		createdBy: string;
	},
): Promise<void> {
	const existing = await queryAll(db, 'select "id" from "github_deliveries" where "operationKey" = ?', values.operationKey);
	if (existing[0]) {
		await db
			.prepare(
				'update "github_deliveries" set "headSha" = ?, "pullRequestNumber" = ?, "updatedAt" = ? where "id" = ?',
			)
			.bind(values.headSha, values.pullRequestNumber, nowIso(), String(existing[0]['id']))
			.run();
		return;
	}
	try {
		await db
			.prepare(
				`insert into "github_deliveries"
				   ("id","operationKey","projectId","installationId","repoFullName","baseBranch","headBranch","mode","contentHash","pullRequestNumber","headSha","createdBy","createdAt","updatedAt")
				 values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			)
			.bind(
				newId('ghdel'),
				values.operationKey,
				values.projectId,
				values.installationId,
				values.repoFullName,
				values.baseBranch,
				values.headBranch,
				values.mode,
				values.contentHash,
				values.pullRequestNumber,
				values.headSha,
				values.createdBy,
				nowIso(),
				nowIso(),
			)
			.run();
	} catch (error) {
		if (!String(error).includes('UNIQUE constraint failed')) throw error;
		// lost an insert race against the same operationKey: update instead
		const row = await deliveryRowByKey(db, values.operationKey);
		if (row) {
			await db
				.prepare('update "github_deliveries" set "headSha" = ?, "pullRequestNumber" = ?, "updatedAt" = ? where "id" = ?')
				.bind(values.headSha, values.pullRequestNumber, nowIso(), row.id)
				.run();
		}
	}
}

/** A delivery file: UTF-8 text, or base64 bytes for binary content (images, lockfiles). */
interface DeliveryFile {
	path: string;
	content: string;
	encoding: 'utf-8' | 'base64';
	/** Decoded bytes (what the blob carries); never part of the content hash. */
	bytes: Uint8Array;
}

/**
 * Canonical JSON over sorted file entries — the delivery intent's revision
 * hash. Text-only deliveries without deletions hash exactly as they always
 * did; a base64 file carries its encoding and deletions ride alongside.
 */
export async function deliveryContentHash(
	files: ReadonlyArray<{ path: string; content: string; encoding?: 'utf-8' | 'base64' }>,
	deletePaths: readonly string[] = [],
): Promise<string> {
	const sorted = [...files]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((file) =>
			file.encoding === 'base64'
				? { path: file.path, content: file.content, encoding: 'base64' }
				: { path: file.path, content: file.content },
		);
	const canonical =
		deletePaths.length === 0 ? JSON.stringify(sorted) : JSON.stringify({ files: sorted, delete: [...deletePaths].sort() });
	return sha256Hex(new TextEncoder().encode(canonical));
}

function decodeDeliveryBytes(path: string, content: string, encoding: 'utf-8' | 'base64'): Uint8Array {
	if (encoding === 'utf-8') return new TextEncoder().encode(content);
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) {
		throw new ScopeError(400, 'invalid_input', `files[${path}].content is not valid base64`);
	}
	const binary = atob(content);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function parseDeliveryInput(input: unknown): {
	runId: string;
	installationId: string;
	repoFullName: string;
	headBranch: string;
	baseBranch: string | null;
	title: string;
	body: string;
	files: DeliveryFile[];
	deletePaths: string[];
	mode: DeliveryMode;
} {
	const raw = asRecord(input);
	const mode = raw['mode'];
	if (mode !== 'pull-request' && mode !== 'merge-default-branch') {
		throw new ScopeError(400, 'invalid_input', 'mode must be pull-request or merge-default-branch');
	}
	const runId = requireNonEmpty(raw['runId'], 'runId');
	const installationId = requireNonEmpty(raw['installationId'], 'installationId');
	const repoFullName = normalizeRepoFullName(raw['repoFullName']);
	const headBranch =
		typeof raw['headBranch'] === 'string' && raw['headBranch'].trim() !== ''
			? normalizeImportPath(raw['headBranch'], 'headBranch')
			: '';
	const baseBranch =
		raw['baseBranch'] === undefined || raw['baseBranch'] === null || String(raw['baseBranch']).trim() === ''
			? null
			: normalizeImportPath(raw['baseBranch'], 'baseBranch');
	const title = requireNonEmpty(raw['title'], 'title');
	const body = typeof raw['body'] === 'string' ? raw['body'] : '';
	const rawFiles = Array.isArray(raw['files']) ? raw['files'] : [];
	if (rawFiles.length === 0) {
		throw new ScopeError(400, 'invalid_input', 'files must be a non-empty array');
	}
	if (rawFiles.length > DEFAULT_IMPORT_CAPS.maxFiles) {
		throw new ScopeError(400, 'invalid_input', `files exceeds ${DEFAULT_IMPORT_CAPS.maxFiles} entries`);
	}
	const seen = new Set<string>();
	let totalBytes = 0;
	const files = rawFiles.map((rawFile): DeliveryFile => {
		const file = asRecord(rawFile);
		const path = normalizeImportPath(file['path'], 'files[].path');
		if (seen.has(path)) throw new ScopeError(400, 'invalid_input', `duplicate file path: ${path}`);
		seen.add(path);
		if (typeof file['content'] !== 'string') {
			throw new ScopeError(400, 'invalid_input', `files[${path}].content must be a string`);
		}
		const rawEncoding = file['encoding'];
		if (rawEncoding !== undefined && rawEncoding !== 'utf-8' && rawEncoding !== 'base64') {
			throw new ScopeError(400, 'invalid_input', `files[${path}].encoding must be utf-8 or base64`);
		}
		const encoding = rawEncoding === 'base64' ? 'base64' : 'utf-8';
		const bytes = decodeDeliveryBytes(path, file['content'], encoding);
		if (bytes.byteLength > DEFAULT_IMPORT_CAPS.maxFileBytes) {
			throw new ScopeError(400, 'invalid_input', `files[${path}] exceeds the per-file size cap`);
		}
		totalBytes += bytes.byteLength;
		return { path, content: file['content'], encoding, bytes };
	});
	if (totalBytes > DEFAULT_IMPORT_CAPS.maxTotalBytes) {
		throw new ScopeError(400, 'invalid_input', 'files exceed the total size cap');
	}
	const rawDeletes = raw['deletePaths'] ?? [];
	if (!Array.isArray(rawDeletes)) {
		throw new ScopeError(400, 'invalid_input', 'deletePaths must be an array of paths');
	}
	if (rawDeletes.length > DEFAULT_IMPORT_CAPS.maxFiles) {
		throw new ScopeError(400, 'invalid_input', `deletePaths exceeds ${DEFAULT_IMPORT_CAPS.maxFiles} entries`);
	}
	const deletePaths = [...new Set(rawDeletes.map((path) => normalizeImportPath(path, 'deletePaths[]')))].sort();
	for (const path of deletePaths) {
		if (seen.has(path)) throw new ScopeError(400, 'invalid_input', `deletePaths overlaps files: ${path}`);
	}
	if (mode === 'pull-request' && !headBranch) {
		throw new ScopeError(400, 'invalid_input', 'headBranch is required for pull-request delivery');
	}
	return { runId, installationId, repoFullName, headBranch, baseBranch, title, body, files, deletePaths, mode };
}

/**
 * Every git-data write (blob, tree, commit, branch) and every merge needs the
 * App's "Contents: Read and write" permission (GitHub's documented rule; pull
 * request write alone is not enough). Read LIVE from the App API, as repo
 * creation does for administration, so an owner who just granted it is never
 * refused from a stale record, and a missing grant is a clear refusal before
 * any write instead of an opaque 403 halfway through.
 */
async function requireContentsWrite(client: GithubRestClient, installationId: string, purpose: string): Promise<void> {
	const live = await client.getInstallation(installationId);
	if ((live.permissions['contents'] ?? '') !== 'write') {
		throw new ScopeError(
			403,
			'github_contents_write_required',
			`the Caddie GitHub App needs the "Contents: Read and write" permission to ${purpose}. Grant it in the App's settings, accept the new permission on the installation, then try again.`,
		);
	}
}

/**
 * The subset of `deletePaths` that exists in `treeSha` — GitHub rejects a
 * delete of a path the base tree does not have, and a path Caddie never saw
 * is never touched. A truncated listing (a very large repo) deletes nothing.
 */
async function deletionsPresentIn(
	client: GithubRestClient,
	installationId: string,
	fullName: string,
	treeSha: string,
	deletePaths: readonly string[],
): Promise<string[]> {
	if (deletePaths.length === 0) return [];
	const tree = await client.getTree(installationId, fullName, treeSha);
	if (tree.truncated) return [];
	const present = new Set(tree.entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path));
	return deletePaths.filter((path) => present.has(path));
}

/**
 * Blobs (deduplicated by content) + one tree on top of `baseTreeSha`, with
 * the confirmed deletions. Returns the tree and the paths it removed.
 */
async function writeDeliveryTree(
	client: GithubRestClient,
	installationId: string,
	fullName: string,
	baseTreeSha: string,
	files: readonly DeliveryFile[],
	deletePaths: readonly string[],
): Promise<{ treeSha: string; deleted: string[] }> {
	const blobShas = new Map<string, string>();
	const fileHashes = new Map<string, string>();
	for (const file of files) {
		const fileHash = await sha256Hex(file.bytes);
		fileHashes.set(file.path, fileHash);
		if (blobShas.has(fileHash)) continue;
		blobShas.set(fileHash, await client.createBlob(installationId, fullName, file.bytes));
	}
	const deleted = await deletionsPresentIn(client, installationId, fullName, baseTreeSha, deletePaths);
	const treeSha = await client.createTree(installationId, fullName, baseTreeSha, [
		...files.map((file) => ({ path: file.path, sha: blobShas.get(fileHashes.get(file.path)!)! })),
		...deleted.map((path) => ({ path, sha: null })),
	]);
	return { treeSha, deleted };
}

/**
 * Elect the ONE dispatcher row for a logical delivery: adopt an existing
 * ledger row (idempotent resume) or insert the unique operation key. A lost
 * insert race re-reads the winner — there is never a second row.
 */
async function electOrAdoptOperation(
	db: D1Database,
	input: { projectId: string; runId: string; provider: string; operationKey: string },
): Promise<ExternalOperation> {
	const existing = await getOperation(db, input.operationKey);
	if (existing) return existing;
	try {
		return await prepareOperation(db, input);
	} catch (error) {
		if (!(error instanceof ScopeError) || error.code !== 'operation_key_conflict') throw error;
		const raced = await getOperation(db, input.operationKey);
		if (!raced) throw error;
		return raced;
	}
}

/**
 * Deliver a verified patch set, RECONCILED through the P03 external-effects
 * ledger:
 *
 *   - the operationKey is the durable idempotency key of the LOGICAL delivery
 *     (project, repo, branch, mode, content hash) — a duplicate intent elects
 *     ONE effect and replays the SAME PR;
 *   - the divergence check refuses to touch a branch whose head is not
 *     exactly the last head we recorded (reviewable conflict, never overwrite,
 *     never force-push);
 *   - merge-default-branch effects are PREPARED by this call but execute only
 *     behind the P03 approval gate (checkApprovalForEffect, exact
 *     revision + actor + project); the prepared row survives a refusal;
 *   - a provider receipt settles the ledger row; an ambiguous dispatch lands
 *     in reconciliation-required and is never retried blindly.
 */
export async function deliverPatch(
	db: D1Database,
	client: GithubRestClient,
	scope: Scope,
	input: unknown,
): Promise<{ delivery: DeliveryView; reconciled: boolean; operation?: ExternalOperation; deleted?: string[] }> {
	const verified = await assertProjectScope(db, scope);
	const parsed = parseDeliveryInput(input);
	const installation = await requireActiveInstallation(db, verified, parsed.installationId);
	await requireSelectedRepo(db, installation.installationId, parsed.repoFullName);

	const fullName = parsed.repoFullName;
	const repo = await client.getRepo(installation.installationId, fullName);
	const baseBranch =
		parsed.mode === 'merge-default-branch' ? repo.defaultBranch : parsed.baseBranch ?? repo.defaultBranch;
	const headBranch = parsed.mode === 'merge-default-branch' ? repo.defaultBranch : parsed.headBranch;
	const contentHash = await deliveryContentHash(parsed.files, parsed.deletePaths);
	const operationKey = `github:${parsed.mode}:${verified.projectId}:${fullName}:${headBranch}:${contentHash}`;

	// Elect/adopt the dispatcher for this logical delivery.
	const operation: ExternalOperation = await electOrAdoptOperation(db, {
		projectId: verified.projectId,
		runId: parsed.runId,
		provider: GITHUB_PROVIDER,
		operationKey,
	});

	const view = (
		overrides: Partial<DeliveryView> & { reconciled?: boolean; operation?: ExternalOperation },
	): { delivery: DeliveryView; operation: ExternalOperation; reconciled: boolean } => {
		const { reconciled: overrideReconciled, operation: overrideOperation, ...rest } = overrides;
		return {
			reconciled: overrideReconciled ?? false,
			operation: overrideOperation ?? operation,
			delivery: {
				operationKey,
				mode: parsed.mode,
				repoFullName: fullName,
				baseBranch,
				headBranch,
				contentHash,
				pullRequestNumber: null,
				headSha: null,
				htmlUrl: null,
				...rest,
			},
		};
	};

	// Terminal / stuck states are honest short-circuits — no re-dispatch path.
	if (operation.status === 'succeeded') {
		const row = await deliveryRowByKey(db, operationKey);
		return view({
			reconciled: true,
			pullRequestNumber: row?.pullRequestNumber ?? null,
			headSha: row?.headSha ?? null,
			// html URLs are provider decoration, never persisted — a replay
			// returns the durable facts (PR number + recorded head) only.
			htmlUrl: null,
		});
	}
	if (operation.status === 'failed' || operation.status === 'cancelled' || operation.status === 'cancel-requested') {
		throw new ScopeError(
			409,
			'operation_settled',
			`this delivery already settled as ${operation.status} — change the content or branch for a new logical delivery`,
		);
	}
	if (operation.status === 'reconciliation-required') {
		throw new ScopeError(
			503,
			'delivery_reconciliation_required',
			'an earlier dispatch of this delivery has an unknown outcome — reconcile by operation key before retrying',
		);
	}

	// THE gate for default-branch effects: runs on EVERY execution attempt
	// (fresh prepared row or resumed one). The prepared row deliberately
	// survives a refusal — it is evidence of intent, never of effect.
	if (parsed.mode === 'merge-default-branch') {
		try {
			await checkApprovalForEffect(db, {
				actorId: verified.actorId,
				projectId: verified.projectId,
				action: 'merge-default-branch',
				resourceId: fullName,
				revisionHash: contentHash,
				policyVersion: GITHUB_POLICY_VERSION,
			});
		} catch (error) {
			if (error instanceof ScopeError) throw new DeliveryGateError(error, operationKey, contentHash);
			throw error;
		}
	}

	const commitMessage = `${parsed.title}\n\n${parsed.body}`.trim();
	// Fail closed before the first write (a replay above never writes).
	await requireContentsWrite(client, installation.installationId, 'save files to the repo');

	if (parsed.mode === 'merge-default-branch') {
		const defaultHead = await client.getBranchHead(installation.installationId, fullName, repo.defaultBranch);
		if (!defaultHead) {
			throw new ScopeError(404, 'base_branch_not_found', `default branch ${repo.defaultBranch} does not exist`);
		}
		const defaultCommit = await client.getCommit(installation.installationId, fullName, defaultHead);

		if (operation.status === 'dispatched') {
			// Resume: confirm our commit is an ancestor of the current head
			// (bounded walk, read-only), then settle the receipt. Never re-apply.
			const row = await deliveryRowByKey(db, operationKey);
			const ourCommit = row?.headSha ?? operation.remoteId ?? '';
			let cursor = defaultHead;
			for (let i = 0; i < 100 && cursor; i++) {
				if (cursor === ourCommit) {
					const settled = await recordReceipt(db, operationKey, {
						receiptId: `merge:${ourCommit}`,
						outcome: 'succeeded',
						remoteId: ourCommit,
					});
					return view({ reconciled: true, headSha: ourCommit, operation: settled });
				}
				const parent = await client.getCommit(installation.installationId, fullName, cursor);
				cursor = parent.parents[0] ?? '';
			}
			await markReconciliationRequired(db, operationKey);
			throw new ScopeError(
				503,
				'delivery_reconciliation_required',
				'the recorded merge commit is not reachable from the branch head — reconcile manually',
			);
		}

		const { treeSha, deleted: deletedOnDefault } = await writeDeliveryTree(
			client,
			installation.installationId,
			fullName,
			defaultCommit.treeSha,
			parsed.files,
			parsed.deletePaths,
		);
		const commitSha = await client.createCommit(installation.installationId, fullName, {
			message: commitMessage,
			tree: treeSha,
			parents: [defaultHead],
		});
		// force is ALWAYS false: a fast-forward onto the head we just read.
		await client.updateBranchHead(installation.installationId, fullName, repo.defaultBranch, commitSha);
		await markDispatched(db, operationKey, commitSha);
		await upsertDeliveryRow(db, {
			operationKey,
			projectId: verified.projectId,
			installationId: installation.installationId,
			repoFullName: fullName,
			baseBranch,
			headBranch,
			mode: parsed.mode,
			contentHash,
			headSha: commitSha,
			pullRequestNumber: null,
			createdBy: verified.actorId,
		});
		const settled = await recordReceipt(db, operationKey, {
			receiptId: `merge:${commitSha}`,
			outcome: 'succeeded',
			remoteId: commitSha,
		});
		return { ...view({ headSha: commitSha, operation: settled }), deleted: deletedOnDefault };
	}

	// --- pull-request mode ------------------------------------------------------------
	const baseHead = await client.getBranchHead(installation.installationId, fullName, baseBranch);
	if (!baseHead) {
		throw new ScopeError(404, 'base_branch_not_found', `base branch ${baseBranch} does not exist`);
	}

	if (operation.status === 'dispatched') {
		// Resume after an ambiguous dispatch: the branch head must still be the
		// commit we recorded, otherwise the provider state is unknown.
		const row = await deliveryRowByKey(db, operationKey);
		const recorded = row?.headSha ?? operation.remoteId ?? '';
		const providerHead = await client.getBranchHead(installation.installationId, fullName, headBranch);
		if (!providerHead || providerHead !== recorded) {
			await markReconciliationRequired(db, operationKey);
			throw new ScopeError(
				503,
				'delivery_reconciliation_required',
				'the dispatched branch head no longer matches the recorded commit — reconcile by operation key',
			);
		}
	}

	let wasDispatchedByUs = operation.status === 'dispatched';
	/** Paths this call removed from the branch; undefined on a resume or replay. */
	let deleted: string[] | undefined;
	if (operation.status === 'prepared') {
		// Divergence pre-flight: the branch must not exist, or its head must be
		// exactly the last head WE recorded for it. Anything else is a foreign
		// history — typed conflict, reviewable, never overwritten.
		const providerHead = await client.getBranchHead(installation.installationId, fullName, headBranch);
		if (providerHead !== null) {
			const recorded = await latestDeliveryForBranch(db, fullName, headBranch);
			if (!recorded?.headSha || recorded.headSha !== providerHead) {
				throw new ScopeError(
					409,
					'delivery_head_diverged',
					`branch ${headBranch} moved outside this delivery's history (head ${providerHead}) — resolve the divergence instead of overwriting`,
				);
			}
		}
		const parentCommit =
			providerHead !== null
				? await client.getCommit(installation.installationId, fullName, providerHead)
				: await client.getCommit(installation.installationId, fullName, baseHead);
		if (providerHead === null) {
			await client.createBranch(installation.installationId, fullName, headBranch, baseHead);
		}
		const written = await writeDeliveryTree(
			client,
			installation.installationId,
			fullName,
			parentCommit.treeSha,
			parsed.files,
			parsed.deletePaths,
		);
		deleted = written.deleted;
		const commitSha = await client.createCommit(installation.installationId, fullName, {
			message: commitMessage,
			tree: written.treeSha,
			parents: [providerHead ?? baseHead],
		});
		await client.updateBranchHead(installation.installationId, fullName, headBranch, commitSha);
		await markDispatched(db, operationKey, commitSha);
		wasDispatchedByUs = false; // this call dispatched it fresh — not a resume
		await upsertDeliveryRow(db, {
			operationKey,
			projectId: verified.projectId,
			installationId: installation.installationId,
			repoFullName: fullName,
			baseBranch,
			headBranch,
			mode: parsed.mode,
			contentHash,
			headSha: commitSha,
			pullRequestNumber: null,
			createdBy: verified.actorId,
		});
	}

	// PR creation reconciles GitHub's "already exists" 422 to the SAME PR.
	const { pr, reconciled: prReconciled } = await client.createPullRequest(
		installation.installationId,
		fullName,
		{ title: parsed.title, head: headBranch, base: baseBranch, body: parsed.body || commitMessage },
	);
	const settled = await recordReceipt(db, operationKey, {
		receiptId: `pr:${pr.number}`,
		outcome: 'succeeded',
		remoteId: `pr:${pr.number}`,
	});
	await upsertDeliveryRow(db, {
		operationKey,
		projectId: verified.projectId,
		installationId: installation.installationId,
		repoFullName: fullName,
		baseBranch,
		headBranch,
		mode: parsed.mode,
		contentHash,
		headSha: pr.headSha || (await client.getBranchHead(installation.installationId, fullName, headBranch)),
		pullRequestNumber: pr.number,
		createdBy: verified.actorId,
	});
	return {
		...view({
			reconciled: prReconciled || wasDispatchedByUs,
			pullRequestNumber: pr.number,
			headSha: pr.headSha,
			htmlUrl: pr.htmlUrl,
			operation: settled,
		}),
		...(deleted !== undefined ? { deleted } : {}),
	};
}

export interface PullRequestCloseView {
	projectId: string;
	repoFullName: string;
	pullRequestNumber: number;
	state: 'closed';
	htmlUrl: string | null;
}

/**
 * Close a pull request Caddie opened for THIS project. An explicit user action
 * with the same fail-closed rules as delivery:
 *
 *   - only a PR recorded in this project's `pull-request` deliveries can be
 *     closed — never an arbitrary PR on the user's repo;
 *   - the installation must still be active and bound, and the repo selected
 *     (a revoked installation denies this like every other operation);
 *   - read-before-write: a PR that is already closed reconciles with NO
 *     provider write; a MERGED PR is a typed 409 (its changes are on the base
 *     branch — closing cannot undo that and is never attempted).
 *
 * Closing is reversible on GitHub (reopen) and never deletes the head branch,
 * so it needs no default-branch approval. Provider state is the idempotency
 * source of truth, so a PR the user reopened can be closed again.
 */
export async function closeDeliveredPullRequest(
	db: D1Database,
	client: GithubRestClient,
	scope: Scope,
	input: unknown,
): Promise<{ pullRequest: PullRequestCloseView; reconciled: boolean }> {
	const verified = await assertProjectScope(db, scope);
	const raw = asRecord(input);
	const repoFullName = normalizeRepoFullName(raw['repoFullName']);
	const pullRequestNumber = Number(raw['pullRequestNumber']);
	if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
		throw new ScopeError(400, 'invalid_request', 'pullRequestNumber must be a positive integer');
	}

	const delivered = await queryAll(
		db,
		'select "installationId" from "github_deliveries" where "projectId" = ? and "repoFullName" = ? and "mode" = ? and "pullRequestNumber" = ? order by "createdAt" desc limit 1',
		verified.projectId,
		repoFullName,
		'pull-request',
		pullRequestNumber,
	);
	if (!delivered[0]) {
		throw new ScopeError(
			404,
			'pull_request_not_delivered',
			`pull request #${pullRequestNumber} on ${repoFullName} was not opened by Caddie for this project`,
		);
	}

	const installation = await requireActiveInstallation(db, verified, String(delivered[0]['installationId']));
	await requireSelectedRepo(db, installation.installationId, repoFullName);

	const view = (htmlUrl: string): PullRequestCloseView => ({
		projectId: verified.projectId,
		repoFullName,
		pullRequestNumber,
		state: 'closed',
		htmlUrl: htmlUrl || null,
	});

	const current = await client.getPullRequest(installation.installationId, repoFullName, pullRequestNumber);
	if (current.merged) {
		throw new ScopeError(
			409,
			'pull_request_merged',
			`pull request #${pullRequestNumber} is already merged — its changes are on ${current.base || 'the base branch'}, so it cannot be closed`,
		);
	}
	if (current.state === 'closed') return { pullRequest: view(current.htmlUrl), reconciled: true };

	const closed = await client.closePullRequest(installation.installationId, repoFullName, pullRequestNumber);
	if (closed.state !== 'closed') {
		// Never report a close the provider did not confirm.
		throw new GithubError(
			502,
			'GITHUB_PROVIDER_ERROR',
			`github did not confirm pull request #${pullRequestNumber} closed (state ${closed.state})`,
		);
	}
	return { pullRequest: view(closed.htmlUrl), reconciled: false };
}

export interface PullRequestMergeView {
	projectId: string;
	repoFullName: string;
	pullRequestNumber: number;
	merged: true;
	/** The commit the merge produced on the base branch (null when GitHub did not say). */
	mergeCommitSha: string | null;
	baseBranch: string;
	htmlUrl: string | null;
}

/**
 * The exact approval a merge of PR `number` at commit `headSha` needs. One
 * helper, so the status read the UI approves and the gate the merge checks
 * can never disagree. It reuses the `merge-default-branch` action; the
 * resource is the PR (`owner/repo#12`), so a direct-write approval (resource
 * `owner/repo`, revision = content hash) can never stand in for a merge.
 */
export function pullRequestMergeIntent(
	projectId: string,
	repoFullName: string,
	pullRequestNumber: number,
	headSha: string,
): ApprovalIntent {
	return {
		projectId,
		action: 'merge-default-branch',
		resourceId: `${repoFullName}#${pullRequestNumber}`,
		revisionHash: headSha,
		policyVersion: GITHUB_POLICY_VERSION,
	};
}

/** The approval gate refused a merge; carries the EXACT intent the user must approve. */
export class MergeGateError extends Error {
	constructor(
		readonly gate: ScopeError,
		readonly intent: ApprovalIntent,
	) {
		super(gate.message);
		this.name = 'MergeGateError';
	}
}

function pickMergeMethod(methods: Record<GithubMergeMethod, boolean> | null): GithubMergeMethod {
	// Squash keeps the user's main history one commit per save; fall back to
	// what the repo allows. Unknown settings try squash (GitHub's default allows it).
	if (!methods || methods.squash) return 'squash';
	if (methods.merge) return 'merge';
	if (methods.rebase) return 'rebase';
	return 'squash';
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

/**
 * Merge a pull request Caddie opened for THIS project into its base branch.
 * Writing the default branch is the one GitHub effect that cannot be undone
 * from Caddie, so:
 *
 *   - only a PR recorded in this project's `pull-request` deliveries, under an
 *     active installation and a selected repo (same rules as close);
 *   - read first: an already-merged PR reconciles with NO write (and settles
 *     a ledger row whose answer was lost); a closed PR, a head that moved
 *     past the reviewed commit, or a PR GitHub reports as conflicting is a
 *     typed 409 before anything is written;
 *   - THE gate: an exact human approval for this PR at this commit
 *     (pullRequestMergeIntent), checked on every attempt;
 *   - the merge call is pinned to the approved commit, so GitHub itself
 *     refuses (409) when anyone pushed after the approval;
 *   - the effect goes through the external-operations ledger: prepared ->
 *     dispatched -> succeeded with the merge commit as receipt. A refusal
 *     GitHub states leaves the row retryable (nothing merged); an answer that
 *     never arrived lands in reconciliation-required, and the next attempt
 *     reads the PR before it tries anything.
 */
export async function mergeDeliveredPullRequest(
	db: D1Database,
	client: GithubRestClient,
	scope: Scope,
	input: unknown,
): Promise<{ pullRequest: PullRequestMergeView; reconciled: boolean }> {
	const verified = await assertProjectScope(db, scope);
	const raw = asRecord(input);
	const repoFullName = normalizeRepoFullName(raw['repoFullName']);
	const pullRequestNumber = Number(raw['pullRequestNumber']);
	if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) {
		throw new ScopeError(400, 'invalid_request', 'pullRequestNumber must be a positive integer');
	}
	const headSha = requireNonEmpty(raw['headSha'], 'headSha');
	if (!/^[0-9A-Za-z-]{7,80}$/.test(headSha)) {
		throw new ScopeError(400, 'invalid_request', 'headSha must be a commit id');
	}

	const delivered = await queryAll(
		db,
		'select "installationId", "operationKey" from "github_deliveries" where "projectId" = ? and "repoFullName" = ? and "mode" = ? and "pullRequestNumber" = ? order by "createdAt" desc limit 1',
		verified.projectId,
		repoFullName,
		'pull-request',
		pullRequestNumber,
	);
	if (!delivered[0]) {
		throw new ScopeError(
			404,
			'pull_request_not_delivered',
			`pull request #${pullRequestNumber} on ${repoFullName} was not opened by Caddie for this project`,
		);
	}
	const installation = await requireActiveInstallation(db, verified, String(delivered[0]['installationId']));
	await requireSelectedRepo(db, installation.installationId, repoFullName);

	const intent = pullRequestMergeIntent(verified.projectId, repoFullName, pullRequestNumber, headSha);
	const operationKey = `github:merge-pull-request:${verified.projectId}:${repoFullName}#${pullRequestNumber}:${headSha}`;
	const view = (current: GithubPullRequestStatus, mergeCommitSha: string | null): PullRequestMergeView => ({
		projectId: verified.projectId,
		repoFullName,
		pullRequestNumber,
		merged: true,
		mergeCommitSha,
		baseBranch: current.base,
		htmlUrl: current.htmlUrl || null,
	});

	const current = await client.getPullRequest(installation.installationId, repoFullName, pullRequestNumber);
	if (current.merged) {
		// A merge we dispatched whose answer was lost settles here, from GitHub's own state.
		const recorded = await getOperation(db, operationKey);
		if (recorded && (recorded.status === 'dispatched' || recorded.status === 'reconciliation-required')) {
			const remoteId = current.mergeCommitSha ?? headSha;
			await recordReceipt(db, operationKey, { receiptId: `merge-pr:${remoteId}`, outcome: 'succeeded', remoteId });
		}
		return { pullRequest: view(current, current.mergeCommitSha), reconciled: true };
	}
	if (current.state === 'closed') {
		throw new ScopeError(
			409,
			'pull_request_closed',
			`pull request #${pullRequestNumber} was closed without merging — reopen it on GitHub to merge it`,
		);
	}
	if (current.headSha !== headSha) {
		throw new ScopeError(
			409,
			'pull_request_head_moved',
			`pull request #${pullRequestNumber} moved to ${shortSha(current.headSha)} after ${shortSha(headSha)} was reviewed — review the new commit and approve again`,
		);
	}
	if (current.mergeable === false) {
		throw new ScopeError(
			409,
			'pull_request_not_mergeable',
			`GitHub reports that pull request #${pullRequestNumber} conflicts with ${current.base || 'its base branch'} — resolve the conflict on GitHub, then merge`,
		);
	}

	// THE gate: an exact human approval for this PR at this commit, on every attempt.
	try {
		await checkApprovalForEffect(db, {
			actorId: verified.actorId,
			projectId: verified.projectId,
			action: intent.action,
			resourceId: intent.resourceId,
			revisionHash: intent.revisionHash,
			policyVersion: intent.policyVersion,
		});
	} catch (error) {
		if (error instanceof ScopeError) throw new MergeGateError(error, intent);
		throw error;
	}

	const origin = await getOperation(db, String(delivered[0]['operationKey']));
	await requireContentsWrite(client, installation.installationId, 'merge pull requests');
	const operation = await electOrAdoptOperation(db, {
		projectId: verified.projectId,
		runId: origin?.runId ?? `github-pull-request-${pullRequestNumber}`,
		provider: GITHUB_PROVIDER,
		operationKey,
	});
	if (operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'cancelled' || operation.status === 'cancel-requested') {
		throw new ScopeError(
			409,
			'operation_settled',
			`this merge already settled as ${operation.status}, but GitHub reports pull request #${pullRequestNumber} open — reconcile it on GitHub`,
		);
	}
	// From dispatched / reconciliation-required: GitHub just said the PR is open
	// and unmerged at the approved commit, and the merge is pinned to that
	// commit, so sending it again cannot merge twice.
	if (operation.status === 'prepared') {
		await markDispatched(db, operationKey, `pr:${pullRequestNumber}@${headSha}`);
	}

	const repo = await client.getRepo(installation.installationId, repoFullName);
	let outcome: GithubMergeOutcome;
	try {
		outcome = await client.mergePullRequest(installation.installationId, repoFullName, pullRequestNumber, {
			sha: headSha,
			method: pickMergeMethod(repo.mergeMethods),
		});
	} catch (error) {
		if (error instanceof GithubError && error.code === 'GITHUB_PROVIDER_ERROR') {
			// No clear answer: the merge may or may not have happened. Never retried blindly.
			await markReconciliationRequired(db, operationKey);
			throw new ScopeError(
				503,
				'merge_outcome_unknown',
				`GitHub did not answer clearly whether pull request #${pullRequestNumber} merged. Check again: Caddie reads the pull request before it tries anything else.`,
			);
		}
		throw error; // GitHub refused outright (auth, permissions, validation): nothing merged.
	}
	if (outcome.outcome === 'head-moved') {
		throw new ScopeError(
			409,
			'pull_request_head_moved',
			`pull request #${pullRequestNumber} changed after ${shortSha(headSha)} was approved (GitHub: ${outcome.message}) — review the new commit and approve again`,
		);
	}
	if (outcome.outcome === 'not-mergeable') {
		throw new ScopeError(
			409,
			'pull_request_not_mergeable',
			`GitHub would not merge pull request #${pullRequestNumber}: ${outcome.message}`,
		);
	}
	await recordReceipt(db, operationKey, {
		receiptId: `merge-pr:${outcome.sha}`,
		outcome: 'succeeded',
		remoteId: outcome.sha,
	});
	return { pullRequest: view(current, outcome.sha), reconciled: false };
}
