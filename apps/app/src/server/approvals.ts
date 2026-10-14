import * as v from 'valibot';
import type { ApprovalAction, ApprovalIntent, ApprovalRecord } from '@caddie/contracts';
import { ApprovalIntentSchema, ApprovalRecordSchema, approvalIntentHash } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError, projectScopeForUser } from './scope.ts';

/**
 * P03 approvals (feature-ledger H4): durable, revision-bound approvals with an
 * execution-side gate.
 *
 * Authority model (audit defect #4 — prompt-only approval must not travel):
 *   - Decisions are recorded ONLY through the authenticated user path; the
 *     deciding actor is the SESSION-derived user id re-verified against the
 *     project's workspace membership. No decision input can name an actor.
 *   - Agent tools may REQUEST (pending) and READ only — there is no function
 *     here that lets an agent set a decision. The route layer enforces the
 *     same split (/api/agents-bridge has no decide route).
 *   - checkApprovalForEffect re-verifies the DURABLE record at effect time:
 *     exact intent-hash match, status approved, decidedBy equals the
 *     authenticated actor driving the effect, not expired, not revoked, same
 *     project, and current membership. Any mismatch throws a typed ScopeError
 *     with a distinct code (STALE_APPROVAL, APPROVAL_EXPIRED, APPROVAL_REVOKED,
 *     APPROVAL_WRONG_ACTOR, APPROVAL_WRONG_PROJECT).
 *
 * Expiry is anchored at the decision: a decision may refresh the window with
 * ttlSeconds; otherwise the request's window carries over. An expired PENDING
 * request cannot be decided (it is lazily marked expired instead).
 */

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type ApprovalDecision = 'approved' | 'rejected';

const ApprovalDecisionSchema = v.union([v.literal('approved'), v.literal('rejected')]);

/** Input for the authenticated decision route (strict: no decidedBy can ride through). */
export const ApprovalDecisionInputSchema = v.pipe(
	v.strictObject({
		intent: ApprovalIntentSchema,
		decision: ApprovalDecisionSchema,
		ttlSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	}),
	v.readonly(),
);
export type ApprovalDecisionInput = v.InferOutput<typeof ApprovalDecisionInputSchema>;

/** Input for the agent-facing request bridge (pending only). */
export const ApprovalRequestInputSchema = v.pipe(
	v.strictObject({
		intent: ApprovalIntentSchema,
		ttlSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	}),
	v.readonly(),
);
export type ApprovalRequestInput = v.InferOutput<typeof ApprovalRequestInputSchema>;

// --- helpers -----------------------------------------------------------------

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function parseOr400<S extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
	schema: S,
	input: unknown,
	code = 'invalid_input',
): v.InferOutput<S> {
	const result = v.safeParse(schema, input);
	if (!result.success) {
		const first = result.issues[0];
		const path = first?.path?.map((p) => String(p.key)).join('.') ?? '(body)';
		throw new ScopeError(
			400,
			code,
			`invalid input at ${path}: ${first?.message ?? 'validation failed'}`,
		);
	}
	return result.output;
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

function requireActorId(actorId: unknown): string {
	if (typeof actorId !== 'string' || actorId.length === 0) {
		throw new ScopeError(401, 'unauthenticated', 'a verified session user is required');
	}
	return actorId;
}

function requireNonEmpty(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new ScopeError(400, 'invalid_request', `${field} is required`);
	}
	return value;
}

function ttlToExpiresAt(fromIso: string, ttlSeconds: number): string {
	return new Date(Date.parse(fromIso) + ttlSeconds * 1000).toISOString();
}

/** Strict boundary parse: DB row -> frozen ApprovalRecord contract. */
function approvalRecordFromRow(row: Record<string, unknown>): ApprovalRecord {
	return parseOr400(ApprovalRecordSchema, {
		projectId: row['projectId'],
		action: row['action'],
		resourceId: row['resourceId'],
		revisionHash: row['revisionHash'],
		policyVersion: row['policyVersion'],
		id: row['id'],
		intentHash: row['intentHash'],
		decidedBy: row['decidedBy'] ?? null,
		status: row['status'],
		expiresAt: row['expiresAt'],
	});
}

