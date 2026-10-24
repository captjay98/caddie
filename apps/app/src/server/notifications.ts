import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';
import { sendWebPush, vapidFromEnv, type VapidKeys } from './web-push.ts';

/**
 * P12 slice 3 — notifications (feature-ledger C20, ADAPT/IMPROVE): in-app
 * alerts plus the Mailer port for opt-in email.
 *
 * Invariants (each pinned by tests/schedules.integration.test.ts):
 *   - dedupeKey is UNIQUE: a repeated notify with the same effective key is a
 *     no-op, never a second row. Time-windowed or per-state dedupe composes
 *     the window/state INTO the key at the service boundary (for example
 *     `sentinel:<sourceId>:<snapshotId>` or `task-reminder:<taskId>:<dueAt>`),
 *     so the storage constraint stays absolute while periodic digests can
 *     re-notify in a later window.
 *   - Reminder keys ride the dueAt instant: when a task's date changes, the
 *     next reminder lands on a NEW key (a new row) and the old row is never
 *     deleted — "date changes recalculate reminders without deleting history".
 *   - Email delivery is fire-and-capture: a failed or THROWING mailer never
 *     fails the calling domain operation; every attempt leaves a
 *     notification_deliveries receipt ('sent' = delivery receipt, 'failed' =
 *     the retry-visible queue entry; a retry updates the SAME row via
 *     priorDeliveryId, incrementing attempts).
 *   - The default Mailer is NoopMailer: with no provider configured it
 *     reports "not configured" honestly — an absent provider is BLOCKED, not
 *     a faked pass. The real SMTP driver is P17 wiring; the port below is the
 *     seam it will implement. Email copy is TEXT-ONLY here, so there is
 *     nothing to escape; any future HTML composition MUST escape title/body
 *     and carry the configured origin (packet P12 acceptance).
 */

