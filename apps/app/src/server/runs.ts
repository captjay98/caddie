import type { D1Database } from './auth.ts';
import type { RunBindingRecord, Scope } from '@caddie/contracts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { findModelRoute, MODEL_ROUTES } from '../agents/providers.ts';
import {
	REPAIR_PAUSE_THRESHOLD,
	type RepairRoundKind,
} from '../agents/permissions.ts';
import { createRunBinding } from './projects.ts';

/**
 * P05 run lifecycle — the durable spine between the Flue DO runtime and the
 * product state in D1 (contracts.md: D1 is authoritative for business
 * records; Flue DO storage for agent execution state; bridge through stable
 * ids, idempotent transitions, receipts).
 *
 * - createRun freezes the model route + pricing version + payer into the
 *   immutable RunBinding BEFORE any agent work (unapproved fallback fails).
 * - The repair ledger counts only `repair_attempt` failures per issue;
 *   diagnosis/transport_retry/framework_recovery never count. Three failed
 *   attempts on the SAME issue pause the run.
 * - Verification evidence is append-only and machine-checked — the
 *   completion gate (evaluateCompletion) reads it; agent self-reports are
 *   never sufficient.
 * - Tool results are stamped with the planRevision they ran under; a result
 *   from a stale revision is rejected after plan revision.
 */

const REPAIR_ROUND_KINDS: readonly string[] = [
	'diagnosis',
	'repair_attempt',
	'verification',
	'transport_retry',
	'framework_recovery',
];

const RUN_PAUSE_THRESHOLD = REPAIR_PAUSE_THRESHOLD;

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

