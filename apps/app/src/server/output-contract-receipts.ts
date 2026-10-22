/**
 * Per-output contract-check receipts (plan part G, step 5).
 *
 * Team mode binds a publish to the EXACT output being published: publish-safety
 * (publish.ts) refuses a team-mode publish unless that output's own sign-in,
 * second-person and restart contract checks passed. This module is the store
 * those receipts live in (migration 0041, `output_contract_receipts`):
 *
 *   - `recordOutputContractReceipts` — the host writes it when verify_build runs
 *     the team-mode contract checks (coordinator-host.ts), from the green/red
 *     map `runTeamModeContractChecks` returns, keyed by the output id;
 *   - `readOutputContractReceipts` — publish.ts's `readOutputContractReceipts`
 *     dep reads it back, keyed by (projectId, outputId), and returns the
 *     `OutputVerifyReceipts` shape publish-safety expects, or null when none
 *     exist for that output (which, in team mode, blocks the publish).
 *
 * Team mode only: with teamMode = 0 verify_build never records a receipt and
 * publish-safety never reads one, so today's publish path is unchanged.
 */

import type { D1Database } from './auth.ts';
import type { OutputVerifyReceipts, RequiredTeamModeCheck } from './publish-safety.ts';
import { REQUIRED_TEAM_MODE_CHECKS } from './publish-safety.ts';

/** The per-check green/red map the host records (the shape host-checks returns). */
export type ContractCheckMap = Readonly<Record<RequiredTeamModeCheck, boolean>>;

/** Normalise an arbitrary stored object to the exact required-check map (missing = false). */
function toCheckMap(raw: unknown): ContractCheckMap {
	const obj = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {});
	const map = {} as Record<RequiredTeamModeCheck, boolean>;
	for (const check of REQUIRED_TEAM_MODE_CHECKS) map[check] = obj[check] === true;
	return map;
}

/**
 * Record (or replace) the contract-check receipts for ONE output. Rebuilt per
 * verify via delete+insert (not ON CONFLICT: the local D1 emulator mishandles
 * upserts — the same note build-steps.saveStoredPart records). Only the three
 * required checks are stored; anything else in the map is dropped.
 */
export async function recordOutputContractReceipts(
	db: D1Database,
	projectId: string,
	outputId: string,
	checks: ContractCheckMap,
	now: string = new Date().toISOString(),
): Promise<void> {
	const stored = toCheckMap(checks);
	await db.batch([
		db
			.prepare('delete from "output_contract_receipts" where "projectId" = ? and "outputId" = ?')
			.bind(projectId, outputId),
		db
			.prepare(
				'insert into "output_contract_receipts" ("id","projectId","outputId","checks","createdAt") values (?,?,?,?,?)',
			)
			.bind(`ocr_${crypto.randomUUID()}`, projectId, outputId, JSON.stringify(stored), now),
	]);
}

/**
 * Read one output's contract-check receipts, in the shape publish-safety wants.
 * Null when no receipt exists for (projectId, outputId) — in team mode that
 * blocks the publish, so a publish of an output whose checks were never run can
 * never go live. `outputId` is carried through so the call site can prove the
 * receipts belong to the output being published.
 */
export async function readOutputContractReceipts(
	db: D1Database,
	projectId: string,
	outputId: string,
): Promise<OutputVerifyReceipts | null> {
	const row = (
		await db
			.prepare('select "checks" from "output_contract_receipts" where "projectId" = ? and "outputId" = ?')
			.bind(projectId, outputId)
			.all<{ checks: string }>()
	).results?.[0];
	if (!row) return null;
	let parsed: unknown = {};
	try {
		parsed = JSON.parse(row.checks);
	} catch {
		parsed = {};
	}
	return { outputId, checks: toCheckMap(parsed) };
}
