import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope } from './scope.ts';
import type { AppAiMode } from './app-ai.ts';

/**
 * Emails inside apps (plan part K). A generated app's server calls
 * `env.CADDIE.email({ to, subject, text, template })`. This week every email,
 * from a preview or a published app, is STORED in `app_test_emails` and shown
 * in the project's test inbox marked "Not sent — test mode" (D11). Nothing is
 * ever delivered — the app can't choose a recipient and send it mail — so the
 * reply is a value the app shows as it is:
 *
 *   { ok: true, delivered: 'test-inbox' }   stored, nothing sent
 *   { ok: false, reason, message }          refused, with a plain message
 *
 * Limits: one address per email; a subject of at most 150 characters and text
 * of at most 5,000; 20 emails per app per hour; the inbox keeps the latest 50
 * per app. Whether an app may send at all is decided by the caller
 * (app-platform.ts), from the project's stamped `appFeatures` / the
 * `app_features` switch — the same rule as photos — never by the app.
 */

export type AppEmailMode = AppAiMode;
export type AppEmailFailure = 'invalid_request' | 'too_long' | 'busy' | 'unavailable';
export type AppEmailReply =
	| { ok: true; delivered: 'test-inbox' }
	| { ok: false; reason: AppEmailFailure; message: string };

export const APP_EMAIL_LIMITS = {
	maxSubject: 150,
	maxText: 5_000,
	/** At most this many templates characters are stored (a short name). */
	maxTemplate: 100,
	perAppPerHour: 20,
	inboxKeep: 50,
} as const;

/** Same forgiving "looks like one address" shape app-sign-in uses; no lists. */
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export interface AppEmailDeps {
	now?: () => Date;
}

const fail = (reason: AppEmailFailure, message: string): AppEmailReply => ({ ok: false, reason, message });

interface ReadEmail {
	to: string;
	subject: string;
	text: string;
	template: string | null;
}

/** Validate what the app sent. One address only; a bad one is refused. */
function readRequest(input: unknown): ReadEmail | AppEmailReply {
	const body = input as { to?: unknown; subject?: unknown; text?: unknown; template?: unknown } | null;
	if (!body || typeof body !== 'object') {
		return fail('invalid_request', 'Send { to, subject, text }.');
	}
	const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : '';
	// One address per email: a comma, semicolon or whitespace-separated list is refused.
	if (to.length === 0 || to.length > 254 || /[\s,;]/.test(to) || !EMAIL.test(to)) {
		return fail('invalid_request', 'Send one valid email address in "to".');
	}
	const subject = typeof body.subject === 'string' ? body.subject : '';
	const text = typeof body.text === 'string' ? body.text : '';
	if (subject.trim().length === 0 || text.trim().length === 0) {
		return fail('invalid_request', 'An email needs a subject and some text.');
	}
	if (subject.length > APP_EMAIL_LIMITS.maxSubject) {
		return fail('too_long', `A subject can be at most ${APP_EMAIL_LIMITS.maxSubject} characters.`);
	}
	if (text.length > APP_EMAIL_LIMITS.maxText) {
		return fail('too_long', `An email's text can be at most ${APP_EMAIL_LIMITS.maxText} characters.`);
	}
	const template = typeof body.template === 'string' && body.template.trim().length > 0 ? body.template.trim().slice(0, APP_EMAIL_LIMITS.maxTemplate) : null;
	return { to, subject, text, template };
}

/**
 * Store one email in the project's test inbox. Nothing is sent. The caller
 * (app-platform.ts) decides whether the app may send at all; this function
 * always records, never delivers, so the mail stub has no "send" to record.
 */
export async function sendAppEmail(
	db: D1Database,
	deps: AppEmailDeps,
	input: { projectId: string; mode: AppEmailMode; request: unknown },
): Promise<AppEmailReply> {
	const now = deps.now?.() ?? new Date();
	const read = readRequest(input.request);
	if ('ok' in read) return read;

	const hourAgo = new Date(now.getTime() - 60 * 60_000).toISOString();
	const stamp = now.toISOString();
	// P2 (review 2026-10-23): admit atomically. A count-then-insert let two
	// concurrent sends both pass the hourly limit; this inserts ONLY when the
	// count in the last hour is still under the cap, in the same statement.
	const admit = (await db
		.prepare(
			'insert into "app_test_emails" ("id","projectId","mode","toEmail","subject","textBody","template","createdAt") ' +
				'select ?,?,?,?,?,?,?,? ' +
				'where (select count(*) from "app_test_emails" where "projectId" = ? and "createdAt" > ?) < ?',
		)
		.bind(
			`ate_${crypto.randomUUID()}`,
			input.projectId,
			input.mode,
			read.to,
			read.subject,
			read.text,
			read.template,
			stamp,
			input.projectId,
			hourAgo,
			APP_EMAIL_LIMITS.perAppPerHour,
		)
		.run()) as { meta?: { changes?: number } };
	if (!admit.meta?.changes) {
		return fail('busy', 'This app has sent a lot of emails in the last hour. Try again later.');
	}
	// Keep only the newest inboxKeep messages for this app.
	await db
		.prepare('delete from "app_test_emails" where "projectId" = ? and "id" not in (select "id" from "app_test_emails" where "projectId" = ? order by "createdAt" desc, "rowid" desc limit ?)')
		.bind(input.projectId, input.projectId, APP_EMAIL_LIMITS.inboxKeep)
		.run();
	return { ok: true, delivered: 'test-inbox' };
}

export interface TestEmailMessage {
	to: string;
	subject: string;
	text: string;
	template: string | null;
	mode: AppEmailMode;
	createdAt: string;
}

/** The preview's test emails, newest first (any project member). */
export async function listTestEmails(db: D1Database, scope: Scope, limit: number = APP_EMAIL_LIMITS.inboxKeep): Promise<TestEmailMessage[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = (await db
		.prepare('select "toEmail", "subject", "textBody", "template", "mode", "createdAt" from "app_test_emails" where "projectId" = ? order by "createdAt" desc, "rowid" desc limit ?')
		.bind(verified.projectId, Math.min(Math.max(limit, 1), APP_EMAIL_LIMITS.inboxKeep))
		.all()).results ?? [];
	return (rows as Array<Record<string, unknown>>).map((row) => ({
		to: String(row['toEmail']),
		subject: String(row['subject']),
		text: String(row['textBody']),
		template: row['template'] == null ? null : String(row['template']),
		mode: row['mode'] === 'live' ? 'live' : 'preview',
		createdAt: String(row['createdAt']),
	}));
}

/** "Reset test data" empties the test emails along with the codes. */
export async function clearTestEmails(db: D1Database, projectId: string): Promise<void> {
	await db.prepare('delete from "app_test_emails" where "projectId" = ?').bind(projectId).run();
}
