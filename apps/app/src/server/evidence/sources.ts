import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../auth.ts';
import { ScopeError, assertProjectScope } from '../scope.ts';
import { AUTHORITY_VALUES, isSourceAuthority } from './authority.ts';
import { deriveEvidenceId, sha256Hex } from './identity.ts';

/**
 * P10 evidence slice 1 — the source registry and immutable snapshots
 * (feature-ledger H1, adapted from the HackSteward reference domain/sources.py
 * + domain/evidence.py).
 *
 * Two rules carried over from the reference:
 *   1. Declared authority belongs to the SOURCE, not the snapshot's content —
 *      whether a page is binding rules or marketing is a property of what the
 *      organizer published it as, and cannot be inferred from the bytes.
 *   2. A snapshot is an immutable observation: content + sha256 + capturedAt.
 *      Re-capturing unchanged content returns the SAME snapshot (dedupe by
 *      content hash per source); changed content creates a NEW snapshot and
 *      history is retained. Placeholder snapshots — rows with no real content
 *      behind them, the audit-defect-#1 failure — are rejected here.
 *
 * Every service takes its Scope as a MANDATORY parameter and re-verifies it
 * against D1 at entry (P02 pattern). Every query leads with projectId.
 */

// --- row / record shapes -----------------------------------------------------

export type SourceKind = 'page' | 'document' | 'repository' | 'message' | 'other';
export const SOURCE_KINDS: readonly SourceKind[] = [
	'page',
	'document',
	'repository',
	'message',
	'other',
];

export type SnapshotProvenance = 'original' | 'processed';

export interface SourceRecord {
	readonly id: string;
	readonly projectId: string;
	readonly canonicalUrl: string;
	readonly kind: SourceKind;
	readonly authority: string;
	readonly displayName: string | null;
	readonly latestSnapshotId: string | null;
	readonly latestContentHash: string | null;
	readonly lastOutcome: string;
	readonly lastFailureReason: string | null;
	readonly observedAt: string | null;
	readonly attemptedAt: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface SnapshotRecord {
	readonly id: string;
	readonly projectId: string;
	readonly sourceId: string;
	readonly contentHash: string;
	readonly mediaType: string;
	readonly byteLength: number;
	readonly content: string;
	readonly originalUrl: string;
	readonly provenance: SnapshotProvenance;
	readonly renderer: string | null;
	readonly rendererRef: string | null;
	readonly capturedAt: string;
	readonly capturedBy: string;
}

// --- small helpers -----------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

function requireString(value: unknown, field: string, code = 'invalid_input'): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		fail(400, code, `${field} is required and must be a non-empty string`);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') fail(400, 'invalid_input', `${field} must be a string`);
	return value.trim().length === 0 ? null : value;
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

// --- URL canonicalization ------------------------------------------------------

export class UnsupportedSourceUrlError extends ScopeError {
	constructor(message: string) {
		super(400, 'unsupported_url', message);
		this.name = 'UnsupportedSourceUrlError';
	}
}

/** Query parameters that identify a marketing campaign rather than a document. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'utm_id',
	'gclid',
	'fbclid',
	'mc_cid',
	'mc_eid',
	'ref',
	'ref_src',
	'ref_content',
	'ref_feature',
	'ref_medium',
	'_gl',
	'_ga',
	'_gcl_au',
]);

/** GA4 emits one parameter per measurement container (_ga_<container>=...). */
const TRACKING_PARAM_PREFIXES: readonly string[] = ['_ga_'];

function isTrackingParam(name: string): boolean {
	const lowered = name.toLowerCase();
	return TRACKING_PARAMS.has(lowered) || TRACKING_PARAM_PREFIXES.some((p) => lowered.startsWith(p));
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

/**
 * Reduce a URL to a stable identity for deduplication (HackSteward
 * canonicalize_url): two URLs differing by scheme/host case, default port,
 * tracking parameters, query ordering, fragment, or trailing slash refer to
 * the same document and must produce the same canonical form — otherwise
 * re-importing a page from a tracked link creates a second source whose
 * snapshots then appear to contradict the first. Path case is preserved
 * (path segments are case-sensitive on most servers).
 */
export function canonicalizeUrl(raw: string): string {
	const candidate = raw.trim();
	if (!candidate) throw new UnsupportedSourceUrlError('Source URL must not be blank');
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new UnsupportedSourceUrlError('Source URL is not a valid absolute URL');
	}
	const scheme = url.protocol.toLowerCase();
	if (scheme !== 'http:' && scheme !== 'https:') {
		// file:, javascript:, data:, mailto:, ftp: … are not fetchable web
		// documents and must never become sources.
		throw new UnsupportedSourceUrlError(`Unsupported URL scheme: ${url.protocol.replace(/:$/, '') || '(none)'}`);
	}
	if (!url.hostname) throw new UnsupportedSourceUrlError('Source URL must include a host');
	if (url.username || url.password) {
		throw new UnsupportedSourceUrlError('Source URL must not embed credentials');
	}
	const host = url.hostname.toLowerCase();
	const defaultPort = DEFAULT_PORTS[scheme]!;
	const netloc = url.port && url.port !== defaultPort ? `${host}:${url.port}` : host;
	let path = url.pathname || '/';
	if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '') || '/';
	const params = new URLSearchParams(url.searchParams);
	for (const key of [...params.keys()]) {
		if (isTrackingParam(key)) params.delete(key);
	}
	params.sort();
	const query = params.toString();
	// The fragment is dropped: it never reaches the server.
	return query ? `${scheme}//${netloc}${path}?${query}` : `${scheme}//${netloc}${path}`;
}