export interface NotificationRecord {
	readonly id: string;
	readonly userId: string;
	readonly projectId: string | null;
	readonly kind: string;
	readonly title: string;
	readonly body: string;
	readonly readAt: string | null;
	readonly dedupeKey: string;
	readonly createdAt: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

function requireText(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		fail(400, 'invalid_input', `${field} is required and must be a non-empty string`);
	}
	return value;
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

function readChanges(result: unknown): number {
	const meta = (result as { meta?: { changes?: number } }).meta;
	if (meta && meta.changes !== undefined) return Number(meta.changes);
	return Number((result as { changes?: number }).changes ?? 0);
}

function notificationFromRow(row: Record<string, unknown>): NotificationRecord {
	return {
		id: String(row['id']),
		userId: String(row['userId']),
		projectId: row['projectId'] == null ? null : String(row['projectId']),
		kind: String(row['kind']),
		title: String(row['title']),
		body: String(row['body']),
		readAt: row['readAt'] == null ? null : String(row['readAt']),
		dedupeKey: String(row['dedupeKey']),
		createdAt: String(row['createdAt']),
	};
}

export interface NotificationInput {
	userId: string;
	/** Nullable: some alerts are account-level, not tied to one project. */
	projectId?: string | null;
	kind: string;
	title: string;
	body: string;
	dedupeKey: string;
}

/**
 * Create an in-app notification. The unique dedupeKey arbitrates: the FIRST
 * write wins, any repeat is a no-op returning { created: false }.
 */
export async function createNotification(
	db: D1Database,
	input: NotificationInput,
): Promise<{ created: boolean; notification: NotificationRecord | null }> {
	requireText(input.userId, 'userId');
	requireText(input.kind, 'kind');
	requireText(input.title, 'title');
	requireText(input.body, 'body');
	const dedupeKey = requireText(input.dedupeKey, 'dedupeKey');
	const projectId =
		input.projectId === undefined || input.projectId === null ? null : requireText(input.projectId, 'projectId');
	const id = `ntf_${crypto.randomUUID()}`;
	const now = nowIso();
	const insert = await db
		.prepare(
			'insert or ignore into "notifications" ' +
				'("id","userId","projectId","kind","title","body","readAt","dedupeKey","createdAt") ' +
				'values (?,?,?,?,?,?,null,?,?)',
		)
		.bind(id, input.userId, projectId, input.kind, input.title, input.body, dedupeKey, now)
		.run();
	if (readChanges(insert) !== 1) {
		return { created: false, notification: null };
	}
	return {
		created: true,
		notification: {
			id,
			userId: input.userId,
			projectId,
			kind: input.kind,
			title: input.title,
			body: input.body,
			readAt: null,
			dedupeKey,
			createdAt: now,
		},
	};
}

export interface DeliveryContext {
	/** The mailer to send through (mailerFromEnv). */
	mailer: Mailer;
	/** The configured deployment origin, for links in the email body. */
	origin: string;
	/** VAPID keys for web push (vapidFromEnv); null when push is not configured. */
	vapid?: VapidKeys | null;
}

/**
 * A DeliveryContext from the Worker env (threaded in as `unknown` by callers
 * that hold it). Returns undefined when there is no env, so a caller without
 * one simply does in-app-only delivery. The origin comes from PUBLIC_ORIGIN /
 * BETTER_AUTH_URL when set, else '' (email still sends; its link degrades).
 */
export function deliveryFromEnv(env: unknown): DeliveryContext | undefined {
	if (!env || typeof env !== 'object') return undefined;
	const e = env as Record<string, unknown>;
	const origin =
		(typeof e['PUBLIC_ORIGIN'] === 'string' && (e['PUBLIC_ORIGIN'] as string)) ||
		(typeof e['BETTER_AUTH_URL'] === 'string' && (e['BETTER_AUTH_URL'] as string)) ||
		'';
	return { mailer: mailerFromEnv(e), origin, vapid: vapidFromEnv(e) };
}

/**
 * Create a notification AND fan it out to the opt-in channels the user has on
 * for its kind. The in-app row is always written (it is the record); email and
 * push are sent only when the kind's channel is on (and the prerequisite — a
 * verified address for email, a subscribed device + VAPID for push — is met).
 * Fire-and-capture: any delivery that fails NEVER fails this call — the inbox
 * notification still stands and each attempt leaves a retry-visible receipt. A
 * de-duplicated repeat (created=false) sends nothing.
 */
export async function createAndDeliverNotification(
	db: D1Database,
	input: NotificationInput,
	delivery: DeliveryContext,
): Promise<{ created: boolean; notification: NotificationRecord | null }> {
	const result = await createNotification(db, input);
	if (!result.created || !result.notification) return result;
	const notification = result.notification;

	try {
		const explicitRows = await queryAll(
			db,
			'select "email","push" from "notification_prefs" where "userId" = ? and "kind" = ?',
			input.userId,
			input.kind,
		);
		const explicit = explicitRows[0]
			? { email: Number(explicitRows[0]['email']) === 1, push: Number(explicitRows[0]['push']) === 1 }
			: null;
		const channels = channelsForKind(input.kind, explicit);

		// Email, only when the kind's email channel is on for this user.
		if (channels.email) {
			// ownerEmail fails closed on a missing/unverified address; that is a
			// captured non-send, never a thrown error up here.
			const to = await ownerEmail(db, input.userId).catch(() => null);
			if (to) {
				await attemptEmailDelivery(
					db,
					{ notificationId: notification.id, to, origin: delivery.origin },
					delivery.mailer,
				);
			}
		}

		// Push, only when the kind's push channel is on AND a device is subscribed
		// AND VAPID is configured. Each device gets one send; a 404/410 prunes it.
		if (channels.push && delivery.vapid) {
			await deliverPush(db, input.userId, notification, delivery.vapid);
		}
	} catch {
		// Fire-and-capture: delivery must never fail the domain operation.
	}
	return result;
}

/**
 * Send one notification to every device the user has subscribed, recording a
 * push delivery receipt per device and pruning any the push service reports
 * gone. Never throws.
 */
async function deliverPush(
	db: D1Database,
	userId: string,
	notification: NotificationRecord,
	vapid: VapidKeys,
): Promise<void> {
	const subs = await listPushSubscriptions(db, userId);
	const payload = {
		title: notification.title,
		body: notification.body,
		url: notification.projectId ? `/app/project?project=${notification.projectId}` : '/app/',
		tag: notification.kind,
	};
	for (const sub of subs) {
		const res = await sendWebPush(sub, payload, vapid);
		const now = nowIso();
		const status = res.ok ? 'sent' : 'failed';
		await db
			.prepare(
				'insert into "notification_deliveries" ("id","notificationId","channel","status","error","attempts","createdAt") values (?,?,\'push\',?,?,1,?)',
			)
			.bind(`dlv_${crypto.randomUUID()}`, notification.id, status, res.ok ? null : res.error ?? `push ${res.status}`, now)
			.run();
		if (res.expired) await db.prepare('delete from "push_subscriptions" where "endpoint" = ?').bind(sub.endpoint).run();
		if (res.ok) await db.prepare('update "push_subscriptions" set "lastUsedAt" = ? where "endpoint" = ?').bind(now, sub.endpoint).run();
	}
}

// --- push subscription storage (0045) ------------------------------------------------

export interface StoredPushSubscription {
	endpoint: string;
	p256dh: string;
	auth: string;
}

/** Save (or update in place) a browser's push subscription for a user. */
export async function savePushSubscription(
	db: D1Database,
	userId: string,
	sub: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
	requireText(userId, 'userId');
	const endpoint = requireText(sub.endpoint, 'endpoint');
	const p256dh = requireText(sub.p256dh, 'p256dh');
	const auth = requireText(sub.auth, 'auth');
	await db
		.prepare(
			'insert into "push_subscriptions" ("id","userId","endpoint","p256dh","auth","createdAt") values (?,?,?,?,?,?) ' +
				'on conflict("endpoint") do update set "userId" = excluded."userId", "p256dh" = excluded."p256dh", "auth" = excluded."auth"',
		)
		.bind(`psub_${crypto.randomUUID()}`, userId, endpoint, p256dh, auth, nowIso())
		.run();
}

/** A user's push subscriptions (endpoint + keys), for sending. */
export async function listPushSubscriptions(db: D1Database, userId: string): Promise<StoredPushSubscription[]> {
	requireText(userId, 'userId');
	const rows = await queryAll(db, 'select "endpoint","p256dh","auth" from "push_subscriptions" where "userId" = ?', userId);
	return rows.map((row) => ({ endpoint: String(row['endpoint']), p256dh: String(row['p256dh']), auth: String(row['auth']) }));
}

/** Remove one subscription by endpoint (the browser unsubscribed). */
export async function deletePushSubscription(db: D1Database, userId: string, endpoint: string): Promise<void> {
	requireText(userId, 'userId');
	await db.prepare('delete from "push_subscriptions" where "userId" = ? and "endpoint" = ?').bind(userId, endpoint).run();
}

export interface NotificationFilter {
	unreadOnly?: boolean;
	limit?: number;
}

/** The user's own notifications, newest first. A user never sees another's. */
export async function listNotifications(
	db: D1Database,
	userId: string,
	filter: NotificationFilter = {},
): Promise<NotificationRecord[]> {
	if (typeof userId !== 'string' || userId.length === 0) {
		fail(400, 'invalid_request', 'userId is required');
	}
	const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
	const rows = filter.unreadOnly
		? await queryAll(
				db,
				'select * from "notifications" where "userId" = ? and "readAt" is null order by "createdAt" desc, "id" asc limit ?',
				userId,
				limit,
			)
		: await queryAll(
				db,
				'select * from "notifications" where "userId" = ? order by "createdAt" desc, "id" asc limit ?',
				userId,
				limit,
			);
	return rows.map(notificationFromRow);
}

/** One of the USER'S OWN notifications, or 404 — ownership is the scope. */
export async function getNotification(
	db: D1Database,
	userId: string,
	notificationId: string,
): Promise<NotificationRecord> {
	if (typeof notificationId !== 'string' || notificationId.length === 0) {
		fail(400, 'invalid_request', 'notificationId is required');
	}
	const rows = await queryAll(
		db,
		'select * from "notifications" where "id" = ? and "userId" = ?',
		notificationId,
		userId,
	);
	if (!rows[0]) fail(404, 'notification_not_found', 'no such notification for this user');
	return notificationFromRow(rows[0]!);
}

export async function markNotificationRead(
	db: D1Database,
	userId: string,
	notificationId: string,
): Promise<NotificationRecord> {
	const current = await getNotification(db, userId, notificationId); // ownership 404
	if (current.readAt === null) {
		await db
			.prepare('update "notifications" set "readAt" = ? where "id" = ? and "userId" = ?')
			.bind(nowIso(), current.id, userId)
			.run();
	}
	return getNotification(db, userId, notificationId);
}

// --- reminders ---------------------------------------------------------------------

/**
 * The reminder dedupe key for a task due date. The dueAt IS the state: a
 * changed date produces a new key (and, on the next reminder pass, a new
 * row) while the old row — and therefore the reminder history — stays.
 */
export function reminderKeyForTask(taskId: string, dueAtIso: string | null): string {
	return `task-reminder:${taskId}:${dueAtIso ?? 'none'}`;
}

export interface TaskReminderInput {
	userId: string;
	projectId: string | null;
	taskId: string;
	taskTitle: string;
	dueAt: string | null;
}

/** Notify (dedupe-keyed on the due date) about an upcoming task deadline. */
export async function notifyTaskReminder(
	db: D1Database,
	input: TaskReminderInput,
): Promise<{ created: boolean; notification: NotificationRecord | null }> {
	requireText(input.taskId, 'taskId');
	const due = input.dueAt ? new Date(Date.parse(input.dueAt)).toISOString() : null;
	return createNotification(db, {
		userId: input.userId,
		projectId: input.projectId,
		kind: 'task_reminder',
		title: `Task due: ${input.taskTitle}`,
		body: due
			? `"${input.taskTitle}" is due at ${due}.`
			: `"${input.taskTitle}" has no due date set.`,
		dedupeKey: reminderKeyForTask(input.taskId, due),
	});
}

/** Test/ops helper: count a user's notifications (database truth). */
export async function notificationCount(db: D1Database, userId: string): Promise<number> {
	const rows = await queryAll(
		db,
		'select count(*) as "n" from "notifications" where "userId" = ?',
		userId,
	);
	return Number(rows[0]?.['n'] ?? 0);
}

// --- the Mailer port -----------------------------------------------------------------

export interface MailMessage {
	to: string;
	subject: string;
	textBody: string;
	/** Styled HTML alternative (Caddie colours, light/dark). Falls back to text. */
	htmlBody?: string;
	/** Overrides the deployment default sender (e.g. "Caddie <caddie@jamalibrahim.dev>"). */
	from?: string;
}

export interface MailSendResult {
	ok: boolean;
	error?: string;
}

/**
 * The outbound-email port. P17 will implement it against a real provider;
 * P12 ships only the port and the honest default below.
 */
export interface Mailer {
	readonly name: string;
	send(message: MailMessage): Promise<MailSendResult>;
}

/**
 * The DEFAULT mailer: no provider is configured, so it reports exactly that.
 * It never pretends to have sent anything — attempts through it land as
 * 'failed' receipts that stay visible for retry (the absent-provider posture
 * is BLOCKED, never a faked pass).
 */
export const noopMailer: Mailer = {
	name: 'noop',
	send: async () => ({
		ok: false,
		error: 'no mail provider configured (SMTP wiring is P17; recipient email requires explicit owner authorization)',
	}),
};

/**
 * Resend Mailer: real transactional email through api.resend.com (the same
 * provider the old caddie used).
 *
 * The API key is passed IN by the caller (from the Worker `env` binding), not
 * read from `process.env`: on Cloudflare, bindings only reach `process.env`
 * with `nodejs_compat_populate_process_env`, which wrangler.jsonc does NOT set
 * — so a `process.env.RESEND_API_KEY` read is empty in production even though
 * the secret is configured. Threading the key through `env` is the posture
 * AGENTS.md warns to keep.
 */
export function makeResendMailer(apiKey: string): Mailer {
	return {
		name: 'resend',
		send: async (message) => {
			if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not configured' };
			try {
				const res = await fetch('https://api.resend.com/emails', {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
					body: JSON.stringify({
						from: message.from,
						to: [message.to],
						subject: message.subject,
						text: message.textBody,
						...(message.htmlBody ? { html: message.htmlBody } : {}),
				}),
			});
			if (!res.ok) {
				const text = await res.text();
				return { ok: false, error: `Resend HTTP ${res.status}: ${text.slice(0, 200)}` };
			}
			const body = (await res.json()) as { id?: string };
			return { ok: true, id: body.id };
			} catch (error) {
				return { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 200) };
			}
		},
	};
}

