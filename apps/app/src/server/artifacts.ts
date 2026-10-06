import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError, assertProjectScope } from './scope.ts';

/**
 * P07 slice 1 — content-addressed artifact storage and immutable artifact
 * revisions (feature-ledger C13: versioned plan/scope/spec/design revisions
 * with diff, export and approval-invalidation support).
 *
 * Architecture:
 *   - A storage PORT ({@link ArtifactContentStore}: put/get/delete keyed by
 *     content hash) with the SQLite blob table `artifact_content` as the
 *     LOCAL DEFAULT implementation ({@link createD1ContentStore}). R2 is the
 *     proposed production binding — documented in docs/setup/previews.md,
 *     deliberately NOT wired here: an R2 adapter implements the same port and
 *     callers never change.
 *   - Immutable revision rows (`project_artifacts`): projectId, kind, the
 *     plan revision the artifact derives from, sha256, size, contentType,
 *     filename, createdBy, createdAt. Rows are written once; the ONLY mutable
 *     column is `status` ({@link markStaleForPlan} flips 'current' -> 'stale'
 *     for artifacts derived from older plan revisions — never a delete, so
 *     the last green revision stays inspectable after a failed repair).
 *   - Content is deduped by SHA-256: storing the same bytes twice lands on
 *     the same content row (mirrors the P10 snapshot pattern).
 *
 * Authorization model (P02 pattern): every user-facing service takes its
 * Scope as a MANDATORY parameter and re-verifies it against D1 at entry
 * ({@link assertProjectScope}). {@link markStaleForPlan} is a SYSTEM hook
 * (called when a new plan revision lands) and takes the projectId directly —
 * it performs no actor authorization because no actor is involved; it never
 * reads or returns content.
 *
 * Every query leads with projectId (audit defect #2 class).
 */

/** ~5 MiB per artifact in the local store; the DDL CHECK enforces the same. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export const ARTIFACT_KINDS = ['plan', 'test-result', 'browser-capture', 'diff'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ArtifactStatus = 'current' | 'stale';

export interface ArtifactRecord {
	readonly id: string;
	readonly projectId: string;
	readonly kind: ArtifactKind;
	readonly planRevision: number;
	/** Hex SHA-256 of the content; the key into the content store. */
	readonly sha256: string;
	readonly size: number;
	readonly contentType: string;
	readonly filename: string;
	readonly status: ArtifactStatus;
	readonly createdBy: string;
	readonly createdAt: string;
}

// --- storage port -------------------------------------------------------------

export interface ArtifactContentPutResult {
	readonly contentHash: string;
	readonly size: number;
	/** True when the bytes already existed (dedupe — no second row written). */
	readonly deduped: boolean;
}

/**
 * The artifact content-store port. Implementations: the local D1/SQLite blob
 * table (default, below) and — proposed, not wired — an R2 bucket adapter
 * (docs/setup/previews.md).
 */
export interface ArtifactContentStore {
	put(bytes: Uint8Array): Promise<ArtifactContentPutResult>;
	get(contentHash: string): Promise<Uint8Array | null>;
	/**
	 * Delete one content blob. Garbage collection only: callers MUST have
	 * proven no revision references the hash. Returns true when a row went.
	 */
	delete(contentHash: string): Promise<boolean>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function asBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	// wrangler's local D1 hands BLOB columns back as plain number arrays in
	// some runtimes (and as Uint8Array/ArrayBuffer in others) — accept all.
	if (Array.isArray(value)) return Uint8Array.from(value as number[]);
	if (typeof value === 'string') return new TextEncoder().encode(value);
	return null;
}

/**
 * Local default store: the `artifact_content` table (contentHash PK, bytes
 * BLOB, size CHECK-capped). Content rows are write-once; identical payloads
 * dedupe onto the existing row via insert-or-ignore semantics.
 */
