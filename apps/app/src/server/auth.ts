import { APIError, betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';

/**
 * P01 identity: Better Auth 1.7.7 on Cloudflare Workers + D1.
 *
 * SPIKE RESULT (P01 slice 1, LOCAL VERIFIED): Better Auth 1.7.7 accepts a D1
 * binding directly as `database` — its bundled Kysely adapter detects the
 * binding (`prepare`/`batch`/`exec`) and runs on its internal D1 sqlite
 * dialect. Documented for this version at
 * https://www.better-auth.com/docs/concepts/database (Cloudflare D1 section).
 *
 * Audit-defect #5 rule (must not travel): session signing uses ONLY the
 * dedicated BETTER_AUTH_SECRET. Nothing here reads or derives from model/API
 * keys (LLM_* etc.) — AuthEnv names every input explicitly.
 */

/**
 * Structural D1 binding type (keeps this module free of extra type deps).
 * Workers' real D1 bindings satisfy this shape; better-auth's bundled Kysely
 * adapter detects the binding at runtime (`batch`/`exec`/`prepare`) and runs
 * its internal D1 sqlite dialect on it.
 */
export interface D1Database {
	prepare(query: string): {
		bind(...values: unknown[]): {
			run(): Promise<unknown>;
			all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
		};
		run(): Promise<unknown>;
		all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	};
	batch<T = unknown>(statements: unknown[]): Promise<T[]>;
	exec(query: string): Promise<unknown>;
}

/**
 * Every authentication input, by name. Credentials come from dedicated env
 * vars set in wrangler secrets / .dev.vars — never from provider model keys.
 */
export interface AuthEnv {
	DB: D1Database;
	/** Dedicated session/state signing secret. Required; no fallback. */
	BETTER_AUTH_SECRET: string;
	/** Explicit canonical origin, e.g. https://app.example.com. Required. */
	BETTER_AUTH_URL: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	/** Comma-separated invited emails. Unset/empty = no new sign-ups (fail closed). */
	INVITE_ALLOWLIST?: string;
	/**
	 * Test-only: base URL of the stub OAuth provider used by the local
	 * integration fixture. Honored ONLY when AUTH_TEST_MODE=1 (the fixture
	 * sets it); any other environment carrying it is a misconfiguration and
	 * createAuth refuses to start.
	 */
	AUTH_STUB_BASE_URL?: string;
	/** Test-only: short session TTL in seconds for expiry tests. Same fence. */
	AUTH_SESSION_TTL_SECONDS?: string;
	/** Test-only marker that gates the knobs above. */
	AUTH_TEST_MODE?: string;
}

export type AuthInstance = ReturnType<typeof createAuth>;

function requireEnv(
	env: Pick<AuthEnv, 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL'>,
	key: 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL',
): string {
	const value: string | undefined = env[key];
	if (!value || value.trim() === '') {
		throw new Error(
			`auth: ${key} is required. Set dedicated secrets per docs/setup/auth.md; ` +
				'auth never derives secrets from model/API keys.',
		);
	}
	return value;
}

function inviteAllowlist(raw: string | undefined): Set<string> {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(',')
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry) => entry.length > 0),
	);
}

const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface CreateAuthOverrides {
	/** Test-only database replacement (e.g. in-process sqlite for config probes). */
	database?: unknown;
}

/**
 * Build the Better Auth instance for the given Worker env. Workers are
 * stateless; prefer `getAuth(env)` which caches one instance per isolate.
 *
 * The instance type is inferred (`AuthInstance`) rather than annotated as
 * `Auth`: better-auth 1.7.7's deep endpoint generics are not assignable to
 * the bare `Auth` alias when plugins are registered.
 */
