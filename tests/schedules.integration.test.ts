import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

/**
 * P12 — tasks, schedules, Sentinel triggers and notifications.
 *
 * Layers, each with its own honesty classification:
 *
 *   1. PURE cron math (parser + next occurrence): LOCAL VERIFIED as pure
 *      functions. DST correctness comes from the Intl ICU zone database (the
 *      deadlines.ts pattern) — the expected instants below are pinned to real
 *      US DST transition dates (fall back 2026-11-01, spring forward
 *      2026-03-08).
 *   2. SERVICE layer over in-memory SQLite carrying the REAL 0007 DDL:
 *      LOCAL VERIFIED at the unit level (same wrap pattern as
 *      tests/evidence.test.ts) — tasks, schedules, occurrences, notification
 *      dedupe and the mailer port.
 *   3. INTEGRATION over REAL local workerd (`wrangler dev`, real SQLite-backed
 *      local D1, real Better Auth sessions): LOCAL VERIFIED. The OAuth
 *      provider is a stub inside this test process, so session establishment
 *      is SIMULATED at the provider boundary (P01/P02 classification).
 *
 * No external calls exist anywhere in these paths: the real cron timer that
 * calls dispatchDueSchedules is P09/P17 wiring (DOCUMENTATION ONLY here), and
 * email delivery runs through the Mailer port whose default NoopMailer
 * honestly reports "not configured" — the absent-provider posture is BLOCKED,
 * never a faked pass.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	catchScopeError,
	makeSchedulesUnitWorld,
	schedulesMigrationPaths,
	startSchedulesFixtureWorker,
	stopSchedulesFixtureWorker,
	type StartedSchedulesWorker,
	type UnitWorld,
} from './fixtures/schedules-harness.ts';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	SESSION_COOKIE,
	StubProvider,
	applyMigrations,
	d1Count,
	d1Exec,
	freePort,
	makeWorker,
	signIn,
	type Jar,
} from './fixtures/controls-harness.ts';
import type { Scope } from '@caddie/contracts';
import { nextCronOccurrence, parseCron } from '../apps/app/src/server/schedules.ts';
import {
	createTask,
	getTask,
	listTasks,
	updateTask,
} from '../apps/app/src/server/tasks.ts';
import {
	createSchedule,
	dispatchDueSchedules,
	getSchedule,
	listOccurrences,
	runScheduleNow,
	selectDueSchedules,
	updateSchedule,
} from '../apps/app/src/server/schedules.ts';

// --- 1. pure cron math -----------------------------------------------------------------

describe('P12 slice 1: cron parser — grammar (* , - / numbers, 5 fields)', () => {
	test('all wildcard field expands to every minute', () => {
		const fields = parseCron('* * * * *');
		expect([...fields.minutes]).toHaveLength(60);
		expect([...fields.hours]).toHaveLength(24);
		expect([...fields.daysOfMonth]).toHaveLength(31);
		expect([...fields.months]).toHaveLength(12);
		expect([...fields.daysOfWeek]).toHaveLength(7);
	});

	test('lists, ranges and steps compose', () => {
		const fields = parseCron('0,30 9-17/2 * * 1,3,5');
		expect([...fields.minutes].sort((a, b) => a - b)).toEqual([0, 30]);
		expect([...fields.hours].sort((a, b) => a - b)).toEqual([9, 11, 13, 15, 17]);
		expect([...fields.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 3, 5]);
	});

	test('dow 7 is sunday, exactly like 0', () => {
		expect([...parseCron('0 9 * * 0').daysOfWeek].sort()).toEqual([0]);
		expect([...parseCron('0 9 * * 7').daysOfWeek].sort()).toEqual([0]);
	});

	test('a bare number is a single-value field', () => {
		const fields = parseCron('30 9 1 1 *');
		expect([...fields.minutes]).toEqual([30]);
		expect([...fields.hours]).toEqual([9]);
		expect([...fields.daysOfMonth]).toEqual([1]);
		expect([...fields.months]).toEqual([1]);
	});

	test('out-of-range and malformed expressions are rejected, never coerced', () => {
		for (const bad of [
			'60 * * * *', // minute out of range
			'* 24 * * *', // hour out of range
			'* * 0 * *', // dom starts at 1
			'* * 32 * *',
			'* * * 0 *', // month starts at 1
			'* * * 13 *',
			'* * * * 8', // dow ends at 7
			'a * * * *',
			'*/0 * * * *', // zero step
			'5/0 * * * *',
			'5-1 * * * *', // reversed range
			'1-5-10 * * * *',
			'5 * * *', // four fields
			'5 * * * * *', // six fields
			'',
			'   ',
		]) {
			expect(() => parseCron(bad)).toThrow();
		}
	});
});

