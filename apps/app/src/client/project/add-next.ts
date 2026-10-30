import { PLAN_ITEM_REQUEST_PREFIX } from '@caddie/contracts';
import type { PlanStageItem, PlanStages } from '../../server/build-features.ts';

/**
 * What the ready card offers next (staged builds, owner 2026-10-30): one
 * suggestion with "Add this", the other ideas behind it, the ones still
 * waiting on another part, and a failed add said plainly. Pure for tests.
 */
export interface AddNextView {
	readonly next: PlanStageItem | null;
	readonly others: readonly PlanStageItem[];
	readonly waiting: readonly PlanStageItem[];
	/** Title of the item whose last add did not work out, if it is still not built. */
	readonly failed: string | null;
}

export function addNextView(
	stages: PlanStages | null | undefined,
	change: { status: string; request: string } | null | undefined,
): AddNextView {
	const later = stages?.later ?? [];
	const available = later.filter((item) => item.status === 'available');
	const waiting = later.filter((item) => item.status === 'waiting');
	const failedTitle =
		change && change.status === 'failed' && change.request.startsWith(PLAN_ITEM_REQUEST_PREFIX)
			? change.request.slice(PLAN_ITEM_REQUEST_PREFIX.length)
			: null;
	const failed = failedTitle && available.some((item) => item.title === failedTitle) ? failedTitle : null;
	// A failed item stays the suggestion, so "Try again" is the first button.
	const next = (failed ? available.find((item) => item.title === failed) : null) ?? available[0] ?? null;
	return { next, others: available.filter((item) => item !== next), waiting, failed };
}