export function createAuth(env: AuthEnv, overrides: CreateAuthOverrides = {}) {
	// Fail-closed fence for test-only knobs (AUTH_STUB_BASE_URL swaps in
	// static-credential stub providers; AUTH_SESSION_TTL_SECONDS shortens
	// sessions). They are honored ONLY when AUTH_TEST_MODE=1 is set
	// explicitly — the integration fixture sets it. Any other environment
	// carrying these vars is a misconfiguration and must be loud.
	const testMode = env.AUTH_TEST_MODE === '1';
	if ((env.AUTH_STUB_BASE_URL || env.AUTH_SESSION_TTL_SECONDS) && !testMode) {
		throw new Error(
			'auth: AUTH_STUB_BASE_URL/AUTH_SESSION_TTL_SECONDS are test-only and require AUTH_TEST_MODE=1',
		);
	}
	const secret = requireEnv(env, 'BETTER_AUTH_SECRET');
	const baseURL = requireEnv(env, 'BETTER_AUTH_URL').replace(/\/$/, '');
	const allowlist = inviteAllowlist(env.INVITE_ALLOWLIST);
	const ttlSeconds = env.AUTH_SESSION_TTL_SECONDS
		? Math.max(2, Number.parseInt(env.AUTH_SESSION_TTL_SECONDS, 10) || DEFAULT_SESSION_TTL_SECONDS)
		: DEFAULT_SESSION_TTL_SECONDS;

	const socialProviders: Record<string, unknown> = {};
	// Built-in library providers, registered only when their dedicated
	// credentials exist. GitHub's library default scopes are exactly
	// `read:user user:email` — no repository scopes are requested anywhere.
	if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
		socialProviders.google = {
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
		};
	}
	if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
		socialProviders.github = {
			clientId: env.GITHUB_CLIENT_ID,
			clientSecret: env.GITHUB_CLIENT_SECRET,
		};
	}

	const plugins: ReturnType<typeof genericOAuth>[] = [];
	if (env.AUTH_STUB_BASE_URL) {
		// Fixture-only seam: the same OAuth code paths against a stub provider
		// so flows run fully local. Production never sets AUTH_STUB_BASE_URL.
		// better-auth 1.7.7 option shape: `config` with `providerId` keys;
		// PKCE S256 is the library default (`pkce ?? true`), matching Google.
		// The subject resolver is explicit per provider — exactly the field the
		// real provider uses for identity (Google: OIDC `sub`; GitHub: numeric
		// `id`) — so the local subject-keyed identity proofs carry over.
		plugins.push(
			genericOAuth({
				config: [
					{
						providerId: 'google',
						clientId: 'stub-client-id',
						clientSecret: 'stub-client-secret',
						authorizationUrl: `${env.AUTH_STUB_BASE_URL}/authorize`,
						tokenUrl: `${env.AUTH_STUB_BASE_URL}/token`,
						userInfoUrl: `${env.AUTH_STUB_BASE_URL}/userinfo`,
						scopes: ['openid', 'email', 'profile'],
						accountSubject: ({ profile }) => String(profile.sub ?? ''),
					},
					{
						providerId: 'github',
						clientId: 'stub-client-id',
						clientSecret: 'stub-client-secret',
						authorizationUrl: `${env.AUTH_STUB_BASE_URL}/authorize`,
						tokenUrl: `${env.AUTH_STUB_BASE_URL}/token`,
						userInfoUrl: `${env.AUTH_STUB_BASE_URL}/userinfo`,
						// identical identity scopes as production GitHub: no repo access
						scopes: ['read:user', 'user:email'],
						accountSubject: ({ profile }) =>
							String((profile as { id?: unknown }).id ?? profile.sub ?? ''),
					},
				],
			}),
		);
	}

	return betterAuth({
		secret,
		baseURL,
		basePath: '/api/auth',
		database: (overrides.database ?? env.DB) as unknown as BetterAuthOptions['database'],
		telemetry: { enabled: false },
		emailAndPassword: { enabled: false },
		session: {
			expiresIn: ttlSeconds,
			// keep updateAge below expiresIn so short fixture TTLs stay valid
			updateAge: Math.max(1, Math.floor(ttlSeconds / 2)),
			// session truth stays in D1: revocation must take effect immediately,
			// so the JWE cookie cache is disabled
			cookieCache: { enabled: false },
		},
		account: {
			accountLinking: {
				// The owner signs in with either provider against the same
				// allowlisted email; Google and GitHub both verify the address
				// before release, so a provider-verified email match IS the
				// identity. There is no link-provider UI, so implicit linking is
				// the only path a second provider attaches — the invite gate in
				// databaseHooks still denies every non-allowlisted email.
				enabled: true,
				trustedProviders: ['google', 'github'],
				allowDifferentEmails: false,
			},
		},
		socialProviders: socialProviders as never,
		plugins: plugins as never,
		databaseHooks: {
			user: {
				create: {
					// Invite gate: fires inside the OAuth callback before the first
					// user row is written; throwing aborts user AND session creation,
					// so uninvited users are denied at sign-in (fail closed).
					async before(user) {
						const email = (user as { email?: string }).email?.toLowerCase();
						if (!email || !allowlist.has(email)) {
							throw new APIError('FORBIDDEN', {
								message: 'INVITE_REQUIRED: this email is not on the invite allowlist',
							});
						}
						return;
					},
				},
			},
		},
	});
}

const instanceCache = new WeakMap<object, AuthInstance>();

/** One auth instance per env object (effectively per isolate). */
export function getAuth(env: AuthEnv): AuthInstance {
	let instance = instanceCache.get(env);
	if (!instance) {
		instance = createAuth(env);
		instanceCache.set(env, instance);
	}
	return instance;
}