/**
 * Private-network classification for the fetch policy (slice 3): loopback,
 * RFC1918, link-local, IPv6 loopback/unique-local/link-local, 0.0.0.0 and
 * localhost names are PRIVATE — production fetches refuse them.
 */
export type UrlHostClass = 'private' | 'public';

export function classifyUrlHost(hostname: string): UrlHostClass {
	const h = hostname.toLowerCase().replace(/\.$/, '');
	if (h === 'localhost' || h.endsWith('.localhost')) return 'private';
	const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
	if (bare === '::1' || bare === '::') return 'private';
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 0 || a === 10 || a === 127) return 'private';
		if (a === 169 && b === 254) return 'private'; // link-local 169.254.0.0/16
		if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
		if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
		if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT 100.64.0.0/10
		if (a === 198 && (b === 18 || b === 19)) return 'private'; // benchmark 198.18.0.0/15
		// IPv4-mapped IPv6 (::ffff:10.0.0.1) reaches here with a dotted tail —
		// the mapped address must be classified by its real v4 ranges.
		if (bare.toLowerCase().startsWith('::ffff:')) {
			return classifyUrlHost(bare.slice(7));
		}
		return 'public';
	}
	// IPv6 unique-local fc00::/7 and link-local fe80::/10.
	if (/^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare)) return 'private';
	// IPv4-mapped IPv6 in compressed or bracketed form.
	if (bare.toLowerCase().startsWith('::ffff:')) {
		return classifyUrlHost(bare.slice(7));
	}
	return 'public';
}

// --- row mapping ---------------------------------------------------------------

