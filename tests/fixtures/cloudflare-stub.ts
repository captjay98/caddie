import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * P08-publish test fixture — LOCAL STUB of the Cloudflare REST API v4 surface
 * the adapter implements (apps/app/src/server/adapters/cloudflare.ts).
 *
 * Binds 127.0.0.1 only — no external network, no real Cloudflare. In-memory
 * state for every endpoint; requires `Authorization: Bearer <token>`. The
 * Worker upload and the static-assets flow are REALLY parsed from the
 * multipart body (a missing `metadata` part, module or upload JWT is rejected
 * exactly as the real API would), so "the adapter sent a well-formed upload"
 * is stub truth, not a code promise.
 *
 * Classification: SIMULATED. Nothing here is evidence about real
 * api.cloudflare.com; it is an emulation for contract tests, deliberately
 * narrow to the shapes this adapter depends on.
 *
 * Chaos control: `failNext(pattern, status, times)` makes the next `times`
 * requests whose "METHOD path" contains `pattern` fail with `status`, so every
 * error-mapping branch can be exercised deterministically.
 */

export interface CloudflareStubOptions {
	/** Bearer token the account-level calls must present. */
	token: string;
}

interface StubScript {
	name: string;
	metadata: Record<string, unknown>;
	bindings: unknown[];
	assets: { jwt?: unknown; config?: unknown } | null;
	mainModule: string;
	hasModule: boolean;
}

interface StubDatabase {
	id: string;
	name: string;
	/** Every SQL statement executed against this database, in order. */
	executedSql: string[];
}

interface StubHostname {
	id: string;
	hostname: string;
	status: string;
	sslStatus: string;
	deleted: boolean;
}

interface StubScan {
	uuid: string;
	url: string;
	malicious: boolean;
	/** The result endpoint answers 404 once (pending), then 200 (done). */
	polls: number;
}

interface FailRule {
	pattern: string;
	status: number;
	remaining: number;
}

export interface CloudflareStubRequest {
	method: string;
	path: string;
	authorized: boolean;
}

/** The hashing wrangler uses — must match the adapter's assetHash. */
function assetHash(base64Body: string, extension: string): string {
	return createHash('sha256').update(base64Body + extension).digest('hex').slice(0, 32);
}

export class CloudflareStub {
	url = '';
	readonly requests: CloudflareStubRequest[] = [];

	private server: Server | undefined;
	private readonly token: string;
	private counter = 0;

	// Observable state.
	readonly scripts = new Map<string, StubScript>();
	readonly databases = new Map<string, StubDatabase>();
	readonly kv = new Map<string, string>();
	readonly hostnames = new Map<string, StubHostname>();
	readonly scans = new Map<string, StubScan>();
	/** Hashes the stub has received bytes for (assets upload truth). */
	readonly storedAssets = new Set<string>();

	/** A URL containing this marker scans as malicious. */
	maliciousMarker = 'phishy';

	private failRules: FailRule[] = [];
	/** Upload-session JWTs this stub minted (asset-upload auth check). */
	private uploadJwts = new Set<string>();

	constructor(options: CloudflareStubOptions) {
		this.token = options.token;
	}

	// --- test controls -------------------------------------------------------

	/** Fail the next `times` requests matching `pattern` ("METHOD /path") with `status`. */
	failNext(pattern: string, status: number, times = 1): void {
		this.failRules.push({ pattern, status, remaining: times });
	}

	/** Drop every pending failure rule (between tests that share one stub). */
	clearFailures(): void {
		this.failRules = [];
	}

	scriptBindings(name: string): unknown[] {
		return this.scripts.get(name)?.bindings ?? [];
	}

	databaseSql(id: string): string[] {
		return this.databases.get(id)?.executedSql ?? [];
	}

	// --- lifecycle -----------------------------------------------------------

