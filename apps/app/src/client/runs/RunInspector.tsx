import { useState } from 'react';
import type { ReactElement } from 'react';
import { formatTimeAgo } from '@caddie/ui/time';
import { StatePanel, StaleChip, failureKind } from '../states.tsx';
import { CopyableId } from '../copyable.tsx';

/**
 * RunInspector — the Build tab's Activity list (v2, HANDOFF §4): past builds
 * as sentences, each opening a detail fold, with "Ask for a change" opening
 * the change-request window (which drafts the ask in the project's chat — the
 * chat is where Caddie takes the request).
 *
 * Details fold (owner steering, 2026-10-15): a build's record is shown as
 * labelled facts first (stack, when, plan version); the raw record ids move
 * into a "For developers" fold inside it — exact and copyable, but no longer
 * an unreadable wall of hex for a non-technical reader.
 *
 * Row status is typed metadata only: 'recorded' comes from the stored binding;
 * 'running' | 'completed' | 'failed' | 'cancelled' arrive (P05) through the
 * optional `statusByRunId` map fed from transport settlements — an absent
 * entry never inflates a stopped run into a success.
 */

export type RunStatus = 'recorded' | 'running' | 'completed' | 'failed' | 'cancelled';

/** The past build as one sentence (§4). Statuses come from real data only. */
function buildSentence(status: RunStatus, stackId: string, when: string): string {
	switch (status) {
		case 'running':
			return `Building now on ${stackId}.`;
		case 'completed':
			return `A build finished on ${stackId} ${when}.`;
		case 'failed':
			return `A build stopped ${when} — the run was marked failed. Ask Caddie in the chat what happened.`;
		case 'cancelled':
			return `A build was cancelled ${when}.`;
		default:
			return `A build ran ${when} on ${stackId}.`;
	}
}

function RunRow(props: {
	runId: string;
	stackId: string;
	planRevision: string;
	conversationId: string;
	submissionId: string;
	createdAt: string;
	status: RunStatus;
	now: Date;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const [devOpen, setDevOpen] = useState(false);
	const when = formatTimeAgo(props.createdAt, props.now);
	return (
		<div className="inspector-row" data-testid="run-row" data-status={props.status}>
			<div className="row-main">
				<span className="row-title">{buildSentence(props.status, props.stackId, when)}</span>
				<button
					type="button"
					className="detail-toggle"
					aria-expanded={open}
					data-testid="run-detail-toggle"
					onClick={() => setOpen((value) => !value)}
				>
					{open ? 'Hide details' : 'Details'}
				</button>
			</div>
			{open ? (
				<div className="row-details run-details" data-testid="run-details">
					<span className="run-fact">
						<span className="fk">Built with</span>
						<span className="fv">{props.stackId}</span>
					</span>
					<span className="run-fact">
						<span className="fk">When</span>
						<span className="fv">{when}</span>
					</span>
					<span className="run-fact">
						<span className="fk">Plan</span>
						<CopyableId value={props.planRevision} label="plan revision id" />
					</span>
					<details
						className="run-devdetail"
						open={devOpen}
						onToggle={(event) => setDevOpen((event.target as HTMLDetailsElement).open)}
					>
						<summary className="kicker">For developers — record ids</summary>
						<span className="run-fact">
							<span className="fk">run</span>
							<CopyableId value={props.runId} label="run id" />
						</span>
						<span className="run-fact">
							<span className="fk">conversation</span>
							<CopyableId value={props.conversationId} label="conversation id" />
						</span>
						<span className="run-fact">
							<span className="fk">submission</span>
							<CopyableId value={props.submissionId} label="submission id" />
						</span>
					</details>
				</div>
			) : null}
		</div>
	);
}

export function RunInspector(props: {
	/** Typed transport outcomes per run (P05); absent = honest 'recorded'. */
	statusByRunId?: Readonly<Record<string, RunStatus>>;
	now?: Date;
	projectId?: string | null;
	onAskChange?: () => void;
	runs: {
		isPending: boolean;
		isFetching: boolean;
		error: unknown;
		items: ReadonlyArray<{
			runId: string;
			stackId: string;
			planRevision: string;
			conversationId: string;
			submissionId: string;
			createdAt: string;
		}>;
		retry: () => void;
	};
}): ReactElement {
	const now = props.now ?? new Date();
	const kindOf = (error: unknown) => failureKind(error);

	return (
		<div data-testid="run-inspector">
			<section className="inspector-section" aria-label="Builds">
				<div className="section-head">
					<h3>Past builds</h3>
					<StaleChip stale={props.runs.isFetching && !props.runs.isPending} />
					{props.onAskChange ? (
						<button type="button" className="btn-ghost" data-testid="change-request-open" onClick={props.onAskChange}>
							Ask for a change
						</button>
					) : null}
				</div>
				{props.runs.isPending ? (
					<StatePanel kind="loading" />
				) : props.runs.error ? (
					<StatePanel
						kind={kindOf(props.runs.error)}
						detail={props.runs.error instanceof Error ? props.runs.error.message : undefined}
						onRetry={props.runs.retry}
					/>
				) : props.runs.items.length === 0 ? (
					<StatePanel
						kind="empty"
						title="No builds yet"
						detail="Approve a plan and Caddie builds; every build is recorded here as it happens."
					/>
				) : (
					<div className="row-list">
						{props.runs.items.map((run) => (
							<RunRow
								key={run.runId}
								runId={run.runId}
								stackId={run.stackId}
								planRevision={run.planRevision}
								conversationId={run.conversationId}
								submissionId={run.submissionId}
								createdAt={run.createdAt}
								status={props.statusByRunId?.[run.runId] ?? 'recorded'}
								now={now}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
