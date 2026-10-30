import {
	aboutMinutes,
	FIRST_VERSION_MAX,
	firstVersionMinutes,
	itemDependents,
	itemMinutes,
	itemNeeds,
	plannedFirstVersion,
	type PlanFeature,
} from '@caddie/contracts';

/**
 * The owner's first-version choice on the plan card (staged builds, owner
 * 2026-10-30). Pure, so the moves are unit-tested: moving an item up brings
 * what it needs with it; moving one down takes what needs it along. The
 * server checks the same rule again when the plan is approved.
 */
export interface PlanChoice {
	readonly first: readonly PlanFeature[];
	readonly later: readonly PlanFeature[];
	readonly firstMinutes: number;
}

export function planChoice(features: readonly PlanFeature[], chosen: readonly string[] | null): PlanChoice {
	const ids = new Set(chosen ?? plannedFirstVersion(features));
	const first = features.filter((feature) => ids.has(feature.id));
	return { first, later: features.filter((feature) => !ids.has(feature.id)), firstMinutes: aboutMinutes(firstVersionMinutes(first)) };
}

/** Minutes for one item, rounded for reading. */
export function itemAboutMinutes(feature: Pick<PlanFeature, 'doneWhen'>): number {
	return aboutMinutes(itemMinutes(feature));
}

export type MoveResult = { ok: true; chosen: string[] } | { ok: false; reason: string };

/** Move one item into the first version, with everything it needs. */
export function moveToFirst(features: readonly PlanFeature[], chosen: readonly string[] | null, id: string): MoveResult {
	const current = new Set(chosen ?? plannedFirstVersion(features));
	for (const need of [...itemNeeds(features, id), id]) current.add(need);
	if (current.size > FIRST_VERSION_MAX) return { ok: false, reason: `A first version holds at most ${FIRST_VERSION_MAX} things. Move one to “add after” first.` };
	return { ok: true, chosen: features.filter((feature) => current.has(feature.id)).map((feature) => feature.id) };
}

/** Move one item out of the first version, with everything that needs it. */
export function moveToLater(features: readonly PlanFeature[], chosen: readonly string[] | null, id: string): MoveResult {
	const current = new Set(chosen ?? plannedFirstVersion(features));
	for (const dependent of [id, ...itemDependents(features, id)]) current.delete(dependent);
	if (current.size === 0) return { ok: false, reason: 'The first version needs at least one thing.' };
	return { ok: true, chosen: features.filter((feature) => current.has(feature.id)).map((feature) => feature.id) };
}

/** Whether the owner changed the plan's own split (only then is a choice sent). */
export function choiceDiffers(features: readonly PlanFeature[], chosen: readonly string[] | null): boolean {
	if (!chosen) return false;
	const planned = plannedFirstVersion(features);
	return planned.length !== chosen.length || planned.some((id) => !chosen.includes(id));
}