	start(port: number): Promise<void> {
		const server = createServer((req, res) => {
			this.handle(req, res).catch((error) => {
				if (!res.headersSent) {
					res.writeHead(500, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ success: false, errors: [{ code: 0, message: `stub error: ${String(error)}` }] }));
				} else {
					res.destroy();
				}
			});
		});
		this.server = server;
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				this.url = `http://127.0.0.1:${port}`;
				resolve();
			});
		});
	}

	stop(): Promise<void> {
		return new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	// --- helpers -------------------------------------------------------------

	private envelope(res: import('node:http').ServerResponse, status: number, result: unknown): void {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ success: status >= 200 && status < 300, errors: [], messages: [], result }));
	}

	private error(res: import('node:http').ServerResponse, status: number, code: number, message: string): void {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }));
	}

	private readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => resolve(Buffer.concat(chunks)));
			req.on('error', reject);
		});
	}

	/** Consume one matching fail rule, if any. */
	private failFor(method: string, path: string): number | null {
		const key = `${method} ${path}`;
		for (const rule of this.failRules) {
			if (rule.remaining > 0 && key.includes(rule.pattern)) {
				rule.remaining -= 1;
				return rule.status;
			}
		}
		return null;
	}

	private messageForStatus(status: number): { code: number; message: string } {
		switch (status) {
			case 400:
				return { code: 10001, message: 'Bad Request (stub)' };
			case 401:
				return { code: 10000, message: 'Authentication error (stub)' };
			case 403:
				return { code: 10001, message: 'Authorization error (stub)' };
			case 404:
				return { code: 10007, message: 'Not Found (stub)' };
			case 409:
				return { code: 10009, message: 'Conflict (stub)' };
			case 422:
				return { code: 10002, message: 'Unprocessable Entity (stub)' };
			case 429:
				return { code: 10013, message: 'Rate limited (stub)' };
			default:
				return { code: 10100, message: `Upstream error ${status} (stub)` };
		}
	}

	// --- request handling ----------------------------------------------------

	private async handle(
		req: import('node:http').IncomingMessage,
		res: import('node:http').ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const path = url.pathname;
		const method = (req.method ?? 'GET').toUpperCase();
		const bodyBuf = await this.readBody(req);
		const authHeader = req.headers.authorization ?? '';
		const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
		const accountOk = bearer === this.token;
		// Asset-upload uses a short-lived upload JWT instead of the account token.
		const uploadAuth = this.uploadJwts.has(bearer);
		this.requests.push({ method, path, authorized: accountOk });

		// Injected failure takes precedence over everything (incl. auth) so an
		// error-mapping test gets exactly the status it asked for.
		const forced = this.failFor(method, path);
		if (forced !== null) {
			const { code, message } = this.messageForStatus(forced);
			return this.error(res, forced, code, message);
		}

		const isAssetUpload = method === 'POST' && path === '/client/v4' + '' && false; // placeholder (never true)
		void isAssetUpload;

		// Auth gate: the assets upload leg authenticates with the upload JWT, so
		// let it through on a valid JWT even without the account token.
		const assetsUpload = method === 'POST' && /\/workers\/assets\/upload$/.test(path);
		if (!accountOk && !(assetsUpload && uploadAuth)) {
			return this.error(res, 401, 10000, 'Invalid API token (stub)');
		}

		// Strip the /client/v4 prefix the adapter's base URL includes.
		const rest = path.replace(/^\/client\/v4/, '');

		// --- Workers for Platforms: assets-upload-session ----------------------
		let m = rest.match(/^\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/([^/]+)\/assets-upload-session$/);
		if (m && method === 'POST') {
			let manifest: Record<string, { hash: string; size: number }> = {};
			try {
				const parsed = JSON.parse(bodyBuf.toString('utf8')) as { manifest?: Record<string, { hash: string; size: number }> };
				manifest = parsed.manifest ?? {};
			} catch {
				return this.error(res, 400, 10001, 'assets-upload-session: invalid JSON manifest');
			}
			const jwt = `upload-${(this.counter += 1)}`;
			this.uploadJwts.add(jwt);
			// Any hash not already stored must be uploaded; group as one bucket.
			const needed = Object.values(manifest)
				.map((entry) => entry.hash)
				.filter((hash) => !this.storedAssets.has(hash));
			const buckets = needed.length > 0 ? [needed] : [];
			return this.envelope(res, 200, { jwt, buckets });
		}

		// --- Workers for Platforms: assets upload (JWT auth) -------------------
		if (assetsUpload) {
			if (!uploadAuth) return this.error(res, 401, 10000, 'assets upload requires the upload-session JWT');
			const contentType = req.headers['content-type'] ?? '';
			const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
			if (!boundary) return this.error(res, 400, 10001, 'assets upload: not multipart/form-data');
			const parts = parseMultipart(bodyBuf, boundary);
			if (parts.length === 0) return this.error(res, 400, 10001, 'assets upload: no files in form');
			for (const part of parts) {
				// Field name is the hash; value is base64 of the bytes.
				if (part.name) this.storedAssets.add(part.name);
			}
			// Completion token.
			const completion = `completion-${(this.counter += 1)}`;
			this.uploadJwts.add(completion);
			return this.envelope(res, 201, { jwt: completion });
		}

		// --- Workers for Platforms: script PUT/DELETE --------------------------
		m = rest.match(/^\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/([^/]+)$/);
		if (m) {
			const name = decodeURIComponent(m[1] ?? '');
			if (method === 'PUT') {
				const contentType = req.headers['content-type'] ?? '';
				const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
				if (!boundary) return this.error(res, 400, 10001, 'script upload: not multipart/form-data');
				const parts = parseMultipart(bodyBuf, boundary);
				const metadataPart = parts.find((p) => p.name === 'metadata');
				if (!metadataPart) return this.error(res, 400, 10001, 'script upload: missing metadata part');
				let metadata: Record<string, unknown>;
				try {
					metadata = JSON.parse(metadataPart.body.toString('utf8')) as Record<string, unknown>;
				} catch {
					return this.error(res, 400, 10001, 'script upload: metadata is not JSON');
				}
				const mainModule = typeof metadata['main_module'] === 'string' ? (metadata['main_module'] as string) : '';
				const modulePart = parts.find((p) => p.name === mainModule);
				if (!mainModule || !modulePart) {
					return this.error(res, 400, 10001, 'script upload: missing main module part');
				}
				const assets = (metadata['assets'] ?? null) as { jwt?: unknown; config?: unknown } | null;
				// If assets are declared, the completion JWT must be one the stub minted.
				if (assets && !(typeof assets.jwt === 'string' && this.uploadJwts.has(assets.jwt))) {
					return this.error(res, 400, 10001, 'script upload: assets.jwt is not a valid completion token');
				}
				this.scripts.set(name, {
					name,
					metadata,
					bindings: Array.isArray(metadata['bindings']) ? (metadata['bindings'] as unknown[]) : [],
					assets,
					mainModule,
					hasModule: true,
				});
				return this.envelope(res, 200, { id: name });
			}
			if (method === 'DELETE') {
				if (!this.scripts.has(name)) return this.error(res, 404, 10007, 'script not found');
				this.scripts.delete(name);
				return this.envelope(res, 200, null);
			}
		}

		// --- D1 ----------------------------------------------------------------
		if (rest.match(/^\/accounts\/[^/]+\/d1\/database$/) && method === 'POST') {
			let name = '';
			try {
				name = (JSON.parse(bodyBuf.toString('utf8')) as { name?: string }).name ?? '';
			} catch {
				return this.error(res, 400, 10001, 'd1 create: invalid JSON');
			}
			if (!name) return this.error(res, 400, 10001, 'd1 create: name required');
			const id = `d1-${(this.counter += 1)}`;
			this.databases.set(id, { id, name, executedSql: [] });
			return this.envelope(res, 200, { uuid: id, name });
		}
		m = rest.match(/^\/accounts\/[^/]+\/d1\/database\/([^/]+)$/);
		if (m && method === 'DELETE') {
			const id = decodeURIComponent(m[1] ?? '');
			if (!this.databases.has(id)) return this.error(res, 404, 10007, 'd1 database not found');
			this.databases.delete(id);
			return this.envelope(res, 200, null);
		}
		m = rest.match(/^\/accounts\/[^/]+\/d1\/database\/([^/]+)\/query$/);
		if (m && method === 'POST') {
			const id = decodeURIComponent(m[1] ?? '');
			const db = this.databases.get(id);
			if (!db) return this.error(res, 404, 10007, 'd1 database not found');
			let payload: { sql?: string; params?: unknown[] };
			try {
				payload = JSON.parse(bodyBuf.toString('utf8')) as { sql?: string; params?: unknown[] };
			} catch {
				return this.error(res, 400, 10001, 'd1 query: invalid JSON');
			}
			const statements = (payload.sql ?? '').split(';').map((s) => s.trim()).filter((s) => s.length > 0);
			for (const sql of statements) db.executedSql.push(sql);
			// One result entry per statement, mirroring the real batch shape.
			const result = statements.map((sql) => ({
				results: /^select/i.test(sql) ? [{ ok: 1 }] : [],
				meta: { changes: 0, last_row_id: 0, rows_read: 0, rows_written: 0 },
				success: true,
			}));
			return this.envelope(res, 200, result);
		}

		// --- KV ----------------------------------------------------------------
		m = rest.match(/^\/accounts\/[^/]+\/storage\/kv\/namespaces\/[^/]+\/values\/(.+)$/);
		if (m) {
			const key = decodeURIComponent(m[1] ?? '');
			if (method === 'PUT') {
				this.kv.set(key, bodyBuf.toString('utf8'));
				return this.envelope(res, 200, null);
			}
			if (method === 'DELETE') {
				this.kv.delete(key);
				return this.envelope(res, 200, null);
			}
		}

		// --- custom hostnames --------------------------------------------------
		if (rest.match(/^\/zones\/[^/]+\/custom_hostnames$/) && method === 'POST') {
			let hostname = '';
			try {
				hostname = (JSON.parse(bodyBuf.toString('utf8')) as { hostname?: string }).hostname ?? '';
			} catch {
				return this.error(res, 400, 10001, 'custom_hostnames: invalid JSON');
			}
			if (!hostname) return this.error(res, 400, 10001, 'custom_hostnames: hostname required');
			const id = `ch-${(this.counter += 1)}`;
			this.hostnames.set(id, { id, hostname, status: 'pending', sslStatus: 'pending_validation', deleted: false });
			return this.envelope(res, 201, {
				id,
				hostname,
				status: 'pending',
				verification_errors: ['custom hostname does not CNAME to this zone.'],
				ownership_verification_http: {
					http_url: `http://${hostname}/.well-known/cf-custom-hostname-challenge/${id}`,
					http_body: `token-${id}`,
				},
				ssl: {
					status: 'pending_validation',
					method: 'http',
					type: 'dv',
					validation_records: [
						{ http_url: `http://${hostname}/.well-known/pki-validation/ca.txt`, http_body: `dcv-${id}` },
					],
				},
			});
		}
		m = rest.match(/^\/zones\/[^/]+\/custom_hostnames\/([^/]+)$/);
		if (m) {
			const id = decodeURIComponent(m[1] ?? '');
			const ch = this.hostnames.get(id);
			if (method === 'GET') {
				if (!ch || ch.deleted) return this.error(res, 404, 10007, 'custom hostname not found');
				// Second read: validation completed (status/ssl active).
				ch.status = 'active';
				ch.sslStatus = 'active';
				return this.envelope(res, 200, {
					id: ch.id,
					hostname: ch.hostname,
					status: ch.status,
					verification_errors: [],
					ssl: { status: ch.sslStatus, method: 'http', type: 'dv', validation_records: [] },
				});
			}
			if (method === 'DELETE') {
				if (!ch || ch.deleted) return this.error(res, 404, 10007, 'custom hostname not found');
				ch.deleted = true;
				this.hostnames.delete(id);
				return this.envelope(res, 200, { id });
			}
		}

		// --- URL Scanner (flat responses, 404 while pending) -------------------
		if (rest.match(/^\/accounts\/[^/]+\/urlscanner\/v2\/scan$/) && method === 'POST') {
			let scanUrl = '';
			try {
				scanUrl = (JSON.parse(bodyBuf.toString('utf8')) as { url?: string }).url ?? '';
			} catch {
				return this.error(res, 400, 10001, 'urlscanner: invalid JSON');
			}
			if (!scanUrl) return this.error(res, 400, 10001, 'urlscanner: url required');
			const uuid = `scan-${(this.counter += 1)}`;
			this.scans.set(uuid, { uuid, url: scanUrl, malicious: scanUrl.includes(this.maliciousMarker), polls: 0 });
			// Flat response (no envelope), as the real submit endpoint returns.
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ uuid, api: `${this.url}/client/v4/accounts/x/urlscanner/v2/result/${uuid}`, visibility: 'unlisted', url: scanUrl, message: 'Submission successful' }));
			return;
		}
		m = rest.match(/^\/accounts\/[^/]+\/urlscanner\/v2\/result\/([^/]+)$/);
		if (m && method === 'GET') {
			const uuid = decodeURIComponent(m[1] ?? '');
			const scan = this.scans.get(uuid);
			if (!scan) return this.error(res, 404, 10007, 'scan not found');
			scan.polls += 1;
			// First poll: still running -> 404 (pending). Subsequent polls: done.
			if (scan.polls < 2) return this.error(res, 404, 10007, 'scan in progress');
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					task: { uuid: scan.uuid, url: scan.url, success: true, status: 'Finished' },
					verdicts: { overall: { malicious: scan.malicious, categories: scan.malicious ? ['phishing'] : [] } },
					meta: { processors: { domainCategories: [] } },
				}),
			);
			return;
		}

		return this.error(res, 404, 10007, `stub: no route for ${method} ${rest}`);
	}
}

