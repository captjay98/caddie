import type { AuthInstance, D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

/**
 * S06 judge access (migration 0033). Hackathon judges sign in with an access
 * code, a judge name and a password — no Google or GitHub account, and no
 * email is ever delivered to them. Every input and refusal in the frozen
 * client contract lives here, so the route layer only reads the body, hashes
 * the caller and forwards the session cookie.
 *
 * Design (mirrors abuse-reports.ts): every function takes its database and an
 * explicit `now` string, refuses with a typed {@link ScopeError} carrying the
 * exact status/code/plain sentence the panel shows, and does no notification.
 *
 * The synthetic address `<judge-name>@judges.caddie.invalid` is the ONE
 * name→email mapping in the product, and it lives here in the server. `.invalid`
 * can never be a real Google or GitHub address, so OAuth account linking can
 * never attach to a judge account (see the migration's header).
 *
 * `judge_accounts` doubles as the invite ticket: a start writes a 'starting'
 * row just before it creates the user; `databaseHooks.user.create.before` in
 * auth.ts admits a judge address only while a fresh matching 'starting' row
 * exists, then this module flips the row to 'active' with the user id.
 */

/** The judge address domain. One place, server-side. */
export const JUDGE_EMAIL_DOMAIN = 'judges.caddie.invalid';

/** Judge names: letters, numbers and dashes, 3 to 24 characters. */
export const JUDGE_NAME_PATTERN = /^[A-Za-z0-9-]{3,24}$/;

export const JUDGE_PASSWORD_MIN = 10;

/** A 'starting' row admits its address for this long (a crashed start expires). */
export const JUDGE_INVITE_TTL_MS = 10 * 60_000;

/** Refusals: at most 10 starts, or 20 sign-ins, per caller per hour. */
export const JUDGE_START_LIMIT = 10;
export const JUDGE_SIGN_IN_LIMIT = 20;

/** Attempt rows are kept 24 hours, then pruned opportunistically on write. */
export const JUDGE_ATTEMPT_TTL_MS = 24 * 60 * 60_000;

/** Default number of judge places when JUDGE_ACCESS_MAX_ACCOUNTS is unset. */
export const JUDGE_MAX_ACCOUNTS_DEFAULT = 40;

/** The four env inputs, collected by the route. */
export interface JudgeAccessConfig {
	code?: string;
	until?: string;
	enabled?: string;
	maxAccounts?: string | number;
}

/** A judge name to its synthetic Better Auth address. */
export function judgeEmail(name: string): string {
	return `${name.toLowerCase()}@${JUDGE_EMAIL_DOMAIN}`;
}

/**
 * The inverse mapping, used by the invite gate and by the rule that
 * email/password sign-in accepts only judge addresses. Null for anything that
 * is not a well-formed judge address.
 */
export function judgeNameFromEmail(email: string | null | undefined): string | null {
	const value = (email ?? '').trim().toLowerCase();
	const suffix = `@${JUDGE_EMAIL_DOMAIN}`;
	if (!value.endsWith(suffix)) return null;
	const name = value.slice(0, value.length - suffix.length);
	return JUDGE_NAME_PATTERN.test(name) ? name : null;
}

/**
 * The end of JUDGE_ACCESS_UNTIL as epoch milliseconds. A bare `YYYY-MM-DD`
 * means the end of that day in UTC; anything else is parsed as a timestamp.
 * Null when unset or unparseable (the gate then reports "not open right now").
 */
export function judgeAccessUntilMs(until: string | undefined): number | null {
	const raw = (until ?? '').trim();
	if (!raw) return null;
	const ms = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T23:59:59.999Z`) : Date.parse(raw);
	return Number.isNaN(ms) ? null : ms;
}

function judgeCodeConfigured(config: JudgeAccessConfig): boolean {
	return typeof config.code === 'string' && config.code.length >= 16;
}

/**
 * What the sign-in panel needs:
 *   open     — judges may start AND sign in right now (the block is shown).
 *   canStart — the same, ignoring the enabled switch, i.e. the "first visit"
 *              form is shown and only a deliberate `JUDGE_ACCESS_ENABLED=0`
 *              is keeping new starts from going through.
 */
export function judgeAccessState(config: JudgeAccessConfig, now: Date = new Date()): { open: boolean; canStart: boolean } {
	const untilMs = judgeAccessUntilMs(config.until);
	const inWindow = judgeCodeConfigured(config) && untilMs !== null && now.getTime() < untilMs;
	return { open: inWindow && config.enabled !== '0', canStart: inWindow };
}

/**
 * The refusal for a call that arrives while judge access is not usable, or
 * null when it may proceed. `requireEnabled` is false for sign-in: turning
 * JUDGE_ACCESS_ENABLED off stops NEW starts only, because a judge already
 * judging must still be able to sign back in.
 */
function judgeGate(config: JudgeAccessConfig, nowIso: string, requireEnabled: boolean): ScopeError | null {
	if (!judgeCodeConfigured(config) || judgeAccessUntilMs(config.until) === null) {
		return new ScopeError(503, 'judge_unavailable', "Judge access isn't open right now.");
	}
	if (Date.parse(nowIso) >= (judgeAccessUntilMs(config.until) as number)) {
		return new ScopeError(403, 'judge_closed', 'Judge access has closed.');
	}
	if (requireEnabled && config.enabled === '0') {
		return new ScopeError(403, 'judge_closed', 'Judge access has closed.');
	}
	return null;
}

function maxJudgeAccounts(config: JudgeAccessConfig): number {
	const raw = config.maxAccounts;
	const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : JUDGE_MAX_ACCOUNTS_DEFAULT;
}

/** The name exactly as the panel validates it, or the panel's 400. */
function validateJudgeName(value: unknown): string {
	const name = typeof value === 'string' ? value.trim() : '';
	if (!JUDGE_NAME_PATTERN.test(name)) {
		throw new ScopeError(400, 'invalid_input', 'Use letters, numbers and dashes for your judge name (3 to 24 characters).');
	}
	return name;
}

/** The password exactly as the panel validates it, or the panel's 400. */
function validateJudgePassword(value: unknown): string {
	const password = typeof value === 'string' ? value : '';
	if (password.length < JUDGE_PASSWORD_MIN) {
		throw new ScopeError(400, 'invalid_input', 'Use a password of at least 10 characters.');
	}
	return password;
}

type Row = Record<string, unknown>;

async function all(db: D1Database, sql: string, ...params: unknown[]): Promise<Row[]> {
	return (await db.prepare(sql).bind(...params).all<Row>()).results ?? [];
}

function inviteCutoff(nowIso: string): string {
	return new Date(Date.parse(nowIso) - JUDGE_INVITE_TTL_MS).toISOString();
}

/**
 * Compare a presented access code with the configured one without letting the
 * comparison depend on either value.
 *
 * Both sides are HMAC-SHA256'd under the master secret first, then the two
 * fixed-length digests are compared byte-by-byte over their whole length (an
 * XOR accumulator, no early return). Comparing the raw strings with `===`
 * would leak two things: how many leading characters matched (it stops at the
 * first difference) and whether the lengths differ (it returns before
 * comparing at all). Over the digests, a wrong code of the same length is
 * still compared in full, and a wrong code of a different length is
 * indistinguishable from a same-length one.
 */
export async function judgeCodeMatches(presented: string, expected: string, secret: string): Promise<boolean> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const digest = async (value: string) => new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
	const [a, b] = await Promise.all([digest(presented), digest(expected)]);
	let differing = 0;
	for (let i = 0; i < a.length; i++) differing |= a[i] ^ b[i];
	return differing === 0;
}

/**
 * Whether the invite gate should admit this address: a well-formed
 * `@judges.caddie.invalid` address whose exact name has a `judge_accounts`
 * row in state 'starting' written within the last ten minutes. Everything
 * else falls through to the ordinary invite refusal.
 */
export async function judgeInviteAdmits(db: D1Database, email: string | null | undefined, nowIso: string): Promise<boolean> {
	const name = judgeNameFromEmail(email);
	if (name === null) return false;
	const rows = await all(
		db,
		'select 1 from "judge_accounts" where lower("judgeName") = ? and "state" = \'starting\' and "createdAt" >= ? limit 1',
		name,
		inviteCutoff(nowIso),
	);
	return rows.length > 0;
}

/** Is this Better Auth user a judge account? Used by the publish refusal (D2). */
export async function isJudgeAccount(db: D1Database, userId: string): Promise<boolean> {
	const rows = await all(db, 'select 1 from "judge_accounts" where "userId" = ? and "state" = \'active\' limit 1', userId);
	return rows.length > 0;
}

/** How many judge places are taken (every row counts, active or in progress). */
export async function judgeAccountCount(db: D1Database): Promise<number> {
	const rows = await all(db, 'select count(*) as "n" from "judge_accounts"');
	return Number(rows[0]?.['n'] ?? 0);
}

/**
 * Whether the name is unusable right now: an active row, or a 'starting' row
 * that is still fresh (someone else is mid-start). A stale 'starting' row
 * does not block — the start clears it before writing its own.
 */
async function judgeNameBlocked(db: D1Database, name: string, nowIso: string): Promise<boolean> {
	const rows = await all(db, 'select "state","createdAt" from "judge_accounts" where lower("judgeName") = ?', name.toLowerCase());
	return rows.some((row) => row['state'] === 'active' || (row['state'] === 'starting' && String(row['createdAt']) >= inviteCutoff(nowIso)));
}

async function enforceJudgeRateLimit(db: D1Database, action: 'start' | 'sign_in', ipHash: string, nowIso: string, limit: number): Promise<void> {
	const since = new Date(Date.parse(nowIso) - 60 * 60_000).toISOString();
	const rows = await all(db, 'select count(*) as "n" from "judge_access_attempts" where "ipHash" = ? and "action" = ? and "createdAt" >= ?', ipHash, action, since);
	if (Number(rows[0]?.['n'] ?? 0) >= limit) {
		throw new ScopeError(429, 'too_many_attempts', 'Too many tries from here. Wait a little while and try again.');
	}
}

/** Record one attempt, then prune everything older than 24 hours. */
async function recordJudgeAttempt(db: D1Database, action: 'start' | 'sign_in', ipHash: string, nowIso: string): Promise<void> {
	await db
		.prepare('insert into "judge_access_attempts" ("id","action","ipHash","createdAt") values (?,?,?,?)')
		.bind(`ja_${crypto.randomUUID()}`, action, ipHash, nowIso)
		.run();
	await db.prepare('delete from "judge_access_attempts" where "createdAt" < ?').bind(new Date(Date.parse(nowIso) - JUDGE_ATTEMPT_TTL_MS).toISOString()).run();
}

/**
 * The identity operations a judge account needs, kept behind a small port so
 * the service above stays pure over its database and `now`, and so the exact
 * Better Auth calls live in one place. {@link judgeIdentityFrom} binds it to
 * the real instance.
 */
export interface JudgeIdentity {
	/** Create the Better Auth user row (it passes the invite gate because of the fresh 'starting' row). */
	createUser(input: { email: string; name: string }): Promise<{ id: string }>;
	/** Attach a credential (password) account to that user, the way sign-up does. */
	setPassword(userId: string, password: string): Promise<void>;
	/** Sign in and hand back the headers carrying Better Auth's session cookie. */
	signIn(input: { email: string; password: string }): Promise<Headers>;
}

/**
 * The one account-creation flow on Better Auth 1.7.10. The plan's probe
 * (tests/judge-access.test.ts) found that `disableSignUp: true` refuses BOTH
 * the HTTP `POST /api/auth/sign-up/email` and the server call
 * `auth.api.signUpEmail`, so judge accounts are created through the internal
 * adapter exactly as sign-up would: `createUser` then `linkAccount` with
 * `providerId: 'credential'` and a `password.hash(...)`. The session itself
 * comes from the ordinary sign-in endpoint, so the cookie is the real thing.
 */
export function judgeIdentityFrom(auth: AuthInstance): JudgeIdentity {
	return {
		async createUser({ email, name }) {
			const ctx = await auth.$context;
			const created = await ctx.internalAdapter.createUser({ email, name, emailVerified: false }, { method: 'email-password' });
			return { id: String(created.id) };
		},
		async setPassword(userId, password) {
			const ctx = await auth.$context;
			await ctx.internalAdapter.linkAccount({ userId, providerId: 'credential', accountId: userId, password: await ctx.password.hash(password) });
		},
		async signIn({ email, password }) {
			const result = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
			return result.headers ?? new Headers();
		},
	};
}

export interface JudgeStartInput {
	code: unknown;
	name: unknown;
	password: unknown;
	secret: string;
	/** The caller's keyed, hour-bound hash, computed by the route. */
	ipHash: string;
	config: JudgeAccessConfig;
	now?: string;
}

/**
 * First visit: check the code, the closing date, the places left and the name,
 * reserve the name, create the account and return a live session cookie.
 *
 * The reservation is written BEFORE the user exists so the invite gate admits
 * exactly this address, and only for the next ten minutes.
 */
export async function startJudge(db: D1Database, input: JudgeStartInput, identity: JudgeIdentity): Promise<{ name: string; headers: Headers }> {
	const now = input.now ?? new Date().toISOString();
	const name = validateJudgeName(input.name);
	const password = validateJudgePassword(input.password);
	const closed = judgeGate(input.config, now, true);
	if (closed) throw closed;
	await enforceJudgeRateLimit(db, 'start', input.ipHash, now, JUDGE_START_LIMIT);
	await recordJudgeAttempt(db, 'start', input.ipHash, now);
	if (!(await judgeCodeMatches(typeof input.code === 'string' ? input.code : '', input.config.code ?? '', input.secret))) {
		throw new ScopeError(403, 'judge_code', "That access code isn't right.");
	}
	if ((await judgeAccountCount(db)) >= maxJudgeAccounts(input.config)) {
		throw new ScopeError(403, 'judge_full', 'All the judge places are taken.');
	}
	if (await judgeNameBlocked(db, name, now)) {
		throw new ScopeError(409, 'name_taken', 'That judge name is taken. Try another.');
	}

	const email = judgeEmail(name);
	// Clear any stale reservation for this name, then reserve it. The fresh row
	// is what the invite gate reads; it admits nothing else.
	await db.prepare('delete from "judge_accounts" where lower("judgeName") = ? and "state" = \'starting\'').bind(name.toLowerCase()).run();
	await db
		.prepare('insert into "judge_accounts" ("judgeName","state","createdAt","lastSignInAt") values (?,?,?,null)')
		.bind(name, 'starting', now)
		.run();

	const created = await identity.createUser({ email, name });
	await identity.setPassword(created.id, password);
	await db
		.prepare('update "judge_accounts" set "state" = \'active\', "userId" = ?, "lastSignInAt" = ? where lower("judgeName") = ? and "state" = \'starting\'')
		.bind(created.id, now, name.toLowerCase())
		.run();

	const headers = await identity.signIn({ email, password });
	return { name, headers };
}

export interface JudgeSignInInput {
	name: unknown;
	password: unknown;
	ipHash: string;
	config: JudgeAccessConfig;
	now?: string;
}

/**
 * Returning, on any device: sign in with the judge name and password. Every
 * failure past input and rate checks is the same 401, so a caller can never
 * learn whether a name exists separately from whether the password is right.
 * A wrong name is checked the same way as a wrong password.
 */
export async function signInJudge(db: D1Database, input: JudgeSignInInput, identity: JudgeIdentity): Promise<{ name: string; headers: Headers }> {
	const now = input.now ?? new Date().toISOString();
	const closed = judgeGate(input.config, now, false);
	if (closed) throw closed;
	await enforceJudgeRateLimit(db, 'sign_in', input.ipHash, now, JUDGE_SIGN_IN_LIMIT);
	await recordJudgeAttempt(db, 'sign_in', input.ipHash, now);

	const localName = typeof input.name === 'string' ? input.name.trim() : '';
	const password = typeof input.password === 'string' ? input.password : '';
	const rows = await all(db, 'select "judgeName" from "judge_accounts" where lower("judgeName") = ? and "state" = \'active\' limit 1', localName.toLowerCase());
	const row = rows[0];
	// One refusal for a wrong name and for a wrong password. The sign-in runs
	// even when the name is unknown, so neither the answer nor the time it
	// takes tells the two apart (Better Auth hashes and compares either way).
	const accountName = row ? String(row['judgeName']) : localName;
	const invalid = new ScopeError(401, 'invalid_credentials', "That judge name or password isn't right.");
	let headers: Headers;
	try {
		headers = await identity.signIn({ email: judgeEmail(accountName), password });
	} catch {
		throw invalid;
	}
	if (!row) throw invalid;
	await db.prepare('update "judge_accounts" set "lastSignInAt" = ? where lower("judgeName") = ?').bind(now, localName.toLowerCase()).run();
	return { name: accountName, headers };
}
