/**
 * Preview runtime for apps with a server (Publish programme, stage 3).
 *
 * The build sandbox runs one command at a time and cannot serve HTTP, so a
 * checked app's server bundle (`dist/server.js`) runs INSIDE Caddie's own
 * Worker through Cloudflare's Worker Loader: a fresh isolate per build output
 * with only the bindings Caddie hands it. The preview iframe stays opaque
 * (no network of its own); its `fetch('/api/…')` calls are relayed by the
 * parent page to Caddie's API, which forwards them here.
 *
 * Inside the isolate:
 *   - `env.DB` speaks Cloudflare D1's API (the same code runs on real D1 once
 *     published) on top of Caddie's per-project PreviewDatabase Durable Object,
 *     reached through an RPC gateway — see PREVIEW_D1_SHIM_SOURCE;
 *   - outbound network is OFF unless Caddie passes an outbound policy.
 *
 * This module is runtime-neutral (no `cloudflare:` imports) so its logic is
 * testable under Bun; the Durable Object and the gateway live in
 * preview-database.ts.
 */

// --- shapes shared by the shim, the gateway and the Durable Object -----------

export type PreviewStatementMode = 'all' | 'raw';

export interface PreviewStatement {
	sql: string;
	params: unknown[];
	mode: PreviewStatementMode;
}

export interface PreviewMeta {
	duration: number;
	size_after: number;
	rows_read: number;
	rows_written: number;
	last_row_id: number;
	changed_db: boolean;
	changes: number;
}

export type PreviewStatementResult =
	| { results: Record<string, unknown>[]; success: true; meta: PreviewMeta }
	| { columns: string[]; rows: unknown[][]; success: true; meta: PreviewMeta };

export interface PreviewMigration {
	name: string;
	sql: string;
}

/** The subset of Durable Object SQL storage the executor uses. */
export interface SqlCursorLike {
	toArray(): Record<string, unknown>[];
	raw(): Iterable<unknown[]>;
	readonly columnNames: string[];
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

export interface SqlStorageLike {
	exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

export interface PreviewStorageLike {
	sql: SqlStorageLike;
	transactionSync<T>(closure: () => T): T;
}

export const PREVIEW_LIMITS = {
	maxStatements: 100,
	maxSqlChars: 100_000,
	maxParams: 100,
	maxRequestBodyBytes: 1024 * 1024,
	maxResponseBodyBytes: 2 * 1024 * 1024,
	maxHeaders: 64,
	requestTimeoutMs: 15_000,
} as const;

export class PreviewRuntimeError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'PreviewRuntimeError';
	}
}

// --- the preview database executor (runs inside the Durable Object) -----------

function d1Error(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(message.startsWith('D1_') ? message : `D1_ERROR: ${message}`);
}

function checkStatements(statements: unknown): PreviewStatement[] {
	if (!Array.isArray(statements) || statements.length === 0 || statements.length > PREVIEW_LIMITS.maxStatements)
		throw new PreviewRuntimeError('invalid_statements', `Send between 1 and ${PREVIEW_LIMITS.maxStatements} statements.`);
	return statements.map((raw) => {
		const item = raw as Partial<PreviewStatement>;
		if (typeof item?.sql !== 'string' || item.sql.trim() === '' || item.sql.length > PREVIEW_LIMITS.maxSqlChars)
			throw new PreviewRuntimeError('invalid_statement', 'Each statement needs SQL text of at most 100,000 characters.');
		const params = Array.isArray(item.params) ? item.params : [];
		if (params.length > PREVIEW_LIMITS.maxParams)
			throw new PreviewRuntimeError('invalid_statement', `At most ${PREVIEW_LIMITS.maxParams} values per statement.`);
		return { sql: item.sql, params, mode: item.mode === 'raw' ? 'raw' : 'all' };
	});
}

function runOne(sql: SqlStorageLike, statement: PreviewStatement): PreviewStatementResult {
	const started = Date.now();
	const cursor = sql.exec(statement.sql, ...statement.params);
	let rows: unknown[][] = [];
	let results: Record<string, unknown>[] = [];
	if (statement.mode === 'raw') rows = [...cursor.raw()];
	else results = cursor.toArray();
	const rowsWritten = cursor.rowsWritten;
	let changes = 0;
	let lastRowId = 0;
	if (rowsWritten > 0) {
		const info = sql.exec('select changes() as "changes", last_insert_rowid() as "id"').toArray()[0] ?? {};
		changes = Number(info['changes'] ?? 0);
		lastRowId = Number(info['id'] ?? 0);
	}
	const meta: PreviewMeta = {
		duration: Date.now() - started,
		size_after: 0,
		rows_read: cursor.rowsRead,
		rows_written: rowsWritten,
		last_row_id: lastRowId,
		changed_db: rowsWritten > 0,
		changes,
	};
	return statement.mode === 'raw'
		? { columns: [...cursor.columnNames], rows, success: true, meta }
		: { results, success: true, meta };
}