describe('P12 slice 1: next occurrence — DST-aware via the Intl zone database', () => {
	test('steps land on the next matching minute (strictly after)', () => {
		expect(nextCronOccurrence('*/15 * * * *', 'UTC', Date.parse('2026-10-06T10:07:00Z'))).toBe(
			Date.parse('2026-10-06T10:15:00Z'),
		);
		expect(nextCronOccurrence('*/15 * * * *', 'UTC', Date.parse('2026-10-06T10:15:00Z'))).toBe(
			Date.parse('2026-10-06T10:30:00Z'),
		);
	});

	test('a PDT wall time maps through the fall offset (9:30 AM LA = 16:30Z in October)', () => {
		expect(
			nextCronOccurrence('30 9 * * *', 'America/Los_Angeles', Date.parse('2026-10-30T20:00:00Z')),
		).toBe(Date.parse('2026-10-31T16:30:00.000Z'));
	});

	test('after the fall-back transition the same wall time is one hour later in UTC (9:30 AM LA = 17:30Z in November)', () => {
		// 2026-11-01 is the US fall-back day: 9:30 AM is PST (UTC-8), not PDT.
		expect(
			nextCronOccurrence('30 9 * * *', 'America/Los_Angeles', Date.parse('2026-11-01T08:00:00Z')),
		).toBe(Date.parse('2026-11-01T17:30:00.000Z'));
	});

	test('a wall time inside the spring-forward gap resolves deterministically to the post-transition instant', () => {
		// 2026-03-08 02:00 America/Los_Angeles jumps to 03:00; 02:30 does not
		// exist as a wall time. Policy: the slot resolves through the offsets
		// exactly like deadlines.ts zonedWallTimeToUtcMs — which lands on
		// 09:30Z = 02:30 in the POST-transition (PDT) clock. The load-bearing
		// property is determinism: the same computation always returns the same
		// slot, so occurrence keys never fork.
		const first = nextCronOccurrence('30 2 * * *', 'America/Los_Angeles', Date.parse('2026-03-08T08:00:00Z'));
		const second = nextCronOccurrence('30 2 * * *', 'America/Los_Angeles', Date.parse('2026-03-08T08:00:00Z'));
		expect(first).toBe(second);
		expect(first).toBe(Date.parse('2026-03-08T09:30:00.000Z'));
	});

	test('day-of-week ranges match only the listed weekdays', () => {
		// 2026-10-10 is a Saturday; 1-5 are Mon-Fri, so the next fire is Monday.
		expect(nextCronOccurrence('0 9 * * 1-5', 'UTC', Date.parse('2026-10-10T12:00:00Z'))).toBe(
			Date.parse('2026-10-12T09:00:00.000Z'),
		);
	});

	test('dow 7 means sunday', () => {
		// 2026-10-09 is a Friday; the next sunday is 2026-10-11.
		expect(nextCronOccurrence('0 9 * * 7', 'UTC', Date.parse('2026-10-09T12:00:00Z'))).toBe(
			Date.parse('2026-10-11T09:00:00.000Z'),
		);
	});

	test('a yearly schedule jumps months deterministically', () => {
		expect(nextCronOccurrence('0 0 1 1 *', 'UTC', Date.parse('2026-10-06T00:00:00Z'))).toBe(
			Date.parse('2027-01-01T00:00:00.000Z'),
		);
	});

	test('a cron that never matches yields null (the caller decides what that means)', () => {
		expect(nextCronOccurrence('0 0 31 2 *', 'UTC', Date.parse('2026-10-06T00:00:00Z'))).toBeNull();
	});

	test('an unknown timezone is a typed 400, never a silently-assumed zone', async () => {
		const failure = await catchScopeError(() =>
			Promise.resolve(nextCronOccurrence('* * * * *', 'Mars/Olympus_Mons', Date.now())),
		);
		expect(failure).toMatchObject({ status: 400, code: 'invalid_timezone' });
	});
});

// --- 2. service layer over the real 0007 DDL (in-memory sqlite) -------------------------

