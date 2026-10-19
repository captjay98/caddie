import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createAuth, getAuth, type D1Database } from '../apps/app/src/server/auth.ts';
import {
	JUDGE_EMAIL_DOMAIN,
	judgeAccessState,
	judgeCodeMatches,
	judgeEmail,
	judgeIdentityFrom,
	judgeNameFromEmail,
	signInJudge,
	startJudge,
	type JudgeIdentity,
} from '../apps/app/src/server/judge-access.ts';
import { createJudgeAccessRouter } from '../apps/app/src/server/routes/judge-access.ts';
import { ScopeError } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * S06 judge access. LOCAL VERIFIED in-process: the real migrations over
 * bun:sqlite, the real Better Auth 1.7.10 instance and the real router. Cases
 * that need a browser-reachable cookie in workerd are covered separately by
 * tests/auth.integration.test.ts (the reviewer's follow-up).
 *
 * The first block is the plan's "prove the mechanism" probe: it records which
 * way of creating a credential account actually works on 1.7.10.
 */

const ORIGIN = 'http://127.0.0.1:8787';
const SECRET = 'judge-test-secret-0123456789abcdef';
const CODE = 'judge-code-0123456789';

/**
 * `tests/fixtures/sqlite-d1.ts`'s `batch` runs each statement with `.run()`,
 * which discards rows — so Better Auth's schema self-check (which reads
 * `batch(...).results` via pragma_table_info) sees an empty database and
 * refuses every endpoint with SCHEMA_MISMATCH. Real D1's `batch` returns each
 * statement's rows, so the harness restores that here (narrowly, in this test
 * file) to exercise Better Auth's real reads and writes over the shim.
 */
function withRealD1Batch(db: D1Database): D1Database {
	return {
		...db,
		batch: (statements: { all(): unknown }[]) => Promise.all(statements.map((statement) => statement.all())),
	} as unknown as D1Database;
}

function setCookieHeader(response: Response): string {
	const headers = response.headers as Headers & { getSetCookie?: () => string[] };
	const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : response.headers.get('set-cookie') ? [response.headers.get('set-cookie') as string] : [];
	return raw.map((cookie) => cookie.split(';')[0]).join('; ');
}

describe('probe: which credential-account creation path works on Better Auth 1.7.10', () => {
	let sqlite: Database;
	let db: D1Database;
	beforeEach(() => {
		const migrated = migratedDatabase();
		sqlite = migrated.sqlite;
		db = withRealD1Batch(migrated.db);
	});
	afterEach(() => sqlite.close());

	const probeEnv = () => ({
		DB: db,
		BETTER_AUTH_SECRET: 'probe-secret-0123456789abcdef0123456789abcdef',
		BETTER_AUTH_URL: ORIGIN,
		INVITE_ALLOWLIST: 'owner@example.com',
	});

	test('(a) HTTP POST /api/auth/sign-up/email is refused by disableSignUp', async () => {
		const auth = createAuth(probeEnv() as never, { database: db });
		const res = await auth.handler(
			new Request(`${ORIGIN}/api/auth/sign-up/email`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({ name: 'Judge One', email: 'judge-one@judges.caddie.invalid', password: 'a-long-enough-password' }),
			}),
		);
		console.log('(a) HTTP sign-up ->', res.status, await res.clone().text());
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('EMAIL_PASSWORD_SIGN_UP_DISABLED');
	});

	test('(b) the server api auth.api.signUpEmail also refuses by disableSignUp', async () => {
		const auth = createAuth(probeEnv() as never, { database: db });
		await expect(
			auth.api.signUpEmail({ body: { name: 'Judge One', email: 'judge-one@judges.caddie.invalid', password: 'a-long-enough-password' } } as never),
		).rejects.toThrow(/sign up is not enabled/i);
	});

	test('(c) internalAdapter createUser + linkAccount creates a working credential account', async () => {
		const auth = createAuth(probeEnv() as never, { database: db });
		const ctx = await auth.$context;
		// The invite gate now admits a judge address only behind a fresh
		// 'starting' row, so the probe writes one the way the service does.
		sqlite.prepare('insert into "judge_accounts" ("judgeName","state","createdAt","lastSignInAt") values (?,?,?,null)').run('judge-one', 'starting', new Date().toISOString());
		const created = await ctx.internalAdapter.createUser({ email: 'judge-one@judges.caddie.invalid', name: 'Judge One', emailVerified: false }, { method: 'email-password' });
		const password = 'a-long-enough-password';
		await ctx.internalAdapter.linkAccount({ userId: created.id, providerId: 'credential', accountId: created.id, password: await ctx.password.hash(password) });
		const account = sqlite.prepare('select "providerId","password" from "account" where "userId" = ?').get(created.id) as { providerId: string; password: string } | null;
		expect(account?.providerId).toBe('credential');
		expect(account?.password).toBeTruthy();

		const signedIn = await auth.api.signInEmail({ body: { email: 'judge-one@judges.caddie.invalid', password }, returnHeaders: true });
		const headers = signedIn.headers as Headers;
		const cookie = headers ? setCookieHeader(new Response(null, { headers })) : '';
		console.log('(c) signInEmail set-cookie ->', cookie);
		expect(cookie).toContain('better-auth.session_token');
	});
});

