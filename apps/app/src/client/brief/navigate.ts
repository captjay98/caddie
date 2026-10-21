import type { DecisionCard } from '@caddie/contracts';

/**
 * Where a brief card's primary action actually goes (audit F08, carried into
 * the account brief): kind decides the surface, `projectId` scopes it,
 * `primaryAction.targetId` rides along as the exact identity (claim, revision,
 * schedule, preview, run, package, candidate). No card ever degrades to a
 * generic project page. Preview-kind actions open the Files surface where the
 * share lives; opportunity cards (the Home scope) open Discover — the feed
 * the candidate came from, since there is no per-candidate route yet.
 */
export function briefActionRoute(
	card: DecisionCard,
	homeProjectId: string | null = null,
): { to: string; search: Record<string, string | undefined> } {
	const search: Record<string, string | undefined> = { project: card.projectId };
	switch (card.primaryAction.kind) {
		case 'preview':
			return { to: '/preview', search: { ...search, preview: card.primaryAction.targetId, source: card.id.startsWith('brf_workflow_preview_') ? 'workflow' : 'share' } };
		case 'inspect':
            if (card.id.startsWith('brf_workflow_')) return { to: '/runs', search };
			// Opportunity review → the account feed the candidate came from.
			if (homeProjectId !== null && card.projectId === homeProjectId) {
				return { to: '/discover', search: {} };
			}
			if (card.evidenceIds.length > 0) {
				return { to: '/evidence', search: { ...search, claim: card.primaryAction.targetId } };
			}
			return { to: '/artifacts', search };
		case 'review':
		default:
			break;
	}
	switch (card.kind) {
		case 'approval':
			return { to: '/design-review', search: card.status === 'handled' ? { ...search, approval: card.primaryAction.targetId } : search };
		case 'deadline':
			return { to: '/schedules', search };
		case 'result':
			return { to: '/project', search };
		case 'change':
			// The submission-gap card → the submission package (its checklist).
			// Routed on the server's stable card id (brf_submission_<packageId>),
			// never on the display label — labels are copy (they get reworded),
			// ids are identity.
			if (card.id.startsWith('brf_submission_')) return { to: '/submission', search };
			if (card.evidenceIds.length > 0) {
				return { to: '/evidence', search: { ...search, claim: card.primaryAction.targetId } };
			}
			return { to: '/artifacts', search };
	}
}