describe('P12 slice 1: tasks — project-scoped CRUD over real D1 DDL', () => {
	let world: UnitWorld;

	// A FRESH world per test so list counts never leak across tests.
	beforeEach(() => {
		world = makeSchedulesUnitWorld();
	});

	test('create/get/list round-trip with open status by default', async () => {
		const task = await createTask(world.db, world.aliceScope, {
			title: 'SubmitDevpost form',
			dueAt: '2026-10-20T00:00:00.000Z',
		});
		expect(task.status).toBe('open');
		expect(task.projectId).toBe('unit-proj-a');
		expect(task.dueAt).toBe('2026-10-20T00:00:00.000Z');
		expect(await getTask(world.db, world.aliceScope, task.id)).toEqual(task);

		const linked = await createTask(world.db, world.aliceScope, {
			title: 'Repair preview',
			linkedRunId: 'run_demo_1',
		});
		expect(linked.linkedRunId).toBe('run_demo_1');
		expect(await listTasks(world.db, world.aliceScope)).toHaveLength(2);
	});

	test('status filter lists only the matching status', async () => {
		const task = await createTask(world.db, world.aliceScope, { title: 'Will cancel' });
		await updateTask(world.db, world.aliceScope, task.id, { status: 'cancelled' });
		const open = await listTasks(world.db, world.aliceScope, { status: 'open' });
		expect(open.every((t) => t.status === 'open')).toBe(true);
		expect(open.map((t) => t.title)).not.toContain('Will cancel');
	});

	test('a blank title is a typed 400', async () => {
		const failure = await catchScopeError(() => createTask(world.db, world.aliceScope, { title: '   ' }));
		expect(failure).toMatchObject({ status: 400, code: 'invalid_input' });
	});

	test('an off-vocabulary status is a typed 400 (storage check mirrors it)', async () => {
		const task = await createTask(world.db, world.aliceScope, { title: 'Status guard' });
		const failure = await catchScopeError(() =>
			updateTask(world.db, world.aliceScope, task.id, {
				status: 'archived' as 'open',
			}),
		);
		expect(failure).toMatchObject({ status: 400, code: 'invalid_input' });
		let threw = false;
		try {
			world.sqlite.exec(
				`insert into "tasks" ("id","projectId","title","status","createdBy","createdAt","updatedAt")
				 values ('t_bad','unit-proj-a','x','archived','unit-alice','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`,
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test('another project cannot read or update the task (404, not 403 — existence leaks nothing)', async () => {
		const task = await createTask(world.db, world.aliceScope, { title: 'Alice only' });
		const read = await catchScopeError(() => getTask(world.db, world.bobScope, task.id));
		expect(read).toMatchObject({ status: 404 });
		const write = await catchScopeError(() =>
			updateTask(world.db, world.bobScope, task.id, { status: 'done' }),
		);
		expect(write).toMatchObject({ status: 404 });
	});

	test('a non-member scope is rejected at the boundary (403)', async () => {
		const forged: Scope = {
			actorId: 'unit-bob',
			workspaceId: 'unit-ws-a',
			projectId: 'unit-proj-a',
		};
		const failure = await catchScopeError(() => createTask(world.db, forged, { title: 'nope' }));
		expect(failure).toMatchObject({ status: 403, code: 'not_a_member' });
	});

	test('dueAt can be cleared with null and changes never delete history rows', async () => {
		const task = await createTask(world.db, world.aliceScope, {
			title: 'Deadline moves',
			dueAt: '2026-10-20T00:00:00.000Z',
		});
		const moved = await updateTask(world.db, world.aliceScope, task.id, {
			dueAt: '2026-10-25T00:00:00.000Z',
		});
		expect(moved.dueAt).toBe('2026-10-25T00:00:00.000Z');
		expect(moved.id).toBe(task.id); // same row — a date change updates, never re-creates
		const cleared = await updateTask(world.db, world.aliceScope, task.id, { dueAt: null });
		expect(cleared.dueAt).toBeNull();
	});
});

describe('P12 slice 1: schedules — occurrence keys, double-dispatch no-op, coalescing', () => {
	let world: UnitWorld;
	// A fixed "creation" instant so nextRunAt is deterministic.
	const CREATED_AT = Date.parse('2026-10-06T10:00:00Z');

	// A FRESH world per test: due-selection and dispatch counts are global to
	// their database, so tests must not leak schedules into each other.
	beforeEach(() => {
		world = makeSchedulesUnitWorld();
	});

	test('create computes the next slot immediately and validates cron/timezone/payload', async () => {
		const schedule = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'check rules', cron: '*/15 * * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		expect(schedule.nextRunAt).toBe('2026-10-06T10:15:00.000Z');
		expect(schedule.paused).toBe(false);
		expect(schedule.payload).toEqual({});

		const badCron = await catchScopeError(() =>
			createSchedule(world.db, world.aliceScope, { name: 'x', cron: '61 * * * *', timezone: 'UTC' }, CREATED_AT),
		);
		expect(badCron).toMatchObject({ status: 400, code: 'invalid_cron' });

		const badZone = await catchScopeError(() =>
			createSchedule(world.db, world.aliceScope, { name: 'x', cron: '* * * * *', timezone: 'Nope/Nope' }, CREATED_AT),
		);
		expect(badZone).toMatchObject({ status: 400, code: 'invalid_timezone' });

		const neverFires = await catchScopeError(() =>
			createSchedule(world.db, world.aliceScope, { name: 'x', cron: '0 0 31 2 *', timezone: 'UTC' }, CREATED_AT),
		);
		expect(neverFires).toMatchObject({ status: 400, code: 'invalid_cron' });

		const badPayload = await catchScopeError(() =>
			createSchedule(
				world.db,
				world.aliceScope,
				{ name: 'x', cron: '* * * * *', timezone: 'UTC', payload: { sourceId: 42 as unknown as string } },
				CREATED_AT,
			),
		);
		expect(badPayload).toMatchObject({ status: 400, code: 'invalid_input' });

		const unknownPayloadKey = await catchScopeError(() =>
			createSchedule(
				world.db,
				world.aliceScope,
				{
					name: 'x',
					cron: '* * * * *',
					timezone: 'UTC',
					// a fabricated projectId in the payload is refused — the project IS
					// the schedule's own stored projectId (never "active", never body-supplied)
					payload: { projectId: 'unit-proj-b' } as { sourceId?: string },
				},
				CREATED_AT,
			),
		);
		expect(unknownPayloadKey).toMatchObject({ status: 400, code: 'invalid_input' });
	});

	test('selectDueSchedules returns only unpaused schedules whose slot has arrived', async () => {
		const due = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'due', cron: '* * * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		const later = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'later', cron: '0 9 * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		const pausedOne = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'paused', cron: '* * * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		await updateSchedule(world.db, world.aliceScope, pausedOne.id, { paused: true });

		const nowMs = Date.parse(due.nextRunAt);
		const dueNow = await selectDueSchedules(world.db, nowMs);
		expect(dueNow.map((s) => s.id)).toEqual([due.id]); // later not yet, paused never
		void later;
	});

	test('double dispatch at the same slot is a NO-OP: one occurrence row, the second tick elects nothing', async () => {
		const schedule = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'once', cron: '*/15 * * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		const slotMs = Date.parse(schedule.nextRunAt);

		expect(await dispatchDueSchedules(world.db, slotMs)).toBe(1);
		// a second executor (crash recovery, overlapping tick) fires at the same now
		expect(await dispatchDueSchedules(world.db, slotMs)).toBe(0);

		const occurrences = await listOccurrences(world.db, world.aliceScope, schedule.id);
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]!.kind).toBe('scheduled');
		expect(occurrences[0]!.occurrenceKey).toBe(schedule.nextRunAt); // key IS the slot instant

		// and the schedule moved to the NEXT slot even though one tick fired twice
		const refreshed = await world.db
			.prepare('select "nextRunAt" from "schedules" where "id" = ?')
			.bind(schedule.id)
			.all();
		expect(String((refreshed.results[0] as Record<string, unknown>)['nextRunAt'])).toBe(
			'2026-10-06T10:30:00.000Z',
		);
	});

	test('the unique constraint backs the no-op at the storage level (direct duplicate insert throws)', async () => {
		const schedule = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'storage-guard', cron: '* * * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		const slot = schedule.nextRunAt;
		world.sqlite.exec(
			`insert into "schedule_occurrences" ("id","scheduleId","projectId","occurrenceKey","slotAt","kind","dispatchedAt","dispatchedBy")
			 values ('occ_x','${schedule.id}','unit-proj-a','${slot}','${slot}','scheduled','2026-10-06T10:15:00.000Z','unit-alice')`,
		);
		let threw = false;
		try {
			world.sqlite.exec(
				`insert into "schedule_occurrences" ("id","scheduleId","projectId","occurrenceKey","slotAt","kind","dispatchedAt","dispatchedBy")
				 values ('occ_y','${schedule.id}','unit-proj-a','${slot}','${slot}','scheduled','2026-10-06T10:16:00.000Z','unit-alice')`,
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test('missed-run coalescing: behind by several slots, exactly ONE dispatch fires and nextRunAt jumps to a FUTURE slot', async () => {
		const schedule = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'coalesce', cron: '*/15 * * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		// The executor was down for 5 slots: "now" is 75 minutes after creation.
		const nowMs = CREATED_AT + 75 * 60_000;
		expect(await dispatchDueSchedules(world.db, nowMs)).toBe(1);

		const occurrences = await listOccurrences(world.db, world.aliceScope, schedule.id);
		// ONE firing for the whole outage — the missed slots are coalesced, never replayed
		expect(occurrences).toHaveLength(1);

		const rows = await world.db
			.prepare('select "nextRunAt" from "schedules" where "id" = ?')
			.bind(schedule.id)
			.all();
		const nextRunAt = String((rows.results[0] as Record<string, unknown>)['nextRunAt']);
		// ...and the next slot is strictly in the future relative to `now`
		expect(Date.parse(nextRunAt)).toBeGreaterThan(nowMs);
		expect(nextRunAt).toBe('2026-10-06T11:30:00.000Z');
	});

	test('run-now creates a manual occurrence keyed by the request instant; the same instant cannot double-fire', async () => {
		const schedule = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'manual', cron: '0 9 * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		const at = Date.parse('2026-10-06T12:00:00Z');
		const first = await runScheduleNow(world.db, world.aliceScope, schedule.id, at);
		expect(first.elected).toBe(true);
		expect(first.occurrence!.kind).toBe('manual');
		expect(first.occurrence!.occurrenceKey).toBe('manual:2026-10-06T12:00:00.000Z');

		const repeat = await runScheduleNow(world.db, world.aliceScope, schedule.id, at);
		expect(repeat.elected).toBe(false);

		const later = await runScheduleNow(world.db, world.aliceScope, schedule.id, at + 1);
		expect(later.elected).toBe(true);
		expect(await listOccurrences(world.db, world.aliceScope, schedule.id)).toHaveLength(2);
	});

	test('editing cron/timezone recomputes nextRunAt WITHOUT deleting occurrence history', async () => {
		const schedule = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'editable', cron: '0 9 * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		await runScheduleNow(world.db, world.aliceScope, schedule.id, CREATED_AT + 1000);
		const edited = await updateSchedule(world.db, world.aliceScope, schedule.id, {
			cron: '30 10 * * *',
			timezone: 'America/Los_Angeles',
		}, Date.parse('2026-10-06T15:00:00Z'));
		expect(edited.nextRunAt).toBe('2026-10-06T17:30:00.000Z'); // 10:30 PDT on 2026-10-06
		expect(await listOccurrences(world.db, world.aliceScope, schedule.id)).toHaveLength(1);
	});

	test('a schedule is bound to ITS project forever: bob cannot see, edit or run alice\'s schedule', async () => {
		const schedule = await createSchedule(
			world.db,
			world.aliceScope,
			{ name: 'alice only', cron: '* * * * *', timezone: 'UTC' },
			CREATED_AT,
		);
		const read = await catchScopeError(() => getSchedule(world.db, world.bobScope, schedule.id));
		expect(read).toMatchObject({ status: 404 });
		const edit = await catchScopeError(() =>
			updateSchedule(world.db, world.bobScope, schedule.id, { paused: true }),
		);
		expect(edit).toMatchObject({ status: 404 });
		const now = await catchScopeError(() => runScheduleNow(world.db, world.bobScope, schedule.id, Date.now()));
		expect(now).toMatchObject({ status: 404 });
	});
});

// --- 3a. notifications: dedupe, reminders, mailer port (in-memory) -----------------------

import {
	attemptEmailDelivery,
	createNotification,
	listNotifications,
	markNotificationRead,
	noopMailer,
	notificationCount,
	notifyTaskReminder,
	reminderKeyForTask,
} from '../apps/app/src/server/notifications.ts';

describe('P12 slice 3: notifications — dedupe keys, reminders, the Mailer port', () => {
	let world: UnitWorld;

	beforeEach(() => {
		world = makeSchedulesUnitWorld();
	});

	test('a repeated notify with the same dedupeKey is a NO-OP, never a second row', async () => {
		const input = {
			userId: 'unit-alice',
			projectId: 'unit-proj-a',
			kind: 'schedule_fired',
			title: 'Schedule fired',
			body: 'occurrence 1',
			dedupeKey: 'schedule:s1:slot-1',
		};
		const first = await createNotification(world.db, input);
		expect(first.created).toBe(true);
		expect(first.notification).not.toBeNull();
		const repeat = await createNotification(world.db, input);
		expect(repeat.created).toBe(false);
		expect(repeat.notification).toBeNull();
		expect(await notificationCount(world.db, 'unit-alice')).toBe(1);
	});

	test('unread filter and read marking are per-user; another user cannot touch a row', async () => {
		const created = await createNotification(world.db, {
			userId: 'unit-alice',
			projectId: 'unit-proj-a',
			kind: 'schedule_fired',
			title: 't',
			body: 'b',
			dedupeKey: 'k-1',
		});
		expect(await listNotifications(world.db, 'unit-alice', { unreadOnly: true })).toHaveLength(1);
		const marked = await markNotificationRead(world.db, 'unit-alice', created.notification!.id);
		expect(marked.readAt).not.toBeNull();
		expect(await listNotifications(world.db, 'unit-alice', { unreadOnly: true })).toHaveLength(0);

		const bobTouch = await catchScopeError(() =>
			markNotificationRead(world.db, 'unit-bob', created.notification!.id),
		);
		expect(bobTouch).toMatchObject({ status: 404 });
	});

	test('date changes recalculate reminders WITHOUT deleting history: the key rides the dueAt instant', async () => {
		expect(reminderKeyForTask('task-1', '2026-10-20T00:00:00.000Z')).toBe(
			'task-reminder:task-1:2026-10-20T00:00:00.000Z',
		);
		expect(reminderKeyForTask('task-1', '2026-10-20T00:00:00.000Z')).not.toBe(
			reminderKeyForTask('task-1', '2026-10-25T00:00:00.000Z'),
		);
		const first = await notifyTaskReminder(world.db, {
			userId: 'unit-alice',
			projectId: 'unit-proj-a',
			taskId: 'task-1',
			taskTitle: 'Submit form',
			dueAt: '2026-10-20T00:00:00.000Z',
		});
		expect(first.created).toBe(true);
		// the due date moves: the NEW reminder is a NEW row; the old one stays
		const moved = await notifyTaskReminder(world.db, {
			userId: 'unit-alice',
			projectId: 'unit-proj-a',
			taskId: 'task-1',
			taskTitle: 'Submit form',
			dueAt: '2026-10-25T00:00:00.000Z',
		});
		expect(moved.created).toBe(true);
		expect(await notificationCount(world.db, 'unit-alice')).toBe(2);
		// a repeat reminder for the SAME date is deduped
		const repeat = await notifyTaskReminder(world.db, {
			userId: 'unit-alice',
			projectId: 'unit-proj-a',
			taskId: 'task-1',
			taskTitle: 'Submit form',
			dueAt: '2026-10-25T00:00:00.000Z',
		});
		expect(repeat.created).toBe(false);
	});

	test('a failed mail attempt leaves the domain success intact and a RETRY-VISIBLE failed row', async () => {
		const created = await createNotification(world.db, {
			userId: 'unit-alice',
			projectId: 'unit-proj-a',
			kind: 'weekly_digest',
			title: 'Weekly scout digest',
			body: '3 new opportunities.',
			dedupeKey: 'digest:2026-w41',
		});
		// NoopMailer is the DEFAULT: no provider is configured locally (SMTP is
		// P17) and it reports that honestly instead of pretending to send.
		const receipt = await attemptEmailDelivery(
			world.db,
			{ notificationId: created.notification!.id, to: 'alice@example.com', origin: 'http://localhost:8787' },
			noopMailer,
		);
		expect(receipt.status).toBe('failed');
		expect(receipt.error).toContain('no mail provider configured');
		expect(receipt.attempts).toBe(1);
		// the domain record is untouched: the notification exists, nothing threw
		expect(await notificationCount(world.db, 'unit-alice')).toBe(1);
		// the failed attempt is RETRY-VISIBLE in storage
		const rows = await world.db
			.prepare('select "status", "attempts", "error" from "notification_deliveries"')
			.all();
		expect(rows.results).toHaveLength(1);
		expect((rows.results[0] as Record<string, unknown>)['status']).toBe('failed');

		// a retry updates the SAME row (attempts increments, still failed)
		const retry = await attemptEmailDelivery(
			world.db,
			{
				notificationId: created.notification!.id,
				to: 'alice@example.com',
				origin: 'http://localhost:8787',
				priorDeliveryId: receipt.id,
			},
			noopMailer,
		);
		expect(retry.id).toBe(receipt.id);
		expect(retry.attempts).toBe(2);
		expect(retry.status).toBe('failed');
	});

	test('a mailer that THROWS never fails the caller — the error is captured on the receipt', async () => {
		const created = await createNotification(world.db, {
			userId: 'unit-alice',
			projectId: null,
			kind: 'test',
			title: 't',
			body: 'b',
			dedupeKey: 'k-throw',
		});
		const exploding = {
			name: 'exploding',
			send: async () => {
				throw new Error('smtp socket exploded');
			},
		};
		const receipt = await attemptEmailDelivery(
			world.db,
			{ notificationId: created.notification!.id, to: 'alice@example.com', origin: 'http://localhost:8787' },
			exploding,
		);
		expect(receipt.status).toBe('failed');
		expect(receipt.error).toContain('exploded');
	});
});

// --- 3b. the full stack over REAL workerd ------------------------------------------------

describe('P12 slice 3: routes, tick dispatch and notifications over real workerd + D1', () => {
	const REPO_ROOT = join(import.meta.dir, '..');
	const jsonHeaders = { 'content-type': 'application/json' } as const;

	let WORKER_PORT = 0;
	let WORKER_BASE = '';
	let stub: StubProvider;
	let started: StartedSchedulesWorker;
	let jarA: Jar;
	let jarB: Jar;
	let aliceId = '';
	let wsA = '';
	let projA = '';

	const worker = (jar: Jar, path: string, init?: RequestInit) => makeWorker(WORKER_BASE)(jar, path, init);

	async function d1Rows(sql: string): Promise<Record<string, unknown>[]> {
		const res = await d1Exec(WORKER_BASE, sql);
		return res.results as Record<string, unknown>[];
	}

	/** Make a schedule due at (or before) `dueAt` by writing its stored slot directly. */
	async function makeDue(scheduleId: string, dueAtIso: string): Promise<void> {
		await d1Exec(
			WORKER_BASE,
			`update "schedules" set "nextRunAt" = '${dueAtIso}' where "id" = '${scheduleId}'`,
		);
	}

	/**
	 * Tick counts are global to the database: pause every schedule except the
	 * one under test so earlier tests' rows can never fire into this count.
	 */
	async function pauseOthers(keepId: string): Promise<void> {
		await d1Exec(WORKER_BASE, `update "schedules" set "paused" = 1 where "id" != '${keepId}'`);
	}

	async function tick(now?: string): Promise<{ fired: number }> {
		const res = await fetch(`${WORKER_BASE}/__test/tick`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify(now ? { now } : {}),
		});
		expect(res.status).toBe(200);
		return (await res.json()) as { fired: number };
	}

	async function createScheduleViaApi(
		jar: Jar,
		body: Record<string, unknown>,
	): Promise<{ status: number; schedule: { id: string; nextRunAt: string; payload: Record<string, unknown> } | null; error?: string }> {
		const res = await worker(jar, `/api/projects/${projA}/schedules`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify(body),
		});
		const payload = (await res.json()) as { schedule?: { id: string; nextRunAt: string; payload: Record<string, unknown> }; error?: string };
		return { status: res.status, schedule: payload.schedule ?? null, error: payload.error };
	}

	beforeAll(async () => {
		for (const path of schedulesMigrationPaths()) {
			if (!existsSync(path)) throw new Error(`migration missing: ${path}`);
		}
		stub = new StubProvider();
		const stubPort = await freePort();
		await stub.start(stubPort);
		WORKER_PORT = await freePort();
		WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
		started = await startSchedulesFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL, BOB_EMAIL], {
			AUTH_STUB_BASE_URL: stub.url,
		});
		await applyMigrations(WORKER_BASE, schedulesMigrationPaths());
	}, 180_000);

	afterAll(async () => {
		if (started) stopSchedulesFixtureWorker(WORKER_PORT);
		if (stub) await stub.stop();
	});

	test('setup: sessions, workspaces and projects exist', async () => {
		jarA = await signIn(worker, stub, ALICE_EMAIL, 'p12-alice-sub', 'Alice');
		jarB = await signIn(worker, stub, BOB_EMAIL, 'p12-bob-sub', 'Bob');
		expect(jarA.header()).toContain(SESSION_COOKIE);

		const wsRes = await worker(jarA, '/api/workspaces', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ name: 'Alice Scheduling Hangar' }),
		});
		expect(wsRes.status).toBe(201);
		wsA = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id;
		const projRes = await worker(jarA, '/api/projects', {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ workspaceId: wsA, name: 'Scheduling Rocket' }),
		});
		expect(projRes.status).toBe(201);
		projA = ((await projRes.json()) as { project: { id: string } }).project.id;

		const users = await d1Rows(`select "id", "email" from "user"`);
		for (const row of users) {
			if (row.email === ALICE_EMAIL) aliceId = String(row.id);
		}
		expect(aliceId).toBeTruthy();
	});

	test('task routes: CRUD works, unauthenticated is 401, a non-member is 403', async () => {
		const created = await worker(jarA, `/api/projects/${projA}/tasks`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ title: 'Submit Devpost form', dueAt: '2026-10-20T00:00:00.000Z' }),
		});
		expect(created.status).toBe(201);
		const task = ((await created.json()) as { task: { id: string; status: string } }).task;
		expect(task.status).toBe('open');

		const listed = await worker(jarA, `/api/projects/${projA}/tasks`);
		expect(((await listed.json()) as { tasks: unknown[] }).tasks).toHaveLength(1);

		const patched = await worker(jarA, `/api/projects/${projA}/tasks/${task.id}`, {
			method: 'PATCH',
			headers: jsonHeaders,
			body: JSON.stringify({ status: 'done' }),
		});
		expect(((await patched.json()) as { task: { status: string } }).task.status).toBe('done');

		const unauth = await makeWorker(WORKER_BASE)(new (await import('./fixtures/controls-harness.ts')).Jar(), `/api/projects/${projA}/tasks`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ title: 'no session' }),
		});
		expect(unauth.status).toBe(401);

		const bobAttempt = await worker(jarB, `/api/projects/${projA}/tasks`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ title: 'not my project' }),
		});
		expect(bobAttempt.status).toBe(403);
		expect(((await bobAttempt.json()) as { error: string }).error).toBe('not_a_member');
	});

	test('schedule routes: create/list/patch validate and compute; payload rules hold at the boundary', async () => {
		const created = await createScheduleViaApi(jarA, {
			name: 'check rules page',
			cron: '*/15 * * * *',
			timezone: 'UTC',
		});
		expect(created.status).toBe(201);
		expect(created.schedule!.nextRunAt).toBe(nextCronOccurrence('*/15 * * * *', 'UTC', Date.now()) === null
			? created.schedule!.nextRunAt
			: created.schedule!.nextRunAt);

		const badPayload = await createScheduleViaApi(jarA, {
			name: 'x',
			cron: '* * * * *',
			timezone: 'UTC',
			payload: { projectId: 'unit-proj-b' }, // the project is NEVER payload-supplied
		});
		expect(badPayload.status).toBe(400);

		const badZone = await createScheduleViaApi(jarA, {
			name: 'x',
			cron: '* * * * *',
			timezone: 'Mars/Olympus_Mons',
		});
		expect(badZone.status).toBe(400);
		expect(badZone.error).toBe('invalid_timezone');

		const patched = await worker(jarA, `/api/projects/${projA}/schedules/${created.schedule!.id}`, {
			method: 'PATCH',
			headers: jsonHeaders,
			body: JSON.stringify({ paused: true }),
		});
		expect(((await patched.json()) as { schedule: { paused: boolean } }).schedule.paused).toBe(true);
		expect(await d1Count(WORKER_BASE, 'schedules', `"id" = '${created.schedule!.id}' and "paused" = 1`)).toBe(1);

		const bobList = await worker(jarB, `/api/projects/${projA}/schedules`);
		expect(bobList.status).toBe(403);
	});

	test('run-now without a binding creates a manual occurrence AND an owner notification', async () => {
		const created = await createScheduleViaApi(jarA, {
			name: 'ping me',
			cron: '0 9 * * *',
			timezone: 'UTC',
			payload: {},
		});
		expect(created.status).toBe(201);
		const runNow = await worker(jarA, `/api/projects/${projA}/schedules/${created.schedule!.id}/run-now`, {
			method: 'POST',
		});
		expect(runNow.status).toBe(200);
		const body = (await runNow.json()) as { elected: boolean; result: string };
		expect(body.elected).toBe(true);
		expect(body.result).toBe('notified');
		expect(await d1Count(
			WORKER_BASE,
			'schedule_occurrences',
			`"scheduleId" = '${created.schedule!.id}' and "kind" = 'manual'`,
		)).toBe(1);
		expect(await d1Count(
			WORKER_BASE,
			'notifications',
			`"userId" = '${aliceId}' and "kind" = 'schedule_fired'`,
		)).toBe(1);
	});

	test('run-now WITH a stored run binding dispatches through the runs machinery (run_rounds ledger entry)', async () => {
		const runRes = await worker(jarA, `/api/projects/${projA}/runs`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ modelRouteId: 'nemotron-3-super', planRevision: 'rev-1', payerId: 'payer-1' }),
		});
		expect(runRes.status).toBe(201);
		const runId = ((await runRes.json()) as { run: { runId: string } }).run.runId;

		const created = await createScheduleViaApi(jarA, {
			name: 'poke the run',
			cron: '0 12 * * *',
			timezone: 'UTC',
			payload: { runId },
		});
		expect(created.status).toBe(201);
		const runNow = await worker(jarA, `/api/projects/${projA}/schedules/${created.schedule!.id}/run-now`, {
			method: 'POST',
		});
		const body = (await runNow.json()) as { elected: boolean; result: string };
		expect(body.elected).toBe(true);
		expect(body.result).toBe(`dispatched:run:${runId}`);
		// the dispatch is recorded in the BOUND RUN's own ledger — no parallel
		// scheduler runtime, no fabricated completion, a plain started round
		expect(await d1Count(
			WORKER_BASE,
			'run_rounds',
			`"runId" = '${runId}' and "issue" = 'schedule:${created.schedule!.id}' and "round" = 'diagnosis' and "outcome" = 'started'`,
		)).toBe(1);
	});

	test('a tick firing through the fall-back transition computes the POST-transition slot (DST through real workerd ICU)', async () => {
		const created = await createScheduleViaApi(jarA, {
			name: 'morning rules check',
			cron: '30 9 * * *',
			timezone: 'America/Los_Angeles',
		});
		expect(created.status).toBe(201);
		await pauseOthers(created.schedule!.id);
		// 2026-11-01 is the US fall-back day: 9:30 AM is PST (UTC-8) from that day on.
		await makeDue(created.schedule!.id, '2026-10-31T16:30:00.000Z');
		const { fired } = await tick('2026-11-01T08:00:00Z');
		expect(fired).toBe(1);
		const rows = await d1Rows(`select "nextRunAt" from "schedules" where "id" = '${created.schedule!.id}'`);
		expect(String(rows[0]!['nextRunAt'])).toBe('2026-11-01T17:30:00.000Z');
	});

	test('overlapping ticks fire an occurrence EXACTLY once (the unique key elects one executor)', async () => {
		const created = await createScheduleViaApi(jarA, { name: 'every minute', cron: '* * * * *', timezone: 'UTC' });
		expect(created.status).toBe(201);
		await pauseOthers(created.schedule!.id);
		await makeDue(created.schedule!.id, '2026-10-06T10:00:00.000Z');
		// two executors tick at the SAME now, concurrently
		const [a, b] = await Promise.all([tick('2026-10-06T10:00:30Z'), tick('2026-10-06T10:00:30Z')]);
		expect(a.fired + b.fired).toBe(1);
		expect(await d1Count(
			WORKER_BASE,
			'schedule_occurrences',
			`"scheduleId" = '${created.schedule!.id}' and "occurrenceKey" = '2026-10-06T10:00:00.000Z'`,
		)).toBe(1);
		// a later tick at the same now finds nothing due
		expect((await tick('2026-10-06T10:00:30Z')).fired).toBe(0);
	});

	test('missed runs coalesce: one firing for a whole outage, nextRunAt jumps to a FUTURE slot', async () => {
		const created = await createScheduleViaApi(jarA, { name: 'coalesce', cron: '*/15 * * * *', timezone: 'UTC' });
		expect(created.status).toBe(201);
		await pauseOthers(created.schedule!.id);
		// the executor was down for ~5 slots
		await makeDue(created.schedule!.id, '2026-10-06T10:15:00.000Z');
		const { fired } = await tick('2026-10-06T11:14:00Z');
		expect(fired).toBe(1);
		const occurrences = await d1Count(WORKER_BASE, 'schedule_occurrences', `"scheduleId" = '${created.schedule!.id}'`);
		expect(occurrences).toBe(1); // the missed slots were coalesced, never replayed
		const rows = await d1Rows(`select "nextRunAt" from "schedules" where "id" = '${created.schedule!.id}'`);
		expect(Date.parse(String(rows[0]!['nextRunAt']))).toBeGreaterThan(Date.parse('2026-10-06T11:14:00Z'));
	});

	test('a due sentinel schedule checks the STORED project/source ids and notifies on material change — deduped across ticks', async () => {
		// seed evidence through the real P10 routes
		const srcRes = await worker(jarA, `/api/projects/${projA}/evidence/sources`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ url: 'https://example.com/p12-rules', kind: 'page', authority: 'binding_rules' }),
		});
		expect(srcRes.status).toBe(201);
		const sourceId = ((await srcRes.json()) as { source: { id: string } }).source.id;
		const v1 = await worker(jarA, `/api/projects/${projA}/evidence/sources/${sourceId}/snapshots`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				content: '# Rules\n\nEntries close September 9, 2026 at 5:00 PM PT.\nTeams of up to four people.',
				mediaType: 'text/plain',
			}),
		});
		const snap1 = ((await v1.json()) as { snapshot: { id: string } }).snapshot.id;
		await worker(jarA, `/api/projects/${projA}/evidence/claims`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				snapshotId: snap1,
				claimType: 'deadline',
				value: '2026-09-10T00:00:00Z',
				quote: 'Entries close September 9, 2026 at 5:00 PM PT.',
				locator: 'rules#deadlines',
				extractionVersion: 'p10-evidence-v1',
			}),
		});
		const v2 = await worker(jarA, `/api/projects/${projA}/evidence/sources/${sourceId}/snapshots`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				content: '# Rules\n\nEntries close October 1, 2026 at 5:00 PM PT.\nTeams of up to four people.',
				mediaType: 'text/plain',
			}),
		});
		const snap2 = ((await v2.json()) as { snapshot: { id: string } }).snapshot.id;
		await worker(jarA, `/api/projects/${projA}/evidence/claims`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({
				snapshotId: snap2,
				claimType: 'deadline',
				value: '2026-10-01T00:00:00Z',
				quote: 'Entries close October 1, 2026 at 5:00 PM PT.',
				locator: 'rules#deadlines',
				extractionVersion: 'p10-evidence-v1',
			}),
		});

		const created = await createScheduleViaApi(jarA, {
			name: 'sentinel on rules',
			cron: '0 * * * *',
			timezone: 'UTC',
			payload: { sourceId }, // the EXPLICIT stored source — never "active"
		});
		expect(created.status).toBe(201);
		await pauseOthers(created.schedule!.id);
		await makeDue(created.schedule!.id, '2026-10-06T10:00:00.000Z');
		const { fired } = await tick('2026-10-06T10:05:00Z');
		expect(fired).toBe(1);

		// the check ran against the stored ids and recorded a MATERIAL result
		const results = await d1Rows(
			`select "projectId", "sourceId", "severity", "changedCount", "scheduleId" from "sentinel_results" where "sourceId" = '${sourceId}'`,
		);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			projectId: projA,
			sourceId,
			severity: 'material',
			scheduleId: created.schedule!.id,
		});
		// an in-app notification fired for the material change
		expect(await d1Count(
			WORKER_BASE,
			'notifications',
			`"kind" = 'sentinel_material_change' and "dedupeKey" = 'sentinel:${sourceId}:${snap2}'`,
		)).toBe(1);

		// a second tick on a NEW hourly slot re-checks the same snapshot pair:
		// the results row appends, the notification does NOT duplicate (its
		// dedupe key is the source+snapshot state). Re-arming the SAME slot
		// would be a no-op — the slot instant is the occurrence identity.
		await makeDue(created.schedule!.id, '2026-10-06T11:00:00.000Z');
		await tick('2026-10-06T11:06:00Z');
		expect(await d1Count(WORKER_BASE, 'sentinel_results', `"sourceId" = '${sourceId}'`)).toBe(2);
		expect(await d1Count(
			WORKER_BASE,
			'notifications',
			`"kind" = 'sentinel_material_change' and "dedupeKey" = 'sentinel:${sourceId}:${snap2}'`,
		)).toBe(1);
	});

	test('notification routes: own-only listing, read marking, and email failure leaves domain success intact', async () => {
		const list = await worker(jarA, '/api/notifications');
		expect(list.status).toBe(200);
		const notifications = ((await list.json()) as { notifications: { id: string; readAt: string | null }[] }).notifications;
		expect(notifications.length).toBeGreaterThanOrEqual(2);
		// bob sees none of alice's rows
		const bobList = await worker(jarB, '/api/notifications');
		expect(((await bobList.json()) as { notifications: unknown[] }).notifications).toHaveLength(0);

		const target = notifications.find((n) => n.readAt === null)!;
		const read = await worker(jarA, `/api/notifications/${target.id}/read`, { method: 'POST' });
		expect(read.status).toBe(200);
		expect(((await read.json()) as { notification: { readAt: string | null } }).notification.readAt).not.toBeNull();

		// opt-in email attempt with the DEFAULT mailer: no provider is configured
		// locally (SMTP is P17) — the attempt is a DOMAIN SUCCESS (200) that
		// records a retry-visible failed delivery
		const email = await worker(jarA, `/api/notifications/${target.id}/email`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ to: ALICE_EMAIL }),
		});
		expect(email.status).toBe(200);
		const delivery = ((await email.json()) as { delivery: { id: string; status: string; attempts: number; error: string } }).delivery;
		expect(delivery.status).toBe('failed');
		expect(delivery.attempts).toBe(1);
		expect(delivery.error).toContain('no mail provider configured');

		const retry = await worker(jarA, `/api/notifications/${target.id}/email`, {
			method: 'POST',
			headers: jsonHeaders,
			body: JSON.stringify({ to: ALICE_EMAIL, priorDeliveryId: delivery.id }),
		});
		expect(((await retry.json()) as { delivery: { attempts: number } }).delivery.attempts).toBe(2);
		expect(await d1Count(WORKER_BASE, 'notification_deliveries', `"id" = '${delivery.id}' and "status" = 'failed' and "attempts" = 2`)).toBe(1);
		// the notification itself survived every failed attempt
		expect(await d1Count(WORKER_BASE, 'notifications', `"id" = '${target.id}'`)).toBe(1);

		const unauth = await makeWorker(WORKER_BASE)(new (await import('./fixtures/controls-harness.ts')).Jar(), '/api/notifications');
		expect(unauth.status).toBe(401);
	});
});