describe('judge access', () => {
	let sqlite: Database;
	let db: D1Database;
	const router = createJudgeAccessRouter();

	const envOf = (overrides: Record<string, unknown> = {}) =>
		({
			DB: db,
			BETTER_AUTH_SECRET: SECRET,
			BETTER_AUTH_URL: ORIGIN,
			INVITE_ALLOWLIST: 'owner@example.com',
			JUDGE_ACCESS_CODE: CODE,
			JUDGE_ACCESS_UNTIL: '2099-01-01',
			...overrides,
		}) as never;

	const post = (path: string, body: unknown, env: never, ip = '203.0.113.7') =>
		router.request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }, env);

	beforeEach(() => {
		const migrated = migratedDatabase();
		sqlite = migrated.sqlite;
		db = withRealD1Batch(migrated.db);
	});
	afterEach(() => sqlite.close());

	test('access state follows the code, the closing date and the enabled switch', () => {
		expect(judgeAccessState({ code: CODE, until: '2099-01-01' })).toEqual({ open: true, canStart: true });
		expect(judgeAccessState({ code: CODE, until: '2099-01-01', enabled: '0' })).toEqual({ open: false, canStart: true });
		expect(judgeAccessState({ code: CODE, until: '2000-01-01' })).toEqual({ open: false, canStart: false });
		expect(judgeAccessState({ code: 'too-short', until: '2099-01-01' })).toEqual({ open: false, canStart: false });
		expect(judgeAccessState({ until: '2099-01-01' })).toEqual({ open: false, canStart: false });
		// A bare date means the END of that day in UTC.
		expect(judgeAccessState({ code: CODE, until: '2026-12-16' }, new Date('2026-12-16T23:00:00Z'))).toEqual({ open: true, canStart: true });
		expect(judgeAccessState({ code: CODE, until: '2026-12-16' }, new Date('2026-12-17T00:00:00Z'))).toEqual({ open: false, canStart: false });
	});

	test('GET /judge/access serves the panel state', async () => {
		const res = await router.request(`${ORIGIN}/judge/access`, {}, envOf());
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ open: true, canStart: true });
		const closed = await router.request(`${ORIGIN}/judge/access`, {}, envOf({ JUDGE_ACCESS_ENABLED: '0' }));
		expect(await closed.json()).toEqual({ open: false, canStart: true });
	});

	test('the judge name and password rules are the panel sentences', async () => {
		const env = envOf();
		const badName = await post('/judge/start', { code: CODE, name: 'no', password: 'a-long-enough-password' }, env);
		expect(badName.status).toBe(400);
		expect(await badName.json()).toEqual({ error: 'invalid_input', message: 'Use letters, numbers and dashes for your judge name (3 to 24 characters).' });
		const badPassword = await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'short' }, env);
		expect(badPassword.status).toBe(400);
		expect(await badPassword.json()).toEqual({ error: 'invalid_input', message: 'Use a password of at least 10 characters.' });
	});

	test('a wrong access code is refused with the panel sentence', async () => {
		const res = await post('/judge/start', { code: 'not-the-right-code', name: 'Judge-One', password: 'a-long-enough-password' }, envOf());
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'judge_code', message: "That access code isn't right." });
		expect(sqlite.prepare('select count(*) as "n" from "judge_accounts"').get()).toEqual({ n: 0 });
	});

	test('a closed date is refused; an unconfigured code reads as unavailable', async () => {
		const expired = await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, envOf({ JUDGE_ACCESS_UNTIL: '2000-01-01' }));
		expect(expired.status).toBe(403);
		expect(await expired.json()).toEqual({ error: 'judge_closed', message: 'Judge access has closed.' });

		const off = await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, envOf({ JUDGE_ACCESS_ENABLED: '0' }));
		expect(off.status).toBe(403);
		expect(await off.json()).toEqual({ error: 'judge_closed', message: 'Judge access has closed.' });

		const unset = await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, envOf({ JUDGE_ACCESS_CODE: undefined }));
		expect(unset.status).toBe(503);
		expect(await unset.json()).toEqual({ error: 'judge_unavailable', message: "Judge access isn't open right now." });
	});

	test('the right code creates an account and a live session', async () => {
		const env = envOf();
		const res = await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, env);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, name: 'Judge-One' });
		const cookie = setCookieHeader(res);
		expect(cookie).toContain('better-auth.session_token');

		const session = (await getAuth(env).api.getSession({ headers: new Headers({ cookie }) })) as { user?: { id?: string; email?: string } } | null;
		expect(session?.user?.email).toBe(`judge-one@${JUDGE_EMAIL_DOMAIN}`);

		const row = sqlite.prepare('select "state","userId" from "judge_accounts" where "judgeName" = ?').get('Judge-One') as { state: string; userId: string } | null;
		expect(row?.state).toBe('active');
		expect(row?.userId).toBe(session?.user?.id);
	});

	test('a returning judge signs in on a fresh device and keeps the same account', async () => {
		const env = envOf();
		await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, env);
		const res = await post('/judge/sign-in', { name: 'Judge-One', password: 'a-long-enough-password' }, env, '198.51.100.4');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, name: 'Judge-One' });
		const session = (await getAuth(env).api.getSession({ headers: new Headers({ cookie: setCookieHeader(res) }) })) as { user?: { email?: string } } | null;
		expect(session?.user?.email).toBe(`judge-one@${JUDGE_EMAIL_DOMAIN}`);
		expect(sqlite.prepare('select count(*) as "n" from "user"').get()).toEqual({ n: 1 });
	});

	test('a wrong judge name and a wrong password give the SAME refusal', async () => {
		const env = envOf();
		await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, env);
		const wrongName = await post('/judge/sign-in', { name: 'Judge-Two', password: 'a-long-enough-password' }, env, '198.51.100.5');
		const wrongPassword = await post('/judge/sign-in', { name: 'Judge-One', password: 'the-wrong-password' }, env, '198.51.100.6');
		expect(wrongName.status).toBe(401);
		expect(wrongPassword.status).toBe(401);
		const refusal = { error: 'invalid_credentials', message: "That judge name or password isn't right." };
		expect(await wrongName.json()).toEqual(refusal);
		expect(await wrongPassword.json()).toEqual(refusal);
	});

	test('a taken judge name is refused with the panel sentence', async () => {
		const env = envOf();
		await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, env);
		const again = await post('/judge/start', { code: CODE, name: 'judge-one', password: 'a-different-password' }, env, '198.51.100.7');
		expect(again.status).toBe(409);
		expect(await again.json()).toEqual({ error: 'name_taken', message: 'That judge name is taken. Try another.' });
		expect(sqlite.prepare('select count(*) as "n" from "user"').get()).toEqual({ n: 1 });
	});

	test('all the judge places being taken is refused with the panel sentence', async () => {
		const env = envOf({ JUDGE_ACCESS_MAX_ACCOUNTS: '1' });
		await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, env);
		const full = await post('/judge/start', { code: CODE, name: 'Judge-Two', password: 'a-long-enough-password' }, env, '198.51.100.8');
		expect(full.status).toBe(403);
		expect(await full.json()).toEqual({ error: 'judge_full', message: 'All the judge places are taken.' });
	});

	test('the 11th start from one caller in an hour is refused', async () => {
		const env = envOf();
		for (let i = 0; i < 10; i++) {
			const res = await post('/judge/start', { code: CODE, name: `judge-${i}`, password: 'a-long-enough-password' }, env);
			expect(res.status).toBe(200);
		}
		const flood = await post('/judge/start', { code: CODE, name: 'judge-11', password: 'a-long-enough-password' }, env);
		expect(flood.status).toBe(429);
		expect(await flood.json()).toEqual({ error: 'too_many_attempts', message: 'Too many tries from here. Wait a little while and try again.' });
		// A different caller is unaffected, and only the hash is stored.
		expect((await post('/judge/start', { code: CODE, name: 'judge-11', password: 'a-long-enough-password' }, env, '198.51.100.9')).status).toBe(200);
		expect(JSON.stringify(sqlite.prepare('select * from judge_access_attempts').all())).not.toContain('203.0.113.7');
	});

	test('JUDGE_ACCESS_ENABLED=0 stops new starts but returning judges still sign in', async () => {
		const env = envOf();
		await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, env);
		const off = envOf({ JUDGE_ACCESS_ENABLED: '0' });
		expect((await post('/judge/sign-in', { name: 'Judge-One', password: 'a-long-enough-password' }, off, '198.51.100.10')).status).toBe(200);
		expect((await post('/judge/start', { code: CODE, name: 'Judge-Two', password: 'a-long-enough-password' }, off)).status).toBe(403);
	});
});

