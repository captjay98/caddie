import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import type { Mailer } from './notifications.ts';
import { assertProjectScope } from './scope.ts';
import type { AppAiMode } from './app-ai.ts';

/**
 * Sign-in for the people who use generated apps (Publish programme stage 7).
 * The app's own server runs Better Auth (template caddie/auth.ts) and asks
 * Caddie to deliver each 6-digit code through env.CADDIE.signInCode():
 *
 *   preview  the code lands in the project's TEST INBOX inside Caddie, so the
 *            owner can sign in to their own app as anyone; nothing is emailed.
 *   live     Caddie emails it with a FIXED text naming the app's address — an
 *            app never chooses an email's wording, so it can't send anything
 *            else through Caddie — and only while the app is published.
 *
 * Codes are capped per app and per person each hour, so an app can't be used
 * to flood an inbox. Replies are values ({ ok: false, reason, message }) the
 * app shows as they are. The app's cookie secret is derived per project and
 * mode from Caddie's own secret (appAuthSecret): never stored, never shown.
 */

export type AppSignInMode = AppAiMode;
export type SignInCodeReply =
	| { ok: true }
	| { ok: false; reason: 'invalid_request' | 'busy' | 'unavailable' | 'failed'; message: string };

export const APP_SIGN_IN_LIMITS = {
	perAppPerHour: { preview: 30, live: 200 } satisfies Record<AppSignInMode, number>,
	perPersonPerHour: 5,
	inboxKeep: 30,
} as const;