/** One request from the shim: each statement in order; a batch is all-or-nothing. */
export function runPreviewStatements(storage: PreviewStorageLike, statements: unknown, transaction: boolean): PreviewStatementResult[] {
	const checked = checkStatements(statements);
	try {
		if (transaction || checked.length > 1) return storage.transactionSync(() => checked.map((item) => runOne(storage.sql, item)));
		return [runOne(storage.sql, checked[0]!)];
	} catch (error) {
		throw d1Error(error);
	}
}

/**
 * Split a SQL script into statements on top-level semicolons, honouring
 * quotes, comments and CREATE TRIGGER … BEGIN … END bodies.
 */
export function splitSqlScript(script: string): string[] {
	const out: string[] = [];
	let current = '';
	let i = 0;
	let quote: string | null = null;
	let blockDepth = 0;
	const flush = () => {
		const text = current.trim();
		if (text) out.push(text);
		current = '';
	};
	while (i < script.length) {
		const ch = script[i]!;
		const next = script[i + 1];
		if (quote) {
			current += ch;
			if (ch === quote) {
				if (next === quote) {
					current += next;
					i += 2;
					continue;
				}
				quote = null;
			}
			i += 1;
			continue;
		}
		if (ch === '-' && next === '-') {
			const end = script.indexOf('\n', i);
			i = end === -1 ? script.length : end + 1;
			current += '\n';
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = script.indexOf('*/', i + 2);
			i = end === -1 ? script.length : end + 2;
			current += ' ';
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
			quote = ch === '[' ? ']' : ch;
			current += ch;
			i += 1;
			continue;
		}
		if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_]/.test(script[i - 1] ?? ' ')) {
			const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(script.slice(i))![0];
			const upper = word.toUpperCase();
			if (upper === 'BEGIN' && /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(current)) blockDepth += 1;
			else if (upper === 'END' && blockDepth > 0) blockDepth -= 1;
			current += word;
			i += word.length;
			continue;
		}
		if (ch === ';' && blockDepth === 0) {
			flush();
			i += 1;
			continue;
		}
		current += ch;
		i += 1;
	}
	flush();
	return out;
}

/** D1 `exec`: run a multi-statement script without parameters. */
export function runPreviewScript(storage: PreviewStorageLike, script: unknown): { count: number; duration: number } {
	if (typeof script !== 'string' || script.length > PREVIEW_LIMITS.maxSqlChars * 10)
		throw new PreviewRuntimeError('invalid_script', 'exec() needs SQL text of at most 1,000,000 characters.');
	const started = Date.now();
	const statements = splitSqlScript(script);
	try {
		storage.transactionSync(() => {
			for (const statement of statements) storage.sql.exec(statement).toArray();
		});
	} catch (error) {
		throw d1Error(error);
	}
	return { count: statements.length, duration: Date.now() - started };
}

const MIGRATION_NAME = /^\d{4}_[A-Za-z0-9_.-]+\.sql$/;