export function createD1ContentStore(db: D1Database): ArtifactContentStore {
	return {
		async put(bytes: Uint8Array): Promise<ArtifactContentPutResult> {
			const contentHash = await sha256Hex(bytes);
			const existing = await db
				.prepare('select "contentHash" from "artifact_content" where "contentHash" = ?')
				.bind(contentHash)
				.all();
			if ((existing.results ?? []).length > 0) {
				return { contentHash, size: bytes.byteLength, deduped: true };
			}
			await db
				.prepare(
					'insert into "artifact_content" ("contentHash","bytes","size","createdAt") values (?,?,?,?)',
				)
				.bind(contentHash, bytes, bytes.byteLength, new Date().toISOString())
				.run();
			return { contentHash, size: bytes.byteLength, deduped: false };
		},
		async get(contentHash: string): Promise<Uint8Array | null> {
			const rows = await db
				.prepare('select "bytes" from "artifact_content" where "contentHash" = ?')
				.bind(contentHash)
				.all();
			const row = (rows.results ?? [])[0] as { bytes?: unknown } | undefined;
			if (!row) return null;
			return asBytes(row.bytes);
		},
		async delete(contentHash: string): Promise<boolean> {
			const res = (await db
				.prepare('delete from "artifact_content" where "contentHash" = ?')
				.bind(contentHash)
				.run()) as { meta?: { changes?: number } };
			return (res.meta?.changes ?? 0) > 0;
		},
	};
}

// --- small helpers ------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
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

/**
 * Sanitize an untrusted filename for the Content-Disposition header: basename
 * only (path separators dropped), characters reduced to a safe set (control
 * chars, quotes and angle brackets cannot survive), leading dots removed, and
 * a fixed fallback. The same sanitized form is STORED at creation, so stored
 * rows and export headers can never disagree.
 */
export function sanitizeFilename(raw: unknown): string {
	let name = typeof raw === 'string' ? raw : '';
	name = name.replaceAll('\\', '/').split('/').pop() ?? '';
	name = name.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim();
	if (name.length === 0) name = 'artifact.bin';
	if (name.length > 80) name = name.slice(name.length - 80).replace(/^\.+/, '');
	return name.length > 0 ? name : 'artifact.bin';
}

