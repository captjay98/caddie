import { useState } from 'react';
import type { ReactElement } from 'react';
import { formatTimeAgo } from '@caddie/ui/time';
import { postJson } from '../api.ts';
import { StatePanel, failureKind } from '../states.tsx';

/**
 * DesignReview — approve/reject the LATEST plan revision through the REAL
 * approvals route (feature-ledger C13: the approval is bound to the exact
 * revision hash; a changed plan needs a new decision — the server, not this
 * UI, is that authority and surfaces STALE_APPROVAL-class failures here).
 *
 * The decision posts to the authenticated user surface:
 *
 *   POST /api/approvals { intent: { projectId, action: 'design',
 *          resourceId: <planRevisionId>, revisionHash: <bodyHash>,
 *          policyVersion }, decision: 'approved' | 'rejected' }
 *
 * decidedBy is always the session-derived actor server-side; no input here
 * can name one. Buttons stay available after a decision: re-deciding is the
 * server's typed 409 to surface, never hidden client state.
 */

export interface DesignReviewRevision {
	readonly id: string;
	readonly revision: number;
	readonly bodyHash: string;
	readonly createdAt: string;
}

type Decision = 'approved' | 'rejected';

function shortHash(hash: string): string {
	const hex = hash.startsWith('sha256-') ? hash.slice(7) : hash;
	return hex.slice(0, 12);
}

export function DesignReview(props: {
	projectId: string;
	/** Newest first, matching the plan-docs list route's ordering. */
	planRevisions: readonly DesignReviewRevision[];
	/** Part of the approval intent hash; stable per policy revision. */
	policyVersion?: string;
	isPending?: boolean;
	error?: unknown;
	retry?: () => void;
}): ReactElement {
	const [busy, setBusy] = useState<Decision | null>(null);
	const [outcome, setOutcome] = useState<{ decision: Decision; revisionId: string; status: string } | null>(
		null,
	);
	const [decisionError, setDecisionError] = useState<string | null>(null);

	const decide = async (decision: Decision, revision: DesignReviewRevision) => {
		setBusy(decision);
		setDecisionError(null);
		try {
			const payload = await postJson<{ approval: { status: string } }>('/api/approvals', {
				intent: {
					projectId: props.projectId,
					action: 'design',
					resourceId: revision.id,
					revisionHash: revision.bodyHash,
					policyVersion: props.policyVersion ?? 'v1',
				},
				decision,
			});
			setOutcome({ decision, revisionId: revision.id, status: payload.approval.status });
		} catch (error) {
			setOutcome(null);
			setDecisionError(error instanceof Error ? error.message : 'The decision could not be recorded.');
		} finally {
			setBusy(null);
		}
	};

	if (props.isPending) {
		return (
			<div data-testid="design-review">
				<StatePanel kind="loading" />
			</div>
		);
	}
	if (props.error) {
		return (
			<div data-testid="design-review">
				<StatePanel
					kind={failureKind(props.error)}
					detail={props.error instanceof Error ? props.error.message : undefined}
					onRetry={props.retry}
				/>
			</div>
		);
	}
	if (props.planRevisions.length === 0) {
		return (
			<div data-testid="design-review">
				<StatePanel
					kind="empty"
					title="No plan revisions yet"
					detail="Design approval binds to the exact revision hash — revisions appear here as they are created."
				/>
			</div>
		);
	}

	const latest = props.planRevisions[0]!;
	return (
		<div data-testid="design-review">
			<div className="section-head">
				<h3>Design review</h3>
				<span className="mono-id">approval bound to revision</span>
			</div>
			{outcome ? (
				<p
					className="state-detail"
					data-testid="design-review-outcome"
					data-decision={outcome.decision}
				>
					{outcome.decision === 'approved' ? 'Approved' : 'Rejected'} ({outcome.status}) · revision{' '}
					{shortHash(outcome.revisionId)}
				</p>
			) : null}
			{decisionError ? (
				<StatePanel kind={failureKind(decisionError)} title="Decision refused" detail={decisionError} />
			) : null}
			<div className="row-list">
				{props.planRevisions.map((revision, index) => (
					<div
						className="inspector-row"
						data-testid="design-review-row"
						data-latest={index === 0 ? 'true' : undefined}
						key={revision.id}
					>
						<div className="row-main">
							<span className="row-title">
								plan <span className="mono-id">r{revision.revision}</span>
								{index === 0 ? (
									<span className="row-status" data-status="current">
										latest
									</span>
								) : null}
							</span>
							<span className="mono-id">{formatTimeAgo(revision.createdAt)}</span>
						</div>
						<div className="row-main">
							<span className="mono-id">revision {shortHash(revision.bodyHash)}</span>
						</div>
						{index === 0 ? (
							<div className="row-main">
								<button
									type="button"
									className="btn-ghost"
									disabled={busy !== null}
									onClick={() => void decide('approved', revision)}
									data-testid="design-review-approve"
								>
									{busy === 'approved' ? 'Approving…' : 'Approve design'}
								</button>
								<button
									type="button"
									className="btn-ghost"
									disabled={busy !== null}
									onClick={() => void decide('rejected', revision)}
									data-testid="design-review-reject"
								>
									{busy === 'rejected' ? 'Rejecting…' : 'Reject design'}
								</button>
							</div>
						) : null}
					</div>
				))}
			</div>
		</div>
	);
}
