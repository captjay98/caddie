import { useState } from 'react';
import type { ReactElement } from 'react';
import { formatTimeAgo } from '@caddie/ui/time';
import { StatePanel, StaleChip, failureKind } from '../states.tsx';

/**
 * RunInspector — inspectable completed (and recorded) runs: the real P02
 * run-bindings + artifact-revisions surfaces, never a summarized claim.
 *
 * Row status is typed metadata only: 'recorded' comes from the stored binding;
 * 'running' | 'completed' | 'failed' | 'cancelled' arrive (P05) through the
 * optional `statusByRunId` map fed from transport settlements — an absent
 * entry never inflates a stopped run into a success.
 */

export type RunStatus = 'recorded' | 'running' | 'completed' | 'failed' | 'cancelled';

const STATUS_LABEL: Record<RunStatus, string> = {
	recorded: 'recorded',
	running: 'running',
	completed: 'completed',
	failed: 'failed',
	cancelled: 'cancelled',
};

function shortId(id: string, keep = 12): string {
	return id.length > keep ? `${id.slice(0, keep)}…` : id;
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
	projectId?: string | null;
}): ReactElement {
	const [open, setOpen] = useState(false);
	return (
		<div className="inspector-row" data-testid="run-row" data-status={props.status}>
			<div className="row-main">
				<span className="row-title mono-id">run {shortId(props.runId, 18)}</span>
				<span className="row-status" data-status={props.status}>
					{STATUS_LABEL[props.status]}
				</span>
			</div>
			<div className="row-main">
				<span className="mono-id">{props.stackId}</span>
				<span className="mono-id">{formatTimeAgo(props.createdAt, props.now)}</span>
			</div>
			<button
				type="button"
				className="detail-toggle"
				aria-expanded={open}
				data-testid="run-detail-toggle"
				onClick={() => setOpen((value) => !value)}
			>
				{open ? 'Hide run details' : 'Run details'}
			</button>
			{open ? (
				<div className="row-details" data-testid="run-details">
					<span className="mono-id">run {props.runId}</span>
					<span className="mono-id">conversation {props.conversationId}</span>
					<span className="mono-id">submission {props.submissionId}</span>
					<span className="mono-id">plan revision {props.planRevision}</span>
					<span className="mono-id">stack {props.stackId}</span>
					<span className="mono-id">recorded {formatTimeAgo(props.createdAt, props.now)}</span>
				</div>
			) : null}
			{props.projectId ? (
				<div className="row-actions">
					<a className="r-link" href={`./evidence?project=${encodeURIComponent(props.projectId)}`}>
						Open evidence
					</a>
				</div>
			) : null}
		</div>
	);
}

function ArtifactRow(props: {
	artifactId: string;
	kind: string;
	revision: number;
	metadataHash: string;
	createdAt: string;
	now: Date;
	projectId?: string | null;
}): ReactElement {
	const [open, setOpen] = useState(false);
	return (
		<div className="inspector-row" data-testid="artifact-row">
			<div className="row-main">
				<span className="row-title">
					{props.kind} <span className="mono-id">rev {props.revision}</span>
				</span>
				<span className="mono-id">{formatTimeAgo(props.createdAt, props.now)}</span>
			</div>
			<button
				type="button"
				className="detail-toggle"
				aria-expanded={open}
				data-testid="artifact-detail-toggle"
				onClick={() => setOpen((value) => !value)}
			>
				{open ? 'Hide artifact details' : 'Artifact details'}
			</button>
			{open ? (
				<div className="row-details">
					<span className="mono-id">artifact {props.artifactId}</span>
					<span className="mono-id">metadata {shortId(props.metadataHash, 19)}</span>
					<span className="mono-id">recorded {formatTimeAgo(props.createdAt, props.now)}</span>
				</div>
			) : null}
			{props.projectId ? (
				<div className="row-actions">
					<a className="r-link" href={`./artifacts?project=${encodeURIComponent(props.projectId)}`}>
						Open artifacts
					</a>
				</div>
			) : null}
		</div>
	);
}

export function RunInspector(props: {
	/** Typed transport outcomes per run (P05); absent = honest 'recorded'. */
	statusByRunId?: Readonly<Record<string, RunStatus>>;
	now?: Date;
	/** Present when the lane can link rows into the screens that hold their
	 *  evidence and artifacts (board screens 07/09/10). */
	projectId?: string | null;
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
	artifacts: {
		isPending: boolean;
		isFetching: boolean;
		error: unknown;
		items: ReadonlyArray<{
			artifactId: string;
			kind: string;
			revision: number;
			metadataHash: string;
			createdAt: string;
		}>;
		retry: () => void;
	};
}): ReactElement {
	const now = props.now ?? new Date();
	const kindOf = (error: unknown) => failureKind(error);

	return (
		<div data-testid="run-inspector">
			<section className="inspector-section" aria-label="Runs">
				<div className="section-head">
					<h3>Runs</h3>
					<StaleChip stale={props.runs.isFetching && !props.runs.isPending} />
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
						title="No runs recorded"
						detail="Start a run and its durable identity — binding, stack, plan revision — lands here."
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
								projectId={props.projectId}
							/>
						))}
					</div>
				)}
			</section>

			<section className="inspector-section" aria-label="Artifacts">
				<div className="section-head">
					<h3>Artifacts</h3>
					<StaleChip stale={props.artifacts.isFetching && !props.artifacts.isPending} />
				</div>
				{props.artifacts.isPending ? (
					<StatePanel kind="loading" />
				) : props.artifacts.error ? (
					<StatePanel
						kind={kindOf(props.artifacts.error)}
						detail={props.artifacts.error instanceof Error ? props.artifacts.error.message : undefined}
						onRetry={props.artifacts.retry}
					/>
				) : props.artifacts.items.length === 0 ? (
					<StatePanel
						kind="empty"
						title="No artifacts yet"
						detail="Plan revisions, previews and build outputs appear here as run evidence."
					/>
				) : (
					<div className="row-list">
						{props.artifacts.items.map((artifact) => (
							<ArtifactRow
								key={`${artifact.artifactId}:${artifact.revision}`}
								artifactId={artifact.artifactId}
								kind={artifact.kind}
								revision={artifact.revision}
								metadataHash={artifact.metadataHash}
								createdAt={artifact.createdAt}
								projectId={props.projectId}
								now={now}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
