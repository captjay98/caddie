import type { D1Database } from './auth.ts';
import type { Scope } from '@caddie/contracts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { recordRepairRound } from './runs.ts';
import { runSentinelCheckForSchedule } from './sentinel.ts';
import { createNotification } from './notifications.ts';

/**
 * P12 slice 1 — schedules: a D1 record whose due slots are executed by
 * calling the EXISTING run/operation machinery, never a parallel scheduler
 * runtime (packets.md P12: "unique occurrence keys trigger Flue work"). The
 * cron timer is REAL: wrangler.jsonc declares a 5-minute trigger and
 * src/cloudflare.ts exports the Worker-level `scheduled` handler that calls
 * {@link dispatchDueSchedules} on that cadence; the tick path is pinned by
 * tests/schedules.integration.test.ts (direct service dispatch and the
 * handler itself over the D1-shaped fixture).
 *
 * ## Cron support
 *
 * A minimal 5-field cron: `m h dom mon dow` supporting `*`, `,`, `-`, `/`
 * and plain numbers (no names, no @-shorthands, no seconds). Day-of-week
 * follows the common 0-7 convention with 7 normalized to 0 (sunday). When
 * BOTH day-of-month and day-of-week are restricted (textually not `*`), the
 * Vixie-cron rule applies: the day matches when EITHER matches.
 *
 * ## Next-occurrence math (DST-aware)
 *
 * {@link nextCronOccurrence} searches forward in WALL-CLOCK time of the
 * schedule's IANA timezone and converts candidate wall times to UTC instants
 * with the exact guess+refine Intl rule from evidence/deadlines.ts — the zone
 * database is the authority, never arithmetic. Documented edge policies:
 *
 *   - A wall time inside a spring-forward gap (it does not exist) resolves to
 *     the instant the guess+refine rule produces for it — deterministic, so
 *     the occurrence key is stable across executors and retries.
 *   - A folded wall time (occurs twice at fall-back) resolves to ONE fixed
 *     instant by the same rule; the slot never fires twice for one wall time
 *     because the key is the resolved instant, not the wall time.
 *   - The next slot is STRICTLY AFTER the reference instant: a slot computed
 *     twice (executor retry, overlapping tick) yields the same key, and the
 *     second election loses on the unique index.
 *
 * ## Missed-run coalescing (the policy, documented)
 *
 * When the executor is late by one or more slots, exactly ONE dispatch fires
 * (for the oldest due slot) and `nextRunAt` then jumps to the next FUTURE
 * slot computed from `now` — the missed slots are coalesced into that single
 * firing and are never replayed. History stays in schedule_occurrences; a
 * dispatch error still advances nextRunAt so one poison schedule cannot wedge
 * the executor into an infinite retry loop.
 *
 * ## Targeting (audit-defect shape)
 *
 * A schedule stores its projectId at creation and an EXPLICIT payload of
 * optional `{ sourceId, runId }`. There is no "currently active project"
 * anywhere in the execution path: {@link dispatchDueSchedules} is
 * system-level (no session exists on a cron tick) and works exclusively off
 * the STORED ids, so switching projects can never retarget a schedule.
 */

// --- cron parsing ---------------------------------------------------------------

interface CronFieldSpec {
	readonly name: string;
	readonly min: number;
	readonly max: number;
}

const CRON_FIELD_SPECS: readonly CronFieldSpec[] = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day-of-month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12 },
	{ name: 'day-of-week', min: 0, max: 7 },
];

export interface CronFields {
	readonly minutes: ReadonlySet<number>;
	readonly hours: ReadonlySet<number>;
	readonly daysOfMonth: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	/** 0-6 with sunday as 0 (input 7 normalized to 0). */
	readonly daysOfWeek: ReadonlySet<number>;
	/** Textually not `*` — drives the Vixie dom/dow OR rule. */
	readonly domRestricted: boolean;
	readonly dowRestricted: boolean;
}

const CRON_TERM_RE = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

