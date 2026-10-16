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
					<AskCaddieWhatHappened />
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
