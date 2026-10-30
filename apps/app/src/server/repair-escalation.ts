import { createHash } from 'node:crypto';
import type { D1Database } from './auth.ts';

export const REPAIR_POLICY_VERSION = 'repair-v1';
/**
 * The builder's model ladder: two failed checks on an issue move it one rung.
 * Rung one IS the builder (every repair-policy build reads its model from
 * here, so this, not MODEL_ROLES.build alone, is what a build runs on).
 * Owner 2026-10-29: MiniMax-M3.1-Flash first, then DeepSeek.
 * GLM-5.3 ($1.40 in / $4.40 out per Mtok) is off the ladder: a third repair
 * round is the worst time to pay five times more per token.
 * 2026-10-30 EggOps run: Super VL as the last code rung was the slowest and
 * least effective — 10–35 s per call, 19 calls and no file written in six
 * minutes, and an earlier round spent $0.27 breaking passing tests — while
 * DeepSeek took the same feature from 0 to 3 of 4 host checks in five minutes.
 * So the last rung is DeepSeek again; Super VL stays for issues that need
 * image input (VISION_REPAIR_ROUTES).
 */
export const REPAIR_ROUTES = ['minimax-m3.1-flash', 'deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash-1017'] as const;
/** An issue that needs image input repairs only on routes that read images. */
export const VISION_REPAIR_ROUTES = ['nemotron-3.5-super-vl', 'deepseek-v4.1-flash-1017'] as const;
export type RepairRoute = typeof REPAIR_ROUTES[number] | typeof VISION_REPAIR_ROUTES[number];
export function repairRoute(failures: number, requiresVision = false): RepairRoute | null {
  const routes: readonly RepairRoute[] = requiresVision ? VISION_REPAIR_ROUTES : REPAIR_ROUTES;
  if (!Number.isSafeInteger(failures) || failures < 0 || failures >= routes.length * 2) return null;
  return routes[Math.floor(failures / 2)]!;
}
interface Admission { projectId: string; runId: string; planId: string; spendPayerId: string; phase: string; }
async function admission(db: D1Database, runId: string): Promise<Admission | null> {
  let rows: { results: Array<Admission & { repairPolicyVersion?: string }> };
  try {
    rows = await db.prepare('select * from build_workflows where runId=?')
      .bind(runId).all<Admission & { repairPolicyVersion?: string }>();
  } catch (error) {
    // Run-only databases from before workflow admission have no repair policy.
    if (String(error).includes('no such table: build_workflows')) return null;
    throw error;
  }
  const row = rows.results[0];
  return row?.repairPolicyVersion === REPAIR_POLICY_VERSION ? row : null;
}
export async function repairState(db: D1Database, runId: string, featureIds?: readonly string[]) {
  const active = await admission(db, runId);
  if (!active) return null;
  const filter = featureIds === undefined ? '' : featureIds.length ? ` and featureId in (${featureIds.map(() => '?').join(',')})` : ' and 0';
  const rows = await db.prepare(`select featureId,failures,requiresVision,state from build_repair_issues where runId=? and admissionId=?${filter} order by failures desc`)
    .bind(runId, active.spendPayerId, ...(featureIds ?? [])).all<{featureId: string; failures: number; requiresVision: number; state: string}>();
  const issue = rows.results.find(row => row.state === 'exhausted') ?? rows.results.find(row => row.state === 'active');
  return { paused: issue?.state === 'exhausted', issue: issue?.featureId ?? null,
    routeId: repairRoute(issue?.failures ?? 0, Boolean(issue?.requiresVision)), failures: issue?.failures ?? 0 };
}
/** One checked failure, one durable receipt. No model-supplied identifier can reset the allowance.
 * The caller supplies the operation key from the already-persisted host repair round.
 * All mutations share one D1 transaction and fence the ORIGINAL admission and phase.
 */
export async function recordCheckedRepair(db: D1Database, input: { runId: string; operationKey: string; issue: string; detail: string; admissionId?: string }) {
  const active = await admission(db, input.runId);
  if (!active || (input.admissionId !== undefined && active.spendPayerId !== input.admissionId) || active.phase !== 'building' || !active.planId || !active.spendPayerId) return null;
  const features = await db.prepare(`select featureId from build_features where runId=? and planId=? and status<>'passed' order by position`)
    .bind(input.runId, active.planId).all<{featureId: string}>();
  // An explicitly prefixed feature owns a parallel module's failure. Otherwise the current feature owns it.
  const featureId = features.results.find(row => input.issue.startsWith(`${row.featureId}:`))?.featureId
    ?? features.results[0]?.featureId ?? 'final-verification';
  const id = createHash('sha256').update(JSON.stringify([active.projectId, active.runId, active.planId, featureId, active.spendPayerId])).digest('hex');
  const stamp = new Date().toISOString();
  const fence = `exists(select 1 from build_workflows where runId=? and spendPayerId=? and planId=? and phase='building' and repairPolicyVersion=?)`;
  const fenceArgs = [active.runId, active.spendPayerId, active.planId, REPAIR_POLICY_VERSION];
  await db.batch([
    db.prepare(`insert or ignore into build_repair_issues(id,projectId,runId,planId,featureId,admissionId,policyVersion,requiresVision,createdAt,updatedAt) select ?,?,?,?,?,?,?,0,?,? where ${fence}`)
      .bind(id, active.projectId, active.runId, active.planId, featureId, active.spendPayerId, REPAIR_POLICY_VERSION, stamp, stamp, ...fenceArgs),
    db.prepare(`insert or ignore into build_repair_attempts(operationKey,issueId,ordinal,modelRouteId,failureHash,createdAt)
      select ?,id,failures+1,case when failures<2 then ? when failures<4 then ? else ? end,?,? from build_repair_issues
      where id=? and state='active' and failures<6 and ${fence}`)
      .bind(input.operationKey, ...REPAIR_ROUTES, createHash('sha256').update(input.detail).digest('hex'), stamp, id, ...fenceArgs),
    db.prepare(`update build_repair_issues set failures=(select count(*) from build_repair_attempts where issueId=?),
      state=case when (select count(*) from build_repair_attempts where issueId=?)>=6 then 'exhausted' else 'active' end,updatedAt=? where id=? and ${fence}`)
      .bind(id, id, stamp, id, ...fenceArgs),
  ]);
  return repairState(db, input.runId, [featureId]);
}