function parseCronField(raw: string, spec: CronFieldSpec): { values: Set<number>; restricted: boolean } {
	const values = new Set<number>();
	const restricted = raw !== '*';
	for (const term of raw.split(',')) {
		const match = CRON_TERM_RE.exec(term);
		if (!match) {
			throw new ScopeError(400, 'invalid_cron', `invalid ${spec.name} term: ${JSON.stringify(term)}`);
		}
		// `*` spans the whole field; a bare number is a SINGLE value; a range
		// `a-b` is inclusive; `/step` strides any of the three.
		const start = match[1] === '*' ? spec.min : Number(match[1]);
		if (start < spec.min || start > spec.max) {
			throw new ScopeError(
				400,
				'invalid_cron',
				`${spec.name} value ${match[1]} is out of range (${spec.min}-${spec.max})`,
			);
		}
		let end: number;
		if (match[1] === '*') {
			end = match[2] === undefined ? spec.max : Number(match[2]);
			if (end < spec.min || end > spec.max) {
				throw new ScopeError(400, 'invalid_cron', `invalid ${spec.name} range: ${JSON.stringify(term)}`);
			}
		} else {
			end = match[2] === undefined ? start : Number(match[2]);
			if (end < start || end > spec.max) {
				throw new ScopeError(
					400,
					'invalid_cron',
					`invalid ${spec.name} range: ${JSON.stringify(term)}`,
				);
			}
		}
		const step = match[3] === undefined ? 1 : Number(match[3]);
		if (step < 1) {
			throw new ScopeError(400, 'invalid_cron', `${spec.name} step must be at least 1`);
		}
		for (let value = start; value <= end; value += step) {
			// day-of-week: 7 is an alias for sunday (0).
			values.add(spec.name === 'day-of-week' && value === 7 ? 0 : value);
		}
	}
	return { values, restricted };
}

/** Parse a 5-field cron expression, or throw a typed 400 {@link ScopeError}. */
export function parseCron(expr: string): CronFields {
	if (typeof expr !== 'string') {
		throw new ScopeError(400, 'invalid_cron', 'cron must be a string');
	}
	const rawFields = expr.trim().split(/\s+/);
	if (rawFields.length !== 5 || rawFields.some((f) => f.length === 0)) {
		throw new ScopeError(400, 'invalid_cron', `cron must have exactly 5 fields (m h dom mon dow): ${JSON.stringify(expr)}`);
	}
	const parsed = rawFields.map((raw, index) => parseCronField(raw, CRON_FIELD_SPECS[index]!));
	return {
		minutes: parsed[0]!.values,
		hours: parsed[1]!.values,
		daysOfMonth: parsed[2]!.values,
		months: parsed[3]!.values,
		daysOfWeek: parsed[4]!.values,
		domRestricted: parsed[2]!.restricted,
		dowRestricted: parsed[4]!.restricted,
	};
}

// --- timezone math (the deadlines.ts Intl pattern, verbatim rules) ------------------

/** Offset (minutes) of `timeZone` in effect at `instant`. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
	const parts = new Map<string, number>();
	for (const part of dtf.formatToParts(instant)) {
		if (part.type !== 'literal') parts.set(part.type, Number(part.value));
	}
	const asUtc = Date.UTC(
		parts.get('year')!,
		parts.get('month')! - 1,
		parts.get('day')!,
		parts.get('hour')!,
		parts.get('minute')!,
		parts.get('second')!,
	);
	return (asUtc - instant.getTime()) / 60000;
}

/** UTC milliseconds for a wall-clock time in a zone (guess + refine). */
function zonedWallTimeToUtcMs(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string,
): number {
	const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
	const offset1 = tzOffsetMinutes(new Date(wallAsUtc), timeZone);
	const guess = wallAsUtc - offset1 * 60000;
	const offset2 = tzOffsetMinutes(new Date(guess), timeZone);
	return wallAsUtc - offset2 * 60000;
}

function wallParts(instantMs: number, timeZone: string): {
	year: number;
	month: number;
	day: number;
} {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	const parts = new Map<string, number>();
	for (const part of dtf.formatToParts(new Date(instantMs))) {
		if (part.type !== 'literal') parts.set(part.type, Number(part.value));
	}
	return {
		year: parts.get('year')!,
		month: parts.get('month')!,
		day: parts.get('day')!,
	};
}

/** Validate an IANA zone name against the Intl ICU database (the authority). */
function assertValidTimezone(timeZone: string): void {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone });
	} catch {
		throw new ScopeError(400, 'invalid_timezone', `unrecognized timezone ${JSON.stringify(timeZone)}`);
	}
}

