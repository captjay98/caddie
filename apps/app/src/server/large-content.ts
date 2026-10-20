import type { D1Database } from './auth.ts';
import { sha256Hex } from './artifacts.ts';
import { ScopeError } from './scope.ts';

/**
 * Files bigger than one D1 value (Track 3): a Flutter app's preview page
 * (a few MB) and its Android APK (about 16 MB). Production D1 refuses any
 * single value over 2,000,000 bytes, so a file is split into chunks of at
 * most LARGE_CHUNK_BYTES, keyed by its sha256 (migration 0036).
 *
 *   put  chunks a few per D1 batch, the head row in the last one, so a file
 *        is either readable whole or not at all; the same bytes are stored once
 *   get  reads chunk by chunk and refuses a file whose chunks do not add up
 *        or whose bytes no longer match the hash: never serve half an APK
 *
 * D1, not R2, so the deploy needs no extra bucket. Its 10 GB database limit
 * is the ceiling; R2 is the move if Flutter builds ever need more.
 */

export const LARGE_CHUNK_BYTES = 1_900_000;
export const LARGE_CHUNKS_PER_BATCH = 4;
export const LARGE_MAX_BYTES = 64 * 1024 * 1024;

export async function putLarge(db: D1Database, bytes: Uint8Array): Promise<{ sha256: string; bytes: number; deduped: boolean }> {
	if (bytes.byteLength === 0) throw new ScopeError(422, 'LARGE_FILE_EMPTY', 'An empty file cannot be stored.');
	if (bytes.byteLength > LARGE_MAX_BYTES) throw new ScopeError(422, 'LARGE_FILE_TOO_BIG', 'The file is larger than 64 MB, the most Caddie keeps for one app file.');
	const sha256 = await sha256Hex(bytes);
	const existing = await db.prepare('select "bytes" from "large_content" where "sha256" = ?').bind(sha256).all<{ bytes: number }>();
	if ((existing.results ?? []).length > 0) return { sha256, bytes: bytes.byteLength, deduped: true };
	const chunks = Math.ceil(bytes.byteLength / LARGE_CHUNK_BYTES);
	// A few chunks per batch keeps each D1 request under ~8 MB. The head row
	// goes in the LAST batch, so a file is readable only once every chunk is
	// in; an interrupted write leaves unreferenced chunks, never half a file.
	const pending = [];
	for (let index = 0; index < chunks; index++) {
		pending.push(
			db
				.prepare('insert or ignore into "large_content_chunks" ("sha256","idx","bytes") values (?,?,?)')
				.bind(sha256, index, bytes.subarray(index * LARGE_CHUNK_BYTES, (index + 1) * LARGE_CHUNK_BYTES)),
		);
	}
	const head = db
		.prepare('insert or ignore into "large_content" ("sha256","bytes","chunks","createdAt") values (?,?,?,?)')
		.bind(sha256, bytes.byteLength, chunks, new Date().toISOString());
	for (let start = 0; start < pending.length; start += LARGE_CHUNKS_PER_BATCH) {
		const group = pending.slice(start, start + LARGE_CHUNKS_PER_BATCH);
		await db.batch(start + LARGE_CHUNKS_PER_BATCH >= pending.length ? [...group, head] : group);
	}
	return { sha256, bytes: bytes.byteLength, deduped: false };
}

export async function getLarge(db: D1Database, sha256: string): Promise<Uint8Array | null> {
	const head = (await db.prepare('select "bytes","chunks" from "large_content" where "sha256" = ?').bind(sha256).all<{ bytes: number; chunks: number }>()).results?.[0];
	if (!head) return null;
	const out = new Uint8Array(Number(head.bytes));
	let at = 0;
	for (let index = 0; index < Number(head.chunks); index++) {
		const row = (await db.prepare('select "bytes" from "large_content_chunks" where "sha256" = ? and "idx" = ?').bind(sha256, index).all<{ bytes: unknown }>()).results?.[0];
		const chunk = row ? toBytes(row.bytes) : null;
		if (!chunk || at + chunk.byteLength > out.byteLength) throw new ScopeError(500, 'LARGE_FILE_DAMAGED', 'A stored app file is incomplete.');
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	if (at !== out.byteLength) throw new ScopeError(500, 'LARGE_FILE_DAMAGED', 'A stored app file is incomplete.');
	if ((await sha256Hex(out)) !== sha256) throw new ScopeError(500, 'LARGE_FILE_DAMAGED', 'A stored app file does not match its checksum.');
	return out;
}

function toBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (Array.isArray(value)) return Uint8Array.from(value as number[]);
	return null;
}
