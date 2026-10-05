import { useState } from 'react';
import type { ReactElement } from 'react';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { formatTimeAgo } from '@caddie/ui/time';
import { StatePanel, StaleChip, failureKind, type StateKind } from '../states.tsx';

/**
 * The typed brief card — feature-ledger row C6 (ADAPT/IMPROVE).
 *
 * Rendered strictly from the frozen DecisionCard contract
 * (packages/contracts/src/index.ts): kind, status, headline, summary,
 * evidenceIds, updatedAt and primaryAction. The action's `targetId` is a
 * server-side id handed to `onAction` for authorized resolution — the UI
 * never parses display prose into an action or an identity.
 *
 * The summary sits behind a collapsible disclosure (design direction:
 * "collapsible detail"); the kicker/pill grammar ports the reference
 * TheCard channel hues mapped onto halo status tokens.
 */

const KIND_LABEL: Record<DecisionCardType['kind'], string> = {
	approval: 'Approval · Needs a decision',
	change: 'Change · What moved',
	deadline: 'Clock · Deadline',
	result: 'Result · Verified output',
};

export function DecisionCardView(props: {
	card: DecisionCardType;
	now?: Date;
	onAction?: (card: DecisionCardType) => void;
}): ReactElement {
	const { card } = props;
	const [detailOpen, setDetailOpen] = useState(false);
	return (
		<article className="decision-card card-surface" data-testid="decision-card" data-kind={card.kind}>
			<div className="card-head">
				<p className="kind-kicker">{KIND_LABEL[card.kind]}</p>
				<span className="pill status-pill" data-status={card.status}>
					{card.status}
				</span>
			</div>
			<h3>{card.headline}</h3>
			<p className="summary">{card.summary}</p>
			<div className="actions">
				<button
					type="button"
					className="btn-key"
					data-testid="card-primary-action"
					data-action-kind={card.primaryAction.kind}
					onClick={() => props.onAction?.(card)}
				>
					{card.primaryAction.label}
				</button>
				<button
					type="button"
					className="detail-toggle"
					aria-expanded={detailOpen}
					data-testid="card-detail-toggle"
					onClick={() => setDetailOpen((open) => !open)}
				>
					{detailOpen ? 'Hide details' : 'Details'}
				</button>
				<span className="mono-id">updated {formatTimeAgo(card.updatedAt, props.now)}</span>
			</div>
			{detailOpen ? (
				<div className="card-details" data-testid="card-details">
					<span className="mono-id">card {card.id}</span>
					<span className="mono-id">
						{card.runId ? `run ${card.runId} · ` : ''}project {card.projectId}
					</span>
					<span className="mono-id">
						evidence: {card.evidenceIds.length > 0 ? card.evidenceIds.join(', ') : 'none attached'}
					</span>
					<span className="mono-id">
						action → {card.primaryAction.kind} ({card.primaryAction.targetId})
					</span>
				</div>
			) : null}
		</article>
	);
}

/**
 * The Brief lane: explicit states first, typed cards underneath. Cards arrive
 * through the props-driven brief store — the run transport that produces them
 * lands in P05, so the composed build shows the honest empty state.
 */
export function BriefLane(props: {
	state: { kind: StateKind; error?: unknown; stale: boolean; retry: () => void };
	cards: readonly DecisionCardType[];
	onAction?: (card: DecisionCardType) => void;
	onStartFirstRun?: () => void;
}): ReactElement {
	const { state } = props;
	const retryable = state.kind === 'error' || state.kind === 'offline' || state.kind === 'limit';
	let content: ReactElement;
	if (state.kind !== 'empty') {
		content = (
			<StatePanel
				kind={state.kind}
				detail={retryable && state.error instanceof Error ? state.error.message : undefined}
				onRetry={retryable ? state.retry : undefined}
			/>
		);
	} else if (props.cards.length === 0) {
		content = (
			<StatePanel
				kind="empty"
				title="No decisions need you yet"
				detail="Briefs land here the moment a run produces a decision, a change or a verified result."
			/>
		);
	} else {
		content = (
			<div className="card-stack">
				{props.cards.map((card) => (
					<DecisionCardView key={card.id} card={card} onAction={props.onAction} />
				))}
			</div>
		);
	}
	return (
		<div data-testid="brief-lane">
			<div className="section-head">
				<h3>Brief</h3>
				<StaleChip stale={state.stale} />
			</div>
			{content}
		</div>
	);
}