/**
 * Select the mailer for this deployment: Resend when RESEND_API_KEY +
 * RESEND_FROM are configured, otherwise the noop mailer — whose failed
 * receipts stay visible for retry, never a faked pass. The key is read from
 * the Worker `env` binding (falling back to process.env only for local Node
 * tooling), and THREADED into the mailer so the send never depends on
 * process.env being populated.
 */
export function mailerFromEnv(env?: Record<string, unknown>): Mailer {
	const get = (key: string): string | undefined =>
		env && typeof env[key] === 'string' ? (env[key] as string) : process.env[key];
	const key = get('RESEND_API_KEY');
	const from = get('RESEND_FROM');
	if (key && from) {
		const resend = makeResendMailer(key);
		return {
			name: 'resend',
			send: async (message) => resend.send({ ...message, from: `Caddie <${from}>` }),
		};
	}
	return noopMailer;
}

export interface MailReceipt {
	readonly id: string;
	readonly notificationId: string;
	readonly channel: 'email';
	readonly status: 'sent' | 'failed';
	readonly error: string | null;
	readonly attempts: number;
	readonly createdAt: string;
}

export interface EmailDeliveryInput {
	notificationId: string;
	/** Opt-in recipient — explicit, never scraped from preferences. */
	to: string;
	/** The configured origin, rendered into the body so links are real. */
	origin: string;
	/** Pass a failed receipt's id to RETRY: the same row is updated. */
	priorDeliveryId?: string;
}

