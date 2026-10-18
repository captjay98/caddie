import type { AuthEnv } from '../auth.ts';

/**
 * P08 GitHub App REST adapter (feature-ledger C17 + H6). TRANSLATED from the
 * HackSteward reference (read-only: apps/api/src/hacksteward/adapters/
 * github_rest.py) — behavior, not code:
 *
 *   - App credentials come from dedicated env inputs and FAIL CLOSED: a blank
 *     or half-configured state is a typed configuration error, never a silent
 *     fallback (HackSteward: "a half-configured GitHub App would look
 *     intentional while no GitHub adapter can run").
 *   - Authentication is the GitHub App flow: a short-lived RS256 JWT signed
 *     with the App private key is exchanged for an installation token; tokens
 *     are cached until near-expiry and reissued when stale. Tokens are
 *     per-isolate memory only — never persisted, never echoed.
 *   - The private key material lives ONLY in env. Everything that leaves this
 *     module is a redacted fingerprint (sha256, truncated), and webhook
 *     verification fails closed without a secret.
 *   - Errors are classified into a bounded vocabulary (authentication /
 *     authorization / validation / rate-limited / provider error) so callers
 *     can distinguish "provably not applied" from "ambiguous".
 *
 * Workers-native: WebCrypto only (RSASSA-PKCS1-v1_5 + HMAC), no node:crypto in
 * the production path; the base URL is injectable so the local test stub
 * (127.0.0.1) stands in for api.github.com exactly like production will.
 */

/** Env inputs this packet owns (PROPOSED addition to app.ts Env). */
export interface GithubEnv extends AuthEnv {
	/** GitHub App id (the JWT `iss`). Required for install/import/export. */
	GITHUB_APP_ID?: string;
	/**
	 * GitHub App private key, PKCS#8 PEM ("BEGIN PRIVATE KEY"). A dedicated
	 * secret — never persisted, only its fingerprint is ever echoed.
	 */
	GITHUB_APP_PRIVATE_KEY?: string;
	/** Webhook signing secret (x-hub-signature-256). Required for webhooks. */
	GITHUB_WEBHOOK_SECRET?: string;
	/** API base override (local test stub). Defaults to https://api.github.com. */
	GITHUB_API_BASE_URL?: string;
	/**
	 * The GitHub App's public slug (the `/apps/<slug>` segment). OPTIONAL and
	 * decorative: used only to build the "Install on GitHub" link so the user
	 * can reach the App's own install page instead of pasting an installation
	 * id. Absent -> no link is offered (never a fabricated URL); binding still
	 * works via the id. The slug is not a credential.
	 */
	GITHUB_APP_SLUG?: string;
}

export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com';

/**
 * The public install URL for the configured GitHub App, or null when no slug is
 * configured. Honesty rule: we never fabricate a slug — an unconfigured slug
 * returns null and the UI falls back to the explicit install-then-paste path.
 */
export function githubInstallUrl(env: Partial<GithubEnv>): string | null {
	const slug = (env.GITHUB_APP_SLUG ?? '').trim();
	if (!slug || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug)) return null;
	return `https://github.com/apps/${slug}/installations/new`;
}

/** Typed GitHub failure. `code` is a bounded vocabulary, never raw transport text. */
export class GithubError extends Error {
	constructor(
		readonly status: number,
		readonly code:
			| 'GITHUB_NOT_CONFIGURED'
			| 'GITHUB_AUTHENTICATION'
			| 'GITHUB_AUTHORIZATION'
			| 'GITHUB_NOT_FOUND'
			| 'GITHUB_VALIDATION'
			| 'GITHUB_RATE_LIMITED'
			| 'GITHUB_PROVIDER_ERROR',
		message: string,
	) {
		super(message);
		this.name = 'GithubError';
	}
}

// --- config (fail-closed) ------------------------------------------------------

export interface GithubAppConfig {
	appId: string;
	privateKeyPem: string;
	webhookSecret: string | null;
	baseUrl: string;
}