/** Apply the app's migrations in name order, once each (tracked in `_caddie_migrations`). */
export function applyPreviewMigrations(storage: PreviewStorageLike, files: unknown): { applied: string[] } {
	if (!Array.isArray(files)) throw new PreviewRuntimeError('invalid_migrations', 'Migrations must be a list.');
	const checked = (files as PreviewMigration[])
		.map((file) => {
			if (typeof file?.name !== 'string' || !MIGRATION_NAME.test(file.name) || typeof file.sql !== 'string')
				throw new PreviewRuntimeError('invalid_migration', 'Each migration needs a NNNN_name.sql file name and SQL text.');
			return { name: file.name, sql: file.sql };
		})
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	storage.sql.exec('create table if not exists "_caddie_migrations" ("name" text primary key not null, "appliedAt" text not null)');
	const done = new Set(
		storage.sql
			.exec('select "name" from "_caddie_migrations"')
			.toArray()
			.map((row) => String(row['name'])),
	);
	const applied: string[] = [];
	for (const file of checked) {
		if (done.has(file.name)) continue;
		try {
			storage.transactionSync(() => {
				for (const statement of splitSqlScript(file.sql)) storage.sql.exec(statement).toArray();
				storage.sql.exec('insert into "_caddie_migrations" ("name","appliedAt") values (?,?)', file.name, new Date().toISOString());
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new PreviewRuntimeError('migration_failed', `${file.name} failed: ${message}`, 422);
		}
		applied.push(file.name);
	}
	return { applied };
}

// --- code that runs inside the app's isolate -----------------------------------

/**
 * `caddie-d1.js`: Cloudflare D1's API (prepare/bind/first/all/run/raw,
 * batch, exec) over Caddie's preview database gateway (env.CADDIE_DB).
 * Plain JavaScript: it is loaded as a module into the app's isolate.
 */
export const PREVIEW_D1_SHIM_SOURCE = String.raw`// caddie-d1.js — env.DB in a Caddie preview: Cloudflare D1's API on Caddie's preview database.
function checkValue(value) {
  if (value === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value !== null && typeof value === "object") throw new Error("D1_TYPE_ERROR: Type 'object' not supported for value '" + String(value) + "'");
  return value;
}
class PreparedStatement {
  constructor(db, sql, params) { this.db = db; this.statement = sql; this.params = params; }
  bind(...values) { return new PreparedStatement(this.db, this.statement, values.map(checkValue)); }
  _json(mode) { return { sql: this.statement, params: this.params, mode: mode }; }
  async first(column) {
    const results = (await this.db._send([this._json("all")], false))[0].results;
    if (results.length === 0) return null;
    const row = results[0];
    if (column === undefined) return row;
    if (!(column in row)) throw new Error("D1_COLUMN_NOTFOUND: Column not found (" + column + ")");
    return row[column];
  }
  async all() { return (await this.db._send([this._json("all")], false))[0]; }
  async run() { return (await this.db._send([this._json("all")], false))[0]; }
  async raw(options) {
    const result = (await this.db._send([this._json("raw")], false))[0];
    return options && options.columnNames ? [result.columns].concat(result.rows) : result.rows;
  }
}
function unavailable() { throw new Error("D1_ERROR: The app's database is not available here."); }
export function makeD1(gateway) {
  const db = {
    async _send(statements, transaction) {
      if (!gateway) unavailable();
      return gateway.query(statements, transaction);
    },
    prepare(sql) {
      if (typeof sql !== "string") throw new TypeError("D1_ERROR: prepare() needs SQL text");
      return new PreparedStatement(db, sql, []);
    },
    async batch(statements) {
      if (!gateway) unavailable();
      if (!Array.isArray(statements) || statements.length === 0) return [];
      return gateway.query(statements.map(function (s) { return s._json("all"); }), true);
    },
    async exec(sql) {
      if (!gateway) unavailable();
      return gateway.execScript(sql);
    },
    async dump() { throw new Error("D1_ERROR: dump() is not available in Caddie previews."); },
    withSession() { return db; },
  };
  return db;
}
`;

/**
 * `caddie-entry.js`: the isolate's main module. Builds the app's env from what
 * Caddie passed (CADDIE_VARS = the app's own keys, CADDIE_DB = the database
 * gateway, CADDIE = the platform service) and hands every request to the
 * app's Hono server (its default export).
 */
export const PREVIEW_ENTRY_SOURCE = String.raw`import app from "./app.js";
import { makeD1 } from "./caddie-d1.js";
export default {
  async fetch(request, env, ctx) {
    const appEnv = Object.assign({}, env.CADDIE_VARS || {}, { DB: makeD1(env.CADDIE_DB) });
    if (env.CADDIE) appEnv.CADDIE = env.CADDIE;
    const handler = app && typeof app.fetch === "function" ? app : null;
    if (!handler) return new Response(JSON.stringify({ error: "app_has_no_server" }), { status: 500, headers: { "content-type": "application/json" } });
    return handler.fetch(request, appEnv, ctx);
  },
};
`;

// --- Worker Loader glue ---------------------------------------------------------

export interface WorkerCodeLike {
	compatibilityDate: string;
	compatibilityFlags?: string[];
	mainModule: string;
	modules: Record<string, string>;
	env?: Record<string, unknown>;
	globalOutbound?: unknown;
}

export interface WorkerStubLike {
	getEntrypoint(): { fetch(request: Request): Promise<Response> };
}

export interface WorkerLoaderLike {
	get(id: string, getCode: () => WorkerCodeLike | Promise<WorkerCodeLike>): WorkerStubLike;
}

export const PREVIEW_COMPATIBILITY_DATE = '2026-06-01';

// --- the per-project preview database, as callers see it -------------------------

export interface PreviewDatabaseStub {
	query(statements: unknown, transaction: boolean): Promise<PreviewStatementResult[]>;
	execScript(script: unknown): Promise<{ count: number; duration: number }>;
	applyMigrations(files: unknown): Promise<{ applied: string[] }>;
	reset(): Promise<void>;
}

export interface PreviewDatabaseNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): PreviewDatabaseStub;
}

