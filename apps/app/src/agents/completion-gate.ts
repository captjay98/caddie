import type { GateRecord } from './tools.ts';
import { GATE_DIR } from './tools.ts';

/**
 * P05 completion gate — pure evaluator for the coordinator's useAgentFinish
 * hook. The gate ledger lives in the sandbox (`.caddie/gates/<revision>.jsonl`,
 * written only by the record_acceptance tool); completion requires a PASSING
 * record under the CURRENT plan revision. Agent self-reports are never
 * sufficient; a missing or unreadable gate fails closed.
 *
 * Kept pure so the unit tests can prove the acceptance rule
 * "failed completion cannot claim success" without a model or a sandbox.
 */

export interface GateEvaluation {
	completable: boolean;
	reason: string;
}

export function evaluateGateLedger(content: string, currentPlanRevision: string): GateEvaluation {
	const records: GateRecord[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as Partial<GateRecord>;
			if (
				typeof parsed.check === 'string' &&
				typeof parsed.command === 'string' &&
				typeof parsed.exitCode === 'number' &&
				typeof parsed.planRevision === 'string'
			) {
				records.push(parsed as GateRecord);
			}
			// malformed lines are skipped: the ledger is append-only evidence,
			// and a corrupt line must not erase the passing records around it.
		} catch {
			// skip
		}
	}
	const relevant = records.filter(
		(r) => r.planRevision === currentPlanRevision && typeof r.operationKey === 'string' && r.operationKey.length >= 8,
	);
	if (relevant.length === 0) {
		return {
			completable: false,
			reason: 'no acceptance record under the current plan revision — run the checks and record_acceptance',
		};
	}
	// Latest record per check decides, matching evaluateCompletion in the D1
	// evaluator. The ledger file is in append order (oldest first), so the
	// LAST record per check is the latest: a failure later re-run and passed
	// does not block, but an unresolved failure does.
	const latestByCheck = new Map<string, number>();
	for (const record of relevant) {
		latestByCheck.set(record.check, record.exitCode);
	}
	const failed = [...latestByCheck.entries()].filter(([, exitCode]) => exitCode !== 0).map(([check]) => check);
	if (failed.length > 0) {
		return {
			completable: false,
			reason: `unresolved failing checks under the current revision: ${failed.join(', ')}`,
		};
	}
	return { completable: true, reason: `accepted by ${latestByCheck.size} passing check(s) under ${currentPlanRevision}` };
}

export function gatePathFor(planRevision: string): string {
	return `${GATE_DIR}/${planRevision}.jsonl`;
}
