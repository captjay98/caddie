import { useState } from 'react';
import type { ReactElement } from 'react';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { formatTimeAgo } from '@caddie/ui/time';
import { StatePanel, StaleChip, failureKind, type StateKind } from '../states.tsx';
import { Icon } from '../icons.tsx';

/**
 * The typed brief card — feature-ledger row C6 (ADAPT/IMPROVE).
 *
 * Rendered strictly from the frozen DecisionCard contract
 * (packages/contracts/src/index.ts): kind, status, headline, summary,
 * evidenceIds, updatedAt and primaryAction. The action's `targetId` is a
 * server-side id handed to `onAction` for authorized resolution — the UI
 * never parses display prose into an action or an identity.
 *
 * UI review board screen 06: the audit trail (run + evidence ids) is promoted
 * into the card body instead of hiding behind the details toggle; the toggle
 * keeps the card/project/action identifiers. The summary carries the
 * "Approving this authorises …" scope inline on approval cards.
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
		<article className="decision-card card-surface" data-testid="decision-card" data-kind={card.kind} data-status={card.status}>
			<div className="card-head">
				<p className="kind-kicker">{KIND_LABEL[card.kind]}</p>
				<span className="pill status-pill" data-status={card.status}>
					{card.status}
				</span>
			</div>
			<h3>{card.headline}</h3>
			<p className="summary">{card.summary}</p>
			<div className="card-meta" data-testid="card-meta">
				{card.runId ? <span className="mono-id">run {card.runId}</span> : null}
				<span className="mono-id">
					evidence {card.evidenceIds.length > 0 ? card.evidenceIds.slice(0, 3).join(' · ') : 'none attached'}
					{card.evidenceIds.length > 3 ? ` · +${card.evidenceIds.length - 3} more` : ''}
				</span>
				<span className="mono-id">updated {formatTimeAgo(card.updatedAt, props.now)}</span>
			</div>
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
					{detailOpen ? 'Hide audit trail' : 'Audit trail'}
				</button>
			</div>
			{detailOpen ? (
				<div className="card-details" data-testid="card-details">
					<span className="mono-id">card {card.id}</span>
					<span className="mono-id">project {card.projectId}</span>
					<span className="mono-id">
						action → {card.primaryAction.kind} ({card.primaryAction.targetId})
					</span>
				</div>
			) : null}
		</article>
	);
}

/**
 * The Brief lane: explicit states first, typed cards underneath. Cards come
 * from the real brief feed (`GET /api/projects/:id/brief`, phase 2) — the
 * lane is never hand-wired empty. An empty feed teaches the loop instead of
 * looking broken (board screen 05).
 */
export function BriefLane(props: {
	state: { kind: StateKind; error?: unknown; stale: boolean; retry: () => void };
	cards: readonly DecisionCardType[];
	feedPending?: boolean;
	feedError?: unknown;
	onAction?: (card: DecisionCardType) => void;
}): ReactElement {
	const { state } = props;
	const retryable = state.kind === 'error' || state.kind === 'offline' || state.kind === 'limit';
	const waitingCount = props.cards.filter((card) => card.status === 'needs-you').length;
	let content: ReactElement;
	if (state.kind !== 'empty') {
		content = (
			<StatePanel
				kind={state.kind}
				detail={retryable && state.error instanceof Error ? state.error.message : undefined}
				onRetry={retryable ? state.retry : undefined}
			/>
		);
	} else if (props.feedError) {
		content = (
			<StatePanel
				kind={failureKind(props.feedError)}
				detail={props.feedError instanceof Error ? props.feedError.message : undefined}
			/>
		);
	} else if (props.feedPending) {
		content = <StatePanel kind="loading" title="Reading the project's brief…" />;
	} else if (props.cards.length === 0) {
		content = (
			<div className="card-stack" data-testid="brief-empty-teaching">
				<section className="decision-card card-surface" data-kind="approval">
					<div className="card-head">
						<p className="kind-kicker">BRIEF · WHAT GOES HERE</p>
						<span className="pill status-pill" data-status="handled">
							all clear
						</span>
					</div>
					<h3>You're all set — nothing needs you right now</h3>
					<p className="summary">
						This is where Caddie asks for your OK before it builds, and where it reports what it
						finished. Nothing here yet? Say hello in the Channel — your first message gets a plan
						drafted for you.
					</p>
					<div className="actions">
						<a className="r-link" href="./" data-testid="brief-teach-channel">
							<Icon name="sparkCheck" title="start" /> Start with the Channel — your first message begins a run
						</a>
					</div>
					<div className="actions">
						<a className="r-link" href="./schedules" data-testid="brief-teach-schedules">
							<Icon name="calendar" title="arm" /> Or let Caddie watch a hackathon for you
						</a>
					</div>
				</section>
			</div>
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
				<span className="count" data-testid="brief-count">
					{props.cards.length} decisions · {waitingCount} waiting on you
				</span>
				<StaleChip stale={state.stale} />
			</div>
			{content}
		</div>
	);
}
