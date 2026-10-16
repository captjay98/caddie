import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { ReactElement } from 'react';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { formatTimeAgo } from '@caddie/ui/time';
import { Mascot } from '@caddie/ui/Mascot';
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

/**
 * Plain-language pill text, by card kind + status. The raw contract status
 * (`needs-you`, `changed`, `handled`, `blocked`) is machine vocabulary and must
 * never reach the user — an approval that needs a decision reads "Plan ready",
 * not "needs-you". Falls back to a readable generic per status.
 */
export function statusLabel(card: DecisionCardType): string {
	if (card.status === 'blocked') return 'Needs attention';
	if (card.status === 'handled') return 'Done';
	if (card.status === 'changed') return 'Changes to review';
	// needs-you — word it for what the card is about.
	switch (card.kind) {
		case 'approval':
			return 'Plan ready';
		case 'deadline':
			return 'Deadline';
		case 'result':
			return 'Ready to try';
		default:
			return 'Needs you';
	}
}

export function DecisionCardView(props: {
	card: DecisionCardType;
	now?: Date;
	onAction?: (card: DecisionCardType) => void;
	/** Account-brief read marker: "seen" only records that the actor read the
	 *  card — it never resolves the underlying work (approved navigation). */
	seen?: boolean;
	/** Which project this card belongs to (v2 brief: no group headers, so the
	 *  card itself carries the context). */
	contextLabel?: string;
}): ReactElement {
	const { card } = props;
	const [detailOpen, setDetailOpen] = useState(false);
	return (
		<article
			className="decision-card card-surface"
			data-testid="decision-card"
			data-kind={card.kind}
			data-status={card.status}
			data-seen={props.seen === true ? 'true' : 'false'}
		>
			<div className="card-head">
				<p className="kind-kicker">
					{props.contextLabel ? <span className="card-context">{props.contextLabel} · </span> : null}
					{KIND_LABEL[card.kind]}
				</p>
				<span className="pill status-pill" data-status={card.status}>
					{statusLabel(card)}
				</span>
				{props.seen === false ? (
					<span className="pill status-pill" data-status="unseen" data-testid="card-unseen">
						new
					</span>
				) : null}
			</div>
			<h3>{card.headline}</h3>
			<p className="summary">{card.summary}</p>
			<div className="card-meta" data-testid="card-meta">
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
					{card.runId ? <span className="mono-id">run {card.runId}</span> : null}
					<span className="mono-id">
						evidence {card.evidenceIds.length > 0 ? card.evidenceIds.slice(0, 3).join(' · ') : 'none attached'}
						{card.evidenceIds.length > 3 ? ` · +${card.evidenceIds.length - 3} more` : ''}
					</span>
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
				onRetry={state.retry}
			/>
		);
	} else if (props.feedError) {
		content = (
			<StatePanel
				kind={failureKind(props.feedError)}
				detail={props.feedError instanceof Error ? props.feedError.message : undefined}
				onRetry={state.retry}
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
						<Link className="r-link" to="/" search={(prev: Record<string, unknown>) => ({ ...prev })} data-testid="brief-teach-channel">
							<Icon name="sparkCheck" title="start" /> Start with the Channel — your first message begins a run
						</Link>
					</div>
					<div className="actions">
						<Link className="r-link" to="/schedules" search={(prev: Record<string, unknown>) => ({ ...prev })} data-testid="brief-teach-schedules">
							<Icon name="calendar" title="arm" /> Or let Caddie watch a hackathon for you
						</Link>
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

/**
 * The ACCOUNT Brief lane (approved navigation 2026-10-09): the aggregated
 * feed across every authorised project, grouped per project, with per-actor
 * read state, freshness and the explicit mark-all-read action.
 *
 * Read semantics: opening this lane marks NOTHING read. A card is marked
 * read by its primary action (which first navigates to the exact work) or by
 * "Mark all read". Read state lives server-side per actor (brief_read_state)
 * and never resolves the underlying approval/schedule/artifact/preview.
 *
 * Empty states: a brand-new account (no builds) is taught what Brief will
 * contain with a discovery path; a returning account with nothing outstanding
 * gets a calm "you're caught up". Retrieval failure renders an explicit error
 * with retry; a stale refetch keeps the last known cards and says so.
 */
export function AccountBriefLane(props: {
	state: { kind: StateKind; error?: unknown; stale: boolean; retry: () => void };
	cards: readonly DecisionCardType[];
	projects: ReadonlyArray<{ id: string; name: string; kind?: string }>;
	asOf?: string;
	feedPending?: boolean;
	feedError?: unknown;
	hasBuildProjects: boolean;
	onAction?: (card: DecisionCardType) => void;
	onMarkAllRead?: () => void;
}): ReactElement {
	const { state, cards } = props;
	const retryable = state.kind === 'error' || state.kind === 'offline' || state.kind === 'limit';
	const unseenCount = cards.filter((card) => !card.seen).length;
	const waitingCount = cards.filter((card) => card.status === 'needs-you').length;
	const projectName = new Map(props.projects.map((project) => [project.id, project.name]));

	// Group cards by project, preserving the server's rank order within each.
	const groups: { projectId: string; cards: DecisionCardType[] }[] = [];
	for (const card of cards) {
		const group = groups.find((g) => g.projectId === card.projectId);
		if (group) group.cards.push(card);
		else groups.push({ projectId: card.projectId, cards: [card] });
	}

	let content: ReactElement;
	if (state.kind !== 'empty') {
		content = (
			<StatePanel
				kind={state.kind}
				detail={retryable && state.error instanceof Error ? state.error.message : undefined}
				onRetry={state.retry}
			/>
		);
	} else if (props.feedError) {
		content = (
			<StatePanel
				kind={failureKind(props.feedError)}
				detail={props.feedError instanceof Error ? props.feedError.message : undefined}
				onRetry={state.retry}
			/>
		);
	} else if (props.feedPending) {
		content = <StatePanel kind="loading" title="Reading updates across your projects…" />;
	} else if (cards.length === 0) {
		content = props.hasBuildProjects ? (
			<div className="card-stack" data-testid="brief-caught-up">
				<section className="decision-card card-surface">
					<div className="card-head">
						<p className="kind-kicker">BRIEF</p>
						<span className="pill status-pill" data-status="handled">
							caught up
						</span>
					</div>
					<h3>You're caught up</h3>
					<p className="summary">
						Nothing across your projects needs a decision right now. When an approval, a deadline, a
						preview or a blocker appears, it lands here with one clear action.
					</p>
				</section>
			</div>
		) : (
			<div className="card-stack" data-testid="brief-new-user">
				<section className="decision-card card-surface">
					<div className="card-head">
						<p className="kind-kicker">BRIEF · WHAT GOES HERE</p>
						<span className="pill status-pill" data-status="handled">
							waiting for your first build
						</span>
					</div>
					<h3>This is where decisions land</h3>
					<p className="summary">
						When Caddie finds a hackathon that fits you, drafts a plan for your approval, finishes a
						preview or gets blocked, it reports it here — one clear action per update, across every
						project. Start by finding something to build.
					</p>
					<div className="actions">
						<Link className="r-link" to="/discover" data-testid="brief-teach-discover">
							<Icon name="target" title="discover" /> Find a hackathon that fits you
						</Link>
					</div>
				</section>
			</div>
		);
	} else {
		content = (
			<div className="card-stack" data-testid="brief-groups">
				{groups.map((group) => (
					<div className="brief-group" key={group.projectId} data-testid={`brief-group-${group.projectId}`}>
						<p className="brief-group-head" data-testid="brief-group-name">
							{projectName.get(group.projectId) ?? group.projectId}
						</p>
						{group.cards.map((card) => (
							<DecisionCardView key={card.id} card={card} seen={card.seen} onAction={props.onAction} />
						))}
					</div>
				))}
			</div>
		);
	}

	return (
		<div data-testid="account-brief-lane">
			<div className="section-head">
				<h3>Brief</h3>
				<span className="count" data-testid="brief-count">
					{cards.length} update{cards.length === 1 ? '' : 's'}
					{waitingCount > 0 ? ` · ${waitingCount} waiting on you` : ''}
					{unseenCount > 0 ? ` · ${unseenCount} unseen` : ''}
				</span>
				{props.asOf ? (
					<span className="mono-id" data-testid="brief-asof">
						updated {formatTimeAgo(props.asOf)}
					</span>
				) : null}
				<StaleChip stale={state.stale} />
				{unseenCount > 0 && props.onMarkAllRead ? (
					<button
						type="button"
						className="detail-toggle"
						data-testid="brief-mark-all-read"
						onClick={props.onMarkAllRead}
					>
						Mark all read
					</button>
				) : null}
			</div>
			{content}
		</div>
	);
}

/**
 * The v2 Brief (Caddie v2, HANDOFF §4): date + one-line title from the caller,
 * then AT MOST THREE big cards (server order — never re-ranked here), deadlines
 * as coloured rows, and finished items folded under "Done · N".
 *
 * The card layout IS the ranking: open cards render in the server's order and
 * the first three non-deadline ones become the big cards. Nothing is promoted
 * or demoted on the client, and a deadline is never a big card — it's a row.
 */
export function AccountBriefV2(props: {
	state: { kind: StateKind; error?: unknown; stale: boolean; retry: () => void };
	cards: readonly DecisionCardType[];
	projects: ReadonlyArray<{ id: string; name: string; kind?: string }>;
	asOf?: string;
	feedPending?: boolean;
	feedError?: unknown;
	hasBuildProjects: boolean;
	onAction?: (card: DecisionCardType) => void;
	onMarkAllRead?: () => void;
	/** New-user teaching card actions (v2 empty Brief): the primary opens the
	 *  Caddie chat where "what to build" is decided; the ghost opens Discover. */
	onAskCaddie?: () => void;
	onBrowse?: () => void;
}): ReactElement {
	const { state, cards } = props;
	const retryable = state.kind === 'error' || state.kind === 'offline' || state.kind === 'limit';
	const projectName = new Map(props.projects.map((project) => [project.id, project.name]));

	if (state.kind !== 'empty' || props.feedError || props.feedPending) {
		let content: ReactElement;
		if (state.kind !== 'empty') {
			content = (
				<StatePanel
					kind={state.kind}
					detail={retryable && state.error instanceof Error ? state.error.message : undefined}
					onRetry={state.retry}
				/>
			);
		} else if (props.feedError) {
			content = (
				<StatePanel
					kind={failureKind(props.feedError)}
					detail={props.feedError instanceof Error ? props.feedError.message : undefined}
					onRetry={state.retry}
				/>
			);
		} else {
			content = <StatePanel kind="loading" title="Reading your brief…" />;
		}
		return <div data-testid="account-brief-lane">{content}</div>;
	}

	if (cards.length === 0) {
		return (
			<div data-testid="account-brief-lane">
				{props.hasBuildProjects ? (
					<div className="card-stack" data-testid="brief-caught-up">
						<section className="decision-card card-surface">
							<div className="card-head">
								<p className="kind-kicker">BRIEF</p>
								<span className="pill status-pill" data-status="handled">
									caught up
								</span>
							</div>
							<h3>Nothing needs you</h3>
							<p className="summary">
								When Caddie needs a decision, finishes something, or hits a blocker, it lands here
								with one clear action.
							</p>
						</section>
					</div>
				) : (
					<div className="card-stack" data-testid="brief-new-user">
						<section className="decision-card card-surface brief-teach brief-teach-quiet">
							<span className="brief-teach-mascot" aria-hidden="true">
								<Mascot mood="ready" size={44} live />
							</span>
							<p className="kind-kicker brief-teach-eyebrow">
								<Icon name="target" title="brief" /> BRIEF
							</p>
							<h3>Nothing needs you yet</h3>
							<p className="summary">
								Once you start a project with Caddie, the decisions it needs from you — plans to
								approve, previews to check, blockers to clear — land here, one at a time. Start in
								the chat.
							</p>
						</section>
					</div>
				)}
			</div>
		);
	}

	const open = cards.filter((card) => card.status !== 'handled');
	const done = cards.filter((card) => card.status === 'handled');
	const deadlineCards = open.filter((card) => card.kind === 'deadline');
	const bigCards = open.filter((card) => card.kind !== 'deadline').slice(0, 3);
	const unseenCount = cards.filter((card) => !card.seen).length;
	const waitingCount = cards.filter((card) => card.status === 'needs-you').length;

	return (
		<div data-testid="account-brief-lane">
			<div className="section-head brief-v2-head">
				<span className="count" data-testid="brief-count">
					{cards.length} update{cards.length === 1 ? '' : 's'}
					{waitingCount > 0 ? ` · ${waitingCount} waiting on you` : ''}
					{unseenCount > 0 ? ` · ${unseenCount} unseen` : ''}
				</span>
				{props.asOf ? (
					<span className="mono-id" data-testid="brief-asof">
						updated {formatTimeAgo(props.asOf)}
					</span>
				) : null}
				<StaleChip stale={state.stale} />
				{unseenCount > 0 && props.onMarkAllRead ? (
					<button type="button" className="detail-toggle" data-testid="brief-mark-all-read" onClick={props.onMarkAllRead}>
						Mark all read
					</button>
				) : null}
			</div>
			<div className="brief-v2">
				{bigCards.map((card) => (
					<DecisionCardView
						key={card.id}
						card={card}
						seen={card.seen}
						onAction={props.onAction}
						contextLabel={props.projects.length > 1 ? projectName.get(card.projectId) : undefined}
					/>
				))}

				{deadlineCards.length > 0 ? (
					<div className="brief-deadlines" data-testid="brief-deadlines">
						{deadlineCards.map((card) => (
							<div className="brief-deadline" key={card.id} data-testid="brief-deadline-row">
								<Icon name="calendar" title="Deadline" />
								<span className="brief-deadline-text">
									<b>{card.headline}</b>
									<span>
										{projectName.get(card.projectId) ?? card.projectId} · {card.summary}
									</span>
								</span>
								<button
									type="button"
									className="btn-ghost"
									data-testid="brief-deadline-action"
									onClick={() => props.onAction?.(card)}
								>
									{card.primaryAction.label}
								</button>
							</div>
						))}
					</div>
				) : null}

				{done.length > 0 ? (
					<details className="brief-done" data-testid="brief-done">
						<summary>
							Done · {done.length}
						</summary>
						<ul>
							{done.map((card) => (
								<li key={card.id} data-testid="brief-done-item">
									<b>{card.headline}</b> — {projectName.get(card.projectId) ?? card.projectId}
									{card.key ? null : null}
								</li>
							))}
						</ul>
					</details>
				) : null}

				{open.length === 0 ? (
					<p className="state-detail" data-testid="brief-all-done">
						You're caught up — everything below is finished.
					</p>
				) : null}
			</div>
		</div>
	);
}
