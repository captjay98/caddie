import type { AppRoute } from '@caddie/contracts';
import {
	AppHostError,
	type AppHost,
	type AppHostBinding,
	type AppHostDeployInput,
	type AppHostFile,
	type CustomHostnameState,
	type ScanResult,
} from '../app-host.ts';

/**
 * P08-publish Cloudflare app-host adapter — the REST API v4 implementation of
 * the `AppHost` port (apps/app/src/server/app-host.ts). Caddie hosts users'
 * published apps on ITS OWN account:
 *
 *   - each app is one user Worker in a Workers for Platforms dispatch namespace,
 *   - each app has one D1 database,
 *   - the dispatch Worker routes by hostname from a KV namespace
 *     (`route:<hostname>` -> JSON AppRoute),
 *   - "Connect my domain" uses Cloudflare for SaaS custom hostnames on the apps
 *     zone (HTTP DCV),
 *   - the URL Scanner gate scans an app before it goes live.
 *
 * Fetch-only (WebCrypto + global fetch + FormData), so the same code runs inside
 * a Worker; there are no Node APIs on the production path. The base URL and the
 * fetch impl are injectable so the local stub (tests/fixtures/cloudflare-stub.ts,
 * bound to 127.0.0.1) stands in for api.cloudflare.com exactly like production.
 *
 * Every method cites the Cloudflare doc it was written against, marked VERIFIED
 * (read 2026-10-17) or UNVERIFIED. The secret API token lives ONLY in the
 * Authorization header and is never placed in an error, a log or a URL.
 */

/** Env inputs this adapter owns (PROPOSED addition to app.ts Env). */
export interface CloudflareEnv {
	/** REST API base. Defaults to https://api.cloudflare.com/client/v4. */
	CLOUDFLARE_API_BASE?: string;
	/** Account-scoped API token (owner secret; Authorization header only). */
	CLOUDFLARE_API_TOKEN?: string;
	/** Caddie's own Cloudflare account id. */
	CLOUDFLARE_ACCOUNT_ID?: string;
	/** Workers for Platforms dispatch namespace holding every user Worker. */
	CLOUDFLARE_DISPATCH_NAMESPACE?: string;
	/** KV namespace id the dispatch Worker reads routes from. */
	CLOUDFLARE_ROUTES_KV_ID?: string;
	/** Zone id of the apps domain (custom hostnames live here). */
	CLOUDFLARE_APPS_ZONE_ID?: string;
	/** Test seam; production uses global fetch. */
	fetchImpl?: typeof fetch;
}

export const DEFAULT_CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Per-call outbound budget; a stalled socket aborts into a typed TIMEOUT. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Fully-resolved, non-secret-free configuration for the adapter. */
export interface CloudflareConfig {
	baseUrl: string;
	apiToken: string;
	accountId: string;
	dispatchNamespace: string;
	routesKvId: string;
	appsZoneId: string;
}

/**
 * Read the adapter's configuration from env, FAIL-CLOSED: a blank or
 * half-configured state is a typed `NOT_CONFIGURED` (503) naming the exact
 * missing variables, never a silent fallback. The adapter is only ever
 * selected with its full credential set (matches the GitHub adapter's
 * fail-closed contract).
 */
export function readCloudflareConfig(env: Partial<CloudflareEnv>): CloudflareConfig {
	const apiToken = (env.CLOUDFLARE_API_TOKEN ?? '').trim();
	const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
	const dispatchNamespace = (env.CLOUDFLARE_DISPATCH_NAMESPACE ?? '').trim();
	const routesKvId = (env.CLOUDFLARE_ROUTES_KV_ID ?? '').trim();
	const appsZoneId = (env.CLOUDFLARE_APPS_ZONE_ID ?? '').trim();
	const missing = [
		...(apiToken ? [] : ['CLOUDFLARE_API_TOKEN']),
		...(accountId ? [] : ['CLOUDFLARE_ACCOUNT_ID']),
		...(dispatchNamespace ? [] : ['CLOUDFLARE_DISPATCH_NAMESPACE']),
		...(routesKvId ? [] : ['CLOUDFLARE_ROUTES_KV_ID']),
		...(appsZoneId ? [] : ['CLOUDFLARE_APPS_ZONE_ID']),
	];
	if (missing.length > 0) {
		throw new AppHostError(
			'NOT_CONFIGURED',
			`Cloudflare app hosting is not configured: ${missing.join(', ')} must be set together. ` +
				'Refusing to guess — a half-configured host would look intentional while no app could be published.',
			503,
		);
	}
	return {
		baseUrl: (env.CLOUDFLARE_API_BASE ?? '').trim() || DEFAULT_CLOUDFLARE_API_BASE,
		apiToken,
		accountId,
		dispatchNamespace,
		routesKvId,
		appsZoneId,
	};
}