// --- minimal multipart/form-data parser ------------------------------------------

interface MultipartPart {
	name: string;
	filename: string | null;
	body: Buffer;
}

/**
 * Parse a multipart/form-data body into its named parts. Narrow and test-only:
 * it reads just enough of RFC 7578 (the `name=` and `filename=` of each
 * Content-Disposition header, CRLF-delimited headers, boundary framing) to let
 * the stub assert the adapter sent a well-formed `metadata` part, a module
 * part and the asset fields. Not a general-purpose parser.
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
	const delimiter = Buffer.from(`--${boundary}`);
	const parts: MultipartPart[] = [];
	let index = body.indexOf(delimiter);
	if (index === -1) return parts;
	index += delimiter.length;
	while (index < body.length) {
		// After a delimiter: either `--` (final) or CRLF then the part.
		if (body[index] === 0x2d && body[index + 1] === 0x2d) break; // closing "--"
		if (body[index] === 0x0d && body[index + 1] === 0x0a) index += 2;
		const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), index);
		if (headerEnd === -1) break;
		const headerText = body.subarray(index, headerEnd).toString('utf8');
		const bodyStart = headerEnd + 4;
		const nextDelim = body.indexOf(delimiter, bodyStart);
		if (nextDelim === -1) break;
		// The part body ends with a trailing CRLF before the next delimiter.
		let bodyEnd = nextDelim;
		if (body[bodyEnd - 2] === 0x0d && body[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
		const disposition = /name="([^"]*)"/i.exec(headerText);
		const filename = /filename="([^"]*)"/i.exec(headerText);
		parts.push({
			name: disposition?.[1] ?? '',
			filename: filename?.[1] ?? null,
			body: body.subarray(bodyStart, bodyEnd),
		});
		index = nextDelim + delimiter.length;
	}
	return parts;
}

/** Exposed for a test that wants to compute an expected manifest hash. */
export { assetHash as stubAssetHash };