function validateRecipient(to: unknown): string {
	if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
		fail(400, 'invalid_input', 'to must be an email address');
	}
	return to.trim();
}

/**
 * The authenticated user's OWN verified email. Email is only ever sent to the
 * account that owns the notification — never a request-supplied address — so
 * the recipient is resolved from the session user id here, server-side. An
 * unverified or missing email fails closed (no send to an unproven address).
 */
export async function ownerEmail(db: D1Database, userId: string): Promise<string> {
	const rows = await queryAll(db, 'select "email", "emailVerified" from "user" where "id" = ?', userId);
	const row = rows[0];
	if (!row || typeof row['email'] !== 'string' || !row['email'].trim()) {
		fail(404, 'no_email', 'your account has no email address on file');
	}
	// emailVerified is 0/1 (SQLite); a falsy value is unverified.
	if (!row['emailVerified']) {
		fail(403, 'email_unverified', 'your account email is not verified — verify it before Caddie can email you');
	}
	return (row['email'] as string).trim();
}

function receiptFromRow(row: Record<string, unknown>): MailReceipt {
	const status = row['status'];
	if (status !== 'sent' && status !== 'failed') {
		fail(500, 'invalid_row', `delivery row carries an unknown status: ${String(status)}`);
	}
	return {
		id: String(row['id']),
		notificationId: String(row['notificationId']),
		channel: 'email',
		status,
		error: row['error'] == null ? null : String(row['error']),
		attempts: Number(row['attempts']),
		createdAt: String(row['createdAt']),
	};
}

