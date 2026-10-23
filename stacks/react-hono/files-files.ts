/**
 * Photo and file uploads (plan part L, lane 9).
 *
 * These files are GENERATED into an app only when a table declares a `file`
 * field (part B), and they are all PROTECTED. Uploads are sent and read in
 * PARTS of at most 700 KB, because Caddie's preview takes at most 1 MB per
 * request and returns at most 2 MB per reply (preview-runtime.ts). Each part is
 * stored as base64 text, about 930 KB per row, under D1's 2 MB value limit —
 * base64 because it is UNVERIFIED that the preview database gateway passes
 * binary values. Photos are shrunk in the browser first.
 *
 *   migrations/0000_caddie_files.sql   caddie_files + caddie_file_parts (sorts
 *                                        after 0000_caddie_auth.sql and before
 *                                        the generated 0001_schema.sql).
 *   caddie/files.ts                     the server: /api/caddie/files start,
 *                                        put part, finish (sha256 + part count),
 *                                        get part, delete; and readFile() for the
 *                                        app's own server code. Each route needs
 *                                        sign-in; only the file's person or team
 *                                        may use it.
 *   caddie/upload.ts                    the screen helpers: uploadFile (shrinks
 *                                        photos first), fileUrl (a blob: URL for
 *                                        <img>), downloadFile.
 *
 * Limits: 5 MB per file after shrinking, 100 MB per app, and only JPEG, PNG,
 * WebP, GIF, PDF, CSV and plain text. A `file` field stores the file id.
 *
 * The generated sources avoid backticks and "${" (except the EM/ELL constants,
 * because bun's transpiler mangles a literal non-ASCII character inside
 * String.raw) so they can live in String.raw (same rule as auth-files.ts).
 */

const file = (text: string) => text.replace(/^\n/, '');

// Interpolated into String.raw: bun turns a LITERAL non-ASCII character inside
// String.raw into the text "\u2014"/"\u2026", so the generated file would show
// the escape. Interpolating keeps the real character while String.raw still
// preserves the regex backslashes the generated code needs.
const EM = '\u2014';
const ELL = '\u2026';

/** At most 700 KB of raw bytes per part (plan part L). */
export const MAX_PART_BYTES = 700 * 1024;

/** At most 5 MB per file, after shrinking (plan part L). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** At most 100 MB per app across all files (plan part L). */
export const MAX_APP_BYTES = 100 * 1024 * 1024;

/** The only accepted content types (plan part L). */
export const ALLOWED_FILE_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'application/pdf',
	'text/csv',
	'text/plain',
] as const;