function dayMatches(fields: CronFields, month: number, day: number, weekday: number): boolean {
	if (!fields.months.has(month)) return false;
	const domOk = fields.daysOfMonth.has(day);
	const dowOk = fields.daysOfWeek.has(weekday);
	// Vixie-cron rule: when both day fields are restricted, EITHER may match.
	if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
	if (fields.domRestricted) return domOk;
	if (fields.dowRestricted) return dowOk;
	return true;
}

const MAX_DAY_SCAN = 366 * 5; // five years of calendar days — beyond any sane cron

/**
 * The first UTC instant strictly after `afterMs` whose wall-clock time in
 * `timeZone` matches the cron expression, or null when no day matches within
 * five years (e.g. Feb 31). Throws typed 400s for a bad expression or an
 * unrecognized timezone — cron math never guesses.
 */
export function nextCronOccurrence(expr: string, timeZone: string, afterMs: number): number | null {
	const fields = parseCron(expr);
	assertValidTimezone(timeZone);
	if (!Number.isFinite(afterMs)) {
		throw new ScopeError(400, 'invalid_request', 'the reference instant must be a finite time');
	}
	const start = wallParts(afterMs, timeZone);
	for (let offset = 0; offset < MAX_DAY_SCAN; offset++) {
		const dayMs = Date.UTC(start.year, start.month - 1, start.day + offset);
		const year = new Date(dayMs).getUTCFullYear();
		const month = new Date(dayMs).getUTCMonth() + 1;
		const day = new Date(dayMs).getUTCDate();
		const weekday = new Date(dayMs).getUTCDay();
		if (!dayMatches(fields, month, day, weekday)) continue;
		// Candidate wall times for this day, ascending wall order.
		const hours = [...fields.hours].sort((a, b) => a - b);
		for (const hour of hours) {
			const minutes = [...fields.minutes].sort((a, b) => a - b);
			for (const minute of minutes) {
				const utcMs = zonedWallTimeToUtcMs(year, month, day, hour, minute, timeZone);
				if (utcMs > afterMs) return utcMs;
			}
		}
	}
	return null;
}

// --- records ---------------------------------------------------------------------

export interface SchedulePayload {
	readonly sourceId?: string;
	readonly runId?: string;
}

