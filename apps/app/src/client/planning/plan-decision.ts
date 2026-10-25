import type { ApprovalRecord } from '@caddie/contracts';

interface Revision { readonly id: string; readonly bodyHash: string }

/** A decision belongs to this exact saved revision, never merely the project. */
export function approvalForRevision(plan: Revision | null | undefined, approval: ApprovalRecord | null | undefined): ApprovalRecord | null {
	return plan && approval?.resourceId === plan.id && approval.revisionHash === plan.bodyHash ? approval : null;
}

export function approvalExpired(approval: ApprovalRecord | null | undefined, now = Date.now()): boolean {
	if (!approval) return false;
	const expiresAt = Date.parse(approval.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt <= now;
}

/** The review-phase result shared by chat and Projects. A recorded approval
 * still in review has not advanced the workflow; it must remain actionable. */
export function planReviewState(plan: Revision | null | undefined, approval: ApprovalRecord | null | undefined, now = Date.now()) {
	const current = approvalForRevision(plan, approval);
	if (current && !approvalExpired(current, now) && current.status === 'rejected') {
		return { label: 'Changes requested', headline: 'You requested changes to this plan', detail: 'Your feedback is saved. Continue with Caddie to update the plan.', action: 'Continue the plan' };
	}
	if (current && (approvalExpired(current, now) || ['expired', 'revoked', 'superseded'].includes(current.status))) {
		return { label: 'Review needed', headline: 'This plan needs a fresh review', detail: 'The earlier approval is no longer active. Open the plan to review what is needed.', action: 'Review plan' };
	}
	return { label: 'Plan ready', headline: 'Your plan is ready to review', detail: 'See the features, scope and checks before you approve this plan.', action: 'Review plan' };
}
