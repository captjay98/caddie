import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { ReactElement } from 'react';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { formatTimeAgo } from '@caddie/ui/time';
import { Mascot } from '@caddie/ui/Mascot';
import { PageSkeleton, StatePanel, StaleChip, failureKind, type StateKind } from '../states.tsx';
import { Icon } from '../icons.tsx';
import { DecisionHistory } from './DecisionHistory.tsx';
import { CardHeader, CardPanel, BuildRail, CardFooter } from './CardFrame.tsx';
import { cardDesign, CARD_DESIGNS } from './card-design.ts';

/**
 * The typed brief card — feature-ledger row C6 (ADAPT/IMPROVE).
 *
 * Rendered strictly from the frozen DecisionCard contract
 * (packages/contracts/src/index.ts): kind, status, headline, summary,
 * evidenceIds, updatedAt and primaryAction. The action's `targetId` is a
 * server-side id handed to `onAction` for authorized resolution — the UI
 * never parses display prose into an action or an identity.
 *
 * UI review board screen 06, reworded by plan 5.5: "Details" say in words
 * what the card rests on and what its button does; the run, evidence, card,
 * project and action ids fold under "For developers". The summary carries the
 * "Approving this authorises …" scope inline on approval cards.
 */

/** What a card's button does, in words (plan 5.5). */
const ACTION_WORDS: Record<DecisionCardType['primaryAction']['kind'], string> = {
	review: 'opens it for you to review; nothing changes until you decide.',
	inspect: 'opens what happened so you can look before deciding.',
	preview: 'opens the app so you can try it.',
};

/**
 * The secondary (ghost) button's label per design (mockup `cc-secondary`). It
 * opens the same Details disclosure the card already carries — the mockup's
 * second button reveals a detail panel, it does not start a new action — so
 * behaviour is unchanged and only the affordance now reads like the mockup.
 * A design with no standing secondary (earlier/update) returns null and the
 * card shows the quiet Details toggle instead.
 */
function secondaryLabel(design: ReturnType<typeof cardDesign>): string | null {
	switch (design) {
		case 'plan': return 'Read the plan';
		case 'build': return 'Stop build';
		case 'repair': return 'See what happened';
		case 'preview': return 'Ask for changes';
		case 'deadline': return 'View deadline source';
		case 'opportunity': return 'Save for later';
		default: return null;
	}
}

/** What a card rests on, in words (plan 5.5); the ids stay for developers. */
function evidenceWords(count: number): string {
	if (count === 0) return 'No evidence is attached yet.';
	return `It rests on ${count} ${count === 1 ? 'piece' : 'pieces'} of evidence.`;
}

/**
 * The footer reassurance line (mockup `cc-bottom`, right side), by design. It
 * is derived from the card's design alone — no new data — and states the one
 * thing the mockup keeps bottom-right: that opening the card commits nothing.
 * A design with no standing reassurance returns null and the footer note is
 * omitted.
 */
function footerNote(design: ReturnType<typeof cardDesign>): string | null {
	switch (design) {
		case 'plan':
			return 'Nothing starts until you approve.';
		case 'build':
			return 'Preview appears after the checks pass.';
		case 'repair':
			return 'Preview held until the checks pass.';
		case 'preview':
			return 'Publishing is a separate decision.';
		case 'deadline':
			return 'Deadline linked to its source.';
		case 'opportunity':
			return 'Reviewing or saving does not start a build.';
		default:
			return null;
	}
}

/**
 * Plain-language pill text, by card kind + status. The raw contract status
 * (`needs-you`, `changed`, `handled`, `blocked`) is machine vocabulary and must
 * never reach the user — an approval that needs a decision reads "Plan ready",
 * not "needs-you". Falls back to a readable generic per status.
 */
export function statusLabel(card: DecisionCardType): string {
	// A schedule card (not a hackathon) never wears a Deadline badge.
	if (card.kind === 'deadline' && card.schedule) return 'Scheduled';
	if (cardDesign(card) === 'build') return 'In progress';
	if (cardDesign(card) === 'repair') return 'I’m on it';
	if (card.status === 'blocked') return 'Needs attention';
	if (cardDesign(card) === 'preview') return 'Ready to try';
	if (cardDesign(card) === 'opportunity') return 'Worth a look';
	if (card.kind === 'deadline') return 'Deadline';
	if (card.status === 'handled') return 'Done';
	if (card.status === 'changed') return 'Changes to review';
	// needs-you — word it for what the card is about.
	switch (card.kind) {
		case 'approval':
			return 'Needs you';
		case 'result':
			return 'Ready to try';
		default:
			return 'Needs you';
	}
}