function sourceFromRow(row: Record<string, unknown>): SourceRecord {
	const kind = row['kind'];
	if (typeof kind !== 'string' || !SOURCE_KINDS.includes(kind as SourceKind)) {
		fail(500, 'invalid_row', `evidence source row carries an unknown kind: ${String(kind)}`);
	}
	const authority = row['authority'];
	if (!isSourceAuthority(authority)) {
		fail(500, 'invalid_row', `evidence source row carries an authority outside the shared vocabulary: ${String(authority)}`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		canonicalUrl: String(row['canonicalUrl']),
		kind: kind as SourceKind,
		authority,
		displayName: row['displayName'] == null ? null : String(row['displayName']),
		latestSnapshotId: row['latestSnapshotId'] == null ? null : String(row['latestSnapshotId']),
		latestContentHash: row['latestContentHash'] == null ? null : String(row['latestContentHash']),
		lastOutcome: String(row['lastOutcome']),
		lastFailureReason: row['lastFailureReason'] == null ? null : String(row['lastFailureReason']),
		observedAt: row['observedAt'] == null ? null : String(row['observedAt']),
		attemptedAt: row['attemptedAt'] == null ? null : String(row['attemptedAt']),
		createdAt: String(row['createdAt']),
		updatedAt: String(row['updatedAt']),
	};
}

function snapshotFromRow(row: Record<string, unknown>): SnapshotRecord {
	const provenance = row['provenance'];
	if (provenance !== 'original' && provenance !== 'processed') {
		fail(500, 'invalid_row', `snapshot row carries an unknown provenance: ${String(provenance)}`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		sourceId: String(row['sourceId']),
		contentHash: String(row['contentHash']),
		mediaType: String(row['mediaType']),
		byteLength: Number(row['byteLength']),
		content: String(row['content']),
		originalUrl: String(row['originalUrl'] ?? ''),
		provenance,
		renderer: row['renderer'] == null ? null : String(row['renderer']),
		rendererRef: row['rendererRef'] == null ? null : String(row['rendererRef']),
		capturedAt: String(row['capturedAt']),
		capturedBy: String(row['capturedBy']),
	};
}

const SNAPSHOT_COLUMNS =
	'"id", "projectId", "sourceId", "contentHash", "mediaType", "byteLength", "content", ' +
	'"originalUrl", "provenance", "renderer", "rendererRef", "capturedAt", "capturedBy"';

// --- source registry ------------------------------------------------------------

export interface SourceCreateInput {
	url: string;
	kind: SourceKind;
	authority: string;
	displayName?: string;
}

/**
 * Register (or return the already-registered) source for a canonical URL
 * within the scoped project. The canonical URL is the dedupe identity: a
 * tracked link to a page that is already registered returns the SAME source,
 * keeping its originally declared authority.
 */
export async function registerSource(
	db: D1Database,
	scope: Scope,
	input: SourceCreateInput,
): Promise<SourceRecord> {
	await assertProjectScope(db, scope);
	const canonicalUrl = canonicalizeUrl(requireString(input.url, 'url'));
	const kind = requireString(input.kind, 'kind');
	if (!SOURCE_KINDS.includes(kind as SourceKind)) {
		fail(400, 'invalid_input', `kind must be one of: ${SOURCE_KINDS.join(', ')}`);
	}
	const authority = requireString(input.authority, 'authority');
	if (!isSourceAuthority(authority)) {
		fail(
			400,
			'invalid_input',
			`authority must be one of the shared vocabulary: ${AUTHORITY_VALUES.join(', ')}`,
		);
	}
	const displayName = optionalString(input.displayName, 'displayName');
	const id = `src_${crypto.randomUUID()}`;
	const now = nowIso();
	await db
		.prepare(
			'insert or ignore into "evidence_sources" ' +
				'("id", "projectId", "canonicalUrl", "kind", "authority", "displayName", "createdAt", "updatedAt") ' +
				'values (?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(id, scope.projectId, canonicalUrl, kind, authority, displayName, now, now)
		.run();
	const rows = await queryAll(
		db,
		'select * from "evidence_sources" where "projectId" = ? and "canonicalUrl" = ?',
		scope.projectId,
		canonicalUrl,
	);
	return sourceFromRow(rows[0]!);
}

/** Fetch one project-scoped source, or throw 404. */
export async function getSource(
	db: D1Database,
	scope: Scope,
	sourceId: string,
): Promise<SourceRecord> {
	await assertProjectScope(db, scope);
	if (typeof sourceId !== 'string' || sourceId.length === 0) {
		fail(400, 'invalid_request', 'sourceId is required');
	}
	const rows = await queryAll(
		db,
		'select * from "evidence_sources" where "id" = ? and "projectId" = ?',
		sourceId,
		scope.projectId,
	);
	if (!rows[0]) fail(404, 'source_not_found', 'no such evidence source in this project');
	return sourceFromRow(rows[0]!);
}

/** List the project's sources, newest registration first. */
export async function listSources(db: D1Database, scope: Scope): Promise<SourceRecord[]> {
	await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "evidence_sources" where "projectId" = ? order by "createdAt" desc, "id" asc',
		scope.projectId,
	);
	return rows.map(sourceFromRow);
}

export interface SourceUpdateInput {
	authority?: string;
	displayName?: string | null;
}

/**
 * Correct a source's declared authority or display name. Authority is a
 * property of how the source was PUBLISHED; correcting it is an owner action
 * and never rewrites existing snapshots (they carry no authority of their
 * own) — reconciliation reads authority through the source at read time.
 */
export async function updateSource(
	db: D1Database,
	scope: Scope,
	sourceId: string,
	patch: SourceUpdateInput,
): Promise<SourceRecord> {
	const current = await getSource(db, scope, sourceId);
	const updates: string[] = [];
	const params: unknown[] = [];
	if (patch.authority !== undefined) {
		if (!isSourceAuthority(patch.authority)) {
			fail(
				400,
				'invalid_input',
				`authority must be one of the shared vocabulary: ${AUTHORITY_VALUES.join(', ')}`,
			);
		}
		updates.push('"authority" = ?');
		params.push(patch.authority);
	}
	if (patch.displayName !== undefined) {
		updates.push('"displayName" = ?');
		params.push(optionalString(patch.displayName, 'displayName'));
	}
	if (updates.length > 0) {
		updates.push('"updatedAt" = ?');
		params.push(nowIso(), current.id);
		await db
			.prepare(`update "evidence_sources" set ${updates.join(', ')} where "id" = ?`)
			.bind(...params)
			.run();
	}
	return getSource(db, scope, sourceId);
}

// --- immutable snapshots ----------------------------------------------------------

export interface SnapshotCaptureInput {
	content: string;
	mediaType: string;
	originalUrl?: string;
	provenance?: SnapshotProvenance;
	renderer?: string;
	rendererRef?: string;
}

export interface CaptureResult {
	snapshot: SnapshotRecord;
	outcome: 'created' | 'unchanged';
}

export function baseMediaType(mediaType: string): string {
	return mediaType.split(';', 1)[0]!.trim().toLowerCase();
}

/**
 * Archive an immutable snapshot of a source's content.
 *
 * The snapshot id is DETERMINISTIC — derived from (project, source, content
 * hash) — so re-capturing unchanged content returns the SAME snapshot with
 * its original capturedAt (outcome 'unchanged'), and changed content lands on
 * a new snapshot while history is retained. Empty/whitespace content is a
 * placeholder, not an observation, and is rejected: a claim must never point
 * at a marker row that has no real fetched content behind it (audit defect
 * #1). The content hash is computed from the actual bytes here — callers
 * cannot supply one.
 */
export async function captureSnapshot(
	db: D1Database,
	scope: Scope,
	sourceId: string,
	input: SnapshotCaptureInput,
): Promise<CaptureResult> {
	const source = await getSource(db, scope, sourceId);
	if (typeof input.content !== 'string' || input.content.trim().length === 0) {
		// A snapshot must have real content + a real hash; placeholders are how
		// "claims pointing at nothing" entered the carryover system.
		fail(400, 'snapshot_content_required', 'snapshot content must not be empty or blank');
	}
	const mediaType = baseMediaType(requireString(input.mediaType, 'mediaType'));
	if (mediaType.length === 0) fail(400, 'invalid_input', 'mediaType is required');
	const provenance = input.provenance === undefined ? 'original' : input.provenance;
	if (provenance !== 'original' && provenance !== 'processed') {
		fail(400, 'invalid_input', 'provenance must be "original" or "processed"');
	}
	const renderer = optionalString(input.renderer, 'renderer');
	const rendererRef = optionalString(input.rendererRef, 'rendererRef');
	if (provenance === 'processed' && !renderer) {
		fail(400, 'invalid_input', 'a processed snapshot must name the renderer that produced it');
	}
	if (rendererRef && !renderer) {
		fail(400, 'invalid_input', 'rendererRef requires renderer');
	}
	const contentHash = await sha256Hex(input.content);
	const byteLength = new TextEncoder().encode(input.content).byteLength;
	const id = await deriveEvidenceId('snap', scope.projectId, source.id, contentHash);
	const now = nowIso();
	await db
		.prepare(
			'insert or ignore into "evidence_snapshots" ' +
				`(${SNAPSHOT_COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			scope.projectId,
			source.id,
			contentHash,
			mediaType,
			byteLength,
			input.content,
			input.originalUrl ?? '',
			provenance,
			renderer,
			rendererRef,
			now,
			scope.actorId,
		)
		.run();
	const rows = await queryAll(
		db,
		`select ${SNAPSHOT_COLUMNS} from "evidence_snapshots" where "id" = ? and "projectId" = ?`,
		id,
		scope.projectId,
	);
	const snapshot = snapshotFromRow(rows[0]!);
	const outcome: CaptureResult['outcome'] = snapshot.capturedAt === now ? 'created' : 'unchanged';
	// Refresh the source's freshness state: an unchanged page was still
	// successfully observed (HackSteward record_success), and the outcome
	// distinguishes "saw new content" from "saw the same content".
	const lastOutcome =
		source.latestContentHash === contentHash ? 'unchanged' : outcome === 'created' ? 'succeeded' : 'unchanged';
	await db
		.prepare(
			'update "evidence_sources" set "latestSnapshotId" = ?, "latestContentHash" = ?, ' +
				'"lastOutcome" = ?, "lastFailureReason" = null, "observedAt" = ?, "attemptedAt" = ?, "updatedAt" = ? ' +
				'where "id" = ? and "projectId" = ?',
		)
		.bind(snapshot.id, contentHash, lastOutcome, now, now, now, source.id, scope.projectId)
		.run();
	return { snapshot, outcome };
}

/** Snapshot history for a source, newest observation first. */
export async function listSnapshots(
	db: D1Database,
	scope: Scope,
	sourceId: string,
): Promise<SnapshotRecord[]> {
	await getSource(db, scope, sourceId); // 404 outside the project
	const rows = await queryAll(
		db,
		`select ${SNAPSHOT_COLUMNS} from "evidence_snapshots" where "sourceId" = ? and "projectId" = ? ` +
			'order by "capturedAt" desc, "id" asc',
		sourceId,
		scope.projectId,
	);
	return rows.map(snapshotFromRow);
}

/** One project-scoped snapshot, or 404. Claims attach ONLY through this. */
export async function getSnapshot(
	db: D1Database,
	scope: Scope,
	snapshotId: string,
): Promise<SnapshotRecord> {
	await assertProjectScope(db, scope);
	if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
		fail(400, 'invalid_request', 'snapshotId is required');
	}
	const rows = await queryAll(
		db,
		`select ${SNAPSHOT_COLUMNS} from "evidence_snapshots" where "id" = ? and "projectId" = ?`,
		snapshotId,
		scope.projectId,
	);
	if (!rows[0]) fail(404, 'snapshot_not_found', 'no such evidence snapshot in this project');
	return snapshotFromRow(rows[0]!);
}

// --- freshness bookkeeping (HackSteward rule: a failed fetch never advances it) ----

/**
 * Record a failed/blocked fetch attempt WITHOUT advancing freshness: the
 * prior snapshot and observedAt are deliberately preserved — the evidence we
 * already hold is still the newest we have, and it must remain visibly stale
 * rather than appearing re-verified. Success outcomes are rejected here (they
 * have their own path through {@link captureSnapshot}).
 */
export async function recordFetchFailure(
	db: D1Database,
	scope: Scope,
	sourceId: string,
	outcome: 'failed' | 'blocked',
	reason: string,
): Promise<SourceRecord> {
	if (outcome !== 'failed' && outcome !== 'blocked') {
		fail(400, 'invalid_input', 'outcome must be "failed" or "blocked"');
	}
	if (typeof reason !== 'string' || reason.trim().length === 0) {
		fail(400, 'invalid_input', 'a failure reason is required');
	}
	const source = await getSource(db, scope, sourceId);
	const now = nowIso();
	await db
		.prepare(
			'update "evidence_sources" set "lastOutcome" = ?, "lastFailureReason" = ?, ' +
				'"attemptedAt" = ?, "updatedAt" = ? where "id" = ? and "projectId" = ?',
		)
		.bind(outcome, reason, now, now, source.id, scope.projectId)
		.run();
	return getSource(db, scope, sourceId);
}

// --- fetch policy (slice 3) ------------------------------------------------------

export type FetchPolicyNetworkMode = 'loopback-stub' | 'owner-authorized';

export interface FetchPolicyEnv {
	CADDIE_LIVE_AUTHORIZED?: string;
}

export interface FetchPolicyOptions {
	/** Response size bound in bytes. Default 2 MiB. */
	maxBytes?: number;
	/** Redirect hop bound. Default 3. */
	maxRedirects?: number;
	/**
	 * 'owner-authorized' (default): private-network hosts are refused
	 * outright; public hosts require CADDIE_LIVE_AUTHORIZED=1 in the provided
	 * env. 'loopback-stub': the inverse — ONLY private (loopback) hosts may be
	 * fetched (the local stub-server escape used by tests), external hosts are
	 * refused. Both directions fail closed.
	 */
	network?: FetchPolicyNetworkMode;
	allowedMediaTypes?: readonly string[];
	env?: FetchPolicyEnv;
}

export interface FetchPolicyResult {
	finalUrl: string;
	status: number;
	mediaType: string;
	byteLength: number;
	content: string;
}

/**
 * Document media types the evidence pipeline can quote from. PDFs are
 * deliberately absent: they need a renderer pass to produce quotable text
 * (the HackSteward page-renderer step) and are not fetched raw.
 */
export const DEFAULT_ALLOWED_MEDIA_TYPES: readonly string[] = [
	'text/html',
	'text/plain',
	'text/markdown',
	'application/json',
];

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * The ALLOWED-URL gate applied BEFORE every request (and before every
 * redirect hop): scheme allowlist (http/https) plus the network-mode gate.
 */
export function assertFetchableUrl(raw: string): URL {
	const candidate = raw.trim();
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new UnsupportedSourceUrlError('fetch target is not a valid absolute URL');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new UnsupportedSourceUrlError(
			`unsupported fetch scheme: ${url.protocol.replace(/:$/, '') || '(none)'} — only http/https`,
		);
	}
	return url;
}

/**
 * Fetch a URL through the ALLOWED-URL policy. Real network egress from this
 * function is possible ONLY in 'loopback-stub' mode AND only to
 * private-network hosts (the local stub server); every external fetch is
 * BLOCKED unless the caller explicitly carries owner authorization
 * (CADDIE_LIVE_AUTHORIZED=1) — and even then private networks stay refused.
 * Redirects are followed only when each hop re-passes the policy AND stays
 * on the original origin. Response size and media type are bounded.
 */
export async function fetchWithPolicy(
	rawUrl: string,
	options: FetchPolicyOptions = {},
): Promise<FetchPolicyResult> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const network: FetchPolicyNetworkMode = options.network ?? 'owner-authorized';
	const allowedMediaTypes = options.allowedMediaTypes ?? DEFAULT_ALLOWED_MEDIA_TYPES;
	const env = options.env ?? (globalThis.process?.env as FetchPolicyEnv | undefined) ?? {};

	let current = assertFetchableUrl(rawUrl);
	const originalOrigin = current.origin;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		// Network gate, re-applied per hop (redirects cannot smuggle a hop in).
		const hostClass = classifyUrlHost(current.hostname);
		if (network === 'owner-authorized') {
			if (hostClass === 'private') {
				fail(
					400,
					'blocked_private_network',
					`refusing to fetch private-network host ${current.hostname} (loopback/RFC1918/link-local are never fetched)`,
				);
			}
			if (env.CADDIE_LIVE_AUTHORIZED !== '1') {
				fail(
					403,
					'blocked_external_without_authorization',
					'external fetches are BLOCKED without explicit owner authorization (CADDIE_LIVE_AUTHORIZED=1)',
				);
			}
		} else {
			if (hostClass === 'public') {
				fail(
					403,
					'blocked_external_without_authorization',
					'loopback-stub mode fetches ONLY the local stub server; external fetch is blocked without owner authorization',
				);
			}
		}

		const response = await fetch(current, { redirect: 'manual' });
		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get('location');
			if (!location) {
				fail(400, 'redirect_without_location', `redirect ${response.status} without a location`);
			}
			const next = new URL(location, current);
			assertFetchableUrl(next.toString());
			if (next.origin !== originalOrigin) {
				fail(
					400,
					'redirect_cross_origin',
					`redirect leaves the original origin (${originalOrigin} -> ${next.origin}); cross-origin redirects are not followed`,
				);
			}
			current = next;
			continue;
		}
		const mediaType = baseMediaType(response.headers.get('content-type') ?? '');
		if (!allowedMediaTypes.includes(mediaType)) {
			fail(
				400,
				'unsupported_media_type',
				`media type ${mediaType || '(none)'} is not an accepted evidence media type (allowed: ${allowedMediaTypes.join(', ')})`,
			);
		}
		const declaredLength = response.headers.get('content-length');
		if (declaredLength !== null && Number(declaredLength) > maxBytes) {
			fail(400, 'response_too_large', `declared response size ${declaredLength} exceeds the ${maxBytes}-byte bound`);
		}
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength > maxBytes) {
			fail(400, 'response_too_large', `response size ${buffer.byteLength} exceeds the ${maxBytes}-byte bound`);
		}
		return {
			finalUrl: current.toString(),
			status: response.status,
			mediaType,
			byteLength: buffer.byteLength,
			content: new TextDecoder().decode(buffer),
		};
	}
	fail(400, 'too_many_redirects', `more than ${maxRedirects} redirects`);
}

export interface CaptureFromUrlInput {
	url: string;
	maxBytes?: number;
}

export interface CaptureFromUrlOptions {
	network?: FetchPolicyNetworkMode;
	env?: FetchPolicyEnv;
}

/**
 * Fetch a source's own canonical URL through the fetch policy and archive the
 * response as a snapshot. The fetch target must BE the registered source
 * document (canonical-URL match) — the registry defines what may be fetched,
 * and arbitrary URLs cannot ride an evidence route. Transport failures are
 * recorded via {@link recordFetchFailure} and never advance freshness.
 */
export async function captureFromUrl(
	db: D1Database,
	scope: Scope,
	sourceId: string,
	input: CaptureFromUrlInput,
	options: CaptureFromUrlOptions = {},
): Promise<CaptureResult> {
	const source = await getSource(db, scope, sourceId);
	const targetUrl = requireString(input.url, 'url');
	if (canonicalizeUrl(targetUrl) !== source.canonicalUrl) {
		fail(
			400,
			'url_mismatch',
			'the fetch target must be the registered source URL (canonical form)',
		);
	}
	let result: FetchPolicyResult;
	try {
		result = await fetchWithPolicy(targetUrl, {
			network: options.network,
			maxBytes: input.maxBytes,
			env: options.env,
		});
	} catch (error) {
		// Policy refusals happen BEFORE any request; record them as blocked.
		const code = (error as { code?: string }).code;
		if (code === 'blocked_private_network' || code === 'blocked_external_without_authorization') {
			await recordFetchFailure(db, scope, sourceId, 'blocked', String((error as Error).message)).catch(
				() => undefined,
			);
		}
		throw error;
	}
	if (result.status !== 200) {
		await recordFetchFailure(db, scope, sourceId, 'failed', `fetch returned status ${result.status}`);
		fail(502, 'fetch_failed', `source fetch returned status ${result.status}`);
	}
	try {
		return await captureSnapshot(db, scope, sourceId, {
			content: result.content,
			mediaType: result.mediaType,
			originalUrl: result.finalUrl,
		});
	} catch (error) {
		await recordFetchFailure(db, scope, sourceId, 'failed', `snapshot capture failed: ${String(error)}`).catch(
			() => undefined,
		);
		throw error;
	}
}
