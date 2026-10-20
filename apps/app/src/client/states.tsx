import type { ReactElement } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ApiError, type FailureKind } from './api.ts';
import { Icon, type IconName } from './icons.tsx';
import { Mascot } from '@caddie/ui/Mascot';

/**
 * Explicit state surfaces — the P06 acceptance grammar: loading, empty,
 * stale, denied, error, offline and limit states are first-class renderable
 * panels, never silent blanks. One shared visual grammar, token-only.
 *
 * v2 (HANDOFF §3.8): loading shows the "thinking" character and a specific
 * line; error shows the "stuck" character, "Your work is safe — this is only
 * the connection", "Try again now" and "Ask Caddie what happened". Page titles
 * and project steps stay real above the panel — pages render those outside
 * the state surface, and only the content below is replaced.
 *
 * `data-state` + `data-testid="state-<kind>"` make every state assertable
 * from browser specs without touching internals.
 */

export type StateKind = 'loading' | 'empty' | 'denied' | 'limit' | 'offline' | 'error';

const COPY: Record<StateKind, { kicker: string; title: string }> = {
	loading: { kicker: 'LOADING', title: 'Fetching the latest state…' },
	empty: { kicker: 'NOTHING YET', title: 'Nothing here yet' },
	denied: { kicker: 'DENIED', title: 'This is not available to your account' },
	limit: { kicker: 'LIMIT', title: 'A limit was reached' },
	offline: { kicker: 'OFFLINE', title: 'You appear to be offline' },
	error: { kicker: 'FAULT', title: 'Something went wrong' },
};

/** Map a thrown failure to an explicit renderable state kind. */
export function failureKind(error: unknown): StateKind {
	if (error instanceof ApiError) return error.kind;
	return 'error';
}

/** The character mood for a state kind (§3.8) — real state only. */
function stateMood(kind: StateKind): 'thinking' | 'stuck' | undefined {
	if (kind === 'loading') return 'thinking';
	if (kind === 'error' || kind === 'offline') return 'stuck';
	return undefined;
}

export function StatePanel(props: {
	kind: StateKind;
	title?: string;
	detail?: string;
	onRetry?: () => void;
	retryLabel?: string;
	busy?: boolean;
	/** Bare variant for use INSIDE another card: no own card surface, so a
	    section never renders a card inside a card (owner steering, 2026-10-15). */
	flat?: boolean;
	/** false where the conversation cannot be reached either (the app opened
	    with no connection): "Ask Caddie what happened" would be a dead end. */
	askCaddie?: boolean;
}): ReactElement {
	const { kind } = props;
	const copy = COPY[kind];
	const retryable = Boolean(props.onRetry) && kind !== 'loading' && kind !== 'empty';
	const mood = stateMood(kind);
	return (
		<section
			className={props.flat ? 'state-panel state-panel-flat' : 'state-panel card-surface'}
			data-state={kind}
			data-testid={`state-${kind}`}
			aria-busy={kind === 'loading' || props.busy ? true : undefined}
		>
			{mood ? (
				<span className="state-mascot" aria-hidden="true">
					<Mascot mood={mood} size={44} />
				</span>
			) : null}
			<p className="kicker" data-tone={kind === 'empty' ? 'action' : kind}>
				{copy.kicker}
			</p>
			<h3 className="state-title">{props.title ?? copy.title}</h3>
			{props.detail ? <p className="state-detail">{props.detail}</p> : null}
			{kind === 'loading' || props.busy ? (
				<div className="state-skeleton" aria-hidden="true">
					<span />
					<span />
					<span />
				</div>
			) : null}
			{retryable ? (
				<button
					type="button"
					className="btn-ghost"
					data-testid={`state-retry-${kind}`}
					onClick={props.onRetry}
				>
					{props.retryLabel ?? 'Try again now'}
				</button>
			) : null}
			{(kind === 'error' || kind === 'offline') && retryable ? (
				<>
					<p className="state-detail" data-testid="state-safety-note">
						Your work is safe — this is only the connection.
					</p>
					{props.askCaddie === false ? null : <AskCaddieWhatHappened />}
				</>
			) : null}
			{kind === 'denied' ? (
				<p className="state-detail">
					Sign in with an account that has access, then reload.
				</p>
			) : null}
		</section>
	);
}

/**
 * "Ask Caddie what happened" (§3.8): opens the conversation pane, where the
 * user can ask about the failure — on desktop this is the full-screen chat,
 * on mobile the Caddie tab. The question itself is left to the user; this
 * control never fabricates a Caddie reply.
 */
function AskCaddieWhatHappened(): ReactElement {
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as Record<string, unknown>;
	return (
		<button
			type="button"
			className="btn-ghost"
			data-testid="state-ask-caddie"
			onClick={() => {
				void navigate({ to: '.', search: { ...search, pane: 'channel' } });
			}}
		>
			Ask Caddie what happened
		</button>
	);
}