// --- validation ----------------------------------------------------------------

const SCRIPT_NAME_PATTERN = /^[a-z0-9-]{1,63}$/;

/** Script names in the dispatch namespace: [a-z0-9-], at most 63 chars. */
function assertScriptName(script: string): void {
	if (!SCRIPT_NAME_PATTERN.test(script)) {
		throw new AppHostError(
			'INVALID_INPUT',
			`invalid Worker script name "${script}": must be 1-63 characters of a-z, 0-9 and hyphen`,
			400,
		);
	}
}

// --- error classification ------------------------------------------------------

function codeForStatus(status: number): AppHostError['code'] {
	if (status === 401 || status === 403) return 'UNAUTHORIZED';
	if (status === 404) return 'NOT_FOUND';
	if (status === 409) return 'CONFLICT';
	if (status === 429) return 'RATE_LIMITED';
	if (status === 400 || status === 422) return 'INVALID_INPUT';
	if (status >= 500) return 'UPSTREAM';
	// Any other non-2xx (e.g. 405, 410) is an upstream protocol surprise.
	return 'UPSTREAM';
}

/** Cloudflare's standard envelope: { success, errors:[{code,message}], result }. */
interface CloudflareEnvelope<T> {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	messages?: unknown;
	result?: T;
}

/** First Cloudflare error code + message, for carrying into AppHostError. */
function firstError(body: unknown): { code?: number; message: string } {
	if (body && typeof body === 'object') {
		const errors = (body as CloudflareEnvelope<unknown>).errors;
		if (Array.isArray(errors) && errors.length > 0) {
			const first = errors[0] ?? {};
			return {
				code: typeof first.code === 'number' ? first.code : undefined,
				message: typeof first.message === 'string' && first.message ? first.message : 'Cloudflare reported an error',
			};
		}
		// URL Scanner and some newer endpoints return a flat { message }.
		const flat = (body as { message?: unknown }).message;
		if (typeof flat === 'string' && flat) return { message: flat };
	}
	return { message: 'Cloudflare reported an error with no detail' };
}

// --- the adapter ---------------------------------------------------------------

type RawBody = string | FormData | undefined;