/** Build-feed state label (mockup "Built"/"Building"/"Waiting"). */
const BUILD_STATE_LABEL = { built: 'Built', building: 'Building', waiting: 'Waiting' } as const;

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
	const design = cardDesign(card);
	const [detailOpen, setDetailOpen] = useState(false);
	const secondary = secondaryLabel(design);
	// Earlier/history gets its own compact layout (mockup 7), not the big card.
	if (design === 'earlier') {
		return (
			<article
				className="decision-card card-surface caddie-card"
				data-testid="decision-card"
				data-kind={card.kind}
				data-design={design}
				data-tone={CARD_DESIGNS[design].tone}
				data-status={card.status}
				data-seen={props.seen === true ? 'true' : 'false'}
			>
				<div className="compact-card-history-head">
					<h3>Earlier</h3>
					{props.contextLabel ? <span className="compact-card-history-label" data-testid="card-foot-subject">{props.contextLabel} · {formatTimeAgo(card.updatedAt, props.now)}</span> : <span className="compact-card-history-label">{formatTimeAgo(card.updatedAt, props.now)}</span>}
				</div>
				<div className="compact-card-record">
					<span className="compact-card-record-mark" aria-hidden="true"><Icon name="check" title="" /></span>
					<div className="compact-card-record-body">
						<h4>{card.headline}</h4>
						<p>{card.summary}</p>
						<button type="button" className="detail-toggle" data-testid="card-primary-action" onClick={() => props.onAction?.(card)}>{card.primaryAction.label}</button>
					</div>
					<time>{formatTimeAgo(card.updatedAt, props.now)}</time>
				</div>
				<div className="compact-card-foot" data-testid="card-foot">
					<span className="compact-card-foot-subject">1 completed update</span>
					<span className="compact-card-foot-note">Read-only history</span>
				</div>
			</article>
		);
	}
	return (
		<article
			className="decision-card card-surface caddie-card"
			data-testid="decision-card"
			data-kind={card.kind}
            data-design={design}
            data-tone={CARD_DESIGNS[design].tone}
			data-status={card.status}
			data-seen={props.seen === true ? 'true' : 'false'}
		>
            <CardHeader design={design} context={props.contextLabel} status={statusLabel(card)} fresh={props.seen === false} freshLabel={formatTimeAgo(card.updatedAt, props.now)} />
            {props.seen === false ? <span className="sr-only" data-testid="card-unseen">New</span> : null}
			<h3>{card.headline}</h3>
			{/* The lede (mockup `cc-copy`) sits under the title on every big card;
			    the plan's feature list follows in its own panel. */}
			<p className="summary">{card.summary}</p>
			{design === 'plan' && card.planItems && card.planItems.length > 0 ? (
				<CardPanel title="What you’re approving">
					<ul className="compact-card-list" data-testid="card-plan-items">
						{card.planItems.map((item, index) => (
							<li key={index} className="compact-card-list-row">
								<span className="compact-card-list-mark" aria-hidden="true"><Icon name="check" title="" /></span>
								<span className="compact-card-list-text">
									<strong>{item.title}</strong>
									{item.detail ? <small>{item.detail}</small> : null}
								</span>
							</li>
						))}
					</ul>
				</CardPanel>
			) : null}
			{design === 'build' ? (
				<>
					<BuildRail design={design} />
					{card.build ? (
					<>
					<div className="compact-card-panel">
						{card.build.current ? (
							<div className="compact-card-active">
								<span className="compact-card-icon" aria-hidden="true"><Icon name="play" title="" /></span>
								<h4 data-testid="card-build-current">Now: {card.build.current}</h4>
							</div>
						) : null}
						<div className="compact-card-feed" data-testid="card-build-feed">
							{card.build.features.map((feature, index) => (
								<div key={index} className="compact-card-feed-row" data-state={feature.state} data-testid="card-build-feed-row">
									<span className="compact-card-icon" aria-hidden="true"><Icon name={feature.state === 'built' ? 'check' : feature.state === 'building' ? 'play' : 'clock'} title="" /></span>
									<span>{feature.title}</span>
									<span className="compact-card-feed-state">{BUILD_STATE_LABEL[feature.state]}</span>
								</div>
							))}
						</div>
					</div>
					<p className="compact-card-live" data-testid="card-build-update">
						<span className="compact-card-icon" aria-hidden="true"><Icon name="refresh" title="" /></span>
						<span>Last update {card.build.lastUpdatedAt ? formatTimeAgo(card.build.lastUpdatedAt, props.now) : 'just now'} · {card.build.builtCount} {card.build.builtCount === 1 ? 'feature' : 'features'} built</span>
					</p>
					</>
					) : (
						<p className="compact-card-note"><span className="compact-card-icon" aria-hidden="true"><Icon name="info" title="" /></span><span>Preview appears after the checks pass.</span></p>
					)}
				</>
			) : null}
			{design === 'repair' ? (
				<>
					{card.repair ? (
						<div className="compact-card-repair" data-testid="card-repair">
							<h4>What needs fixing</h4>
							<p>{card.repair.expectation}</p>
						</div>
					) : null}
					{card.checks || card.repair?.fixing ? (
						<div className="compact-card-panel">
							<div className="compact-card-active">
								<span className="compact-card-pulse" aria-hidden="true" />
								{/* The feature from the build record, never mockup text. */}
								<h4 data-testid="card-repair-now">{card.repair?.fixing ? `Now fixing: ${card.repair.fixing}` : 'Fixing it now'}</h4>
							</div>
							{card.checks ? (
								<p className="compact-card-fix" data-testid="card-repair-fix">
									<span className="compact-card-icon" aria-hidden="true"><Icon name="check" title="" /></span>
									{/* It counts passed features, so it says features. */}
									<span>{card.checks.passed} {card.checks.passed === 1 ? 'feature passed' : 'features passed'}</span>
									<span>·</span>
									<span>1 being repaired</span>
								</p>
							) : null}
						</div>
					) : null}
					<p className="compact-card-note" data-testid="card-repair-reassure">
						<span className="compact-card-icon" aria-hidden="true"><Icon name="send" title="" /></span>
						<span>You don’t need to do anything. I’ll run the checks again after the fix.</span>
					</p>
				</>
			) : null}
            {card.deadline ? (
                <>
                <div className="compact-card-countdown" data-testid="card-countdown">
                    <div className="compact-card-days">
                        <b data-testid="card-days-left">{card.deadline.daysLeft}</b>
                        <span>{card.deadline.daysLeft === 1 ? 'day left' : 'days left'}</span>
                    </div>
                    <div className="compact-card-when">
                        <strong>{card.deadline.dateLabel}</strong>
                        {card.deadline.localTimeLabel ? <p data-testid="card-local-time">{card.deadline.localTimeLabel} · Your local time</p> : null}
                        {card.deadline.source ? <p className="compact-card-when-source">{card.deadline.source}</p> : null}
                    </div>
                </div>
                {card.deadline.steps && card.deadline.steps.length > 0 ? (
                    <ul className="compact-card-steps" data-testid="card-deadline-steps">
                        {card.deadline.steps.map((step, index) => (
                            <li key={index} data-done={step.done ? 'true' : 'false'}>
                                <span className="compact-card-icon" aria-hidden="true"><Icon name={step.done ? 'check' : 'clock'} title="" /></span>
                                <span><strong>{step.title}</strong>{step.detail ? <small>{step.detail}</small> : null}</span>
                            </li>
                        ))}
                    </ul>
                ) : null}
                </>
            ) : null}
            {card.schedule ? (
                <p className="compact-card-note" data-testid="card-schedule"><span className="compact-card-icon" aria-hidden="true"><Icon name="calendar" title="" /></span><span>{card.schedule.name} runs next {card.schedule.nextRunLabel}.</span></p>
            ) : null}
            {card.fit && (card.fit.reasons.length > 0 || card.fit.cautions.length > 0) ? (
                <div className="compact-card-split" data-testid="card-fit">
                    {card.fit.reasons.length > 0 ? (
                        <CardPanel title="Why it fits">
                            <ul className="compact-card-notes" data-testid="card-fit-reasons">
                                {card.fit.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
                            </ul>
                        </CardPanel>
                    ) : null}
                    {card.fit.cautions.length > 0 ? (
                        <CardPanel title="Before you commit" tone="caution">
                            <ul className="compact-card-notes" data-testid="card-fit-cautions">
                                {card.fit.cautions.map((caution, index) => <li key={index}>{caution}</li>)}
                            </ul>
                        </CardPanel>
                    ) : null}
                </div>
            ) : null}
            {design === 'preview' && card.checks ? (
                <div className="compact-card-chips" data-testid="card-checks">
                    <span className="compact-card-chip compact-card-chip-ok">
                        <b aria-hidden="true">✓</b> All {card.checks.passed} {card.checks.passed === 1 ? 'feature passed its check' : 'features passed their checks'}
                    </span>
                    {card.checks.version ? <span className="compact-card-chip" data-testid="card-check-version">Version {card.checks.version}</span> : null}
                </div>
            ) : null}
            {card.nextStep ? (
                <p className="compact-card-note" data-testid="card-next-step"><span className="compact-card-icon" aria-hidden="true"><Icon name="send" title="" /></span><span>{card.nextStep}</span></p>
            ) : null}
			{design === 'build' || design === 'repair' ? (
				// A card where Caddie is working gets NO filled CTA (mockup): the
				// navigate action is a light bordered button, and "Stop build" is
				// text-only and quiet. Neither takes the card hue fill.
				<div className="actions">
					<button
						type="button"
						className="btn-ghost"
						data-testid="card-primary-action"
						data-action-kind={card.primaryAction.kind}
						onClick={() => props.onAction?.(card)}
					>
						{design === 'repair' ? 'See what happened' : card.primaryAction.label}
					</button>
					<button
						type="button"
						className="detail-toggle compact-card-quiet"
						aria-expanded={detailOpen}
						data-testid="card-secondary-action"
						onClick={() => setDetailOpen((open) => !open)}
					>
						Stop build
					</button>
				</div>
			) : (
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
				{secondary ? (
					<button
						type="button"
						className="btn-ghost"
						aria-expanded={detailOpen}
						data-testid="card-secondary-action"
						onClick={() => setDetailOpen((open) => !open)}
					>
						{secondary}
					</button>
				) : (
					<button
						type="button"
						className="detail-toggle"
						aria-expanded={detailOpen}
						data-testid="card-detail-toggle"
						onClick={() => setDetailOpen((open) => !open)}
					>
						{detailOpen ? 'Hide details' : 'Details'}
					</button>
				)}
			</div>
			)}
			{detailOpen ? (
				<div className="card-details" data-testid="card-details">
					<ul className="card-details-words" data-testid="card-details-words">
						<li>{evidenceWords(card.evidenceIds.length)}</li>
						<li>
							“{card.primaryAction.label}” {ACTION_WORDS[card.primaryAction.kind]}
						</li>
					</ul>
					<details className="ev-devdetail" data-testid="card-details-dev">
						<summary className="kicker">For developers — record ids</summary>
						<div className="card-details-ids">
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
					</details>
				</div>
			) : null}
			<CardFooter subject={props.contextLabel} note={footerNote(design) ?? undefined} app={card.footer?.appName} version={card.footer?.version} />
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
		if (state.kind === 'loading') {
			content = <PageSkeleton page="home" label="Reading your brief…" />;
		} else if (state.kind !== 'empty') {
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
			content = <PageSkeleton page="home" label="Reading your brief…" />;
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
                        <details className="brief-done"><summary>Earlier decisions</summary><DecisionHistory existingIds={[]} names={projectName} onAction={props.onAction} /></details>
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
								approve, previews to check, blockers to clear — land here, one at a time.
							</p>
                            <div className="actions"><button type="button" className="btn-key" onClick={props.onAskCaddie}>Start with Caddie</button><button type="button" className="btn-ghost" onClick={props.onBrowse}>Find a hackathon</button></div>
						</section>
					</div>
				)}
			</div>
		);
	}

	const open = cards.filter((card) => card.status !== 'handled' || ['preview', 'opportunity'].includes(cardDesign(card)));
	const done = cards.filter((card) => card.status === 'handled' && !['deadline', 'preview', 'opportunity'].includes(cardDesign(card)));
	const deadlineCards = cards.filter((card) => card.kind === 'deadline');
	const bigCards = open.filter((card) => card.kind !== 'deadline');
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

                {deadlineCards.length > 0 ? <div className="brief-deadlines" data-testid="brief-deadlines">{deadlineCards.map(card => <div key={card.id} data-testid="brief-deadline-row"><DecisionCardView card={card} seen={card.seen} contextLabel={projectName.get(card.projectId)} onAction={props.onAction} /></div>)}</div> : null}

				{done.length > 0 || props.hasBuildProjects ? (
					<details className="brief-done" data-testid="brief-done">
						<summary>
							Earlier · {done.length}
						</summary>
						<ul>
                            {done.map(card => <li key={card.id} data-testid="brief-done-item"><DecisionCardView card={card} seen={card.seen} contextLabel={projectName.get(card.projectId)} onAction={props.onAction} /></li>)}
                        </ul>
                        <DecisionHistory existingIds={done.map(card => card.id)} names={projectName} onAction={props.onAction} />
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
