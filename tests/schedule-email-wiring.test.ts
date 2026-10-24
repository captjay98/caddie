import { describe, expect, test } from 'bun:test';
import { migratedDatabase } from './fixtures/sqlite-d1.ts';
import { dispatchDueSchedules } from '../apps/app/src/server/schedules.ts';
import { setNotificationPref, type Mailer, type MailMessage } from '../apps/app/src/server/notifications.ts';

/**
 * The schedule → email wiring (end to end): dispatchDueSchedules, given a
 * delivery context, fans a fired schedule out to email when the owner has
 * turned email on for 'schedule_fired'. Proves the env-threading, not just the
 * fan-out helper in isolation. LOCAL VERIFIED.
 */

function recordingMailer(): { mailer: Mailer; sent: MailMessage[] } {
	const sent: MailMessage[] = [];
	return { sent, mailer: { name: 'rec', send: async (m) => (sent.push(m), { ok: true }) } };
}

/** A verified user + a project they own + a schedule due now (empty payload → schedule_fired). */
function seed(sqlite: import('bun:sqlite').Database) {
	const now = new Date().toISOString();
	const past = new Date(Date.now() - 60_000).toISOString();
	sqlite.prepare('insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt") values (?,?,?,1,?,?)').run('u1', 'u1', 'u1@example.com', now, now);
	sqlite.prepare('insert into "workspaces" ("id","name","createdAt") values (?,?,?)').run('ws1', 'W', now);
	sqlite.prepare('insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt") values (?,?,?,?,?,?)').run('p1', 'ws1', 'Proj', 'active', now, now);
	sqlite
		.prepare('insert into "schedules" ("id","projectId","name","cron","timezone","nextRunAt","paused","payload","createdBy","createdAt","updatedAt") values (?,?,?,?,?,?,0,?,?,?,?)')
		.run('s1', 'p1', 'Weekly sweep', '0 9 * * 1', 'UTC', past, '{}', 'u1', now, now);
}

describe('dispatchDueSchedules email wiring', () => {
	test('a fired schedule emails the owner when schedule_fired email is on', async () => {
		const { sqlite, db } = migratedDatabase();
		seed(sqlite);
		await setNotificationPref(db, 'u1', 'schedule_fired', { email: true, push: false });
		const { mailer, sent } = recordingMailer();
		const fired = await dispatchDueSchedules(db, Date.now(), { mailer, origin: 'https://caddie.test', vapid: null });
		expect(fired).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.to).toBe('u1@example.com');
		expect(sent[0]!.subject).toContain('Weekly sweep');
		sqlite.close();
	});

	test('without a delivery context, the schedule still fires in-app but sends no email', async () => {
		const { sqlite, db } = migratedDatabase();
		seed(sqlite);
		await setNotificationPref(db, 'u1', 'schedule_fired', { email: true, push: false });
		const { mailer, sent } = recordingMailer();
		const fired = await dispatchDueSchedules(db, Date.now()); // no delivery
		expect(fired).toBe(1);
		expect(sent).toHaveLength(0);
		const inbox = sqlite.prepare('select count(*) as n from notifications where userId = ? and kind = ?').get('u1', 'schedule_fired') as { n: number };
		expect(inbox.n).toBe(1);
		sqlite.close();
	});
});