/**
 * The subset of `fetch` the adapter calls. Narrower than `typeof fetch` (which
 * carries `preconnect`), so a plain wrapper or a test double satisfies it; the
 * DOM global `fetch` is assignable to it.
 */
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CloudflareAppHost implements AppHost {
	private readonly config: CloudflareConfig;
	private readonly doFetch: FetchLike;

	constructor(config: CloudflareConfig, deps: { fetchImpl?: FetchLike } = {}) {
		this.config = config;
		this.doFetch = deps.fetchImpl ?? ((input, init) => fetch(input, init));
	}

	static fromEnv(env: Partial<CloudflareEnv>): CloudflareAppHost {
		return new CloudflareAppHost(readCloudflareConfig(env), { fetchImpl: env.fetchImpl });
	}

	/**
	 * One authenticated REST call. `authToken` overrides the account token for
	 * the asset-upload leg (which uses the short-lived upload-session JWT, per
	 * the direct-upload docs). Returns the parsed body for any 2xx; throws a
	 * typed AppHostError for everything else, carrying Cloudflare's own first
	 * error code and message — never the token.
	 */
	private async call(
		method: string,
		path: string,
		options: {
			body?: RawBody;
			contentType?: string;
			authToken?: string;
			/** Treat 404 as `null` instead of throwing (idempotent deletes/polls). */
			notFoundIsNull?: boolean;
			timeoutMs?: number;
		} = {},
	): Promise<unknown> {
		const res = await this.send(method, path, options);
		if (res.status === 404 && options.notFoundIsNull) return null;
		const parsed = await this.parse(res);
		if (res.status >= 200 && res.status < 300) {
			// Standard envelope reports success:false even on a 200 for some endpoints.
			if (parsed && typeof parsed === 'object' && (parsed as CloudflareEnvelope<unknown>).success === false) {
				const { code, message } = firstError(parsed);
				throw new AppHostError('UPSTREAM', `Cloudflare ${method} ${path} reported failure: ${message}`, 502, code);
			}
			return parsed;
		}
		const { code, message } = firstError(parsed);
		throw new AppHostError(
			codeForStatus(res.status),
			`Cloudflare ${method} ${path} -> HTTP ${res.status}: ${message}`,
			res.status,
			code,
		);
	}

	/** Transport layer: builds headers, applies the timeout, maps aborts to TIMEOUT. */
	private async send(
		method: string,
		path: string,
		options: { body?: RawBody; contentType?: string; authToken?: string; timeoutMs?: number },
	): Promise<Response> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${options.authToken ?? this.config.apiToken}`,
		};
		// FormData sets its own multipart boundary; never set content-type for it.
		if (options.contentType && !(options.body instanceof FormData)) {
			headers['content-type'] = options.contentType;
		}
		try {
			return await this.doFetch(`${this.config.baseUrl}${path}`, {
				method,
				headers,
				body: options.body,
				signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			});
		} catch (error) {
			const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
			throw new AppHostError(
				timedOut ? 'TIMEOUT' : 'UPSTREAM',
				timedOut
					? `Cloudflare ${method} ${path} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
					: `Cloudflare ${method} ${path} failed before a response arrived: ${String(error)}`,
				timedOut ? 504 : 502,
			);
		}
	}

	private async parse(res: Response): Promise<unknown> {
		const text = await res.text();
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	private get account(): string {
		return encodeURIComponent(this.config.accountId);
	}

	// --- Workers for Platforms: user Worker + assets ---------------------------
	//
	// Script upload: multipart PUT with a `metadata` JSON part + module part(s).
	// Static assets: assets-upload-session -> upload buckets -> completion JWT.
	// VERIFIED 2026-10-17:
	//   https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/
	//   https://developers.cloudflare.com/workers/static-assets/direct-upload/
	//   https://developers.cloudflare.com/workers/configuration/multipart-upload-metadata/

	async deploy(input: AppHostDeployInput): Promise<{ script: string }> {
		assertScriptName(input.script);
		assertAssets(input.assets);

		const completionJwt = await this.uploadAssets(input.script, input.assets);
		const mainModule = 'index.js';
		const metadata = {
			main_module: mainModule,
			compatibility_date: input.compatibilityDate,
			compatibility_flags: input.compatibilityFlags,
			tags: input.tags,
			bindings: input.bindings.map(toBindingJson).concat([{ type: 'assets', name: 'ASSETS' }]),
			assets: {
				jwt: completionJwt,
				config: {
					// Unknown non-/api paths fall back to index.html (SPA); /api/* hits
					// the Worker first. VERIFIED (static-assets routing docs).
					not_found_handling: 'single-page-application',
					run_worker_first: ['/api/*'],
				},
			},
		};

		const form = new FormData();
		form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
		// serverModule=null -> upload a minimal assets-only module that serves ASSETS.
		const moduleSource = input.serverModule ?? ASSETS_ONLY_MODULE;
		form.append(
			mainModule,
			new Blob([moduleSource], { type: 'application/javascript+module' }),
			mainModule,
		);

		await this.call(
			'PUT',
			`/accounts/${this.account}/workers/dispatch/namespaces/${encodeURIComponent(this.config.dispatchNamespace)}/scripts/${encodeURIComponent(input.script)}`,
			{ body: form },
		);
		return { script: input.script };
	}

	/**
	 * Run the three-step assets flow and return the deployment completion JWT.
	 * When the upload session returns empty `buckets`, its `jwt` IS the
	 * completion token and no bytes are uploaded (VERIFIED, direct-upload docs).
	 */
	private async uploadAssets(script: string, assets: AppHostFile[]): Promise<string> {
		const manifest: Record<string, { hash: string; size: number }> = {};
		const byHash = new Map<string, AppHostFile>();
		for (const file of assets) {
			const hash = await assetHash(file);
			manifest[file.path] = { hash, size: file.bytes.byteLength };
			byHash.set(hash, file);
		}

		const session = (await this.call(
			'POST',
			`/accounts/${this.account}/workers/dispatch/namespaces/${encodeURIComponent(this.config.dispatchNamespace)}/scripts/${encodeURIComponent(script)}/assets-upload-session`,
			{ body: JSON.stringify({ manifest }), contentType: 'application/json' },
		)) as CloudflareEnvelope<{ jwt?: unknown; buckets?: unknown }> | null;

		const result = (session?.result ?? {}) as { jwt?: unknown; buckets?: unknown };
		const uploadJwt = typeof result.jwt === 'string' ? result.jwt : '';
		const buckets = Array.isArray(result.buckets) ? (result.buckets as unknown[]) : [];
		if (!uploadJwt) {
			throw new AppHostError('UPSTREAM', 'Cloudflare assets-upload-session returned no jwt', 502);
		}
		if (buckets.length === 0) return uploadJwt;

		// Upload each bucket; the completion JWT comes back on the final 201.
		let completionJwt = '';
		for (const bucket of buckets) {
			const hashes = Array.isArray(bucket) ? (bucket as unknown[]).filter((h): h is string => typeof h === 'string') : [];
			const form = new FormData();
			for (const hash of hashes) {
				const file = byHash.get(hash);
				if (!file) {
					throw new AppHostError('UPSTREAM', `Cloudflare asset upload asked for an unknown hash`, 502);
				}
				form.append(hash, new Blob([base64(file.bytes)], { type: file.contentType }), hash);
			}
			const uploaded = (await this.call('POST', `/accounts/${this.account}/workers/assets/upload?base64=true`, {
				body: form,
				authToken: uploadJwt,
			})) as CloudflareEnvelope<{ jwt?: unknown }> | null;
			const jwt = (uploaded?.result as { jwt?: unknown } | undefined)?.jwt;
			if (typeof jwt === 'string' && jwt) completionJwt = jwt;
		}
		if (!completionJwt) {
			throw new AppHostError('UPSTREAM', 'Cloudflare asset upload finished without a completion token', 502);
		}
		return completionJwt;
	}

	async removeScript(script: string): Promise<void> {
		assertScriptName(script);
		// DELETE a user Worker; 404 means it is already gone (idempotent).
		// VERIFIED: WFP scripts DELETE endpoint.
		await this.call(
			'DELETE',
			`/accounts/${this.account}/workers/dispatch/namespaces/${encodeURIComponent(this.config.dispatchNamespace)}/scripts/${encodeURIComponent(script)}?force=true`,
			{ notFoundIsNull: true },
		);
	}

	// --- D1 --------------------------------------------------------------------
	//
	// VERIFIED 2026-10-17:
	//   POST   /accounts/{a}/d1/database            create
	//   DELETE /accounts/{a}/d1/database/{id}        delete
	//   POST   /accounts/{a}/d1/database/{id}/query  query
	// A single `sql` may hold several statements joined by `;`, executed as one
	// batch; `result` is an array (one entry per statement) of
	// { results, meta, success }. We send ALL statements in ONE request by
	// joining them so they run atomically in order.

	async createDatabase(name: string): Promise<{ id: string }> {
		const body = (await this.call('POST', `/accounts/${this.account}/d1/database`, {
			body: JSON.stringify({ name }),
			contentType: 'application/json',
		})) as CloudflareEnvelope<{ uuid?: unknown }> | null;
		const id = (body?.result as { uuid?: unknown } | undefined)?.uuid;
		if (typeof id !== 'string' || !id) {
			throw new AppHostError('UPSTREAM', 'Cloudflare D1 create returned no database id', 502);
		}
		return { id };
	}

	async deleteDatabase(id: string): Promise<void> {
		// 404 = already deleted (idempotent).
		await this.call('DELETE', `/accounts/${this.account}/d1/database/${encodeURIComponent(id)}`, {
			notFoundIsNull: true,
		});
	}

	async query(
		databaseId: string,
		statements: { sql: string; params?: unknown[] }[],
	): Promise<Record<string, unknown>[][]> {
		if (statements.length === 0) return [];
		// The D1 query body accepts ONE { sql, params } object; `sql` may carry
		// several statements joined by `;` run as a batch IN ORDER. Positional
		// params bind across the whole batch, so we only use batch params when
		// EVERY statement is parameterless (the common migration-DDL case) or
		// when there is a single statement. A mix of parameterised statements in
		// one request cannot be expressed by this endpoint, so we refuse it
		// rather than silently misbinding.
		const anyParams = statements.some((s) => (s.params?.length ?? 0) > 0);
		if (statements.length > 1 && anyParams) {
			throw new AppHostError(
				'INVALID_INPUT',
				'D1 batch query cannot carry per-statement params in one request; send parameterised statements one at a time',
				400,
			);
		}
		const sql = statements.map((s) => s.sql).join(';\n');
		const params = statements.length === 1 ? (statements[0]?.params ?? []) : [];
		const body = (await this.call('POST', `/accounts/${this.account}/d1/database/${encodeURIComponent(databaseId)}/query`, {
			body: JSON.stringify({ sql, params }),
			contentType: 'application/json',
		})) as CloudflareEnvelope<Array<{ results?: unknown }>> | null;
		const result = Array.isArray(body?.result) ? body.result : [];
		return result.map((entry) => {
			const rows = (entry as { results?: unknown }).results;
			return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
		});
	}

	// --- KV routes -------------------------------------------------------------
	//
	// VERIFIED: KV write/delete by key value endpoints.
	//   PUT/DELETE /accounts/{a}/storage/kv/namespaces/{ns}/values/{key}

	async putRoute(hostname: string, route: AppRoute): Promise<void> {
		await this.call('PUT', this.routePath(hostname), {
			body: JSON.stringify(route),
			contentType: 'text/plain',
		});
	}

	async deleteRoute(hostname: string): Promise<void> {
		// A missing key is already-absent; KV returns 200 either way, but treat
		// 404 as success defensively.
		await this.call('DELETE', this.routePath(hostname), { notFoundIsNull: true });
	}

	private routePath(hostname: string): string {
		const key = `route:${hostname.toLowerCase()}`;
		return `/accounts/${this.account}/storage/kv/namespaces/${encodeURIComponent(this.config.routesKvId)}/values/${encodeURIComponent(key)}`;
	}

	// --- Cloudflare for SaaS custom hostnames ----------------------------------
	//
	// VERIFIED 2026-10-17:
	//   POST   /zones/{z}/custom_hostnames        create (ssl.method:'http', type:'dv')
	//   GET    /zones/{z}/custom_hostnames/{id}    read
	//   DELETE /zones/{z}/custom_hostnames/{id}    delete
	// Response carries status, ssl.status, ssl.validation_records (http_url/
	// http_body for HTTP DCV), ownership_verification{_http} and
	// verification_errors.

	async createHostname(hostname: string): Promise<CustomHostnameState> {
		const body = (await this.call('POST', `/zones/${encodeURIComponent(this.config.appsZoneId)}/custom_hostnames`, {
			body: JSON.stringify({ hostname, ssl: { method: 'http', type: 'dv' } }),
			contentType: 'application/json',
		})) as CloudflareEnvelope<unknown> | null;
		return hostnameStateFrom(body?.result, hostname);
	}

	async getHostname(id: string): Promise<CustomHostnameState> {
		const body = (await this.call(
			'GET',
			`/zones/${encodeURIComponent(this.config.appsZoneId)}/custom_hostnames/${encodeURIComponent(id)}`,
		)) as CloudflareEnvelope<unknown> | null;
		return hostnameStateFrom(body?.result, '');
	}

	async deleteHostname(id: string): Promise<void> {
		await this.call(
			'DELETE',
			`/zones/${encodeURIComponent(this.config.appsZoneId)}/custom_hostnames/${encodeURIComponent(id)}`,
			{ notFoundIsNull: true },
		);
	}

	// --- URL Scanner -----------------------------------------------------------
	//
	// VERIFIED 2026-10-17: https://developers.cloudflare.com/radar/investigate/url-scanner/
	//   POST /accounts/{a}/urlscanner/v2/scan            submit (visibility:'Unlisted') -> { uuid, api, ... }
	//   GET  /accounts/{a}/urlscanner/v2/result/{id}      404 WHILE IN PROGRESS, 200 done
	// Done body is a FLAT object (no success/result envelope): verdicts.overall.malicious,
	// meta.processors.domainCategories, and `api` is the sibling of the human report URL.

	async scanUrl(url: string): Promise<{ scanId: string }> {
		const body = (await this.call('POST', `/accounts/${this.account}/urlscanner/v2/scan`, {
			body: JSON.stringify({ url, visibility: 'Unlisted' }),
			contentType: 'application/json',
		})) as unknown;
		// Submit may answer flat ({ uuid }) or enveloped ({ result: { uuid } }).
		const flat = (body ?? {}) as { uuid?: unknown; result?: { uuid?: unknown } };
		const scanId = typeof flat.uuid === 'string' ? flat.uuid : typeof flat.result?.uuid === 'string' ? flat.result.uuid : '';
		if (!scanId) {
			throw new AppHostError('UPSTREAM', 'Cloudflare URL Scanner submit returned no scan id', 502);
		}
		return { scanId };
	}

	async scanResult(scanId: string): Promise<ScanResult> {
		const body = (await this.call(
			'GET',
			`/accounts/${this.account}/urlscanner/v2/result/${encodeURIComponent(scanId)}`,
			{ notFoundIsNull: true },
		)) as unknown;
		// 404 while the scan is still running -> pending.
		if (body === null) return { state: 'pending' };
		const flat = (body ?? {}) as {
			result?: unknown;
			verdicts?: { overall?: { malicious?: unknown; categories?: unknown } };
			meta?: { processors?: { domainCategories?: unknown } };
			task?: { uuid?: unknown };
		};
		// Accept either the flat doc or an enveloped { result: <doc> }.
		const doc = (flat.result && typeof flat.result === 'object' ? flat.result : flat) as {
			verdicts?: { overall?: { malicious?: unknown; categories?: unknown } };
			meta?: { processors?: { domainCategories?: unknown } };
			task?: { uuid?: unknown };
		};
		const overall = doc.verdicts?.overall ?? {};
		const malicious = overall.malicious === true;
		const categories = extractCategories(overall.categories, doc.meta?.processors?.domainCategories);
		const uuid = typeof doc.task?.uuid === 'string' ? doc.task.uuid : scanId;
		return {
			state: 'done',
			malicious,
			categories,
			reportUrl: uuid ? `https://radar.cloudflare.com/scan/${uuid}` : null,
		};
	}
}

