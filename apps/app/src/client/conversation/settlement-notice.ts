import type { FlueConversationSettlement } from '@flue/react';

/**
 * The plain-language notice for a turn that ended without finishing.
 *
 * Before this, every failure read "Caddie stopped before finishing. Your saved
 * plan and files are retained…" — even for a hackathon search that simply
 * timed out, where there is no plan or file involved. The user saw Caddie's
 * last "Thought it through" note and then a vague stop, so the planning note
 * looked like the reply. This names WHAT happened and the one thing to do next.
 * It never shows the raw internal error text.
 */
export interface SettlementNotice {
	/** Short reason, shown first. */
	readonly title: string;
	/** What to do next. */
	readonly detail: string;
	/** Stable kind for styling/tests. */
	readonly kind: 'timeout' | 'cancelled' | 'failed';
}

function errorType(error: unknown): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const type = (error as { type?: unknown }).type;
	return typeof type === 'string' ? type : null;
}

export function settlementNotice(settlement: Pick<FlueConversationSettlement, 'outcome' | 'error'>): SettlementNotice {
	if (errorType(settlement.error) === 'submission_timeout') {
		return {
			kind: 'timeout',
			title: 'Caddie ran out of time on that request.',
			detail: 'A search or lookup took too long and was stopped. Nothing was lost — send your message again to retry.',
		};
	}
	if (settlement.outcome === 'aborted') {
		return {
			kind: 'cancelled',
			title: 'That request was stopped before Caddie finished.',
			detail: 'Nothing was lost — send your message again to continue.',
		};
	}
	return {
		kind: 'failed',
		title: 'Caddie hit a problem and could not finish that request.',
		detail: 'Your projects and files are safe. Send your message again, or ask Caddie what went wrong.',
	};
}
