import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { artifactFromRow, getArtifact, type ArtifactRecord } from './artifacts.ts';

/**
 * P07 slice 2 — the private preview gateway (packets.md P07 slice 3: token
 * expiry/revoke/share on the managed preview path; acceptance: token-only
 * auth so a separate isolated origin can serve previews, and generated
 * content can never read Caddie cookies — enforced with `CSP: sandbox` at
 * the route layer).
 *
 * Authority model:
 *   - MANAGEMENT (create / list / revoke / extend) is project-scoped: the
 *     Scope is mandatory and re-verified against D1 at entry
 *     ({@link assertProjectScope}); the creator is the session-derived actor.
 *   - RESOLUTION is TOKEN-ONLY. The secret is 32 random bytes base64url
 *     (43 chars), shown exactly once at creation and NEVER stored — only its
 *     hex SHA-256 (`tokenHash`, unique) is persisted. Resolution reads no
 *     session, no cookie, no header credential: a valid unexpired
 *     un-revoked token serves the bound revision's bytes; an unknown or
 *     malformed token is a bare 404 (existence is never confirmed); an
 *     expired or revoked token is 410 Gone with the reason.
 *   - EVERY resolve attempt appends a `preview_access_log` row. Unknown
 *     secrets are logged as a NON-reversible hash prefix, never the secret.
 *
 * Every management query leads with projectId (audit defect #2 class). Rows
 * are never deleted: revocation sets revokedAt, expiry compares ISO stamps.
 */

export const DEFAULT_PREVIEW_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const MAX_PREVIEW_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface PreviewRecord {
	readonly id: string;
	readonly projectId: string;
	readonly revisionId: string;
	readonly expiresAt: string;
	readonly revoked: boolean;
	readonly createdBy: string;
	readonly createdAt: string;
}

export type PreviewOutcome = 'served' | 'denied' | 'gone';

export type PreviewResolution =
	| { readonly outcome: 'served'; readonly preview: PreviewRecord; readonly revision: ArtifactRecord; readonly bytes: Uint8Array }
	| { readonly outcome: 'gone'; readonly reason: 'expired' | 'revoked' }
	| { readonly outcome: 'denied' };

// --- small helpers ------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The preview secret: 32 random bytes, base64url — 43 URL-safe characters.
 * The full secret is the credential AND the URL segment; it is returned to
 * the creator exactly once and only its hash ever touches storage.
 */
export function generatePreviewToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Strict token shape: exactly the 43 base64url characters of 32 bytes. */
export function isValidPreviewToken(token: unknown): token is string {
	return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

function previewFromRow(row: Record<string, unknown>): PreviewRecord {
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		revisionId: String(row['revisionId']),
		expiresAt: String(row['expiresAt']),
		revoked: row['revokedAt'] != null,
		createdBy: String(row['createdBy']),
		createdAt: String(row['createdAt']),
	};
}

const PREVIEW_COLUMNS =
	'"id", "projectId", "revisionId", "expiresAt", "revokedAt", "createdBy", "createdAt"';

function requireTtl(value: unknown, field = 'ttlSeconds'): number {
	if (value === undefined || value === null) return DEFAULT_PREVIEW_TTL_SECONDS;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PREVIEW_TTL_SECONDS) {
		fail(400, 'invalid_input', `${field} must be an integer between 1 and ${MAX_PREVIEW_TTL_SECONDS}`);
	}
	return value;
}

// --- management (session-scoped) -------------------------------------------------

export interface PreviewCreateInput {
	revisionId: unknown;
	ttlSeconds?: unknown;
}

/**
 * Mint a preview token for ONE artifact revision of the scoped project. The
 * revision must exist in THIS project (404 otherwise) — tokens cannot be
 * aimed across projects. The secret travels back exactly once, here.
 */
export async function createPreview(
	db: D1Database,
	scope: Scope,
	input: PreviewCreateInput,
): Promise<{ preview: PreviewRecord; token: string }> {
	const verified = await assertProjectScope(db, scope);
	const revisionId = input.revisionId;
	if (typeof revisionId !== 'string' || revisionId.length === 0) {
		fail(400, 'invalid_request', 'revisionId is required');
	}
	// scope-checked 404 for foreign/unknown revisions
	await getArtifact(db, verified, revisionId);
	const ttl = requireTtl(input.ttlSeconds);
	const token = generatePreviewToken();
	const record: PreviewRecord = {
		id: newId('pvw'),
		projectId: verified.projectId,
		revisionId,
		expiresAt: new Date(Date.parse(nowIso()) + ttl * 1000).toISOString(),
		revoked: false,
		createdBy: verified.actorId,
		createdAt: nowIso(),
	};
	await db
		.prepare(
			'insert into "preview_tokens" ("id","projectId","revisionId","tokenHash","createdBy","expiresAt","revokedAt","createdAt") values (?,?,?,?,?,?,null,?)',
		)
		.bind(
			record.id,
			record.projectId,
			record.revisionId,
			await sha256Hex(token),
			record.createdBy,
			record.expiresAt,
			record.createdAt,
		)
		.run();
	return { preview: record, token };
}

/** List the scoped project's preview tokens — metadata only, never secrets. */
export async function listPreviews(db: D1Database, scope: Scope): Promise<PreviewRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		`select ${PREVIEW_COLUMNS} from "preview_tokens" where "projectId" = ? order by "createdAt" desc, "rowid" desc`,
		verified.projectId,
	);
	return rows.map(previewFromRow);
}