/**
 * Read GitHub App credentials from env. Fail-closed per HackSteward behavior:
 * a blank config and a half-configured config are both typed errors — the
 * adapter is only ever selected with its full credential set.
 */
export function readGithubConfig(env: Partial<GithubEnv>): GithubAppConfig {
	const appId = (env.GITHUB_APP_ID ?? '').trim();
	const privateKeyPem = (env.GITHUB_APP_PRIVATE_KEY ?? '').trim();
	if (!appId || !privateKeyPem) {
		const missing = [
			...(appId ? [] : ['GITHUB_APP_ID']),
			...(privateKeyPem ? [] : ['GITHUB_APP_PRIVATE_KEY']),
		];
		throw new GithubError(
			503,
			'GITHUB_NOT_CONFIGURED',
			`GitHub App configuration is incomplete: ${missing.join(', ')} must be set together ` +
				'(dedicated secrets per docs/setup/github-app.md). Refusing to guess: a half-configured ' +
				'GitHub App would look intentional while no GitHub adapter can run.',
		);
	}
	return {
		appId,
		privateKeyPem,
		webhookSecret: (env.GITHUB_WEBHOOK_SECRET ?? '').trim() || null,
		baseUrl: (env.GITHUB_API_BASE_URL ?? '').trim() || DEFAULT_GITHUB_API_BASE,
	};
}

/** Redacted handle for the private key: sha256-<16 hex>. Never the key itself. */
export async function privateKeyFingerprint(pem: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pem));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `sha256-${hex.slice(0, 16)}`;
}

// --- webhook signature verification ------------------------------------------------

/** Constant-time equality over equal-length strings (hex signatures). */
function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Verify an x-hub-signature-256 header over the RAW request bytes.
 *
 * Fail-closed exactly like the HackSteward reference: without a configured
 * secret NO signature can be asserted valid. Header must be `sha256=<64 hex>`;
 * the comparison is constant-time.
 */
export async function verifyWebhookSignature(
	secret: string | null,
	payloadBytes: Uint8Array,
	signatureHeader: string | null | undefined,
): Promise<boolean> {
	if (!secret) return false;
	if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
	const provided = signatureHeader.slice('sha256='.length).toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(provided)) return false;
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	// Fresh ArrayBuffer-backed copy: crypto.subtle requires a non-shared buffer.
	const input = new Uint8Array(payloadBytes);
	const mac = await crypto.subtle.sign('HMAC', key, input);
	const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return timingSafeEqualHex(expected, provided);
}

// --- REST client ---------------------------------------------------------------------

export interface GithubInstallationInfo {
	installationId: string;
	accountLogin: string;
	permissions: Record<string, string>;
	appSlug: string;
	suspended: boolean;
}

export type GithubMergeMethod = 'merge' | 'squash' | 'rebase';

export interface GithubRepoInfo {
	fullName: string;
	defaultBranch: string;
	/**
	 * Merge methods the repo allows, or null when GitHub did not say (the
	 * allow_* flags are only returned to callers with push access).
	 */
	mergeMethods: Record<GithubMergeMethod, boolean> | null;
}

/** GitHub's answer to a merge request. Every other response is a thrown GithubError. */
export type GithubMergeOutcome =
	| { outcome: 'merged'; sha: string }
	/** 409: the head moved past the commit the merge was pinned to. */
	| { outcome: 'head-moved'; message: string }
	/** 405: GitHub will not merge (conflicts, branch protection, method not allowed). */
	| { outcome: 'not-mergeable'; message: string };

export interface GithubRepoCreated {
	fullName: string;
	htmlUrl: string;
	visibility: 'private' | 'public';
	/** The repo already existed under this account and was adopted, not created. */
	adopted: boolean;
}

export interface GithubCommitInfo {
	sha: string;
	treeSha: string;
	message: string;
	parents: string[];
}

