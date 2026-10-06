import { beforeEach, describe, expect, test } from 'bun:test';

/**
 * P12 slice 1 — tasks and schedules.
 *
 * Three layers, each with its own honesty classification:
 *
 *   1. PURE cron math (parser + next occurrence): LOCAL VERIFIED as pure
 *      functions. DST correctness comes from the Intl ICU zone database (the
 *      deadlines.ts pattern) — the expected instants below are pinned to real
 *      US DST transition dates (fall back 2026-11-01, spring forward
 *      2026-03-08).
 *   2. SERVICE layer over in-memory SQLite carrying the REAL 0007 DDL:
 *      LOCAL VERIFIED at the unit level (same wrap pattern as
 *      tests/evidence.test.ts).
 *   3. (slice 3 adds the real-workerd integration layer.)
 *
 * No external calls exist anywhere in this packet's code paths; the real cron
 * timer (the thing that calls dispatchDueSchedules on a schedule) is P09/P17
 * wiring and is DOCUMENTATION ONLY here.
 */

import {
	catchScopeError,
	makeSchedulesUnitWorld,
	type UnitWorld,
} from './fixtures/schedules-harness.ts';
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
