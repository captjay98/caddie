import type { DecisionCard } from '@caddie/contracts';

const PRIORITY = { 'needs-you': 0, blocked: 1, changed: 2, handled: 3 };

/** Brief cards report events, not a completed percentage of a build. */
export function projectStatus(cards: readonly DecisionCard[]) {
	const ordered = [...cards].sort((a, b) =>
		PRIORITY[a.status] - PRIORITY[b.status] || b.updatedAt.localeCompare(a.updatedAt));
	const next = ordered.find((card) => card.status !== 'handled') ?? null;
	const latest = next ?? ordered[0] ?? null;
	let label = 'No updates yet';
	if (latest) {
		if (latest.status === 'blocked') label = 'Needs attention';
		else if (latest.kind === 'approval' && latest.status === 'needs-you') label = 'Decision needed';
		else if (latest.status === 'changed') label = 'Changes to review';
		else if (latest.id.startsWith('brf_preview_')) label = 'Preview available';
		else if (latest.kind === 'deadline') label = 'Upcoming deadline';
		else label = 'Update available';
	}
	return {
		label,
		detail: latest?.summary ?? 'Tell Caddie what you would like to build or change.',
		next,
	};
}