export interface AppSignInDeps {
	mailer: Mailer;
	/** The apps domain (published addresses); null when publishing isn't set up. */
	appsDomain: string | null;
	/** Caddie's own origin, for the report link in live emails. */
	caddieOrigin: string | null;
	now?: () => Date;
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const fail = (reason: Exclude<SignInCodeReply, { ok: true }>['reason'], message: string): SignInCodeReply => ({ ok: false, reason, message });

async function sha256Hex(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readRequest(input: unknown): { email: string; code: string } | SignInCodeReply {
	const body = input as { email?: unknown; code?: unknown } | null;
	const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
	const code = typeof body?.code === 'string' ? body.code.trim() : '';
	if (email.length > 254 || !EMAIL.test(email)) return fail('invalid_request', 'Enter a valid email address.');
	if (!/^\d{6}$/.test(code)) return fail('invalid_request', 'A sign-in code is 6 digits.');
	return { email, code };
}

async function count(db: D1Database, sql: string, ...values: unknown[]): Promise<number> {
	const row = (await db.prepare(sql).bind(...values).all()).results?.[0] as { n?: number } | undefined;
	return Number(row?.n ?? 0);
}

/** The fixed text of a live sign-in email. The app's address is the only app-specific part. */
export function signInEmailText(input: { code: string; appHost: string; appUrl: string; reportUrl: string | null }): { subject: string; textBody: string } {
	return {
		subject: `Your sign-in code for ${input.appHost}`,
		textBody: [
			`Your code for ${input.appHost} is ${input.code}`,
			'',
			`It expires in 10 minutes. If you didn't try to sign in to ${input.appHost}, you can ignore this email.`,
			'',
			`${input.appUrl} is an app made with Caddie.`,
			...(input.reportUrl ? [`Report a problem with this app: ${input.reportUrl}`] : []),
		].join('\n'),
	};
}

export async function sendAppSignInCode(
	db: D1Database,
	deps: AppSignInDeps,
	input: { projectId: string; mode: AppSignInMode; request: unknown },
): Promise<SignInCodeReply> {
	const now = deps.now?.() ?? new Date();
	const read = readRequest(input.request);
	if ('ok' in read) return read;

	let slug: string | null = null;
	if (input.mode === 'live') {
		const published = (await db.prepare('select "status", "slug" from "app_publications" where "projectId" = ?').bind(input.projectId).all()).results?.[0] as
			| { status?: string; slug?: string }
			| undefined;
		if (published?.status !== 'live' || !published.slug || !deps.appsDomain) return fail('unavailable', "This app isn't published right now.");
		if (deps.mailer.name === 'noop') return fail('unavailable', "Sign-in emails aren't set up on this Caddie server yet.");
		slug = published.slug;
	}

	const hourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
	if ((await count(db, 'select count(*) as "n" from "app_sign_in_emails" where "projectId" = ? and "mode" = ? and "createdAt" > ?', input.projectId, input.mode, hourAgo)) >= APP_SIGN_IN_LIMITS.perAppPerHour[input.mode]) {
		return fail('busy', 'This app has sent a lot of sign-in codes in the last hour. Try again later.');
	}
	const recipientHash = await sha256Hex(`${input.projectId}:${read.email}`);
	if ((await count(db, 'select count(*) as "n" from "app_sign_in_emails" where "projectId" = ? and "recipientHash" = ? and "createdAt" > ?', input.projectId, recipientHash, hourAgo)) >= APP_SIGN_IN_LIMITS.perPersonPerHour) {
		return fail('busy', 'Several codes were already sent to this address. Wait a few minutes and use the newest one.');
	}

	const stamp = now.toISOString();
	const record = (status: 'inbox' | 'sent' | 'failed') =>
		db
			.prepare('insert into "app_sign_in_emails" ("id","projectId","mode","recipientHash","status","createdAt") values (?,?,?,?,?,?)')
			.bind(`sie_${crypto.randomUUID()}`, input.projectId, input.mode, recipientHash, status, stamp);

	if (input.mode === 'preview') {
		await db.batch([
			record('inbox'),
			db.prepare('insert into "app_test_inbox" ("id","projectId","toEmail","code","createdAt") values (?,?,?,?,?)').bind(`tib_${crypto.randomUUID()}`, input.projectId, read.email, read.code, stamp),
			db
				.prepare('delete from "app_test_inbox" where "projectId" = ? and "id" not in (select "id" from "app_test_inbox" where "projectId" = ? order by "createdAt" desc, "rowid" desc limit ?)')
				.bind(input.projectId, input.projectId, APP_SIGN_IN_LIMITS.inboxKeep),
		]);
		return { ok: true };
	}

	const appHost = `${slug}.${deps.appsDomain}`;
	const message = signInEmailText({
		code: read.code,
		appHost,
		appUrl: `https://${appHost}/`,
		reportUrl: deps.caddieOrigin ? `${deps.caddieOrigin.replace(/\/+$/, '')}/report?app=${encodeURIComponent(slug!)}` : null,
	});
	const sent = await deps.mailer.send({ to: read.email, ...message });
	await record(sent.ok ? 'sent' : 'failed').run();
	if (!sent.ok) {
		console.error(JSON.stringify({ kind: 'app-sign-in-email', projectId: input.projectId, outcome: 'failed', error: String(sent.error ?? '').slice(0, 200) }));
		return fail('failed', "The sign-in email couldn't be sent. Try again in a minute.");
	}
	return { ok: true };
}

export interface TestInboxMessage {
	to: string;
	code: string;
	createdAt: string;
}

/** The preview's test inbox, newest first (any project member). */
export async function listTestInbox(db: D1Database, scope: Scope, limit = 20): Promise<TestInboxMessage[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = (await db
		.prepare('select "toEmail", "code", "createdAt" from "app_test_inbox" where "projectId" = ? order by "createdAt" desc, "rowid" desc limit ?')
		.bind(verified.projectId, Math.min(Math.max(limit, 1), APP_SIGN_IN_LIMITS.inboxKeep))
		.all()).results ?? [];
	return (rows as Array<Record<string, unknown>>).map((row) => ({ to: String(row['toEmail']), code: String(row['code']), createdAt: String(row['createdAt']) }));
}

/** "Reset test data" empties the test inbox with the preview database. */
export async function clearTestInbox(db: D1Database, projectId: string): Promise<void> {
	await db.prepare('delete from "app_test_inbox" where "projectId" = ?').bind(projectId).run();
}

/**
 * The secret an app signs its sign-in cookies with, one per project and mode,
 * derived from Caddie's own secret (HMAC-SHA256): nothing to store, and a
 * preview cookie never works on the published app. Null without Caddie's secret.
 */
export async function appAuthSecret(masterSecret: string | undefined, projectId: string, mode: AppSignInMode): Promise<string | null> {
	const master = (masterSecret ?? '').trim();
	if (master.length < 16) return null;
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(master), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`caddie-app-auth:v1:${mode}:${projectId}`)));
	let binary = '';
	for (const byte of mac) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