export interface PreviewDatabaseEnv {
	PREVIEW_DB?: PreviewDatabaseNamespace;
}

/** This project's preview database (one Durable Object per project). */
export function previewDatabaseFor(env: PreviewDatabaseEnv, projectId: string): PreviewDatabaseStub {
	const namespace = env.PREVIEW_DB;
	if (!namespace) throw new PreviewRuntimeError('preview_db_unavailable', 'The preview database is not configured.', 503);
	return namespace.get(namespace.idFromName(`project:${projectId}`));
}

export function previewWorkerCode(input: {
	serverSource: string;
	env: Record<string, unknown>;
	/** null blocks every outbound fetch from the app; otherwise a Fetcher that applies Caddie's policy. */
	globalOutbound: unknown;
}): WorkerCodeLike {
	return {
		compatibilityDate: PREVIEW_COMPATIBILITY_DATE,
		compatibilityFlags: ['nodejs_compat'],
		mainModule: 'caddie-entry.js',
		modules: {
			'caddie-entry.js': PREVIEW_ENTRY_SOURCE,
			'caddie-d1.js': PREVIEW_D1_SHIM_SOURCE,
			'app.js': input.serverSource,
		},
		env: input.env,
		globalOutbound: input.globalOutbound,
	};
}

async function withTimeout<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new PreviewRuntimeError('preview_timeout', message, 504)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * The runs-on-Cloudflare check: load the server bundle with no database and
 * no network, and require `GET /api/health` to answer 200. Catches code that
 * only works under Bun before a build counts as checked.
 */