describe('judge access: the sign-up / sign-in rules stay closed for everyone else', () => {
	let sqlite: Database;
	let db: D1Database;
	beforeEach(() => {
		const migrated = migratedDatabase();
		sqlite = migrated.sqlite;
		db = withRealD1Batch(migrated.db);
	});
	afterEach(() => sqlite.close());

	const env = () => ({
		DB: db,
		BETTER_AUTH_SECRET: SECRET,
		BETTER_AUTH_URL: ORIGIN,
		INVITE_ALLOWLIST: 'owner@example.com',
		JUDGE_ACCESS_CODE: CODE,
		JUDGE_ACCESS_UNTIL: '2099-01-01',
	});

	test('direct email/password sign-up is refused for everyone', async () => {
		const auth = createAuth(env() as never, { database: db });
		const res = await auth.handler(
			new Request(`${ORIGIN}/api/auth/sign-up/email`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({ name: 'Stranger', email: 'stranger@example.com', password: 'a-long-enough-password' }),
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain('EMAIL_PASSWORD_SIGN_UP_DISABLED');
	});

	test('email/password sign-in is refused for a NON-judge address, even with the right password', async () => {
		const auth = createAuth(env() as never, { database: db });
		addUser(sqlite, 'owner-1', 'owner@example.com');
		// Give the allowed (Google/GitHub) user a real password to prove the
		// refusal comes from the judge-only rule, not from a missing credential.
		await judgeIdentityFrom(auth).setPassword('owner-1', 'the-right-password');
		const res = await auth.handler(
			new Request(`${ORIGIN}/api/auth/sign-in/email`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({ email: 'owner@example.com', password: 'the-right-password' }),
			}),
		);
		// `disabledPaths` now refuses this native path outright for EVERYONE
		// before the before-hook guard runs, so the shape is the router's
		// disabled-path answer; the property the guard protected is unchanged:
		// a non-judge address never gets a session here.
		expect(res.status).not.toBe(200);
		expect(setCookieHeader(res)).not.toContain('better-auth.session_token');
		expect(sqlite.prepare('select count(*) as "n" from "session"').get()).toEqual({ n: 0 });
	});

	test('an uninvited email is still refused by the invite gate (regression)', async () => {
		const auth = createAuth(env() as never, { database: db });
		const ctx = await auth.$context;
		await expect(ctx.internalAdapter.createUser({ email: 'stranger@example.com', name: 'Stranger', emailVerified: false }, { method: 'email-password' })).rejects.toThrow(/INVITE_REQUIRED/);
		// The owner's allowlisted address is unaffected.
		const owner = await ctx.internalAdapter.createUser({ email: 'owner@example.com', name: 'Owner', emailVerified: true }, { method: 'email-password' });
		expect(owner.id).toBeTruthy();
	});

	test('the invite gate admits a judge address only behind a FRESH matching starting row', async () => {
		const auth = createAuth(env() as never, { database: db });
		const ctx = await auth.$context;
		const insert = (name: string, createdAt: string) =>
			sqlite.prepare('insert into "judge_accounts" ("judgeName","state","createdAt","lastSignInAt") values (?,?,?,null)').run(name, 'starting', createdAt);
		const now = Date.now();

		// No row at all: refused.
		await expect(ctx.internalAdapter.createUser({ email: `judge-one@${JUDGE_EMAIL_DOMAIN}`, name: 'Judge One', emailVerified: false }, { method: 'email-password' })).rejects.toThrow(/INVITE_REQUIRED/);

		// A stale row (older than ten minutes): refused.
		insert('judge-one', new Date(now - 20 * 60_000).toISOString());
		await expect(ctx.internalAdapter.createUser({ email: `judge-one@${JUDGE_EMAIL_DOMAIN}`, name: 'Judge One', emailVerified: false }, { method: 'email-password' })).rejects.toThrow(/INVITE_REQUIRED/);

		// A fresh row for a DIFFERENT name: refused.
		insert('judge-two', new Date(now).toISOString());
		await expect(ctx.internalAdapter.createUser({ email: `judge-one@${JUDGE_EMAIL_DOMAIN}`, name: 'Judge One', emailVerified: false }, { method: 'email-password' })).rejects.toThrow(/INVITE_REQUIRED/);

		// Fresh, matching, and still 'starting': admitted.
		sqlite.prepare('update "judge_accounts" set "createdAt" = ? where "judgeName" = ?').run(new Date(now).toISOString(), 'judge-one');
		const admitted = await ctx.internalAdapter.createUser({ email: `judge-one@${JUDGE_EMAIL_DOMAIN}`, name: 'Judge One', emailVerified: false }, { method: 'email-password' });
		expect(admitted.id).toBeTruthy();
	});

	test('the judge name to address mapping is the one place, both ways', () => {
		expect(judgeEmail('Judge-One')).toBe(`judge-one@${JUDGE_EMAIL_DOMAIN}`);
		expect(judgeNameFromEmail(`judge-one@${JUDGE_EMAIL_DOMAIN}`)).toBe('judge-one');
		expect(judgeNameFromEmail(`judge-one@${JUDGE_EMAIL_DOMAIN}`.replace('judges.', 'mail.'))).toBeNull();
		expect(judgeNameFromEmail('someone@example.com')).toBeNull();
		expect(judgeNameFromEmail(null)).toBeNull();
	});

	test('the access-code comparison is value-independent: same length and different length are both compared in full', async () => {
		const expected = 'judge-code-0123456789';
		// The right code matches.
		expect(await judgeCodeMatches(expected, expected, SECRET)).toBe(true);
		// Same length, sharing every character but the LAST: a byte-compare that
		// stopped at the first difference would have to reach the final byte to
		// say no, and it does.
		expect(await judgeCodeMatches(`${expected.slice(0, -1)}X`, expected, SECRET)).toBe(false);
		expect(await judgeCodeMatches(`${expected.slice(0, -2)}XY`, expected, SECRET)).toBe(false);
		// A different length is refused the same way (the digests are equal length).
		expect(await judgeCodeMatches(expected.slice(0, -1), expected, SECRET)).toBe(false);
		expect(await judgeCodeMatches(`${expected}EXTRA`, expected, SECRET)).toBe(false);
		expect(await judgeCodeMatches('', expected, SECRET)).toBe(false);
	});
});

describe('judge access: the native email/password sign-in door is closed', () => {
	let sqlite: Database;
	let db: D1Database;
	const router = createJudgeAccessRouter();

	beforeEach(() => {
		const migrated = migratedDatabase();
		sqlite = migrated.sqlite;
		db = withRealD1Batch(migrated.db);
	});
	afterEach(() => sqlite.close());

	const env = () =>
		({
			DB: db,
			BETTER_AUTH_SECRET: SECRET,
			BETTER_AUTH_URL: ORIGIN,
			INVITE_ALLOWLIST: 'owner@example.com',
			JUDGE_ACCESS_CODE: CODE,
			JUDGE_ACCESS_UNTIL: '2099-01-01',
		}) as never;

	const post = (path: string, body: unknown, e: never, ip = '203.0.113.7') =>
		router.request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }, e);

	const nativeSignIn = (e: never, email: string, password: string) =>
		createAuth(e, { database: db }).handler(
			new Request(`${ORIGIN}/api/auth/sign-in/email`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify({ email, password }),
			}),
		);

	test('POST /api/auth/sign-in/email can no longer sign a judge in with the RIGHT password', async () => {
		const e = env();
		// The account is created through the product route, so its password is
		// real: this is exactly the reviewer's probe that used to return 200.
		const started = await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, e);
		expect(started.status).toBe(200);
		// `/judge/start` signs in too, so one session exists before the probe.
		const sessionsBefore = sqlite.prepare('select count(*) as "n" from "session"').get();

		const res = await nativeSignIn(e, `judge-one@${JUDGE_EMAIL_DOMAIN}`, 'a-long-enough-password');
		expect(res.status).not.toBe(200);
		expect(setCookieHeader(res)).not.toContain('better-auth.session_token');
		expect(sqlite.prepare('select count(*) as "n" from "session"').get()).toEqual(sessionsBefore);
	});

	test('/api/judge/sign-in still signs the same judge in through the server-side API', async () => {
		const e = env();
		await post('/judge/start', { code: CODE, name: 'Judge-One', password: 'a-long-enough-password' }, e);
		// The judge route signs in with `auth.api.signInEmail`, which never
		// enters the disabled HTTP router — so a 200 proves the server-side API
		// still works and the limiter is the judge's only door.
		const res = await post('/judge/sign-in', { name: 'Judge-One', password: 'a-long-enough-password' }, e, '198.51.100.20');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, name: 'Judge-One' });
		expect(setCookieHeader(res)).toContain('better-auth.session_token');
	});
});

