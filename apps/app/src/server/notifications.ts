import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

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
 * Select the mailer for this deployment. P12 has no SMTP driver: any
 * configuration (CADDIE_SMTP_URL) is honored by P17 — until that driver
 * exists the ONLY honest mailer is the noop one, whatever the env says.
 */
export function mailerFromEnv(_env?: Record<string, unknown>): Mailer {
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

	let outcome: MailSendResult;
	try {
		outcome = await mailer.send({ to, subject: notification.title, textBody });
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