export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
	return `${kind}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Headers every artifact/preview content response carries (sandbox class). */
export function sandboxHeaders(contentType: string, bytes: Uint8Array): Record<string, string> {
	return {
		'content-type': contentType,
		'content-length': String(bytes.byteLength),
		// Generated/previewed content must never touch this origin's storage,
		// cookies or credentials: 'sandbox' gives it a unique opaque origin.
		'content-security-policy': 'sandbox',
		// Never sniff an executable type out of artifact bytes.
		'x-content-type-options': 'nosniff',
	};
}

/** Strict boundary parse: DB row -> ArtifactRecord (throws typed on bad rows). */
export function artifactFromRow(row: Record<string, unknown>): ArtifactRecord {
	const kind = row['kind'];
	if (typeof kind !== 'string' || !ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
		fail(500, 'invalid_row', `artifact row carries an unknown kind: ${String(kind)}`);
	}
	const status = row['status'];
	if (status !== 'current' && status !== 'stale') {
		fail(500, 'invalid_row', `artifact row carries an unknown status: ${String(status)}`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		kind: kind as ArtifactKind,
		planRevision: Number(row['planRevision']),
		sha256: String(row['sha256']),
		size: Number(row['size']),
		contentType: String(row['contentType']),
		filename: String(row['filename']),
		status,
		createdBy: String(row['createdBy']),
		createdAt: String(row['createdAt']),
	};
}

const ARTIFACT_COLUMNS =
	'"id", "projectId", "kind", "planRevision", "sha256", "size", "contentType", ' +
	'"filename", "status", "createdBy", "createdAt"';

// --- write path -----------------------------------------------------------------

export interface ArtifactStoreInput {
	kind: unknown;
	planRevision: unknown;
	contentType: unknown;
	filename: unknown;
	contentBase64: unknown;
}

function base64ToBytes(value: unknown): Uint8Array {
	if (typeof value !== 'string' || value.trim().length === 0) {
		fail(400, 'invalid_input', 'contentBase64 is required');
	}
	let decoded: string;
	try {
		decoded = atob(value);
	} catch {
		fail(400, 'invalid_input', 'contentBase64 must be valid base64');
	}
	const bytes = new Uint8Array(decoded.length);
	for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
	return bytes;
}

function requirePlanRevision(value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		fail(400, 'invalid_input', 'planRevision must be a positive integer');
	}
	return value;
}

function requireContentType(value: unknown): string {
	if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
		fail(400, 'invalid_input', 'contentType is required (a media type string)');
	}
	return value.trim();
}

/**
 * Store artifact content and append ONE immutable revision record. The hash
 * is computed from the actual decoded bytes here — a caller can never supply
 * (or lie about) one. Identical bytes dedupe onto the same content row while
 * still producing a new, independently addressable revision.
 */
export async function storeArtifact(
	db: D1Database,
	scope: Scope,
	input: ArtifactStoreInput,
): Promise<ArtifactRecord> {
	const verified = await assertProjectScope(db, scope);
	const kind = input.kind;
	if (typeof kind !== 'string' || !ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
		fail(400, 'invalid_input', `kind must be one of: ${ARTIFACT_KINDS.join(', ')}`);
	}
	const planRevision = requirePlanRevision(input.planRevision);
	const contentType = requireContentType(input.contentType);
	const filename = sanitizeFilename(input.filename);
	const bytes = base64ToBytes(input.contentBase64);
	if (bytes.byteLength === 0) {
		fail(400, 'artifact_content_required', 'artifact content must not be empty');
	}
	if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
		fail(
			400,
			'artifact_too_large',
			`artifact content ${bytes.byteLength} bytes exceeds the ${MAX_ARTIFACT_BYTES}-byte local-store cap`,
		);
	}
	const store = createD1ContentStore(db);
	const put = await store.put(bytes);
	const record: ArtifactRecord = {
		id: `art_${crypto.randomUUID()}`,
		projectId: verified.projectId,
		kind: kind as ArtifactKind,
		planRevision,
		sha256: put.contentHash,
		size: put.size,
		contentType,
		filename,
		status: 'current',
		createdBy: verified.actorId,
		createdAt: nowIso(),
	};
	await db
		.prepare(
			'insert into "project_artifacts" ("id","projectId","kind","planRevision","sha256","size","contentType","filename","status","createdBy","createdAt") ' +
				'values (?,?,?,?,?,?,?,?,?,?,?)',
		)
		.bind(
			record.id,
			record.projectId,
			record.kind,
			record.planRevision,
			record.sha256,
			record.size,
			record.contentType,
			record.filename,
			record.status,
			record.createdBy,
			record.createdAt,
		)
		.run();
	return record;
}

// --- reads ----------------------------------------------------------------------

/** List the scoped project's artifact revisions, newest first, optionally per kind. */
export async function listArtifacts(
	db: D1Database,
	scope: Scope,
	kind?: string,
): Promise<ArtifactRecord[]> {
	const verified = await assertProjectScope(db, scope);
	if (kind !== undefined && !ARTIFACT_KINDS.includes(kind as ArtifactKind)) {
		fail(400, 'invalid_input', `kind must be one of: ${ARTIFACT_KINDS.join(', ')}`);
	}
	const rows = kind
		? await queryAll(
				db,
				`select ${ARTIFACT_COLUMNS} from "project_artifacts" where "projectId" = ? and "kind" = ? order by "createdAt" desc, "rowid" desc`,
				verified.projectId,
				kind,
			)
		: await queryAll(
				db,
				`select ${ARTIFACT_COLUMNS} from "project_artifacts" where "projectId" = ? order by "createdAt" desc, "rowid" desc`,
				verified.projectId,
			);
	return rows.map(artifactFromRow);
}

/** One project-scoped artifact revision (metadata only), or 404. */
export async function getArtifact(
	db: D1Database,
	scope: Scope,
	revisionId: string,
): Promise<ArtifactRecord> {
	const verified = await assertProjectScope(db, scope);
	if (typeof revisionId !== 'string' || revisionId.length === 0) {
		fail(400, 'invalid_request', 'revisionId is required');
	}
	const rows = await queryAll(
		db,
		`select ${ARTIFACT_COLUMNS} from "project_artifacts" where "id" = ? and "projectId" = ?`,
		revisionId,
		verified.projectId,
	);
	if (!rows[0]) fail(404, 'artifact_not_found', 'no such artifact revision in this project');
	return artifactFromRow(rows[0]!);
}

export interface ArtifactContent {
	readonly revision: ArtifactRecord;
	readonly bytes: Uint8Array;
}

/** Metadata + the immutable bytes behind one revision (scope-checked). */
export async function readArtifact(
	db: D1Database,
	scope: Scope,
	revisionId: string,
): Promise<ArtifactContent> {
	const revision = await getArtifact(db, scope, revisionId);
	const bytes = await createD1ContentStore(db).get(revision.sha256);
	if (!bytes) fail(404, 'artifact_content_missing', 'artifact content is missing from the store');
	return { revision, bytes };
}

// --- diff -------------------------------------------------------------------------

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
	readonly type: DiffLineType;
	readonly text: string;
}

/** Bound on diff input so a pathological pair cannot spin the worker. */
const DIFF_MAX_LINES = 20_000;

/**
 * Myers O(ND) line diff, bounded: past the line budget the result degrades to
 * an honest whole-file replace instead of unbounded work.
 */
export function diffLines(before: string, after: string): DiffLine[] {
	return diffLinesSeq(
		before.length === 0 ? [] : before.replace(/\n$/, '').split('\n'),
		after.length === 0 ? [] : after.replace(/\n$/, '').split('\n'),
	);
}

export function diffLinesSeq(a: string[], b: string[]): DiffLine[] {
	if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
		return [
			...a.map((text) => ({ type: 'del' as const, text })),
			...b.map((text) => ({ type: 'add' as const, text })),
		];
	}
	const n = a.length;
	const m = b.length;
	const max = n + m;
	if (max === 0) return [];
	const offset = max;
	// v[k + offset] = furthest x reached on diagonal k
	let v = new Int32Array(2 * max + 1);
	const trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
				x = v[k + 1 + offset]!;
			} else {
				x = v[k - 1 + offset]! + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[k + offset] = x;
			if (x >= n && y >= m) {
				return backtrack(trace, a, b, d, offset);
			}
		}
	}
	return []; // unreachable: d = max always terminates
}

function backtrack(
	trace: Int32Array[],
	a: string[],
	b: string[],
	dFinal: number,
	offset: number,
): DiffLine[] {
	const out: DiffLine[] = [];
	let x = a.length;
	let y = b.length;
	for (let d = dFinal; d >= 1; d--) {
		const v = trace[d]!;
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = v[prevK + offset]!;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			out.push({ type: 'context', text: a[x]! });
		}
		if (x === prevX) {
			y--;
			out.push({ type: 'add', text: b[y]! });
		} else {
			x--;
			out.push({ type: 'del', text: a[x]! });
		}
	}
	while (x > 0 && y > 0) {
		x--;
		y--;
		out.push({ type: 'context', text: a[x]! });
	}
	out.reverse();
	return out;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

export interface ArtifactDiff {
	readonly from: ArtifactRecord;
	readonly to: ArtifactRecord;
	readonly lines: DiffLine[];
}

/**
 * Line diff between two revisions OF THE SAME KIND in the scoped project.
 * Both revisions must be decodable text — a binary pair is a typed 400, not
 * a garbled pseudo-diff. The diff is computed on demand and never stored.
 */
export async function diffArtifactRevisions(
	db: D1Database,
	scope: Scope,
	fromId: string,
	toId: string,
): Promise<ArtifactDiff> {
	const from = await getArtifact(db, scope, fromId);
	const to = await getArtifact(db, scope, toId);
	if (from.kind !== to.kind) {
		fail(400, 'artifact_kind_mismatch', 'a diff requires two revisions of the same kind');
	}
	if (from.id === to.id) return { from, to, lines: [] };
	const store = createD1ContentStore(db);
	const fromBytes = await store.get(from.sha256);
	const toBytes = await store.get(to.sha256);
	if (!fromBytes || !toBytes) {
		fail(404, 'artifact_content_missing', 'artifact content is missing from the store');
	}
	let beforeText: string;
	let afterText: string;
	try {
		beforeText = utf8Strict.decode(fromBytes!);
		afterText = utf8Strict.decode(toBytes!);
	} catch {
		fail(400, 'artifact_not_text', 'a line diff requires text content on both sides');
	}
	return { from, to, lines: diffLines(beforeText, afterText) };
}

// --- staleness hook -----------------------------------------------------------------

export interface MarkStaleResult {
	readonly marked: number;
}

/**
 * SYSTEM hook (no actor, no scope): called when plan revision
 * `newPlanRevision` lands. Flips 'current' -> 'stale' for every artifact of
 * the project derived from an OLDER plan revision. Never deletes anything —
 * the last green revision stays readable and downloadable, just visibly
 * superseded (contracts.md: a stale revision must not present itself as
 * current). Returns the number of rows flipped.
 */
export async function markStaleForPlan(
	db: D1Database,
	projectId: string,
	newPlanRevision: number,
): Promise<MarkStaleResult> {
	if (typeof projectId !== 'string' || projectId.length === 0) {
		fail(400, 'invalid_request', 'projectId is required');
	}
	if (typeof newPlanRevision !== 'number' || !Number.isInteger(newPlanRevision) || newPlanRevision < 1) {
		fail(400, 'invalid_request', 'newPlanRevision must be a positive integer');
	}
	const res = (await db
		.prepare(
			'update "project_artifacts" set "status" = \'stale\' ' +
				'where "projectId" = ? and "planRevision" < ? and "status" = \'current\'',
		)
		.bind(projectId, newPlanRevision)
		.run()) as { meta?: { changes?: number } };
	return { marked: res.meta?.changes ?? 0 };
}