export interface GithubTreeEntry {
	path: string;
	mode: string;
	type: 'blob' | 'tree' | 'commit';
	sha: string;
	size: number;
}

export interface GithubTreeInfo {
	sha: string;
	truncated: boolean;
	entries: GithubTreeEntry[];
}

export interface GithubPullRequestInfo {
	number: number;
	head: string;
	base: string;
	headSha: string;
	htmlUrl: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
/** Reissue an installation token when it is within this window of expiring. */
const TOKEN_REISSUE_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

// --- JWT encoding (workerd-safe: no node:crypto) -----------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
	const body = pem
		.replace(/-----BEGIN [^-]+-----/, '')
		.replace(/-----END [^-]+-----/, '')
		.replace(/\s+/g, '');
	let binary: string;
	try {
		binary = atob(body);
	} catch {
		throw new GithubError(503, 'GITHUB_NOT_CONFIGURED', 'GITHUB_APP_PRIVATE_KEY is not valid PEM');
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function signAppJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
	const nowSeconds = Math.floor(nowMs / 1000);
	const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
	const payload = base64UrlEncode(
		new TextEncoder().encode(
			JSON.stringify({
				iat: nowSeconds - JWT_BACKDATE_SECONDS,
				exp: nowSeconds + JWT_LIFETIME_SECONDS,
				iss: appId,
			}),
		),
	);
	let key: CryptoKey;
	try {
		key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKeyPem), {
			name: 'RSASSA-PKCS1-v1_5',
			hash: 'SHA-256',
		}, false, ['sign']);
	} catch {
		throw new GithubError(
			503,
			'GITHUB_NOT_CONFIGURED',
			'GITHUB_APP_PRIVATE_KEY must be a PKCS#8 PEM RSA key ("BEGIN PRIVATE KEY")',
		);
	}
	const signature = await crypto.subtle.sign(
		{ name: 'RSASSA-PKCS1-v1_5' },
		key,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// --- response classification (HackSteward outcome vocabulary) ------------------------

function classificationFor(status: number): GithubError['code'] {
	if (status === 401) return 'GITHUB_AUTHENTICATION';
	if (status === 403) return 'GITHUB_AUTHORIZATION';
	if (status === 404) return 'GITHUB_NOT_FOUND';
	if (status === 429) return 'GITHUB_RATE_LIMITED';
	if (status >= 500) return 'GITHUB_PROVIDER_ERROR';
	return 'GITHUB_VALIDATION';
}

function snippet(body: string): string {
	return body.slice(0, 200).replace(/\s+/g, ' ');
}

async function parseBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export interface GithubRequestOptions {
	/** 'app' = App JWT; otherwise an installation id whose token is used. */
	auth: 'app' | { installationId: string };
	body?: unknown;
	timeoutMs?: number;
}

/**
 * The GitHub REST surface this packet uses. Every call is authenticated (App
 * JWT for the app surface, installation token for repo surfaces); tokens are
 * cached until near-expiry and reissued when stale (HackSteward behavior).
 */
export class GithubRestClient {
	/** Exposed read-only so services can derive the redacted key fingerprint. */
	readonly config: GithubAppConfig;
	private readonly doFetch: FetchLike;
	private readonly nowMs: () => number;
	private readonly tokens = new Map<string, { token: string; expiresAtMs: number }>();

	constructor(
		config: GithubAppConfig,
		deps: { fetch?: FetchLike; nowMs?: () => number } = {},
	) {
		this.config = config;
		this.doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
		this.nowMs = deps.nowMs ?? (() => Date.now());
	}

	private async appJwt(): Promise<string> {
		return signAppJwt(this.config.appId, this.config.privateKeyPem, this.nowMs());
	}

	private async installationToken(installationId: string): Promise<string> {
		const cached = this.tokens.get(installationId);
		if (cached && cached.expiresAtMs - this.nowMs() > TOKEN_REISSUE_MARGIN_MS) {
			return cached.token;
		}
		const res = await this.requestRaw(
			'POST',
			`/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
			{ auth: 'app' },
		);
		const body = (await parseBody(res)) as { token?: unknown; expires_at?: unknown } | null;
		if (res.status !== 201 || !body || typeof body.token !== 'string' || !body.token) {
			const code = classificationFor(res.status);
			throw new GithubError(
				classificationStatus(code),
				code,
				`installation token mint failed for installation ${installationId}: HTTP ${res.status} ${snippet(JSON.stringify(body ?? null))}`,
			);
		}
		const expiresAtMs =
			typeof body.expires_at === 'string' && !Number.isNaN(Date.parse(body.expires_at))
				? Date.parse(body.expires_at)
				: this.nowMs() + 10 * 60_000;
		this.tokens.set(installationId, { token: body.token, expiresAtMs });
		return body.token;
	}

	private async requestRaw(
		method: string,
		path: string,
		options: GithubRequestOptions,
	): Promise<Response> {
		const headers: Record<string, string> = {
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
			'user-agent': 'caddie-forge',
		};
		if (options.auth === 'app') {
			headers.authorization = `Bearer ${await this.appJwt()}`;
		} else {
			headers.authorization = `Bearer ${await this.installationToken(options.auth.installationId)}`;
		}
		let body: string | undefined;
		if (options.body !== undefined) {
			body = JSON.stringify(options.body);
			headers['content-type'] = 'application/json';
		}
		try {
			return await this.doFetch(`${this.config.baseUrl}${path}`, {
				method,
				headers,
				body,
				signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			});
		} catch (error) {
			// Ambiguous transport failure — the write may have been applied. Never
			// classified as a definite rejection (HackSteward outcome vocabulary).
			throw new GithubError(
				504,
				'GITHUB_PROVIDER_ERROR',
				`github call failed before a response arrived (${method} ${path}): ${String(error)}`,
			);
		}
	}

	/** Authenticated REST call with typed classification of non-2xx responses. */
	async request(method: string, path: string, options: GithubRequestOptions): Promise<unknown> {
		const res = await this.requestRaw(method, path, options);
		if (res.status >= 200 && res.status < 300) return parseBody(res);
		const body = (await parseBody(res)) as { message?: unknown } | null;
		const message =
			body && typeof body.message === 'string' ? body.message : snippet(JSON.stringify(body ?? null));
		throw new GithubError(
			classificationStatus(classificationFor(res.status)),
			classificationFor(res.status),
			`github ${method} ${path} -> HTTP ${res.status}: ${message}`,
		);
	}

	// --- app surface -----------------------------------------------------------------

	async getInstallation(installationId: string): Promise<GithubInstallationInfo> {
		const body = (await this.request(
			'GET',
			`/app/installations/${encodeURIComponent(installationId)}`,
			{ auth: 'app' },
		)) as {
			id?: unknown;
			account?: { login?: unknown } | null;
			permissions?: unknown;
			app_slug?: unknown;
			suspended_at?: unknown;
		};
		const login = body.account && typeof body.account.login === 'string' ? body.account.login : '';
		return {
			installationId: String(body.id ?? installationId),
			accountLogin: login,
			permissions:
				body.permissions && typeof body.permissions === 'object'
					? (body.permissions as Record<string, string>)
					: {},
			appSlug: typeof body.app_slug === 'string' ? body.app_slug : '',
			suspended: typeof body.suspended_at === 'string' && body.suspended_at.length > 0,
		};
	}

	// --- repo surface ------------------------------------------------------------------

	async getRepo(installationId: string, fullName: string): Promise<GithubRepoInfo> {
		const body = (await this.request('GET', `/repos/${fullName}`, {
			auth: { installationId },
		})) as {
			full_name?: unknown;
			default_branch?: unknown;
			allow_merge_commit?: unknown;
			allow_squash_merge?: unknown;
			allow_rebase_merge?: unknown;
		};
		const flags = [body.allow_merge_commit, body.allow_squash_merge, body.allow_rebase_merge];
		return {
			fullName: typeof body.full_name === 'string' ? body.full_name : fullName,
			defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : 'main',
			mergeMethods: flags.every((flag) => typeof flag === 'boolean')
				? { merge: flags[0] === true, squash: flags[1] === true, rebase: flags[2] === true }
				: null,
		};
	}

	/**
	 * Create a NEW repo under the installation's account (org installation).
	 *
	 * Fail-closed, in order:
	 *   1. the installation must grant `administration: write` — without it the
	 *      App literally cannot create repos, so we refuse with a typed
	 *      authorization error (503-class) BEFORE any write call, instead of
	 *      letting GitHub 403 opaquely;
	 *   2. a name collision under the account is ADOPTED (returned with
	 *      adopted=true) rather than erroring — the user asked to end up with
	 *      this repo connected, and an existing one of the same name satisfies
	 *      that intent idempotently.
	 *
	 * Visibility maps to GitHub's `private` boolean. The repo is created under
	 * the installation's org (`POST /orgs/{login}/repos`); a user-account
	 * installation that is not an org is refused with a typed validation error
	 * (an App cannot create under a user account).
	 */
	async createRepository(
		installationId: string,
		input: { name: string; visibility: 'private' | 'public' },
	): Promise<GithubRepoCreated> {
		const installation = await this.getInstallation(installationId);
		if ((installation.permissions['administration'] ?? '') !== 'write') {
			throw new GithubError(
				503,
				'GITHUB_AUTHORIZATION',
				'the GitHub App needs the "administration: write" permission to create repositories — grant it on the App and re-install, then try again',
			);
		}
		const login = installation.accountLogin;
		if (!login) {
			throw new GithubError(503, 'GITHUB_VALIDATION', 'the installation has no account login to create a repo under');
		}
		const isPrivate = input.visibility === 'private';
		try {
			const body = (await this.request('POST', `/orgs/${encodeURIComponent(login)}/repos`, {
				auth: { installationId },
				body: { name: input.name, private: isPrivate, auto_init: true },
			})) as { full_name?: unknown; html_url?: unknown; private?: unknown };
			return {
				fullName: typeof body.full_name === 'string' ? body.full_name : `${login}/${input.name}`,
				htmlUrl: typeof body.html_url === 'string' ? body.html_url : '',
				visibility: body.private === false ? 'public' : isPrivate ? 'private' : 'public',
				adopted: false,
			};
		} catch (error) {
			// GitHub returns 422 when a repo of this name already exists on the
			// account; adopt it instead of failing (idempotent "end up connected").
			if (error instanceof GithubError && error.code === 'GITHUB_VALIDATION') {
				const existing = await this.getRepo(installationId, `${login}/${input.name}`);
				return {
					fullName: existing.fullName,
					htmlUrl: `https://github.com/${existing.fullName}`,
					visibility: input.visibility,
					adopted: true,
				};
			}
			throw error;
		}
	}

	async getCommit(installationId: string, fullName: string, ref: string): Promise<GithubCommitInfo> {
		const body = (await this.request('GET', `/repos/${fullName}/commits/${encodeURIComponent(ref)}`, {
			auth: { installationId },
		})) as {
			sha?: unknown;
			commit?: { message?: unknown; tree?: { sha?: unknown } };
			parents?: Array<{ sha?: unknown }>;
		};
		return {
			sha: String(body.sha ?? ''),
			treeSha: String(body.commit?.tree?.sha ?? ''),
			message: typeof body.commit?.message === 'string' ? body.commit.message : '',
			parents: (body.parents ?? []).map((p) => String(p.sha ?? '')),
		};
	}

	async getTree(installationId: string, fullName: string, sha: string): Promise<GithubTreeInfo> {
		const body = (await this.request('GET', `/repos/${fullName}/git/trees/${encodeURIComponent(sha)}?recursive=1`, {
			auth: { installationId },
		})) as { sha?: unknown; truncated?: unknown; tree?: unknown };
		const entries: GithubTreeEntry[] = [];
		if (Array.isArray(body.tree)) {
			for (const raw of body.tree) {
				const entry = raw as { path?: unknown; mode?: unknown; type?: unknown; sha?: unknown; size?: unknown };
				entries.push({
					path: String(entry.path ?? ''),
					mode: String(entry.mode ?? ''),
					type: entry.type === 'tree' || entry.type === 'commit' ? entry.type : 'blob',
					sha: String(entry.sha ?? ''),
					size: typeof entry.size === 'number' ? entry.size : 0,
				});
			}
		}
		return {
			sha: String(body.sha ?? sha),
			truncated: body.truncated === true,
			entries,
		};
	}

	async getBlob(installationId: string, fullName: string, sha: string): Promise<Uint8Array> {
		const body = (await this.request('GET', `/repos/${fullName}/git/blobs/${encodeURIComponent(sha)}`, {
			auth: { installationId },
		})) as { content?: unknown; encoding?: unknown };
		if (typeof body.content !== 'string') {
			throw new GithubError(502, 'GITHUB_PROVIDER_ERROR', `blob ${sha} arrived without content`);
		}
		const binary = atob(body.content.replace(/\s+/g, ''));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	/** Current head of a branch, or null when the branch does not exist (404). */
	async getBranchHead(installationId: string, fullName: string, branch: string): Promise<string | null> {
		try {
			const body = (await this.request(
				'GET',
				// Branch refs may contain slashes; GitHub treats the whole
				// remainder of refs/heads/ as the ref name — no encoding here.
				`/repos/${fullName}/git/ref/heads/${branch}`,
				{ auth: { installationId } },
			)) as { object?: { sha?: unknown } };
			return String(body.object?.sha ?? '');
		} catch (error) {
			if (error instanceof GithubError && error.code === 'GITHUB_NOT_FOUND') return null;
			throw error;
		}
	}

	async createBranch(
		installationId: string,
		fullName: string,
		branch: string,
		sha: string,
	): Promise<void> {
		await this.request('POST', `/repos/${fullName}/git/refs`, {
			auth: { installationId },
			body: { ref: `refs/heads/${branch}`, sha },
		});
	}

	/**
	 * Move a branch head. `force` is ALWAYS false here — this adapter has no
	 * force-push path (acceptance: never force-push, never overwrite). The stub
	 * and real GitHub both enforce a fast-forward for force:false.
	 */
	async updateBranchHead(
		installationId: string,
		fullName: string,
		branch: string,
		sha: string,
	): Promise<void> {
		await this.request('PATCH', `/repos/${fullName}/git/refs/heads/${branch}`, {
			auth: { installationId },
			body: { sha, force: false },
		});
	}

	async createBlob(installationId: string, fullName: string, bytes: Uint8Array): Promise<string> {
		let binary = '';
		for (const byte of bytes) binary += String.fromCharCode(byte);
		const body = (await this.request('POST', `/repos/${fullName}/git/blobs`, {
			auth: { installationId },
			body: { content: btoa(binary), encoding: 'base64' },
		})) as { sha?: unknown };
		return String(body.sha ?? '');
	}

	/**
	 * Create a tree on top of `baseTreeSha`. An entry with `sha: null` removes
	 * that path from the base tree (GitHub's documented delete form); callers
	 * only pass paths they confirmed exist in the base tree.
	 */
	async createTree(
		installationId: string,
		fullName: string,
		baseTreeSha: string | null,
		entries: Array<{ path: string; sha: string | null }>,
	): Promise<string> {
		const body = (await this.request('POST', `/repos/${fullName}/git/trees`, {
			auth: { installationId },
			body: {
				...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
				tree: entries.map((e) => ({ path: e.path, sha: e.sha, mode: '100644', type: 'blob' })),
			},
		})) as { sha?: unknown };
		return String(body.sha ?? '');
	}

	async createCommit(
		installationId: string,
		fullName: string,
		input: { message: string; tree: string; parents: string[] },
	): Promise<string> {
		const body = (await this.request('POST', `/repos/${fullName}/git/commits`, {
			auth: { installationId },
			body: input,
		})) as { sha?: unknown };
		return String(body.sha ?? '');
	}

	async listOpenPullRequests(
		installationId: string,
		fullName: string,
		headBranch: string,
	): Promise<GithubPullRequestInfo[]> {
		const body = (await this.request(
			'GET',
			`/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(`${fullName.split('/')[0]}:${headBranch}`)}`,
			{ auth: { installationId } },
		)) as unknown;
		if (!Array.isArray(body)) return [];
		return body.map((raw) => {
			const pr = raw as {
				number?: unknown;
				head?: { ref?: unknown; sha?: unknown };
				base?: { ref?: unknown };
				html_url?: unknown;
			};
			return {
				number: Number(pr.number ?? 0),
				head: String(pr.head?.ref ?? ''),
				base: String(pr.base?.ref ?? ''),
				headSha: String(pr.head?.sha ?? ''),
				htmlUrl: typeof pr.html_url === 'string' ? pr.html_url : '',
			};
		});
	}

	/**
	 * Create a PR, reconciling GitHub's "a pull request already exists for this
	 * head" 422 to the EXISTING PR (provider-side idempotency — HackSteward
	 * read-before-write behavior). Returns the PR plus whether it pre-existed.
	 */
	async createPullRequest(
		installationId: string,
		fullName: string,
		input: { title: string; head: string; base: string; body: string },
	): Promise<{ pr: GithubPullRequestInfo; reconciled: boolean }> {
		try {
			const body = (await this.request('POST', `/repos/${fullName}/pulls`, {
				auth: { installationId },
				body: input,
			})) as {
				number?: unknown;
				head?: { ref?: unknown; sha?: unknown };
				base?: { ref?: unknown };
				html_url?: unknown;
			};
			return {
				pr: {
					number: Number(body.number ?? 0),
					head: String(body.head?.ref ?? input.head),
					base: String(body.base?.ref ?? input.base),
					headSha: String(body.head?.sha ?? ''),
					htmlUrl: typeof body.html_url === 'string' ? body.html_url : '',
				},
				reconciled: false,
			};
		} catch (error) {
			const isAlreadyExists =
				error instanceof GithubError &&
				error.status === 422 &&
				/a pull request already exists/i.test(error.message);
			if (!isAlreadyExists) throw error;
			const existing = await this.listOpenPullRequests(installationId, fullName, input.head);
			const match = existing.find((pr) => pr.head === input.head);
			if (!match) {
				throw new GithubError(
					409,
					'GITHUB_VALIDATION',
					`github reports an existing PR for head ${input.head} but none is listable — reconciliation required, no second PR was created`,
				);
			}
			return { pr: match, reconciled: true };
		}
	}

	/** Read one PR's live state — the read half of read-before-write for close. */
	async getPullRequest(installationId: string, fullName: string, number: number): Promise<GithubPullRequestStatus> {
		const body = await this.request('GET', `/repos/${fullName}/pulls/${number}`, {
			auth: { installationId },
		});
		return pullRequestStatusFrom(body, number);
	}

	/**
	 * Close an open PR (PATCH state=closed). Closing is REVERSIBLE — the PR can
	 * be reopened on GitHub — and never deletes the head branch or its commits.
	 * Callers read first (getPullRequest) so a merged or already-closed PR is
	 * never written to.
	 */
	async closePullRequest(installationId: string, fullName: string, number: number): Promise<GithubPullRequestStatus> {
		const body = await this.request('PATCH', `/repos/${fullName}/pulls/${number}`, {
			auth: { installationId },
			body: { state: 'closed' },
		});
		return pullRequestStatusFrom(body, number);
	}

	/**
	 * Merge a PR, pinned to `sha`: GitHub itself refuses (409) when the head
	 * moved past the commit the caller approved, so a push that lands after
	 * the approval is never merged. Callers read the PR first and hold an
	 * exact approval; this method only maps GitHub's answer.
	 */
	async mergePullRequest(
		installationId: string,
		fullName: string,
		number: number,
		input: { sha: string; method: GithubMergeMethod; commitTitle?: string },
	): Promise<GithubMergeOutcome> {
		const path = `/repos/${fullName}/pulls/${number}/merge`;
		const res = await this.requestRaw('PUT', path, {
			auth: { installationId },
			body: {
				sha: input.sha,
				merge_method: input.method,
				// Omitted: GitHub's own default title ("<PR title> (#n)" for squash).
				...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
			},
		});
		const body = (await parseBody(res)) as { sha?: unknown; merged?: unknown; message?: unknown } | null;
		const message =
			body && typeof body.message === 'string' ? body.message : snippet(JSON.stringify(body ?? null));
		if (res.status === 200 && body?.merged === true && typeof body.sha === 'string' && body.sha) {
			return { outcome: 'merged', sha: body.sha };
		}
		if (res.status === 409) return { outcome: 'head-moved', message };
		if (res.status === 405) return { outcome: 'not-mergeable', message };
		if (res.status >= 200 && res.status < 300) {
			// Never report a merge GitHub did not confirm.
			throw new GithubError(
				502,
				'GITHUB_PROVIDER_ERROR',
				`github did not confirm the merge of pull request #${number}: ${message}`,
			);
		}
		const code = classificationFor(res.status);
		throw new GithubError(classificationStatus(code), code, `github PUT ${path} -> HTTP ${res.status}: ${message}`);
	}
}