// --- helpers -------------------------------------------------------------------

/** Validate the assets include the SPA entry the dispatch routing needs. */
function assertAssets(assets: AppHostFile[]): void {
	if (!assets.some((f) => f.path === '/index.html')) {
		throw new AppHostError('INVALID_INPUT', 'assets must include /index.html for single-page-application fallback', 400);
	}
}

/**
 * The manifest hash wrangler uses: sha256 of (base64(bytes) + extension),
 * hex, first 32 chars. VERIFIED 2026-10-17 against the direct-upload docs and
 * cloudflare-typescript example (createManifest).
 */
async function assetHash(file: AppHostFile): Promise<string> {
	const dot = file.path.lastIndexOf('.');
	const slash = file.path.lastIndexOf('/');
	const extension = dot > slash ? file.path.slice(dot + 1) : '';
	const input = `${base64(file.bytes)}${extension}`;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return hex.slice(0, 32);
}

/** Workers-safe base64 of raw bytes (no Buffer). */
function base64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/** Map a port binding to Cloudflare's metadata binding JSON. */
function toBindingJson(binding: AppHostBinding): Record<string, unknown> {
	switch (binding.type) {
		case 'd1':
			return { type: 'd1', name: binding.name, id: binding.databaseId };
		case 'secret_text':
			return { type: 'secret_text', name: binding.name, text: binding.text };
		case 'plain_text':
			return { type: 'plain_text', name: binding.name, text: binding.text };
		case 'service':
			return {
				type: 'service',
				name: binding.name,
				service: binding.service,
				...(binding.entrypoint ? { entrypoint: binding.entrypoint } : {}),
			};
	}
}