/** Escape text for safe interpolation into the HTML email body. */
function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A Caddie-branded HTML email: the Azure palette (the default app theme), with
 * a light base and a `prefers-color-scheme: dark` override so it matches the
 * app in either mode. Table layout + inline styles for client compatibility;
 * title and body are HTML-escaped. Email clients ignore CSS variables, so the
 * colours are literal — light: bg #f6f8fc, card #ffffff, text #0b1220, accent
 * #155fbe; dark: bg #090b10, card #141922, text #e6e9ef, accent #4d9fff.
 */
export function caddieEmailHtml(title: string, body: string, origin: string): string {
	const t = escapeHtml(title);
	const b = escapeHtml(body).replace(/\n/g, '<br>');
	const url = origin ? `${origin}/app` : '#';
	return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<style>
  :root { color-scheme: light dark; }
  .bg { background:#f6f8fc; } .card { background:#ffffff; border:1px solid #e2e8f3; }
  .title { color:#0b1220; } .body { color:#3a4455; } .brand { color:#155fbe; }
  .btn { background:#155fbe; color:#ffffff !important; }
  .muted { color:#8a93a6; }
  @media (prefers-color-scheme: dark) {
    .bg { background:#090b10 !important; } .card { background:#141922 !important; border-color:#242c38 !important; }
    .title { color:#e6e9ef !important; } .body { color:#b4bccb !important; } .brand { color:#4d9fff !important; }
    .btn { background:#4d9fff !important; color:#09121c !important; } .muted { color:#6b7484 !important; }
  }
</style></head>
<body class="bg" style="margin:0;background:#f6f8fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:#f6f8fc;padding:24px 0;"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
    <tr><td style="padding:0 8px 14px;"><span class="brand" style="color:#155fbe;font-weight:700;font-size:15px;letter-spacing:.3px;">Caddie</span></td></tr>
    <tr><td class="card" style="background:#ffffff;border:1px solid #e2e8f3;border-radius:14px;padding:24px;">
      <h1 class="title" style="margin:0 0 10px;font-size:19px;line-height:1.3;color:#0b1220;">${t}</h1>
      <p class="body" style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#3a4455;">${b}</p>
      <a href="${url}" class="btn" style="display:inline-block;background:#155fbe;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:10px;">Open your workspace</a>
    </td></tr>
    <tr><td style="padding:14px 8px 0;"><p class="muted" style="margin:0;font-size:12px;color:#8a93a6;">You’re getting this because you turned on email for this kind of update. Change it in Caddie → Settings → Notifications.</p></td></tr>
  </table>
</td></tr></table></body></html>`;
}

/**
 * Attempt email delivery of a notification. NEVER throws and NEVER fails the
 * calling domain operation: the mailer's outcome (or its explosion) is
 * captured onto a notification_deliveries receipt — 'sent' is the delivery
 * receipt, 'failed' is the retry-visible queue entry. A retry passes the
 * prior failed receipt's id and the SAME row is updated (attempts increments);
 * a first attempt inserts a new row.
 */
export async function attemptEmailDelivery(
	db: D1Database,
	input: EmailDeliveryInput,
	mailer: Mailer,
): Promise<MailReceipt> {
	if (typeof input.notificationId !== 'string' || input.notificationId.length === 0) {
		fail(400, 'invalid_request', 'notificationId is required');
	}
	const to = validateRecipient(input.to);
	const origin = typeof input.origin === 'string' && input.origin.trim() ? input.origin.trim() : '';
	const rows = await queryAll(
		db,
		'select * from "notifications" where "id" = ?',
		input.notificationId,
	);
	if (!rows[0]) fail(404, 'notification_not_found', 'no such notification');
	const notification = notificationFromRow(rows[0]!);

	// Text-only composition (nothing to escape). The origin is the configured
	// deployment origin, never request-supplied paths.
	const textBody = [
		notification.title,
		'',
		notification.body,
		'',
		origin ? `Open your workspace: ${origin}/app` : '(origin not configured)',
	].join('\n');
	const htmlBody = caddieEmailHtml(notification.title, notification.body, origin);

	let outcome: MailSendResult;
	try {
		outcome = await mailer.send({ to, subject: notification.title, textBody, htmlBody });
	} catch (error) {
		outcome = { ok: false, error: String(error) };
	}
	const status: 'sent' | 'failed' = outcome.ok ? 'sent' : 'failed';
	const error = outcome.ok ? null : (outcome.error ?? 'unknown mailer failure');
	const now = nowIso();

	if (input.priorDeliveryId !== undefined) {
		// Retry: update the SAME receipt row, incrementing attempts.
		const prior = await queryAll(
			db,
			'select * from "notification_deliveries" where "id" = ? and "notificationId" = ?',
			input.priorDeliveryId,
			notification.id,
		);
		if (!prior[0]) fail(404, 'delivery_not_found', 'no such delivery for this notification');
		const attempts = Number(prior[0]['attempts']) + 1;
		await db
			.prepare(
				'update "notification_deliveries" set "status" = ?, "error" = ?, "attempts" = ?, "createdAt" = ? where "id" = ?',
			)
			.bind(status, error, attempts, now, input.priorDeliveryId)
			.run();
		return receiptFromRow({
			id: input.priorDeliveryId,
			notificationId: notification.id,
			status,
			error,
			attempts,
			createdAt: now,
		});
	}

	const id = `dlv_${crypto.randomUUID()}`;
	await db
		.prepare(
			'insert into "notification_deliveries" ' +
				'("id","notificationId","channel","status","error","attempts","createdAt") values (?,?,\'email\',?,?,1,?)',
		)
		.bind(id, notification.id, status, error, now)
		.run();
	return receiptFromRow({
		id,
		notificationId: notification.id,
		status,
		error,
		attempts: 1,
		createdAt: now,
	});
}

// --- per-kind delivery preferences (0045) --------------------------------------------

/** The two OPT-IN delivery channels. In-app is always on and never stored. */
export interface ChannelPrefs {
	email: boolean;
	push: boolean;
}

/**
 * The DEFAULT channels for each notification kind, used when the user has set
 * no explicit preference. In-app is always on (the inbox is the record); these
 * decide only email and push. The guiding rule: a kind that NEEDS the person
 * (a paused build, a plan waiting) defaults email ON so they hear about it when
 * away; routine or informational kinds default both OFF. Push is off by default
 * for every kind until the person subscribes a device AND opts a kind in.
 */
export const DEFAULT_CHANNEL_PREFS: Readonly<Record<string, ChannelPrefs>> = {
	build_paused: { email: true, push: true },
	task_reminder: { email: true, push: false },
	sentinel_material_change: { email: true, push: false },
	discovery_fit: { email: false, push: false },
	schedule_fired: { email: false, push: false },
	stack_enabled: { email: false, push: false },
};

/** The fallback for a kind not in the default map: email on (safe — the person
 *  hears about a new kind of alert), push off (never surprise-push). */
export const FALLBACK_CHANNEL_PREFS: ChannelPrefs = { email: true, push: false };

/**
 * The effective channels for one kind: the user's explicit row when present,
 * otherwise the kind's default (or the fallback). PURE — unit-tested — so the
 * fan-out decision never depends on I/O.
 */
export function channelsForKind(
	kind: string,
	explicit: ChannelPrefs | null | undefined,
): ChannelPrefs {
	if (explicit) return { email: explicit.email, push: explicit.push };
	return DEFAULT_CHANNEL_PREFS[kind] ?? FALLBACK_CHANNEL_PREFS;
}

export interface NotificationPref {
	readonly kind: string;
	readonly email: boolean;
	readonly push: boolean;
	/** true when this is the stored default (no explicit row), false when set. */
	readonly isDefault: boolean;
}

/**
 * Every kind the UI lets a person tune, with its EFFECTIVE channels: the stored
 * row where one exists, else the default. The kind list is the default map's
 * keys (the knowable kinds), so the Settings panel always shows the full set.
 */
export async function listNotificationPrefs(
	db: D1Database,
	userId: string,
): Promise<NotificationPref[]> {
	requireText(userId, 'userId');
	const rows = await queryAll(
		db,
		'select "kind","email","push" from "notification_prefs" where "userId" = ?',
		userId,
	);
	const explicit = new Map<string, ChannelPrefs>();
	for (const row of rows) {
		explicit.set(String(row['kind']), { email: Number(row['email']) === 1, push: Number(row['push']) === 1 });
	}
	return Object.keys(DEFAULT_CHANNEL_PREFS).map((kind) => {
		const set = explicit.get(kind);
		const channels = channelsForKind(kind, set);
		return { kind, email: channels.email, push: channels.push, isDefault: set === undefined };
	});
}

/** Set (upsert) a user's explicit channel preference for one kind. */
export async function setNotificationPref(
	db: D1Database,
	userId: string,
	kind: string,
	channels: ChannelPrefs,
): Promise<NotificationPref> {
	requireText(userId, 'userId');
	requireText(kind, 'kind');
	if (!(kind in DEFAULT_CHANNEL_PREFS)) {
		fail(400, 'unknown_kind', `no such notification kind: ${kind}`);
	}
	await db
		.prepare(
			'insert into "notification_prefs" ("userId","kind","email","push","updatedAt") values (?,?,?,?,?) ' +
				'on conflict("userId","kind") do update set "email" = excluded."email", "push" = excluded."push", "updatedAt" = excluded."updatedAt"',
		)
		.bind(userId, kind, channels.email ? 1 : 0, channels.push ? 1 : 0, nowIso())
		.run();
	return { kind, email: channels.email, push: channels.push, isDefault: false };
}