async function queryAll(db: D1Database, sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

export interface CreateRunInput {
	modelRouteId: string;
	planRevision: string;
	conversationId?: string;
	submissionId?: string;
	payerId: string;
}

export interface RunSnapshot {
	runBinding: RunBindingRecord;
	paused: boolean;
	pauseReason: string | null;
	lastCheckpoint: { planRevision: string; sha256: string; createdAt: string } | null;
	verifications: { check: string; passed: boolean; evidence: string; planRevision: string; createdAt: string }[];
}

export async function createRun(db: D1Database, scope: Scope, input: CreateRunInput): Promise<RunBindingRecord> {
	const verified = await assertProjectScope(db, scope);
	// Model route is frozen and must be a registered route — unknown ids throw;
	// a run NEVER silently falls back to a different provider or price.
	const route = findModelRoute(input.modelRouteId);
	if (!input.payerId) {
		throw new ScopeError(400, 'invalid_request', 'payerId is required — runs are payer-bound');
	}
	const binding = await createRunBinding(db, scope, {
		conversationId: input.conversationId ?? newId('conv'),
		submissionId: input.submissionId ?? newId('sub'),
		planRevision: input.planRevision,
		stackId: 'react-hono',
		payerId: input.payerId,
		modelRouteId: route.id,
		pricingVersion: route.pricingVersion,
	});
	return binding;
}

/**
 * Resolve a run binding by conversation id (the Flue stream/conversation key).
 * No project scope here by design: the caller (conversation guard) uses the
 * result's projectId to CHECK the scope; this lookup itself grants nothing.
 */
export async function lookupRunByConversation(
	db: D1Database,
	conversationId: string,
): Promise<RunBindingRecord | null> {
	const rows = await queryAll(
		db,
		'select * from "run_bindings" where "conversationId" = ? order by "createdAt" desc limit 1',
		conversationId,
	);
	return rows[0] ? runBindingFromRow(rows[0]) : null;
}

function runBindingFromRow(row: Record<string, unknown>): RunBindingRecord {
	return {
		runId: String(row['runId']),
		projectId: String(row['projectId']),
		conversationId: String(row['conversationId']),
		submissionId: String(row['submissionId']),
		planRevision: String(row['planRevision']),
		stackId: String(row['stackId']) as RunBindingRecord['stackId'],
		payerId: String(row['payerId']),
		modelRouteId: String(row['modelRouteId']),
		pricingVersion: String(row['pricingVersion']),
		createdBy: String(row['createdBy'] ?? ''),
		createdAt: String(row['createdAt']),
	};
}

export interface RepairRoundInput {
	issue: string;
	round: RepairRoundKind;
	outcome: 'started' | 'succeeded' | 'failed';
	detail?: string;
}

/**
 * OWNERSHIP CHECK: the run binding must exist AND belong to the verified
 * scope's project. A valid project scope alone must never authorize writes
 * against a run bound to a DIFFERENT project (audit P05 finding 3) — the
 * runId in a request is untrusted input, the scope is not.
 */
async function requireRunInProject(db: D1Database, runId: string, projectId: string): Promise<void> {
	const rows = await queryAll(db, 'select "projectId" from "run_bindings" where "runId" = ?', runId);
	const boundProjectId = rows[0] ? String(rows[0]['projectId']) : null;
	if (boundProjectId !== projectId) {
		// 404 (not 403): the run is invisible under this project's scope —
		// same rule as runSnapshot.
		throw new ScopeError(404, 'run_not_found', 'no such run under this project');
	}
}

/**
 * Ledger one round. Returns the pause verdict AFTER recording: when the
 * issue's failed repair_attempts reach the threshold, the run pauses — the
 * caller (coordinator loop / route) must stop dispatching further repairs.
 */
export async function recordRepairRound(
	db: D1Database,
	scope: Scope,
	runId: string,
	input: RepairRoundInput,
): Promise<{ paused: boolean; failedRepairAttempts: number }> {
	const verified = await assertProjectScope(db, scope);
	await requireRunInProject(db, runId, verified.projectId);
	if (!REPAIR_ROUND_KINDS.includes(input.round)) {
		throw new ScopeError(400, 'invalid_request', `unknown round kind ${input.round}`);
	}
	await db
		.prepare(
			'insert into "run_rounds" ("id","runId","projectId","issue","round","outcome","detail","createdAt") values (?,?,?,?,?,?,?,?)',
		)
		.bind(
			newId('round'),
			runId,
			verified.projectId,
			input.issue,
			input.round,
			input.outcome,
			input.detail ?? null,
			nowIso(),
		)
		.run();
	const rows = await queryAll(
		db,
		`select count(*) as "failed" from "run_rounds"
		 where "runId" = ? and "issue" = ? and "round" = 'repair_attempt' and "outcome" = 'failed'`,
		runId,
		input.issue,
	);
	const failed = Number(rows[0]?.['failed'] ?? 0);
	return { paused: failed >= RUN_PAUSE_THRESHOLD, failedRepairAttempts: failed };
}

/** Is this run currently paused (threshold reached on any issue)? */
export async function isRunPaused(db: D1Database, runId: string): Promise<{ paused: boolean; issue: string | null }> {
	const rows = await queryAll(
		db,
		`select "issue", count(*) as "failed" from "run_rounds"
		 where "runId" = ? and "round" = 'repair_attempt' and "outcome" = 'failed'
		 group by "issue" having count(*) >= ?`,
		runId,
		RUN_PAUSE_THRESHOLD,
	);
	return { paused: rows.length > 0, issue: rows[0] ? String(rows[0]['issue']) : null };
}

/**
 * Append-only verification evidence. Only machine-checked results belong
 * here (command exits, browser assertions); the QA tool is the only writer
 * and rows are never updated or deleted.
 */
export async function recordVerification(
	db: D1Database,
	scope: Scope,
	runId: string,
	input: { check: string; passed: boolean; evidence: string; planRevision: string },
): Promise<void> {
	const verified = await assertProjectScope(db, scope);
	await requireRunInProject(db, runId, verified.projectId);
	await db
		.prepare(
			'insert into "run_verifications" ("id","runId","projectId","check","passed","evidence","planRevision","recordedBy","createdAt") values (?,?,?,?,?,?,?,?,?)',
		)
		.bind(
			newId('ver'),
			runId,
			verified.projectId,
			input.check,
			input.passed ? 1 : 0,
			input.evidence,
			input.planRevision,
			verified.actorId,
			nowIso(),
		)
		.run();
	if (input.passed) {
		// Last good checkpoint: the newest verified state under the CURRENT plan
		// revision. Kept across failed repairs; never presented as containing
		// unverified changes.
		await db
			.prepare(
				`insert into "run_checkpoints" ("runId","projectId","planRevision","evidenceIds","sha256","createdAt")
				 values (?,?,?,?,?,?)
				 on conflict("runId") do update set
				   "planRevision" = excluded."planRevision",
				   "evidenceIds" = excluded."evidenceIds",
				   "sha256" = excluded."sha256",
				   "createdAt" = excluded."createdAt"`,
			)
			.bind(runId, verified.projectId, input.planRevision, '[]', `${input.check}:${input.evidence}`, nowIso())
			.run();
	}
}

/**
 * The completion gate's evidence reader (consumed by useAgentFinish in the
 * coordinator): a run is completable only when machine-checked verification
 * evidence exists under the CURRENT plan revision. Agent self-reports and
 * transport state are never sufficient.
 */
export async function evaluateCompletion(
	db: D1Database,
	runId: string,
	currentPlanRevision: string,
): Promise<{ completable: boolean; reason: string }> {
	const rows = await queryAll(
		db,
		`select "check", "passed" from "run_verifications"
		 where "runId" = ? and "planRevision" = ? order by rowid desc`,
		runId,
		currentPlanRevision,
	);
	if (rows.length === 0) {
		return { completable: false, reason: 'no machine-checked verification evidence under the current plan revision' };
	}
	// The latest record per check decides: a failure that was later re-run and
	// passed does not block completion, but an unresolved failure does.
	const latestByCheck = new Map<string, boolean>();
	for (const row of rows) {
		const check = String(row['check']);
		if (!latestByCheck.has(check)) {
			latestByCheck.set(check, Number(row['passed']) === 1);
		}
	}
	const failed = [...latestByCheck.entries()].filter(([, passed]) => !passed).map(([check]) => check);
	if (failed.length > 0) {
		return { completable: false, reason: `unresolved failing checks under the current plan revision: ${failed.join(', ')}` };
	}
	return { completable: true, reason: 'verified under the current plan revision' };
}

/** Staleness rule: tool results are valid only under the revision they ran. */
export function isStaleToolResult(resultPlanRevision: string, currentPlanRevision: string): boolean {
	return resultPlanRevision !== currentPlanRevision;
}

export async function runSnapshot(db: D1Database, scope: Scope, runId: string): Promise<RunSnapshot> {
	const verified = await assertProjectScope(db, scope);
	const bindingRows = await queryAll(
		db,
		'select * from "run_bindings" where "runId" = ? and "projectId" = ?',
		runId,
		verified.projectId,
	);
	const bindingRow = bindingRows[0];
	if (!bindingRow) throw new ScopeError(404, 'run_not_found', 'no such run under this project');
	const pause = await isRunPaused(db, runId);
	const verifications = await queryAll(
		db,
		'select * from "run_verifications" where "runId" = ? order by "createdAt" desc limit 50',
		runId,
	);
	const checkpointRows = await queryAll(db, 'select * from "run_checkpoints" where "runId" = ?', runId);
	const checkpoint = checkpointRows[0];
	return {
		runBinding: runBindingFromRow(bindingRow),
		paused: pause.paused,
		pauseReason: pause.issue,
		lastCheckpoint: checkpoint
			? {
					planRevision: String(checkpoint['planRevision']),
					sha256: String(checkpoint['sha256']),
					createdAt: String(checkpoint['createdAt']),
				}
			: null,
		verifications: verifications.map((row) => ({
			check: String(row['check']),
			passed: Number(row['passed']) === 1,
			evidence: String(row['evidence']),
			planRevision: String(row['planRevision']),
			createdAt: String(row['createdAt']),
		})),
	};
}

export { MODEL_ROUTES };