export async function checkServerStarts(
	loader: WorkerLoaderLike,
	serverSource: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	try {
		const key = await previewCacheKey({ projectId: '', outputId: 'startup-check', serverSource, vars: {} });
		const stub = loader.get(`check:${key}`, () =>
			previewWorkerCode({ serverSource, env: {}, globalOutbound: null }),
		);
		const response = await withTimeout(
			stub.getEntrypoint().fetch(new Request('https://app.preview.invalid/api/health')),
			10_000,
			'The app server took longer than 10 seconds to answer.',
		);
		if (response.status === 200) return { ok: true };
		const text = (await response.text()).slice(0, 300);
		return { ok: false, reason: `GET /api/health answered ${response.status}${text ? `: ${text}` : ''}` };
	} catch (error) {
		return { ok: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
	}
}

// --- the preview frame's request relay ---------------------------------------------

export interface BridgeRequest {
	method: string;
	/** Path + query, must start with /api. */
	path: string;
	headers: Array<[string, string]>;
	/** Base64 body, or null. */
	body: string | null;
}

export interface BridgeResponse {
	status: number;
	headers: Array<[string, string]>;
	body: string;
}

const BRIDGE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Headers the relay never forwards: transport-level, or Caddie's own. */
const DROPPED_HEADERS = new Set([
	'host',
	'content-length',
	'connection',
	'keep-alive',
	'transfer-encoding',
	'upgrade',
	'te',
	'trailer',
	'proxy-authorization',
	'proxy-connection',
	'cf-connecting-ip',
	'x-forwarded-for',
	'x-real-ip',
]);

function base64ToBytesLocal(value: string): Uint8Array {
	const binary = atob(value);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
	return out;
}

function bytesToBase64Local(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** Validate a relayed request and turn it into the Request the app sees. */
export function bridgeRequestToRequest(raw: unknown): Request {
	const input = raw as Partial<BridgeRequest>;
	const method = typeof input?.method === 'string' ? input.method.toUpperCase() : '';
	if (!BRIDGE_METHODS.has(method)) throw new PreviewRuntimeError('invalid_method', 'Unsupported request method.');
	const path = typeof input?.path === 'string' ? input.path : '';
	if (path.length > 2048 || !/^\/api(?:[/?#]|$)/.test(path) || path.includes('\\'))
		throw new PreviewRuntimeError('invalid_path', "The preview only relays requests to the app's own /api routes.");
	const url = new URL(path, 'https://app.preview.invalid');
	if (url.origin !== 'https://app.preview.invalid' || !url.pathname.startsWith('/api'))
		throw new PreviewRuntimeError('invalid_path', "The preview only relays requests to the app's own /api routes.");
	const headers = new Headers();
	const list = Array.isArray(input?.headers) ? input.headers : [];
	if (list.length > PREVIEW_LIMITS.maxHeaders) throw new PreviewRuntimeError('invalid_headers', 'Too many request headers.');
	for (const pair of list) {
		if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
		const name = pair[0].toLowerCase();
		if (DROPPED_HEADERS.has(name) || name.startsWith('x-caddie-') || pair[1].length > 8192) continue;
		try {
			headers.append(name, pair[1]);
		} catch {
			// An invalid header name or value is dropped, not fatal.
		}
	}
	let body: Uint8Array | null = null;
	if (input?.body !== null && input?.body !== undefined) {
		if (typeof input.body !== 'string') throw new PreviewRuntimeError('invalid_body', 'The request body must be base64 text.');
		if (input.body.length > Math.ceil(PREVIEW_LIMITS.maxRequestBodyBytes / 3) * 4 + 4)
			throw new PreviewRuntimeError('body_too_large', 'Request bodies in the preview are limited to 1 MB.', 413);
		try {
			body = base64ToBytesLocal(input.body);
		} catch {
			throw new PreviewRuntimeError('invalid_body', 'The request body must be base64 text.');
		}
	}
	return new Request(url, {
		method,
		headers,
		body: body && method !== 'GET' && method !== 'HEAD' ? (body.slice().buffer as ArrayBuffer) : undefined,
	});
}

/** Serialize the app's answer for the relay, capped. */
export async function responseToBridge(response: Response): Promise<BridgeResponse> {
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > PREVIEW_LIMITS.maxResponseBodyBytes) {
				await reader.cancel().catch(() => undefined);
				throw new PreviewRuntimeError('response_too_large', "The app's answer is larger than the preview's 2 MB limit.", 502);
			}
			chunks.push(value);
		}
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const headers: Array<[string, string]> = [];
	response.headers.forEach((value, name) => {
		if (!DROPPED_HEADERS.has(name.toLowerCase())) headers.push([name, value]);
	});
	// Headers.forEach folds Set-Cookie; keep each cookie separate for the frame's cookie jar.
	const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
	const withoutCookies = headers.filter(([name]) => name.toLowerCase() !== 'set-cookie');
	for (const cookie of cookies) withoutCookies.push(['set-cookie', cookie]);
	return { status: response.status, headers: withoutCookies, body: bytesToBase64Local(bytes) };
}

/**
 * Worker Loader keeps an isolate warm per id and reuses the env it was FIRST
 * loaded with. The id therefore covers everything in that env — the project
 * (whose database the gateway reaches), the build output, the code and the
 * app's keys — so one project's isolate can never serve another's request.
 */
export async function previewCacheKey(parts: {
	projectId: string;
	outputId: string;
	serverSource: string;
	vars: Record<string, string>;
	/** 'none' (no network) or 'gate' (Caddie's egress policy): part of the env too. */
	egress?: 'none' | 'gate';
	/** Whether env.CADDIE (Caddie's platform for this project) is in the env. */
	platform?: boolean;
}): Promise<string> {
	const vars = Object.keys(parts.vars)
		.sort()
		.map((name) => [name, parts.vars[name]]);
	const material = JSON.stringify([parts.projectId, parts.outputId, parts.serverSource, vars, parts.egress ?? 'none', ...(parts.platform ? ['platform'] : [])]);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
	return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Send one relayed request into the app's isolate. */
export async function runPreviewApp(input: {
	loader: WorkerLoaderLike;
	projectId: string;
	outputId: string;
	serverSource: string;
	/** The app's own keys (decrypted server-side; never shown to the model or the sandbox). */
	vars: Record<string, string>;
	/** RPC gateway to this project's preview database (props.projectId bound). */
	database: unknown;
	/** Caddie's platform service for the app (AI, email), when available. */
	platform?: unknown;
	globalOutbound: unknown;
	request: Request;
}): Promise<BridgeResponse> {
	const key = await previewCacheKey({ ...input, egress: input.globalOutbound === null ? 'none' : 'gate', platform: Boolean(input.platform) });
	const env: Record<string, unknown> = { CADDIE_DB: input.database, CADDIE_VARS: input.vars };
	if (input.platform) env.CADDIE = input.platform;
	const stub = input.loader.get(`preview:${key}`, () =>
		previewWorkerCode({ serverSource: input.serverSource, env, globalOutbound: input.globalOutbound }),
	);
	const response = await withTimeout(
		stub.getEntrypoint().fetch(input.request),
		PREVIEW_LIMITS.requestTimeoutMs,
		'The app took longer than 15 seconds to answer.',
	);
	return responseToBridge(response);
}
