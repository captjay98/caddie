import { describe, expect, test } from 'bun:test';
import { migratedDatabase } from './fixtures/sqlite-d1.ts';
import {
	createAndDeliverNotification,
	setNotificationPref,
	type Mailer,
	type MailMessage,
} from '../apps/app/src/server/notifications.ts';

/**
 * Email fan-out (step 2): createAndDeliverNotification writes the in-app row
 * (always) and sends email only when the kind's email channel is on and the
 * user has a verified address. Fire-and-capture: a failed/absent mailer never
 * fails the call. LOCAL VERIFIED.
 */

function recordingMailer(): { mailer: Mailer; sent: MailMessage[] } {
	const sent: MailMessage[] = [];
	return {
		sent,
		mailer: {
			name: 'recording',
			send: async (m) => {
				sent.push(m);
				return { ok: true };
			},
		},
	};
}

function throwingMailer(): Mailer {
	return { name: 'boom', send: async () => { throw new Error('smtp exploded'); } };
}

const ctx = (mailer: Mailer) => ({ mailer, origin: 'https://caddie.test' });

/** A user with a VERIFIED email (ownerEmail requires emailVerified = 1). */
function verifiedUser(sqlite: import('bun:sqlite').Database, id: string, email: string) {
	const now = new Date().toISOString();
	sqlite
		.prepare('insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt") values (?,?,?,1,?,?)')
		.run(id, id, email, now, now);
}

const input = (userId: string, kind: string) => ({
	userId,
	projectId: null,
	kind,
	title: 'Something happened',
	body: 'A thing you might care about.',
	dedupeKey: `${kind}:1`,
});

describe('createAndDeliverNotification — email fan-out', () => {
	test('emails a verified user when the kind defaults email on (build_paused)', async () => {
		const { sqlite, db } = migratedDatabase();
		verifiedUser(sqlite, 'u1', 'u1@example.com');
		const { mailer, sent } = recordingMailer();
		const r = await createAndDeliverNotification(db, input('u1', 'build_paused'), ctx(mailer));
		expect(r.created).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.to).toBe('u1@example.com');
		sqlite.close();
	});

	test('does NOT email when the user turned the kind’s email off', async () => {
		const { sqlite, db } = migratedDatabase();
		verifiedUser(sqlite, 'u1', 'u1@example.com');
		await setNotificationPref(db, 'u1', 'build_paused', { email: false, push: false });
		const { mailer, sent } = recordingMailer();
		await createAndDeliverNotification(db, input('u1', 'build_paused'), ctx(mailer));
		expect(sent).toHaveLength(0);
		sqlite.close();
	});

	test('does NOT email a kind that defaults email off (discovery_fit)', async () => {
		const { sqlite, db } = migratedDatabase();
		verifiedUser(sqlite, 'u1', 'u1@example.com');
		const { mailer, sent } = recordingMailer();
		await createAndDeliverNotification(db, input('u1', 'discovery_fit'), ctx(mailer));
		expect(sent).toHaveLength(0);
		sqlite.close();
	});

	test('a de-duplicated repeat sends no second email', async () => {
		const { sqlite, db } = migratedDatabase();
		verifiedUser(sqlite, 'u1', 'u1@example.com');
		const { mailer, sent } = recordingMailer();
		await createAndDeliverNotification(db, input('u1', 'build_paused'), ctx(mailer));
		const again = await createAndDeliverNotification(db, input('u1', 'build_paused'), ctx(mailer));
		expect(again.created).toBe(false);
		expect(sent).toHaveLength(1);
		sqlite.close();
	});

	test('an unverified email means no send, and the call still succeeds', async () => {
		const { sqlite, db } = migratedDatabase();
		const now = new Date().toISOString();
		sqlite
			.prepare('insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt") values (?,?,?,0,?,?)')
			.run('u1', 'u1', 'u1@example.com', now, now);
		const { mailer, sent } = recordingMailer();
		const r = await createAndDeliverNotification(db, input('u1', 'build_paused'), ctx(mailer));
		expect(r.created).toBe(true);
		expect(sent).toHaveLength(0);
		sqlite.close();
	});

	test('a throwing mailer never fails the call; the in-app row still stands', async () => {
		const { sqlite, db } = migratedDatabase();
		verifiedUser(sqlite, 'u1', 'u1@example.com');
		const r = await createAndDeliverNotification(db, input('u1', 'build_paused'), ctx(throwingMailer()));
		expect(r.created).toBe(true);
		// The failed attempt left a receipt (retry-visible), not an exception.
		const deliveries = sqlite.prepare('select status from notification_deliveries where notificationId = ?').all(r.notification!.id) as { status: string }[];
		expect(deliveries.some((d) => d.status === 'failed')).toBe(true);
		sqlite.close();
	});
});
