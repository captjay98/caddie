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
		return 'public';
	}
	// IPv6 unique-local fc00::/7 and link-local fe80::/10.
	if (/^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare)) return 'private';
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