/**
 * TeachingEmpty — a rich, non-dead-end empty state: an icon, a title, one
 * plain sentence explaining what the section is FOR, and an optional action.
 * Used where "nothing yet" should still teach and offer the way in (Tasks,
 * Routines, What Caddie knows) instead of a bare grey line. Flat by default so
 * it sits inside a section without nesting a card in a card.
 */
export function TeachingEmpty(props: {
	icon: IconName;
	title: string;
	detail: string;
	action?: { label: string; onClick: () => void; testid?: string };
	testid?: string;
}): ReactElement {
	return (
		<div className="teaching-empty" data-testid={props.testid}>
			<span className="teaching-empty-icon" aria-hidden="true">
				<Icon name={props.icon} title="" />
			</span>
			<p className="teaching-empty-title">{props.title}</p>
			<p className="teaching-empty-detail">{props.detail}</p>
			{props.action ? (
				<button
					type="button"
					className="btn-key"
					data-testid={props.action.testid}
					onClick={props.action.onClick}
				>
					{props.action.label}
				</button>
			) : null}
		</div>
	);
}

/**
 * Stale indicator: rendered alongside live data while a refetch is in flight
 * (query.isFetching after the first load). The visible old data stays — the
 * refresh is announced, never silently swapped.
 */
export function StaleChip({ stale }: { stale: boolean }): ReactElement | null {
	if (!stale) return null;
	return (
		<span className="stale-chip" role="status" data-testid="stale-chip">
			refreshing…
		</span>
	);
}

/** The pages that load in their own shape (plan 5.6). */
export type SkeletonPage = 'home' | 'projects' | 'plan' | 'build';

const Bar = (props: { kind: string }) => <span className={`skel ${props.kind}`} />;

/** A card of placeholder lines: kicker, title, two lines, a button. */
function SkelCard(props: { lines?: number; button?: boolean }): ReactElement {
	return (
		<div className="card-surface skel-card">
			<Bar kind="skel-kicker" />
			<Bar kind="skel-title" />
			{Array.from({ length: props.lines ?? 2 }, (_, i) => (
				<Bar key={i} kind={i === (props.lines ?? 2) - 1 ? 'skel-text skel-short' : 'skel-text'} />
			))}
			{props.button === false ? null : <Bar kind="skel-button" />}
		</div>
	);
}

/** A list card of placeholder rows (a title and a line, a dot or a button). */
function SkelRows(props: { rows: number; lead?: 'dot'; trail?: 'button' }): ReactElement {
	return (
		<div className="card-surface skel-list">
			{Array.from({ length: props.rows }, (_, i) => (
				<div key={i} className="skel-row">
					{props.lead === 'dot' ? <Bar kind="skel-dot" /> : null}
					<span className="skel-row-text">
						<Bar kind="skel-title" />
						<Bar kind="skel-text skel-short" />
					</span>
					{props.trail === 'button' ? <Bar kind="skel-button" /> : null}
				</div>
			))}
		</div>
	);
}

const SHAPES: Record<SkeletonPage, () => ReactElement> = {
	// Home: the Brief's cards.
	home: () => (
		<>
			<SkelCard />
			<SkelCard />
			<SkelCard lines={1} />
		</>
	),
	// Projects: the list of projects, each with its next step.
	projects: () => <SkelRows rows={4} trail="button" />,
	// Plan: the decision bar, then the plan itself.
	plan: () => (
		<>
			<SkelCard lines={2} />
			<SkelCard lines={5} button={false} />
		</>
	),
	// Build: the build's status, then its stages.
	build: () => (
		<>
			<SkelCard lines={1} />
			<SkelRows rows={5} lead="dot" />
		</>
	),
};

/**
 * A loading placeholder shaped like the page that is on its way (plan 5.6):
 * the same cards and rows in the same places, so nothing jumps when the page
 * arrives. The thinking character and one specific line say what is loading
 * (the U03 loading grammar); the blocks are decoration for screen readers.
 */
export function PageSkeleton(props: { page: SkeletonPage; label: string }): ReactElement {
	return (
		<div className="page-skeleton" data-testid={`page-skeleton-${props.page}`} data-state="loading" aria-busy="true">
			<div className="page-skeleton-head">
				<span className="state-mascot" aria-hidden="true">
					<Mascot mood="thinking" size={22} />
				</span>
				<p className="page-skeleton-line" role="status">
					{props.label}
				</p>
			</div>
			<div className="page-skeleton-blocks" aria-hidden="true">
				{SHAPES[props.page]()}
			</div>
		</div>
	);
}