/** A PR plus its lifecycle state, as GitHub reports it. */
export interface GithubPullRequestStatus extends GithubPullRequestInfo {
	state: 'open' | 'closed';
	merged: boolean;
	/** GitHub's mergeability check: null while GitHub is still computing it. */
	mergeable: boolean | null;
	/** The commit a merge produced; null unless merged. */
	mergeCommitSha: string | null;
}

function pullRequestStatusFrom(raw: unknown, fallbackNumber: number): GithubPullRequestStatus {
	const pr = (raw ?? {}) as {
		number?: unknown;
		state?: unknown;
		merged?: unknown;
		merged_at?: unknown;
		mergeable?: unknown;
		merge_commit_sha?: unknown;
		head?: { ref?: unknown; sha?: unknown };
		base?: { ref?: unknown };
		html_url?: unknown;
	};
	// GitHub sets merged:true and merged_at on a merged PR (state is then 'closed').
	const merged = pr.merged === true || typeof pr.merged_at === 'string';
	return {
		number: Number(pr.number ?? fallbackNumber),
		state: pr.state === 'closed' ? 'closed' : 'open',
		merged,
		mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
		// merge_commit_sha is a TEST merge commit while the PR is open; only a merged PR's is real.
		mergeCommitSha: merged && typeof pr.merge_commit_sha === 'string' && pr.merge_commit_sha ? pr.merge_commit_sha : null,
		head: String(pr.head?.ref ?? ''),
		base: String(pr.base?.ref ?? ''),
		headSha: String(pr.head?.sha ?? ''),
		htmlUrl: typeof pr.html_url === 'string' ? pr.html_url : '',
	};
}

function classificationStatus(code: GithubError['code']): number {
	switch (code) {
		case 'GITHUB_NOT_CONFIGURED':
			return 503;
		case 'GITHUB_AUTHENTICATION':
		case 'GITHUB_AUTHORIZATION':
		case 'GITHUB_PROVIDER_ERROR':
			return 502;
		case 'GITHUB_NOT_FOUND':
			return 404;
		case 'GITHUB_RATE_LIMITED':
			return 429;
		default:
			return 422;
	}
}