/** A minimal module for a static-only app: every request serves env.ASSETS. */
const ASSETS_ONLY_MODULE = `export default { fetch(request, env) { return env.ASSETS.fetch(request); } };\n`;

/** Normalise a Cloudflare custom-hostname object into CustomHostnameState. */
function hostnameStateFrom(raw: unknown, fallbackHostname: string): CustomHostnameState {
	const ch = (raw ?? {}) as {
		id?: unknown;
		hostname?: unknown;
		status?: unknown;
		verification_errors?: unknown;
		ownership_verification?: { type?: unknown; name?: unknown; value?: unknown };
		ownership_verification_http?: { http_url?: unknown; http_body?: unknown };
		ssl?: {
			status?: unknown;
			validation_records?: Array<{
				txt_name?: unknown;
				txt_value?: unknown;
				http_url?: unknown;
				http_body?: unknown;
			}>;
			validation_errors?: Array<{ message?: unknown }>;
		};
	};
	const records: CustomHostnameState['validationRecords'] = [];
	// DCV records from ssl.validation_records (HTTP: http_url/http_body; TXT: txt_name/txt_value).
	for (const rec of ch.ssl?.validation_records ?? []) {
		if (typeof rec.http_url === 'string') {
			records.push({ type: 'http', name: rec.http_url, value: typeof rec.http_body === 'string' ? rec.http_body : '' });
		} else if (typeof rec.txt_name === 'string') {
			records.push({ type: 'TXT', name: rec.txt_name, value: typeof rec.txt_value === 'string' ? rec.txt_value : '' });
		}
	}
	// Ownership-verification record (CNAME to this zone proof).
	const ovh = ch.ownership_verification_http;
	if (ovh && typeof ovh.http_url === 'string') {
		records.push({ type: 'http', name: ovh.http_url, value: typeof ovh.http_body === 'string' ? ovh.http_body : '' });
	}
	const ov = ch.ownership_verification;
	if (ov && typeof ov.name === 'string') {
		records.push({
			type: typeof ov.type === 'string' ? ov.type : 'txt',
			name: ov.name,
			value: typeof ov.value === 'string' ? ov.value : '',
		});
	}
	const errors: string[] = [];
	if (Array.isArray(ch.verification_errors)) {
		for (const e of ch.verification_errors) if (typeof e === 'string') errors.push(e);
	}
	for (const e of ch.ssl?.validation_errors ?? []) {
		if (typeof e.message === 'string') errors.push(e.message);
	}
	return {
		id: typeof ch.id === 'string' ? ch.id : '',
		hostname: typeof ch.hostname === 'string' ? ch.hostname : fallbackHostname,
		status: typeof ch.status === 'string' ? ch.status : 'pending',
		sslStatus: typeof ch.ssl?.status === 'string' ? ch.ssl.status : 'initializing',
		validationRecords: records,
		errors,
	};
}

/** Collect scan categories from the overall verdict and/or domain categories. */
function extractCategories(overallCategories: unknown, domainCategories: unknown): string[] {
	const out = new Set<string>();
	const pull = (value: unknown): void => {
		if (!Array.isArray(value)) return;
		for (const entry of value) {
			if (typeof entry === 'string') out.add(entry);
			else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
				out.add((entry as { name: string }).name);
			}
		}
	};
	pull(overallCategories);
	pull(domainCategories);
	return [...out];
}
