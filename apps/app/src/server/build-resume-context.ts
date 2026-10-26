/**
 * B05 — restore the right work after interruption (PURE, no I/O).
 *
 * On a cold restart the host rebuilds scope + run and re-opens the sandbox
 * session, but a chat transcript alone is not enough to restore an execution
 * environment. Before any effect, the host must prove the restored workspace
 * still matches what the run was building: the same stack, the last verified
 * checkpoint still present and pointing where expected, and (when known) the
 * same recipe version. On any mismatch, effects are REFUSED with an actionable
 * reason rather than writing into an incompatible workspace (plan B05.2).
 *
 * This is the pure decision; the caller (resolveCoordinatorContext / the
 * feature loop) consults it before the first write on a resumed build.
 */

export interface RestoreCompatibilityInput {
	/** The stack the run was admitted with (run_bindings.stackId). */
	expectedStack: string;
	/** The stack the restored session actually provides. */
	restoredStack: string;
	/** The last verified checkpoint the feature expects, or null for none yet. */
	expectedCheckpointRef: string | null;
	/** The checkpoint actually available in the restored workspace, or null. */
	availableCheckpointRef: string | null;
	/** The recipe version the run used, when recorded. */
	expectedRecipeVersion?: string;
	/** The recipe version the restored environment provides, when recorded. */
	restoredRecipeVersion?: string;
}

export type RestoreCompatibility = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a restored build workspace may take effects. Strict on the
 * three identity dimensions the host can actually compare; permissive only
 * where a value is genuinely unknown (legacy runs without a recorded recipe
 * version are not blocked on that dimension).
 */
export function restoreCompatibility(input: RestoreCompatibilityInput): RestoreCompatibility {
	if (input.expectedStack !== input.restoredStack)
		return {
			ok: false,
			reason: `The restored workspace is a ${input.restoredStack} stack, but this build is ${input.expectedStack}. It cannot continue here.`,
		};
	// The last verified checkpoint must be present and be the exact one the
	// feature expects — a gone or moved checkpoint means the save point this
	// feature resumes from is no longer there.
	if (input.expectedCheckpointRef !== input.availableCheckpointRef)
		return {
			ok: false,
			reason:
				input.availableCheckpointRef === null
					? "The last verified checkpoint for this feature is no longer available in the restored workspace."
					: "The restored workspace's checkpoint does not match the one this feature was verified at.",
		};
	// Recipe version: only a blocker when BOTH are known and differ. An absent
	// value is a legacy run that never recorded one — do not refuse on unknown.
	if (
		input.expectedRecipeVersion !== undefined &&
		input.restoredRecipeVersion !== undefined &&
		input.expectedRecipeVersion !== input.restoredRecipeVersion
	)
		return {
			ok: false,
			reason: `The build recipe changed (was ${input.expectedRecipeVersion}, now ${input.restoredRecipeVersion}); the restored checkpoint may be incompatible.`,
		};
	return { ok: true };
}

import type { D1Database } from './auth.ts';
/** Host-owned recovery context. No file bodies, credentials or private reasoning.
 * Queries are bounded; this is derived from durable authority, not a model summary.
 */
export async function buildResumeContext(db:D1Database,runId:string):Promise<string|null> {
 let workflow:Record<string,unknown>|undefined;
 try {workflow=(await db.prepare('select * from build_workflows where runId=?').bind(runId).all<Record<string,unknown>>()).results[0];}
 catch(error){if(String(error).includes('no such table: build_workflows'))return null;throw error;}
 if(!workflow || workflow.repairPolicyVersion!=='repair-v1') return null;
 const features=(await db.prepare('select featureId,position,title,doneWhen,status,checkpointRef from build_features where runId=? and planId=? order by position limit 40')
  .bind(runId,workflow.planId).all<Record<string,unknown>>()).results;
 const pending=(await db.prepare("select operationKey,provider,status,receiptId from external_operations where runId=? and status not in ('succeeded','failed','cancelled') order by createdAt desc limit 12")
  .bind(runId).all()).results;
 const failures=(await db.prepare("select issue,detail from run_rounds where runId=? and outcome='failed' order by rowid desc limit 3")
  .bind(runId).all<{issue:string;detail:string|null}>()).results.map(row=>({issue:row.issue,detail:row.detail?.slice(0,500)}));
 const budget=(await db.prepare(`select l.limitMicros,coalesce(sum(case when r.status='settled' then r.settledMicros when r.status='reserved' then r.reservedMicros else 0 end),0) as committedMicros
  from build_spend_limits l left join build_spend_reservations r on l.payerId=r.payerId where l.payerId=? group by l.payerId`)
  .bind(workflow.spendPayerId).all()).results[0] ?? null;
 const current=features.find(row=>row.status!=='passed');
 const capsule={version:1,runId,projectId:workflow.projectId,planId:workflow.planId,approvedDesignId:workflow.approvedDesignRevisionId,
  admissionId:workflow.spendPayerId,phase:workflow.phase,currentFeature:current??null,
  savedFeatures:features.filter(row=>row.status==='passed').map(row=>({featureId:row.featureId,checkpointRef:row.checkpointRef})),
  pendingEffects:pending,failures,budget,
  instruction:'Read the approved plan and design for scope. Continue only the current feature. Reconcile pending effects by their existing operation key before retrying. Do not reset the admission, counters or spending allowance.'};
 let encoded=JSON.stringify(capsule);
 if(encoded.length>16_000)encoded=JSON.stringify({...capsule,currentFeature:current?{featureId:current.featureId,title:String(current.title).slice(0,200),scope:'Read the approved plan for the full criteria'}:null,savedFeatures:capsule.savedFeatures.slice(-6),pendingEffects:pending.slice(0,4),failures:failures.slice(0,1)});
 return encoded;
}
