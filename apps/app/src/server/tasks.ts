import type { D1Database } from './auth.ts';
import type { Scope } from '@caddie/contracts';
import { ScopeError, assertProjectScope } from './scope.ts';

/**
 * P12 slice 1 — human tasks (feature-ledger C20 neighborhood, the task half of
 * P12): simple project-scoped records with a status vocabulary, an optional
 * due date and an optional soft link to a run.
 *
 * Rules carried over from the established services:
 *   - Every service takes its Scope as a MANDATORY parameter and re-verifies
 *     it against D1 at entry (P02 pattern) — the actor/project never ride in
 *     from the body.
 *   - Every query leads with projectId (audit defect #2 class).
 *   - A task addressed across projects reads as 404, not 403 — existence
 *     outside the caller's project leaks nothing.
 *   - Date changes are UPDATES to the same row: history (and any notification
 *     rows derived from earlier dates — see notifications.ts) is never
 *     deleted; the P12 acceptance "date changes recalculate reminders without
 *     deleting history" is pinned by tests/schedules.integration.test.ts and
 *     implemented by keying reminders on the dueAt instant
 *     ({@link reminderKeyForTask} in notifications.ts), not by mutating rows.
 */

export type TaskStatus = 'open' | 'done' | 'cancelled';

export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'done', 'cancelled'];

export interface TaskRecord {
	readonly id: string;
	readonly projectId: string;
	readonly title: string;
	readonly status: TaskStatus;
	readonly dueAt: string | null;
	readonly linkedRunId: string | null;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

function nowIso(): string {
	return new Date().toISOString();
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

function requireTitle(title: unknown): string {
	if (typeof title !== 'string' || title.trim().length === 0) {
		fail(400, 'invalid_input', 'title is required and must be a non-empty string');
	}
	return title.trim();
}

/**
 * Validate an optional ISO-8601 dueAt. `null` clears it; `undefined` leaves it
 * untouched; anything that is not a parseable datetime string is a typed 400 —
 * a due date that cannot be compared is worse than none.
 */
function normalizeDueAt(value: unknown): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
		fail(400, 'invalid_input', 'dueAt must be an ISO-8601 datetime string or null');
	}
	return new Date(Date.parse(value)).toISOString();
}

function optionalId(value: unknown, field: string): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== 'string' || value.trim().length === 0) {
		fail(400, 'invalid_input', `${field} must be a non-empty string or null`);
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

function taskFromRow(row: Record<string, unknown>): TaskRecord {
	const status = row['status'];
	if (typeof status !== 'string' || !TASK_STATUSES.includes(status as TaskStatus)) {
		fail(500, 'invalid_row', `task row carries an unknown status: ${String(status)}`);
	}
	return {
		id: String(row['id']),
		projectId: String(row['projectId']),
		title: String(row['title']),
		status: status as TaskStatus,
		dueAt: row['dueAt'] == null ? null : String(row['dueAt']),
		linkedRunId: row['linkedRunId'] == null ? null : String(row['linkedRunId']),
		createdBy: String(row['createdBy']),
		createdAt: String(row['createdAt']),
		updatedAt: String(row['updatedAt']),
	};
}

export interface TaskCreateInput {
	title: string;
	dueAt?: string | null;
	linkedRunId?: string | null;
}

export async function createTask(
	db: D1Database,
	scope: Scope,
	input: TaskCreateInput,
): Promise<TaskRecord> {
	const verified = await assertProjectScope(db, scope);
	const title = requireTitle(input.title);
	const dueAt = normalizeDueAt(input.dueAt) ?? null;
	const linkedRunId = optionalId(input.linkedRunId, 'linkedRunId') ?? null;
	const id = `task_${crypto.randomUUID()}`;
	const now = nowIso();
	await db
		.prepare(
			'insert into "tasks" ("id","projectId","title","status","dueAt","linkedRunId","createdBy","createdAt","updatedAt") ' +
				'values (?,?,?,?,?,?,?,?,?)',
		)
		.bind(id, verified.projectId, title, 'open', dueAt, linkedRunId, verified.actorId, now, now)
		.run();
	return {
		id,
		projectId: verified.projectId,
		title,
		status: 'open',
		dueAt,
		linkedRunId,
		createdBy: verified.actorId,
		createdAt: now,
		updatedAt: now,
	};
}

export async function getTask(db: D1Database, scope: Scope, taskId: string): Promise<TaskRecord> {
	const verified = await assertProjectScope(db, scope);
	if (typeof taskId !== 'string' || taskId.length === 0) {
		fail(400, 'invalid_request', 'taskId is required');
	}
	const rows = await queryAll(
		db,
		'select * from "tasks" where "id" = ? and "projectId" = ?',
		taskId,
		verified.projectId,
	);
	if (!rows[0]) fail(404, 'task_not_found', 'no such task in this project');
	return taskFromRow(rows[0]!);
}

export interface TaskFilter {
	status?: TaskStatus;
}

export async function listTasks(
	db: D1Database,
	scope: Scope,
	filter: TaskFilter = {},
): Promise<TaskRecord[]> {
	const verified = await assertProjectScope(db, scope);
	if (filter.status !== undefined && !TASK_STATUSES.includes(filter.status)) {
		fail(400, 'invalid_input', `status must be one of: ${TASK_STATUSES.join(', ')}`);
	}
	const rows = filter.status
		? await queryAll(
				db,
				'select * from "tasks" where "projectId" = ? and "status" = ? order by "createdAt" desc, "id" asc',
				verified.projectId,
				filter.status,
			)
		: await queryAll(
				db,
				'select * from "tasks" where "projectId" = ? order by "createdAt" desc, "id" asc',
				verified.projectId,
			);
	return rows.map(taskFromRow);
}

export interface TaskUpdateInput {
	title?: string;
	status?: TaskStatus;
	dueAt?: string | null;
	linkedRunId?: string | null;
}

/**
 * Patch a task. Status is validated against the shared vocabulary before the
 * write (the DDL check constraint mirrors it — storage cannot drift). A dueAt
 * change updates the row in place; anything derived from the OLD date (for
 * example an already-created reminder notification) stays on record — history
 * is never deleted to implement a recalculation.
 */
export async function updateTask(
	db: D1Database,
	scope: Scope,
	taskId: string,
	patch: TaskUpdateInput,
): Promise<TaskRecord> {
	const current = await getTask(db, scope, taskId); // scopes + 404
	const updates: string[] = [];
	const params: unknown[] = [];
	if (patch.title !== undefined) {
		updates.push('"title" = ?');
		params.push(requireTitle(patch.title));
	}
	if (patch.status !== undefined) {
		if (!TASK_STATUSES.includes(patch.status)) {
			fail(400, 'invalid_input', `status must be one of: ${TASK_STATUSES.join(', ')}`);
		}
		updates.push('"status" = ?');
		params.push(patch.status);
	}
	const dueAt = normalizeDueAt(patch.dueAt);
	if (dueAt !== undefined) {
		updates.push('"dueAt" = ?');
		params.push(dueAt);
	}
	const linkedRunId = optionalId(patch.linkedRunId, 'linkedRunId');
	if (linkedRunId !== undefined) {
		updates.push('"linkedRunId" = ?');
		params.push(linkedRunId);
	}
	if (updates.length > 0) {
		updates.push('"updatedAt" = ?');
		params.push(nowIso(), current.id);
		await db
			.prepare(`update "tasks" set ${updates.join(', ')} where "id" = ?`)
			.bind(...params)
			.run();
	}
	return getTask(db, scope, taskId);
}