async function approvalById(db: D1Database, id: string): Promise<Record<string, unknown>> {
	const rows = await queryAll(db, 'select * from "approvals" where "id" = ?', id);
	const row = rows[0];
	if (!row) throw new ScopeError(404, 'approval_not_found', 'no such approval');
	return row;
}

/** Latest row for an intent hash (the live request, or the newest lifecycle record). */
async function latestByIntentHash(
	db: D1Database,
	intentHash: string,
): Promise<Record<string, unknown> | null> {
	const rows = await queryAll(
		db,
		'select * from "approvals" where "intentHash" = ? order by "createdAt" desc, "rowid" desc limit 1',
		intentHash,
	);
	return rows[0] ?? null;
}

async function insertPending(
	db: D1Database,
	intent: ApprovalIntent,
	opts: { ttlSeconds?: number; now?: string },
): Promise<Record<string, unknown>> {
	const intentHash = await approvalIntentHash(intent);
	const createdAt = opts.now ?? nowIso();
	const expiresAt = ttlToExpiresAt(createdAt, opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
	const id = newId('apr');
	try {
		await db
			.prepare(
				'insert into "approvals" ("id","projectId","action","resourceId","revisionHash","policyVersion","intentHash","decidedBy","status","expiresAt","createdAt","decidedAt") values (?,?,?,?,?,?,?,null,\'pending\',?,?,null)',
			)
			.bind(
				id,
				intent.projectId,
				intent.action,
				intent.resourceId,
				intent.revisionHash,
				intent.policyVersion,
				intentHash,
				expiresAt,
				createdAt,
			)
			.run();
	} catch (error) {
		if (String(error).includes('UNIQUE constraint failed')) {
			throw new ScopeError(
				409,
				'approval_intent_conflict',
				'a live approval request already exists for this exact intent',
			);
		}
		throw error;
	}
	return (await queryAll(db, 'select * from "approvals" where "id" = ?', id))[0]!;
}

// --- request (agent-facing: pending ONLY) --------------------------------------

/**
 * Agent tools request an approval. Creates a PENDING record and nothing else —
 * there is no parameter here that could record a decision. One live pending
 * request per exact intent (unique partial index; duplicate → 409).
 */
export async function requestApproval(
	db: D1Database,
	input: unknown,
	opts: { ttlSeconds?: number; now?: string } = {},
): Promise<ApprovalRecord> {
	const parsed = parseOr400(ApprovalRequestInputSchema, input);
	const row = await insertPending(db, parsed.intent, {
		ttlSeconds: opts.ttlSeconds ?? parsed.ttlSeconds,
		now: opts.now,
	});
	return approvalRecordFromRow(row);
}

// --- decision (authenticated user path) ------------------------------------------

/**
 * Record an authenticated user decision. The deciding actor is the
 * session-derived userId, re-verified against the project's workspace
 * membership; the record's decidedBy can never be anyone else. Idempotent for
 * an exact duplicate click (same decision, same actor); any other re-decision
 * is a typed 409.
 */
export async function recordDecision(
	db: D1Database,
	actorId: string,
	input: unknown,
): Promise<ApprovalRecord> {
	const verifiedActor = requireActorId(actorId);
	const parsed = parseOr400(ApprovalDecisionInputSchema, input);
	const intent: ApprovalIntent = parsed.intent;
	const decision: ApprovalDecision = parsed.decision;
	const now = nowIso();

	// membership authority for the deciding actor (project must exist, actor a member)
	const scope = await projectScopeForUser(db, verifiedActor, intent.projectId);

	let row = await latestByIntentHash(db, await approvalIntentHash(intent));
	if (!row) {
		row = await insertPending(db, intent, { ttlSeconds: parsed.ttlSeconds });
	}

	if (row['status'] === 'pending') {
		const expiresAt = String(row['expiresAt']);
		if (now > expiresAt && parsed.ttlSeconds === undefined) {
			// stale request: lazily expire it, refuse the decision (typed, honest)
			await db
				.prepare('update "approvals" set "status" = \'expired\' where "id" = ? and "status" = \'pending\'')
				.bind(String(row['id']))
				.run();
			throw new ScopeError(409, 'approval_expired', 'the approval request expired before a decision');
		}
		const newExpiresAt =
			parsed.ttlSeconds !== undefined ? ttlToExpiresAt(now, parsed.ttlSeconds) : expiresAt;
		// Atomic single-statement transition: the WHERE clause makes a concurrent
		// decision race lose cleanly (changes = 0) instead of double-writing.
		await db
			.prepare(
				'update "approvals" set "status" = ?, "decidedBy" = ?, "decidedAt" = ?, "expiresAt" = ? where "id" = ? and "status" = \'pending\'',
			)
			.bind(decision, scope.actorId, now, newExpiresAt, String(row['id']))
			.run();
		// re-read the row: ours or a concurrent winner's, the rules below decide
		row = (await queryAll(db, 'select * from "approvals" where "id" = ?', String(row['id'])))[0]!;
	}

	// terminal states: exact duplicate click is idempotent, anything else conflicts
	if (row['status'] === decision && row['decidedBy'] === scope.actorId) {
		if (decision === 'approved') {
			// a newly approved revision supersedes older approved revisions of the
			// same (project, action, resource, policy)
			await supersedeOlderApprovals(db, intent, String(row['id']));
		}
		return approvalRecordFromRow(row);
	}
	throw new ScopeError(
		409,
		'approval_already_decided',
		`approval is already ${String(row['status'])} by ${String(row['decidedBy'] ?? 'someone else')}`,
	);
}

// --- supersede (internal write, part of approve) ------------------------------------

/**
 * Approving a revision supersedes every OTHER approved revision of the same
 * (project, action, resource): an old approval can never execute again once a
 * newer one exists. Called only from this module's approve path.
 */
async function supersedeOlderApprovals(
	db: D1Database,
	intent: ApprovalIntent,
	keepApprovalId: string,
): Promise<void> {
	await db
		.prepare(
			'update "approvals" set "status" = \'superseded\' where "projectId" = ? and "action" = ? and "resourceId" = ? and "policyVersion" = ? and "revisionHash" != ? and "status" = \'approved\' and "id" != ?',
		)
		.bind(
			intent.projectId,
			intent.action,
			intent.resourceId,
			intent.policyVersion,
			intent.revisionHash,
			keepApprovalId,
		)
		.run();
}

// --- revoke ----------------------------------------------------------------------

/** Revoke a pending or approved approval. Requires project membership authority. */
export async function revokeApproval(
	db: D1Database,
	actorId: string,
	approvalId: string,
): Promise<ApprovalRecord> {
	const verifiedActor = requireActorId(actorId);
	const id = requireNonEmpty(approvalId, 'approvalId');
	const row = await approvalById(db, id);
	// membership authority over the approval's project
	await projectScopeForUser(db, verifiedActor, String(row['projectId']));
	const res = (await db
		.prepare(
			'update "approvals" set "status" = \'revoked\' where "id" = ? and "status" in (\'pending\', \'approved\')',
		)
		.bind(id)
		.run()) as { meta?: { changes?: number } };
	if ((res.meta?.changes ?? 0) === 0) {
		throw new ScopeError(409, 'approval_not_revocable', `approval is already ${String(row['status'])}`);
	}
	return approvalRecordFromRow(await approvalById(db, id));
}

// --- reads -------------------------------------------------------------------------

/** Authenticated read: the actor must hold membership in the approval's project. */
export async function getApprovalForActor(
	db: D1Database,
	actorId: string,
	approvalId: string,
): Promise<ApprovalRecord> {
	const verifiedActor = requireActorId(actorId);
	const row = await approvalById(db, requireNonEmpty(approvalId, 'approvalId'));
	await projectScopeForUser(db, verifiedActor, String(row['projectId']));
	return approvalRecordFromRow(row);
}

/** Read the exact revision's decision after navigation or a reload. */
export async function getApprovalForIntent(db: D1Database, actorId: string, input: unknown): Promise<ApprovalRecord | null> {
	const actor = requireActorId(actorId);
	const intent = parseOr400(ApprovalIntentSchema, input);
	await projectScopeForUser(db, actor, intent.projectId);
	const row = await latestByIntentHash(db, await approvalIntentHash(intent));
	return row ? approvalRecordFromRow(row) : null;
}

/**
 * Agent-facing read (agents-bridge). Pending/approval STATE is readable by the
 * run's tooling; this grants no authority — the gate below never trusts a read,
 * only its own re-verification.
 */
export async function getApprovalById(db: D1Database, approvalId: string): Promise<ApprovalRecord> {
	return approvalRecordFromRow(await approvalById(db, requireNonEmpty(approvalId, 'approvalId')));
}

// --- execution-side gate -------------------------------------------------------------

export type ApprovalEffectCheck = Readonly<{
	actorId: string;
	projectId: string;
	action: ApprovalAction;
	resourceId: string;
	revisionHash: string;
	policyVersion: string;
	/** Injectable clock (ISO). Defaults to the real clock. */
	now?: string;
}>;

/**
 * THE execution-side gate: call immediately before ANY external effect. Every
 * check re-reads durable D1 state — nothing travels from the prompt, the UI or
 * a passed approval id (audit defect #4).
 *
 * Failure codes (typed ScopeError, all 403):
 *   STALE_APPROVAL       no approved record covers this exact intent (missing,
 *                        pending, rejected or superseded — including "approve
 *                        v1, revise to v2, deploy v2")
 *   APPROVAL_EXPIRED     the approved record's window has passed
 *   APPROVAL_REVOKED     the approved record was revoked
 *   APPROVAL_WRONG_ACTOR the record was decided by someone else
 *   APPROVAL_WRONG_PROJECT the intent matches an approval of a DIFFERENT project
 * On success returns the verified record (evidence for the effect receipt).
 */
export async function checkApprovalForEffect(
	db: D1Database,
	check: ApprovalEffectCheck,
): Promise<ApprovalRecord> {
	const verifiedActor = requireActorId(check.actorId);
	const intent = parseOr400(
		ApprovalIntentSchema,
		{
			projectId: check.projectId,
			action: check.action,
			resourceId: check.resourceId,
			revisionHash: check.revisionHash,
			policyVersion: check.policyVersion,
		},
		'invalid_request',
	);
	const intentHash = await approvalIntentHash(intent);
	const now = check.now ?? nowIso();

	const rows = await queryAll(
		db,
		'select * from "approvals" where "intentHash" = ? and "projectId" = ? order by "createdAt" desc, "rowid" desc limit 1',
		intentHash,
		intent.projectId,
	);
	const row = rows[0];
	if (!row) {
		// Distinguish reusing another project's approval for the same resource:
		// same action/resource/revision/policy approved under a different project.
		const others = await queryAll(
			db,
			`select * from "approvals"
			 where "action" = ? and "resourceId" = ? and "revisionHash" = ? and "policyVersion" = ?
			   and "projectId" != ? and "status" = 'approved'
			 limit 1`,
			intent.action,
			intent.resourceId,
			intent.revisionHash,
			intent.policyVersion,
			intent.projectId,
		);
		if (others[0]) {
			throw new ScopeError(
				403,
				'APPROVAL_WRONG_PROJECT',
				'the matching approval belongs to a different project and never travels across projects',
			);
		}
		throw new ScopeError(
			403,
			'STALE_APPROVAL',
			'no approved record covers this exact intent — re-approve after the revision change',
		);
	}

	if (row['status'] === 'revoked') {
		throw new ScopeError(403, 'APPROVAL_REVOKED', 'the approval was revoked before this effect');
	}
	if (row['status'] !== 'approved') {
		throw new ScopeError(
			403,
			'STALE_APPROVAL',
			`the approval for this intent is ${String(row['status'])}, not approved`,
		);
	}
	if (now > String(row['expiresAt'])) {
		throw new ScopeError(403, 'APPROVAL_EXPIRED', 'the approval expired before this effect');
	}
	if (typeof row['decidedBy'] !== 'string' || row['decidedBy'] !== verifiedActor) {
		throw new ScopeError(
			403,
			'APPROVAL_WRONG_ACTOR',
			'the approval was decided by a different actor than the one driving this effect',
		);
	}
	// project match is guaranteed by the lookup; keep the explicit guard
	if (String(row['projectId']) !== intent.projectId) {
		throw new ScopeError(403, 'APPROVAL_WRONG_PROJECT', 'approval project does not match the effect');
	}
	// membership authority at effect time: loss of membership revokes future effects
	await projectScopeForUser(db, verifiedActor, intent.projectId);
	return approvalRecordFromRow(row);
}
