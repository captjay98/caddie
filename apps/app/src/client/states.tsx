import type { ReactElement } from 'react';
import { ApiError, type FailureKind } from './api.ts';

/**
 * Explicit state surfaces — the P06 acceptance grammar: loading, empty,
 * stale, denied, error, offline and limit states are first-class renderable
 * panels, never silent blanks. One shared visual grammar, token-only.
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

export function StatePanel(props: {
	kind: StateKind;
	title?: string;
	detail?: string;
	onRetry?: () => void;
	retryLabel?: string;
	busy?: boolean;
}): ReactElement {
	const { kind } = props;
	const copy = COPY[kind];
	const retryable = Boolean(props.onRetry) && kind !== 'loading' && kind !== 'empty';
	return (
		<section
			className="state-panel card-surface"
			data-state={kind}
			data-testid={`state-${kind}`}
			aria-busy={kind === 'loading' || props.busy ? true : undefined}
		>
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
					{props.retryLabel ?? 'Try again'}
				</button>
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
