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
	const relevant = records.filter((r) => r.planRevision === currentPlanRevision);
	if (relevant.length === 0) {
		return {
			completable: false,
			reason: 'no acceptance record under the current plan revision — run the checks and record_acceptance',
		};
	}
	const passing = relevant.filter((r) => r.exitCode === 0);
	if (passing.length === 0) {
		return {
			completable: false,
			reason: 'acceptance records exist for the current revision but none passed — fix and re-run',
		};
	}
	return { completable: true, reason: `accepted by ${passing.length} passing record(s) under ${currentPlanRevision}` };
}

export function gatePathFor(planRevision: string): string {
	return `${GATE_DIR}/${planRevision}.jsonl`;
}