describe('judge access: the account cap is enforced by the reservation INSERT', () => {
	let sqlite: Database;
	let db: D1Database;
	beforeEach(() => {
		const migrated = migratedDatabase();
		sqlite = migrated.sqlite;
		db = withRealD1Batch(migrated.db);
	});
	afterEach(() => sqlite.close());

	const config = { code: CODE, until: '2099-01-01' };

	/** A JudgeIdentity that records every call, so a refusal can be proven to
	 *  stop before any Better Auth user is created. */
	function recordingIdentity() {
		const calls = { createUser: 0, setPassword: 0, signIn: 0 };
		const identity: JudgeIdentity = {
			async createUser() {
				calls.createUser += 1;
				return { id: `user-${calls.createUser}` };
			},
			async setPassword() {
				calls.setPassword += 1;
			},
			async signIn() {
				calls.signIn += 1;
				return new Headers({ 'set-cookie': 'better-auth.session_token=stub' });
			},
		};
		return { identity, calls };
	}

	function seedActive(name: string, userId: string): void {
		sqlite
			.prepare('insert into "judge_accounts" ("judgeName","state","createdAt","lastSignInAt","userId") values (?,?,?,null,?)')
			.run(name, 'active', new Date().toISOString(), userId);
	}

	test('a full roster refuses the start with judge_full and creates no user', async () => {
		seedActive('Judge-One', 'existing-user');
		const { identity, calls } = recordingIdentity();
		let error: unknown;
		try {
			await startJudge(
				db,
				{ code: CODE, name: 'Judge-Two', password: 'a-long-enough-password', secret: SECRET, ipHash: 'hash-full', config: { ...config, maxAccounts: '1' } },
				identity,
			);
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(ScopeError);
		const refusal = error as ScopeError;
		expect(refusal.status).toBe(403);
		expect(refusal.code).toBe('judge_full');
		expect(refusal.message).toBe('All the judge places are taken.');
		expect(calls.createUser).toBe(0);
	});

	test('a refusal at the cap leaves no starting row behind for that name', async () => {
		seedActive('Judge-One', 'existing-user');
		const { identity } = recordingIdentity();
		await expect(
			startJudge(db, { code: CODE, name: 'Judge-Two', password: 'a-long-enough-password', secret: SECRET, ipHash: 'hash-full', config: { ...config, maxAccounts: '1' } }, identity),
		).rejects.toThrow('All the judge places are taken.');
		const starting = sqlite.prepare('select count(*) as "n" from "judge_accounts" where "state" = \'starting\'').get();
		expect(starting).toEqual({ n: 0 });
		const mine = sqlite.prepare('select count(*) as "n" from "judge_accounts" where lower("judgeName") = ?').get('judge-two');
		expect(mine).toEqual({ n: 0 });
	});

	test('a start with room left still succeeds and flips to active', async () => {
		const { identity, calls } = recordingIdentity();
		const started = await startJudge(
			db,
			{ code: CODE, name: 'Judge-One', password: 'a-long-enough-password', secret: SECRET, ipHash: 'hash-room', config: { ...config, maxAccounts: '2' } },
			identity,
		);
		expect(started.name).toBe('Judge-One');
		expect(calls.createUser).toBe(1);
		const row = sqlite.prepare('select "state","userId" from "judge_accounts" where "judgeName" = ?').get('Judge-One') as { state: string; userId: string } | null;
		expect(row?.state).toBe('active');
		expect(row?.userId).toBe('user-1');
		expect(sqlite.prepare('select count(*) as "n" from "judge_accounts" where "state" = \'starting\'').get()).toEqual({ n: 0 });
	});

	test('a stale reservation for the same name is cleared before the cap is counted', async () => {
		// A crashed start leaves a stale 'starting' row. Retrying the SAME name
		// must not be refused for a place this start is about to reclaim: the
		// stale row is deleted BEFORE the conditional INSERT counts the roster.
		// (The old code counted first, so a stale row consumed a place forever.)
		sqlite
			.prepare('insert into "judge_accounts" ("judgeName","state","createdAt","lastSignInAt") values (?,?,?,null)')
			.run('Judge-One', 'starting', new Date(Date.now() - 20 * 60_000).toISOString());
		const { identity, calls } = recordingIdentity();
		const started = await startJudge(
			db,
			{ code: CODE, name: 'Judge-One', password: 'a-long-enough-password', secret: SECRET, ipHash: 'hash-stale', config: { ...config, maxAccounts: '1' } },
			identity,
		);
		expect(started.name).toBe('Judge-One');
		expect(calls.createUser).toBe(1);
		expect(sqlite.prepare('select count(*) as "n" from "judge_accounts"').get()).toEqual({ n: 1 });
	});
});

describe('judge access: the service layer over the real identity flow', () => {
	let sqlite: Database;
	let db: D1Database;
	beforeEach(() => {
		const migrated = migratedDatabase();
		sqlite = migrated.sqlite;
		db = withRealD1Batch(migrated.db);
	});
	afterEach(() => sqlite.close());

	test('startJudge reserves then flips the row to active, and signInJudge reaches the same account', async () => {
		const auth = createAuth({ DB: db, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: ORIGIN, INVITE_ALLOWLIST: 'owner@example.com' } as never, { database: db });
		const identity = judgeIdentityFrom(auth);
		const config = { code: CODE, until: '2099-01-01' };
		const started = await startJudge(db, { code: CODE, name: 'Judge-One', password: 'a-long-enough-password', secret: SECRET, ipHash: 'hash-a', config }, identity);
		expect(started.name).toBe('Judge-One');
		const active = sqlite.prepare('select "state","userId" from "judge_accounts" where "judgeName" = ?').get('Judge-One') as { state: string; userId: string };
		expect(active.state).toBe('active');
		expect(sqlite.prepare('select count(*) as "n" from "judge_accounts" where "state" = \'starting\'').get()).toEqual({ n: 0 });

		const again = await signInJudge(db, { name: 'Judge-One', password: 'a-long-enough-password', ipHash: 'hash-b', config }, identity);
		expect(again.name).toBe('Judge-One');
		expect(again.headers.get('set-cookie')).toContain('better-auth.session_token');
	});
});