async function previewRow(db: D1Database, scope: Scope, previewId: string): Promise<PreviewRecord> {
	if (typeof previewId !== 'string' || previewId.length === 0) {
		fail(400, 'invalid_request', 'previewId is required');
	}
	const rows = await queryAll(
		db,
		`select ${PREVIEW_COLUMNS} from "preview_tokens" where "id" = ? and "projectId" = ?`,
		previewId,
		scope.projectId,
	);
	if (!rows[0]) fail(404, 'preview_not_found', 'no such preview in this project');
	return previewFromRow(rows[0]!);
}

/**
 * Revoke (share-off). Only a live token can be revoked; a second revoke is a
 * typed 409. Revocation wins over extension and expiry is checked at
 * resolve time — the row is kept for the audit story.
 */
export async function revokePreview(
	db: D1Database,
	scope: Scope,
	previewId: string,
): Promise<PreviewRecord> {
	const verified = await assertProjectScope(db, scope);
	const existing = await previewRow(db, verified, previewId);
	if (existing.revoked) fail(409, 'preview_not_revocable', 'the preview is already revoked');
	const res = (await db
		.prepare('update "preview_tokens" set "revokedAt" = ? where "id" = ? and "revokedAt" is null')
		.bind(nowIso(), previewId)
		.run()) as { meta?: { changes?: number } };
	if ((res.meta?.changes ?? 0) === 0) {
		fail(409, 'preview_not_revocable', 'the preview is already revoked');
	}
	return previewRow(db, verified, previewId);
}

/**
 * Extend the window from NOW (an explicit owner action; it can revive an
 * expired token but never a revoked one — that is a typed 409). The secret
 * is never part of any management response.
 */
export async function extendPreview(
	db: D1Database,
	scope: Scope,
	previewId: string,
	ttlSeconds: unknown,
): Promise<PreviewRecord> {
	const verified = await assertProjectScope(db, scope);
	const existing = await previewRow(db, verified, previewId);
	if (existing.revoked) fail(409, 'preview_revoked', 'a revoked preview cannot be extended');
	const ttl = requireTtl(ttlSeconds);
	await db
		.prepare('update "preview_tokens" set "expiresAt" = ? where "id" = ?')
		.bind(new Date(Date.parse(nowIso()) + ttl * 1000).toISOString(), previewId)
		.run();
	return previewRow(db, verified, previewId);
}

// --- resolution (token-only, public) ------------------------------------------------

/**
 * Resolve a presented token WITHOUT any session context. Order matters and
 * is part of the contract:
 *   1. malformed or unknown secret  -> 'denied'   (route maps to a bare 404)
 *   2. revoked                      -> 'gone'/'revoked' (route maps to 410)
 *   3. expired                      -> 'gone'/'expired'  (route maps to 410)
 *   4. otherwise the bound revision's bytes are served ('served').
 */
export async function resolvePreview(
	db: D1Database,
	token: unknown,
	opts: { now?: string } = {},
): Promise<PreviewResolution> {
	if (!isValidPreviewToken(token)) return { outcome: 'denied' };
	const tokenHash = await sha256Hex(token);
	const rows = await queryAll(
		db,
		`select ${PREVIEW_COLUMNS} from "preview_tokens" where "tokenHash" = ?`,
		tokenHash,
	);
	const row = rows[0];
	if (!row) return { outcome: 'denied' };
	const preview = previewFromRow(row);
	if (preview.revoked) return { outcome: 'gone', reason: 'revoked' };
	const now = opts.now ?? nowIso();
	if (now > preview.expiresAt) return { outcome: 'gone', reason: 'expired' };
	// the revision is read strictly under the token's OWN stored project — the
	// token row is the only authority here, no caller-supplied identity exists
	const revisionRows = await queryAll(
		db,
		'select * from "project_artifacts" where "id" = ? and "projectId" = ?',
		preview.revisionId,
		preview.projectId,
	);
	if (!revisionRows[0]) return { outcome: 'denied' };
	const revision = artifactFromRow(revisionRows[0]!);
	const bytesRows = await queryAll(
		db,
		'select "bytes" from "artifact_content" where "contentHash" = ?',
		revision.sha256,
	);
	const bytes = toBytes((bytesRows[0] as { bytes?: unknown } | undefined)?.bytes);
	if (!bytes) return { outcome: 'denied' };
	return { outcome: 'served', preview, revision, bytes };
}

function toBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (Array.isArray(value)) return Uint8Array.from(value as number[]);
	return null;
}

// --- access log ---------------------------------------------------------------------

export interface PreviewAccessEntry {
	/** The preview row id when known; a non-reversible marker otherwise. */
	tokenId: string;
	projectId?: string | null;
	path: string;
	outcome: PreviewOutcome;
}

const UNKNOWN_TOKEN_PREFIX = 'unknown:';

/** A non-reversible log marker for an unknown/malformed secret (never the secret). */
export async function unknownTokenMarker(token: unknown): Promise<string> {
	if (!isValidPreviewToken(token)) return 'malformed';
	return `${UNKNOWN_TOKEN_PREFIX}${(await sha256Hex(token)).slice(0, 16)}`;
}

/** Append one audit row for a resolve attempt. Append-only; never throws routes. */
export async function logPreviewAccess(db: D1Database, entry: PreviewAccessEntry): Promise<void> {
	await db
		.prepare(
			'insert into "preview_access_log" ("id","tokenId","projectId","path","outcome","at") values (?,?,?,?,?,?)',
		)
		.bind(newId('pva'), entry.tokenId, entry.projectId ?? null, entry.path, entry.outcome, nowIso())
		.run();
}