export interface ScheduleRecord {
	readonly id: string;
	readonly projectId: string;
	readonly name: string;
	readonly cron: string;
	readonly timezone: string;
	/** ISO UTC instant of the next slot. */
	readonly nextRunAt: string;
	readonly lastResult: string | null;
	readonly lastResultAt: string | null;
	readonly paused: boolean;
	readonly payload: SchedulePayload;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export type OccurrenceKind = 'scheduled' | 'manual';

export interface OccurrenceRecord {
	readonly id: string;
	readonly scheduleId: string;
	readonly projectId: string;
	readonly occurrenceKey: string;
	readonly slotAt: string;
	readonly kind: OccurrenceKind;
	readonly dispatchedAt: string;
	readonly dispatchedBy: string;
	readonly result: string | null;
}

function nowIso(): string {
	return new Date().toISOString();
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

function requireNonEmpty(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		fail(400, 'invalid_input', `${field} is required and must be a non-empty string`);
	}
	return value.trim();
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

/**
 * Validate the schedule payload: an object carrying AT MOST an explicit
 * `sourceId` and/or `runId` (non-empty strings). The project is never part of
 * the payload — it is the schedule's own stored projectId, set at creation
 * and never retargeted.
 */
function validatePayload(input: unknown): SchedulePayload {
	if (input === undefined || input === null) return {};
	if (typeof input !== 'object' || Array.isArray(input)) {
		fail(400, 'invalid_input', 'payload must be an object with optional sourceId/runId');
	}
	const out: { sourceId?: string; runId?: string } = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (key !== 'sourceId' && key !== 'runId') {
			fail(
				400,
				'invalid_input',
				`payload key ${JSON.stringify(key)} is not allowed — schedules target explicit sourceId/runId only; the project is the schedule's own projectId`,
			);
		}
		if (typeof value !== 'string' || value.trim().length === 0) {
			fail(400, 'invalid_input', `payload.${key} must be a non-empty string`);
		}
		out[key as 'sourceId' | 'runId'] = value.trim();
	}
	return out;
}

function scheduleFromRow(row: Record<string, unknown>): ScheduleRecord {
	let payload: SchedulePayload = {};
	try {
		payload = validatePayload(JSON.parse(String(row['payload'] ?? '{}')));
	} catch {
		fail(500, 'invalid_row', 'schedule row carries an unparseable payload');
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		name: String(row['name']),
		cron: String(row['cron']),
		timezone: String(row['timezone']),
		nextRunAt: String(row['nextRunAt']),
		lastResult: row['lastResult'] == null ? null : String(row['lastResult']),
		lastResultAt: row['lastResultAt'] == null ? null : String(row['lastResultAt']),
		paused: Number(row['paused']) === 1,
		payload,
		createdBy: String(row['createdBy']),
		createdAt: String(row['createdAt']),
		updatedAt: String(row['updatedAt']),
	};
}

function occurrenceFromRow(row: Record<string, unknown>): OccurrenceRecord {
	const kind = row['kind'];
	if (kind !== 'scheduled' && kind !== 'manual') {
		fail(500, 'invalid_row', `occurrence row carries an unknown kind: ${String(kind)}`);
	}
	return {
		id: String(row['id']),
		scheduleId: String(row['scheduleId']),
		projectId: String(row['projectId']),
		occurrenceKey: String(row['occurrenceKey']),
		slotAt: String(row['slotAt']),
		kind,
		dispatchedAt: String(row['dispatchedAt']),
		dispatchedBy: String(row['dispatchedBy']),
		result: row['result'] == null ? null : String(row['result']),
	};
}

// --- schedule CRUD ------------------------------------------------------------------

export interface ScheduleCreateInput {
	name: string;
	cron: string;
	timezone: string;
	payload?: unknown;
}

export async function createSchedule(
	db: D1Database,
	scope: Scope,
	input: ScheduleCreateInput,
	nowMs: number = Date.now(),
): Promise<ScheduleRecord> {
	const verified = await assertProjectScope(db, scope);
	const name = requireNonEmpty(input.name, 'name');
	const cron = requireNonEmpty(input.cron, 'cron');
	const timezone = requireNonEmpty(input.timezone, 'timezone');
	const payload = validatePayload(input.payload);
	// Validation IS the computation: a cron that parses but never fires
	// (e.g. Feb 31) cannot back a schedule, and an unknown timezone must fail
	// loudly at creation rather than silently drifting to UTC at fire time.
	const nextMs = nextCronOccurrence(cron, timezone, nowMs);
	if (nextMs === null) {
		fail(400, 'invalid_cron', 'this cron never fires in the given timezone');
	}
	const id = `sched_${crypto.randomUUID()}`;
	const now = nowIso();
	await db
		.prepare(
			'insert into "schedules" ("id","projectId","name","cron","timezone","nextRunAt","paused","payload","createdBy","createdAt","updatedAt") ' +
				'values (?,?,?,?,?,?,0,?,?,?,?)',
		)
		.bind(id, verified.projectId, name, cron, timezone, new Date(nextMs).toISOString(), JSON.stringify(payload), verified.actorId, now, now)
		.run();
	return {
		id,
		projectId: verified.projectId,
		name,
		cron,
		timezone,
		nextRunAt: new Date(nextMs).toISOString(),
		lastResult: null,
		lastResultAt: null,
		paused: false,
		payload,
		createdBy: verified.actorId,
		createdAt: now,
		updatedAt: now,
	};
}

export async function getSchedule(db: D1Database, scope: Scope, scheduleId: string): Promise<ScheduleRecord> {
	const verified = await assertProjectScope(db, scope);
	if (typeof scheduleId !== 'string' || scheduleId.length === 0) {
		fail(400, 'invalid_request', 'scheduleId is required');
	}
	const rows = await queryAll(
		db,
		'select * from "schedules" where "id" = ? and "projectId" = ?',
		scheduleId,
		verified.projectId,
	);
	if (!rows[0]) fail(404, 'schedule_not_found', 'no such schedule in this project');
	return scheduleFromRow(rows[0]!);
}

export async function listSchedules(db: D1Database, scope: Scope): Promise<ScheduleRecord[]> {
	const verified = await assertProjectScope(db, scope);
	const rows = await queryAll(
		db,
		'select * from "schedules" where "projectId" = ? order by "createdAt" desc, "id" asc',
		verified.projectId,
	);
	return rows.map(scheduleFromRow);
}

export interface ScheduleUpdateInput {
	name?: string;
	cron?: string;
	timezone?: string;
	paused?: boolean;
	payload?: unknown;
}

/**
 * Edit a schedule. A cron/timezone edit recomputes nextRunAt from `nowMs`
 * (strictly future) — occurrence history is never deleted by an edit; the
 * schedule simply fires on the new pattern from now on.
 */
export async function updateSchedule(
	db: D1Database,
	scope: Scope,
	scheduleId: string,
	patch: ScheduleUpdateInput,
	nowMs: number = Date.now(),
): Promise<ScheduleRecord> {
	const current = await getSchedule(db, scope, scheduleId);
	const name = patch.name === undefined ? current.name : requireNonEmpty(patch.name, 'name');
	const cron = patch.cron === undefined ? current.cron : requireNonEmpty(patch.cron, 'cron');
	const timezone =
		patch.timezone === undefined ? current.timezone : requireNonEmpty(patch.timezone, 'timezone');
	const payload = patch.payload === undefined ? current.payload : validatePayload(patch.payload);

	let nextRunAt = current.nextRunAt;
	if (patch.cron !== undefined || patch.timezone !== undefined) {
		const nextMs = nextCronOccurrence(cron, timezone, nowMs);
		if (nextMs === null) {
			fail(400, 'invalid_cron', 'this cron never fires in the given timezone');
		}
		nextRunAt = new Date(nextMs).toISOString();
	}
	await db
		.prepare(
			'update "schedules" set "name" = ?, "cron" = ?, "timezone" = ?, "nextRunAt" = ?, "paused" = ?, "payload" = ?, "updatedAt" = ? ' +
				'where "id" = ? and "projectId" = ?',
		)
		.bind(
			name,
			cron,
			timezone,
			nextRunAt,
			patch.paused === undefined ? (current.paused ? 1 : 0) : patch.paused ? 1 : 0,
			JSON.stringify(payload),
			nowIso(),
			current.id,
			current.projectId,
		)
		.run();
	return getSchedule(db, scope, scheduleId);
}

// --- occurrences and dispatch ----------------------------------------------------------

export async function listOccurrences(
	db: D1Database,
	scope: Scope,
	scheduleId: string,
): Promise<OccurrenceRecord[]> {
	const schedule = await getSchedule(db, scope, scheduleId); // scopes + 404
	const rows = await queryAll(
		db,
		'select * from "schedule_occurrences" where "scheduleId" = ? and "projectId" = ? order by "slotAt" desc, "id" asc',
		schedule.id,
		schedule.projectId,
	);
	return rows.map(occurrenceFromRow);
}

/**
 * The system-level due selector. NO scope by design: a cron tick has no
 * session, and the schedule's STORED projectId/payload are the only targeting
 * information (the audit-defect rule — there is no "active project" to
 * inherit). Rows carry their project everywhere they are used.
 */
export async function selectDueSchedules(db: D1Database, nowMs: number): Promise<ScheduleRecord[]> {
	if (!Number.isFinite(nowMs)) fail(400, 'invalid_request', 'now must be a finite time');
	const rows = await queryAll(
		db,
		'select * from "schedules" where "paused" = 0 and "nextRunAt" <= ? order by "nextRunAt" asc, "id" asc',
		new Date(nowMs).toISOString(),
	);
	return rows.map(scheduleFromRow);
}

/**
 * The workspaceId backing a stored projectId — used to build the scope the
 * runs machinery re-verifies when a schedule dispatches into a run binding.
 */
async function projectWorkspaceId(db: D1Database, projectId: string): Promise<string | null> {
	const rows = await queryAll(db, 'select "workspaceId" from "projects" where "id" = ?', projectId);
	return rows[0] ? String(rows[0]['workspaceId']) : null;
}

function readChanges(result: unknown): number {
	const meta = (result as { meta?: { changes?: number } }).meta;
	if (meta && meta.changes !== undefined) return Number(meta.changes);
	return Number((result as { changes?: number }).changes ?? 0);
}

export interface FireOutcome {
	readonly elected: boolean;
	readonly result: string;
	readonly occurrence: OccurrenceRecord | null;
}

/**
 * Fire one occurrence of a schedule. The (scheduleId, occurrenceKey) unique
 * index ELECTS the executor: `insert or ignore` succeeding (meta.changes = 1)
 * means this call owns the slot; a losing concurrent call is a no-op — no
 * second run dispatch, no second notification, ever.
 *
 * Dispatch targets, in order:
 *   1. payload.sourceId — a Sentinel check against the stored project+source
 *      ids (existing snapshots only; the re-fetch pass is P09/P17 wiring),
 *      with a material-change notification to the owner.
 *   2. payload.runId AND a run binding with that id under the schedule's own
 *      project — the dispatch is recorded through the EXISTING runs
 *      machinery (a run_rounds ledger entry naming the schedule), never a
 *      parallel executor.
 *   3. otherwise — the occurrence row itself plus an owner notification
 *      deduped on the occurrence key.
 */
async function fireOccurrence(
	db: D1Database,
	schedule: ScheduleRecord,
	input: {
		occurrenceKey: string;
		slotAtMs: number;
		kind: OccurrenceKind;
		dispatchedBy: string;
		nowMs: number;
	},
): Promise<FireOutcome> {
	const id = `occ_${crypto.randomUUID()}`;
	const now = nowIso();
	const insert = await db
		.prepare(
			'insert or ignore into "schedule_occurrences" ' +
				'("id","scheduleId","projectId","occurrenceKey","slotAt","kind","dispatchedAt","dispatchedBy") ' +
				'values (?,?,?,?,?,?,?,?)',
		)
		.bind(
			id,
			schedule.id,
			schedule.projectId,
			input.occurrenceKey,
			new Date(input.slotAtMs).toISOString(),
			input.kind,
			now,
			input.dispatchedBy,
		)
		.run();
	if (readChanges(insert) !== 1) {
		// Lost the election: another executor already fired this exact slot.
		return { elected: false, result: 'duplicate_occurrence', occurrence: null };
	}

	let result = 'notified';
	if (schedule.payload.sourceId !== undefined) {
		// A Sentinel check against the STORED project/source ids (never an
		// "active" project). The re-fetch/capture pass that produces NEW
		// snapshots is P09/P17 wiring — this compares the snapshots that exist.
		try {
			const check = await runSentinelCheckForSchedule(db, {
				projectId: schedule.projectId,
				sourceId: schedule.payload.sourceId,
				scheduleId: schedule.id,
			});
			result = `sentinel:${check.result.severity}:${check.result.changedCount}`;
			if (check.result.severity === 'material') {
				// Rules-tier change: notify the schedule's owner. The dedupe key is
				// the SOURCE+SNAPSHOT state, so repeated ticks on the same pair do
				// not duplicate the alert — only a genuinely new snapshot re-alerts.
				await createNotification(db, {
					userId: schedule.createdBy,
					projectId: schedule.projectId,
					kind: 'sentinel_material_change',
					title: `Binding rule change on a watched source`,
					body:
						`${check.result.changedCount} claim change(s) on source ${schedule.payload.sourceId}: ` +
						`snapshot ${check.result.previousSnapshotId} -> ${check.result.currentSnapshotId}.`,
					dedupeKey: `sentinel:${schedule.payload.sourceId}:${check.result.currentSnapshotId}`,
				});
			}
		} catch (error) {
			// A failed check is recorded on the occurrence; the slot stays
			// consumed (coalescing policy) and the timer moves on.
			result = `failed:${String(error).slice(0, 160)}`;
		}
	} else if (schedule.payload.runId !== undefined) {
		const binding = await queryAll(
			db,
			'select "runId" from "run_bindings" where "runId" = ? and "projectId" = ?',
			schedule.payload.runId,
			schedule.projectId,
		);
		if (binding[0]) {
			// Dispatch through the runs machinery: a ledger entry in the bound
			// run's rounds. The scope is rebuilt from stored records (creator +
			// project workspace) and re-verified by the runs service against D1 —
			// a creator who lost membership fails the dispatch honestly.
			const workspaceId = await projectWorkspaceId(db, schedule.projectId);
			if (workspaceId) {
				await recordRepairRound(
					db,
					{ actorId: schedule.createdBy, workspaceId, projectId: schedule.projectId },
					schedule.payload.runId,
					{
						issue: `schedule:${schedule.id}`,
						round: 'diagnosis',
						outcome: 'started',
						detail: `occurrence ${input.occurrenceKey}`,
					},
				);
				result = `dispatched:run:${schedule.payload.runId}`;
			} else {
				result = 'failed:project_missing';
			}
		} else {
			// The binding is gone — fall through to the plain occurrence +
			// notification path rather than failing the slot.
			result = 'notified';
		}
	}
	if (result === 'notified') {
		// No dispatch target resolved (empty payload, or the bound run is gone):
		// the occurrence row itself is the durable trigger and the owner gets an
		// in-app notification, deduped per occurrence key — a retried or
		// overlapping fire can never notify twice for one slot.
		await createNotification(db, {
			userId: schedule.createdBy,
			projectId: schedule.projectId,
			kind: 'schedule_fired',
			title: `Schedule fired: ${schedule.name}`,
			body: `Occurrence ${input.occurrenceKey} of "${schedule.name}" (${schedule.cron} ${schedule.timezone}).`,
			dedupeKey: `schedule:${schedule.id}:${input.occurrenceKey}`,
		});
	}

	await db
		.prepare('update "schedule_occurrences" set "result" = ? where "id" = ?')
		.bind(result, id)
		.run();

	// Advance to the next FUTURE slot from now — the missed-run coalescing
	// policy (module header). Applies to manual fires too: a run-now never
	// leaves a stale past slot behind.
	const nextMs = nextCronOccurrence(schedule.cron, schedule.timezone, input.nowMs);
	if (nextMs !== null) {
		await db
			.prepare('update "schedules" set "nextRunAt" = ?, "lastResult" = ?, "lastResultAt" = ?, "updatedAt" = ? where "id" = ?')
			.bind(new Date(nextMs).toISOString(), result, now, now, schedule.id)
			.run();
	}

	const occurrence = occurrenceFromRow({
		id,
		scheduleId: schedule.id,
		projectId: schedule.projectId,
		occurrenceKey: input.occurrenceKey,
		slotAt: new Date(input.slotAtMs).toISOString(),
		kind: input.kind,
		dispatchedAt: now,
		dispatchedBy: input.dispatchedBy,
		result,
	});
	return { elected: true, result, occurrence };
}

/**
 * Run a schedule NOW (user action, session-scoped). Paused schedules may
 * still be fired manually — pausing stops the TIMER, not the owner. The
 * manual occurrence key is the request instant, so two run-now calls in the
 * same instant collapse and distinct instants are distinct fires.
 */
export async function runScheduleNow(
	db: D1Database,
	scope: Scope,
	scheduleId: string,
	nowMs: number = Date.now(),
): Promise<FireOutcome> {
	const verified = await assertProjectScope(db, scope);
	const schedule = await getSchedule(db, scope, scheduleId);
	return fireOccurrence(db, schedule, {
		occurrenceKey: `manual:${new Date(nowMs).toISOString()}`,
		slotAtMs: nowMs,
		kind: 'manual',
		dispatchedBy: verified.actorId,
		nowMs,
	});
}

/**
 * The cron tick: fire every unpaused schedule whose slot has arrived. One
 * dispatch per due schedule; the unique occurrence index makes overlapping
 * or retried ticks safe (the second election loses and does nothing).
 * A per-schedule failure is recorded in lastResult AND still advances
 * nextRunAt — one poison schedule can never wedge the executor.
 */
export async function dispatchDueSchedules(db: D1Database, nowMs: number): Promise<number> {
	const due = await selectDueSchedules(db, nowMs);
	let fired = 0;
	for (const schedule of due) {
		try {
			const outcome = await fireOccurrence(db, schedule, {
				occurrenceKey: schedule.nextRunAt,
				slotAtMs: Date.parse(schedule.nextRunAt),
				kind: 'scheduled',
				dispatchedBy: 'system:cron',
				nowMs,
			});
			if (outcome.elected) fired++;
		} catch (error) {
			const nextMs = nextCronOccurrence(schedule.cron, schedule.timezone, nowMs);
			if (nextMs !== null) {
				await db
					.prepare(
						'update "schedules" set "nextRunAt" = ?, "lastResult" = ?, "lastResultAt" = ?, "updatedAt" = ? where "id" = ?',
					)
					.bind(
						new Date(nextMs).toISOString(),
						`failed:${String(error).slice(0, 200)}`,
						nowIso(),
						nowIso(),
						schedule.id,
					)
					.run();
			}
		}
	}
	return fired;
}