export const FILES_FILES: Readonly<Record<string, string>> = {
	// Sorts after 0000_caddie_auth.sql and before 0001_schema.sql (name order).
	'migrations/0000_caddie_files.sql': file(String.raw`
-- Caddie runtime migration ${EM} do not edit. Photo and file uploads (part L):
-- a file's details (caddie_files) and its parts (caddie_file_parts), each part
-- at most 700 KB of bytes stored as base64 text. A table's "file" field stores
-- a caddie_files.id.
create table caddie_files (
  id text not null primary key,
  ownerId text not null,
  teamId text,
  name text not null,
  mime text not null,
  bytes integer not null,
  sha256 text not null,
  parts integer not null,
  status text not null,
  createdAt text not null
);

create table caddie_file_parts (
  fileId text not null,
  n integer not null,
  data text not null,
  primary key (fileId, n)
);

create index ix_caddie_files_ownerId on caddie_files (ownerId);

create index ix_caddie_files_teamId on caddie_files (teamId);
`),

	'caddie/files.ts': file(String.raw`
// Caddie runtime file ${EM} do not edit. Photo and file uploads, sent and read
// in parts of at most 700 KB. Mount it from src/server.ts:
//
//   import { mountFiles } from "../caddie/files";
//   mountFiles(app);
//
// Routes (all under /api/caddie/files, all need sign-in; only the file's person
// or team may use it):
//   POST /api/caddie/files/start           { name, type, size, sha256 } -> { id }
//   PUT  /api/caddie/files/:id/parts/:n     the base64 of part n
//   POST /api/caddie/files/:id/finish       checks the sha256 and the part count
//   GET  /api/caddie/files/:id/parts/:n     the base64 of part n (+ the count)
//   DELETE /api/caddie/files/:id
//
// Your own server code reads a finished file with readFile(c, id):
//
//   const bytes = await readFile(c, fileId); // Uint8Array, or null if missing/unreadable
//
// The browser side (uploadFile, fileUrl, downloadFile) is in caddie/upload.ts.
import type { Context, Hono } from "hono";
import { requireUser } from "./auth";
import type { AppUser } from "./auth";
import type { D1Database } from "./d1";
import type { CaddiePlatform } from "./platform";

export const MAX_PART_BYTES = 700 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_APP_BYTES = 100 * 1024 * 1024;
export const ALLOWED_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "text/csv", "text/plain"];

type FilesEnv = { DB: D1Database; CADDIE: CaddiePlatform; CADDIE_AUTH_SECRET?: string };

export interface FileRow {
  id: string;
  ownerId: string;
  teamId: string | null;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  parts: number;
  status: "uploading" | "ready";
  createdAt: string;
}

/** The base64 of some bytes (no data: prefix). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** The bytes of a base64 string. */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** sha256 of some bytes, as lowercase hex (the browser and the server agree). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json415(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
}

/** The file row if it exists AND this person may use it (their own, or their team's). */
async function readableFile(c: Context, id: string, user: AppUser): Promise<FileRow | null> {
  const env = c.env as FilesEnv;
  const row = await env.DB.prepare("select * from caddie_files where id = ?").bind(id).first<FileRow>();
  if (!row) return null;
  if (row.ownerId === user.id) return row;
  if (row.teamId) {
    const member = await env.DB
      .prepare("select 1 as ok from team_members where teamId = ? and personId = ?")
      .bind(row.teamId, user.id)
      .first<{ ok: number }>();
    if (member) return row;
  }
  return null;
}

/** Read a finished file's bytes for the app's own server code. null if missing or unreadable. */
export async function readFile(c: Context, id: string): Promise<Uint8Array | null> {
  const user = await requireUser(c);
  const row = await readableFile(c, id, user);
  if (!row || row.status !== "ready") return null;
  const env = c.env as FilesEnv;
  const { results } = await env.DB.prepare("select n, data from caddie_file_parts where fileId = ? order by n").bind(id).all<{ n: number; data: string }>();
  const parts = results.map((r) => fromBase64(r.data));
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** Add the file routes under /api/caddie/files. Call once in src/server.ts. */
export function mountFiles<E extends { Bindings: FilesEnv }>(app: Hono<E>): void {
  // Begin an upload: records the file's details and returns an id. teamId is
  // optional; when given, the person must be on that team.
  app.post("/caddie/files/start", async (c) => {
    const user = await requireUser(c);
    const env = c.env as FilesEnv;
    if (!json415(c)) return c.json({ error: "Send JSON." }, 415);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; type?: unknown; size?: unknown; sha256?: unknown; teamId?: unknown };
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : "";
    const mime = typeof body.type === "string" ? body.type : "";
    const size = typeof body.size === "number" && Number.isInteger(body.size) ? body.size : -1;
    const sha256 = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : "";
    const teamId = typeof body.teamId === "string" && body.teamId ? body.teamId : null;
    if (!name) return c.json({ error: "A file needs a name." }, 400);
    if (!ALLOWED_FILE_TYPES.includes(mime)) return c.json({ error: "That kind of file isn't allowed." }, 415);
    if (size <= 0 || size > MAX_FILE_BYTES) return c.json({ error: "A file can be at most 5 MB." }, 413);
    if (!/^[0-9a-f]{64}$/.test(sha256)) return c.json({ error: "A file needs its sha256." }, 400);
    if (teamId) {
      const member = await env.DB.prepare("select 1 as ok from team_members where teamId = ? and personId = ?").bind(teamId, user.id).first<{ ok: number }>();
      if (!member) return c.json({ error: "You're not on that team." }, 403);
    }
    const id = crypto.randomUUID();
    const parts = Math.max(1, Math.ceil(size / MAX_PART_BYTES));
    // FINDING #8 (review 2026-10-23): 100 MB per app, counted atomically across
    // READY and UPLOADING files. A count-then-insert that read only 'ready'
    // bytes let two concurrent starts both pass against the same free space and
    // overshoot the cap. This single statement inserts ONLY when the sum of
    // every ready+uploading file's declared bytes, plus this one, fits the cap —
    // so the reservation is made in the same step the cap is checked.
    const res = await env.DB
      .prepare(
        "insert into caddie_files (id, ownerId, teamId, name, mime, bytes, sha256, parts, status, createdAt) " +
          "select ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ? " +
          "where (select coalesce(sum(bytes), 0) from caddie_files where status in ('ready','uploading')) + ? <= ?",
      )
      .bind(id, user.id, teamId, name, mime, size, sha256, parts, new Date().toISOString(), size, MAX_APP_BYTES)
      .run();
    if (!res.meta.changes) return c.json({ error: "This app has reached its 100 MB of files." }, 413);
    return c.json({ id, parts, partBytes: MAX_PART_BYTES });
  });

  // Store part n (base64 text in the body). Refuses a part over 700 KB of raw bytes.
  app.put("/caddie/files/:id/parts/:n", async (c) => {
    const user = await requireUser(c);
    const env = c.env as FilesEnv;
    const row = await readableFile(c, c.req.param("id"), user);
    if (!row) return c.json({ error: "Not found." }, 404);
    if (row.status !== "uploading") return c.json({ error: "This file is already finished." }, 409);
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 0 || n >= row.parts) return c.json({ error: "No such part." }, 400);
    const base64 = await c.req.text();
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(base64.trim());
    } catch {
      return c.json({ error: "A part must be base64 text." }, 400);
    }
    if (bytes.length > MAX_PART_BYTES) return c.json({ error: "A part is at most 700 KB." }, 413);
    await env.DB.prepare("insert into caddie_file_parts (fileId, n, data) values (?, ?, ?) on conflict(fileId, n) do update set data = excluded.data").bind(row.id, n, toBase64(bytes)).run();
    return c.json({ stored: n });
  });

  // Finish: every part is present and the joined bytes match the sha256 and size.
  app.post("/caddie/files/:id/finish", async (c) => {
    const user = await requireUser(c);
    const env = c.env as FilesEnv;
    const row = await readableFile(c, c.req.param("id"), user);
    if (!row) return c.json({ error: "Not found." }, 404);
    if (row.status === "ready") return c.json({ id: row.id, status: "ready" });
    const { results } = await env.DB.prepare("select n, data from caddie_file_parts where fileId = ? order by n").bind(row.id).all<{ n: number; data: string }>();
    if (results.length !== row.parts) return c.json({ error: "Some parts are missing." }, 400);
    for (let i = 0; i < results.length; i += 1) if (results[i].n !== i) return c.json({ error: "Some parts are missing." }, 400);
    const chunks = results.map((r) => fromBase64(r.data));
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (total !== row.bytes) return c.json({ error: "The file didn't come through whole." }, 400);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    if ((await sha256Hex(joined)) !== row.sha256) return c.json({ error: "The file didn't come through whole." }, 400);
    await env.DB.prepare("update caddie_files set status = 'ready' where id = ?").bind(row.id).run();
    return c.json({ id: row.id, status: "ready" });
  });

  // Read part n back (for the browser to re-join into a blob: URL).
  app.get("/caddie/files/:id/parts/:n", async (c) => {
    const user = await requireUser(c);
    const env = c.env as FilesEnv;
    const row = await readableFile(c, c.req.param("id"), user);
    if (!row) return c.json({ error: "Not found." }, 404);
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 0 || n >= row.parts) return c.json({ error: "No such part." }, 400);
    const part = await env.DB.prepare("select data from caddie_file_parts where fileId = ? and n = ?").bind(row.id, n).first<{ data: string }>();
    if (!part) return c.json({ error: "No such part." }, 404);
    return c.json({ n, parts: row.parts, name: row.name, mime: row.mime, data: part.data });
  });

  app.delete("/caddie/files/:id", async (c) => {
    const user = await requireUser(c);
    const env = c.env as FilesEnv;
    const row = await readableFile(c, c.req.param("id"), user);
    if (!row) return c.json({ error: "Not found." }, 404);
    await env.DB.prepare("delete from caddie_file_parts where fileId = ?").bind(row.id).run();
    await env.DB.prepare("delete from caddie_files where id = ?").bind(row.id).run();
    return c.json({ deleted: row.id });
  });
}
`),

	'caddie/upload.ts': file(String.raw`
// Caddie runtime file ${EM} do not edit. The browser side of file uploads
// (caddie/files.ts). Files go up and come back in parts of at most 700 KB.
//
//   import { uploadFile, fileUrl, downloadFile } from "../caddie/upload";
//   const id = await uploadFile(file, { onProgress: (done, total) => setPct(done / total) });
//   // store id in a "file" field, then show it:
//   const url = await fileUrl(id); // a blob: URL for <img src={url} />
//
// Photos (JPEG, PNG, WebP) are shrunk to at most 1,600 px on the long side as
// JPEG before upload, which usually makes them a single part. A "file" field
// stores the returned id.
export const MAX_PART_BYTES = 700 * 1024;
export const MAX_PHOTO_EDGE = 1600;

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** sha256 of some bytes, lowercase hex (matches the server). */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Shrink a photo to at most 1,600 px on the long side, as JPEG. Returns the
 * original Blob unchanged when it isn't a photo type or the browser can't draw
 * it (so the upload still works). Exported so a screen can preview the shrunk
 * size, and so the shrink is testable on its own.
 */
export async function shrinkPhoto(input: Blob, maxEdge = MAX_PHOTO_EDGE): Promise<Blob> {
  if (!PHOTO_TYPES.includes(input.type) || typeof createImageBitmap !== "function") return input;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(input);
  } catch {
    return input;
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  if (longest <= maxEdge) {
    bitmap.close();
    return input;
  }
  const scale = maxEdge / longest;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
  const context = (canvas as OffscreenCanvas).getContext("2d");
  if (!context) {
    bitmap.close();
    return input;
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  if ("convertToBlob" in canvas) return await (canvas as OffscreenCanvas).convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return await new Promise<Blob>((resolve) => (canvas as HTMLCanvasElement).toBlob((b) => resolve(b ?? input), "image/jpeg", 0.85));
}

/** Split bytes into parts of at most 700 KB. */
export function splitParts(bytes: Uint8Array, partBytes = MAX_PART_BYTES): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length || at === 0; at += partBytes) {
    parts.push(bytes.subarray(at, Math.min(at + partBytes, bytes.length)));
    if (bytes.length === 0) break;
  }
  return parts;
}

/**
 * Upload a file and return its id (store it in a "file" field). Photos are
 * shrunk first. onProgress(done, total) is called after each part.
 */
export async function uploadFile(input: Blob & { name?: string }, options: { name?: string; teamId?: string; onProgress?: (done: number, total: number) => void } = {}): Promise<string> {
  const blob = await shrinkPhoto(input);
  const name = options.name ?? input.name ?? "file";
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const sha256 = await sha256Hex(buffer);
  const started = await fetch("/api/caddie/files/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, type: blob.type, size: bytes.length, sha256, teamId: options.teamId }),
  });
  if (!started.ok) throw new Error(((await started.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't start the upload.");
  const { id } = (await started.json()) as { id: string };
  const parts = splitParts(bytes);
  for (let n = 0; n < parts.length; n += 1) {
    const put = await fetch("/api/caddie/files/" + id + "/parts/" + n, { method: "PUT", body: toBase64(parts[n]) });
    if (!put.ok) throw new Error("Couldn't upload part " + (n + 1) + " of " + parts.length + ".");
    options.onProgress?.(n + 1, parts.length);
  }
  const finished = await fetch("/api/caddie/files/" + id + "/finish", { method: "POST" });
  if (!finished.ok) throw new Error(((await finished.json().catch(() => ({}))) as { error?: string }).error ?? "The upload didn't finish.");
  return id;
}

/** Join a file's parts into a blob: URL (for <img>, a link, ${ELL}). Remember to revoke it. */
export async function fileUrl(id: string): Promise<string> {
  const first = await fetch("/api/caddie/files/" + id + "/parts/0");
  if (!first.ok) throw new Error("Couldn't read the file.");
  const head = (await first.json()) as { parts: number; mime: string; data: string };
  const chunks: Uint8Array[] = [fromBase64(head.data)];
  for (let n = 1; n < head.parts; n += 1) {
    const res = await fetch("/api/caddie/files/" + id + "/parts/" + n);
    if (!res.ok) throw new Error("Couldn't read the file.");
    chunks.push(fromBase64(((await res.json()) as { data: string }).data));
  }
  return URL.createObjectURL(new Blob(chunks as BlobPart[], { type: head.mime }));
}

/** Download a file through a temporary blob: URL. */
export async function downloadFile(id: string): Promise<void> {
  const first = await fetch("/api/caddie/files/" + id + "/parts/0");
  if (!first.ok) throw new Error("Couldn't read the file.");
  const head = (await first.json()) as { parts: number; mime: string; name: string; data: string };
  const chunks: Uint8Array[] = [fromBase64(head.data)];
  for (let n = 1; n < head.parts; n += 1) {
    const res = await fetch("/api/caddie/files/" + id + "/parts/" + n);
    if (!res.ok) throw new Error("Couldn't read the file.");
    chunks.push(fromBase64(((await res.json()) as { data: string }).data));
  }
  const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: head.mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = head.name;
  link.click();
  URL.revokeObjectURL(url);
}
`),
};
