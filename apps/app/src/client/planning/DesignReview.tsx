import { useState } from 'react';
import type { ReactElement } from 'react';
import { formatTimeAgo } from '@caddie/ui/time';
import { postJson } from '../api.ts';
import { StatePanel, failureKind } from '../states.tsx';
import { CopyableId } from '../copyable.tsx';

/**
 * DesignReview — approve/reject the LATEST plan revision through the REAL
 * approvals route (feature-ledger C13: the approval is bound to the exact
 * revision hash; a changed plan needs a new decision — the server, not this
 * UI, is that authority and surfaces STALE_APPROVAL-class failures here).
 *
 * UI review board screen 11 — the most consequential decision in the product
 * gets the presentation it deserves:
 *   - the scope is WRITTEN ON THE CONTROL: what approving authorises and what
 *     it never does (each of those stays a separate gate);
 *   - the pair is weighted honestly: Approve is the page's only primary
 *     action; Reject carries the danger tone and a stated consequence;
 *   - the full revision hash sits beside a copy action;
 *   - decisions are kept as a dated RECORD (newest first), not a line the
 *     next click overwrites;
 *   - re-deciding is the server's typed 409 to surface, never hidden client
 *     state.
 *
 * The decision posts to the authenticated user surface:
 *
 *   POST /api/approvals { intent: { projectId, action: 'design',
 *          resourceId: <planRevisionId>, revisionHash: <bodyHash>,
 *          policyVersion }, decision: 'approved' | 'rejected' }
 *
 * decidedBy is always the session-derived actor server-side; no input here
 * can name one.
 */

export interface DesignReviewRevision {
	readonly id: string;
	readonly revision: number;
	readonly bodyHash: string;
	readonly createdAt: string;
	/** The plan body as drafted — rendered readably below (audit F09). */
	readonly body: string;
}

interface DecisionRecord {
	decision: 'approved' | 'rejected';
	revisionId: string;
	status: string;
	at: string;
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
	const policyVersion = props.policyVersion ?? 'v1';
	const [busy, setBusy] = useState<'approved' | 'rejected' | null>(null);
	const [records, setRecords] = useState<DecisionRecord[]>([]);
	const [decisionError, setDecisionError] = useState<string | null>(null);

	const decide = async (decision: 'approved' | 'rejected', revision: DesignReviewRevision) => {
		setBusy(decision);
		setDecisionError(null);
		try {
			const payload = await postJson<{ approval: { status: string } }>('/api/approvals', {
				intent: {
					projectId: props.projectId,
					action: 'design',
					resourceId: revision.id,
					revisionHash: revision.bodyHash,
					policyVersion,
				},
				decision,
			});
			// A dated decision record — the newest is the live outcome; older
			// ones stay on screen instead of being overwritten.
			setRecords((prev) => [
				{ decision, revisionId: revision.id, status: payload.approval.status, at: new Date().toISOString() },
				...prev,
			]);
		} catch (error) {
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
	const latestRecord = records[0] ?? null;

	return (
		<div data-testid="design-review" className="design-review-panel settings-stack">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						PLAN
					</p>
					<h2 className="ev-title">Plan review</h2>
					<p className="page-lede">
						Caddie drafts the plan; building starts only after you say it’s good. Saying yes lets
						specialists build against plan version {latest.revision}, under policy {policyVersion}.
					</p>
				</div>
				{latestRecord ? (
					<span
						className="badge"
						data-tone={latestRecord.decision === 'approved' ? 'ok' : 'danger'}
						data-testid="design-review-outcome"
						data-decision={latestRecord.decision}
					>
						{latestRecord.decision} · r{latestRecord.revisionId}
					</span>
				) : (
					<span className="badge" data-tone="warn">
						waiting on you
					</span>
				)}
			</div>

			<section className="card-surface settings-panel" data-testid="design-review-scope">
				<h3 className="ev-head">What this decision binds</h3>
				<div className="ev-field">
					<span className="fk">authorises</span>
					<span className="fv">
						building against this plan revision inside the sandbox. The approval is bound to the exact
						revision hash below — if the plan changes, this decision stops applying and the change
						returns to the brief as a Change decision.
					</span>
				</div>
				<div className="ev-field">
					<span className="fk">does not authorise</span>
					<span className="fv">deploy to production · a destructive database change · merge to the default
						branch. Each stays behind its own separate gate.</span>
				</div>
				<div className="ev-field">
					<span className="fk">revision hash</span>
					<CopyableId value={latest.bodyHash} label="revision hash" />
				</div>
			</section>

			{decisionError ? (
				<StatePanel
					kind={failureKind(decisionError)}
					title="Decision refused"
					detail={`${decisionError} — re-deciding a settled revision is the server's typed refusal to surface, never hidden client state.`}
				/>
			) : null}

			<section className="card-surface settings-panel" data-testid="design-review-plan-body">
				<h3 className="ev-head">The plan as drafted — r{latest.revision}</h3>
				{latest.body.trim() === '' ? (
					<p className="state-detail">This revision carries no plan text.</p>
				) : (
					<pre className="plan-body" data-testid="plan-body-content">
						{latest.body}
					</pre>
				)}
			</section>

			<section className="card-surface settings-panel">
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
										<span className="badge" data-tone="action">
											latest
										</span>
									) : (
										<span className="mono-id">superseded by r{props.planRevisions[0]!.revision}</span>
									)}
								</span>
								<span className="mono-id">{formatTimeAgo(revision.createdAt)}</span>
							</div>
							<div className="row-details">
								<span className="ev-field">
									<span className="fk">revision hash</span>
									<CopyableId value={revision.bodyHash} label="revision hash" />
								</span>
							</div>
							{index === 0 ? (
								<div className="row-actions">
									<button
										type="button"
										className="btn-key"
										disabled={busy !== null}
										onClick={() => void decide('approved', revision)}
										data-testid="design-review-approve"
									>
										{busy === 'approved' ? 'Saving…' : 'Looks good — build it'}
									</button>
									<button
										type="button"
										className="btn-ghost btn-danger"
										disabled={busy !== null}
										onClick={() => void decide('rejected', revision)}
										data-testid="design-review-reject"
									>
										{busy === 'rejected' ? 'Rejecting…' : 'Reject and replan'}
									</button>
									<span className="mono-id">
										rejecting stops the lane and returns the plan to the author
									</span>
								</div>
							) : null}
						</div>
					))}
				</div>
			</section>

{records.length > 0 ? (
					<section className="card-surface settings-panel" data-testid="design-review-record">
						<h3 className="ev-head">Your decisions this session</h3>
						<div className="row-list">
						{records.map((record) => (
							<div className="inspector-row" key={`${record.revisionId}:${record.at}`}>
								<div className="row-main">
									<span className="row-title">
										<span className="badge" data-tone={record.decision === 'approved' ? 'ok' : 'danger'}>
											{record.decision}
										</span>{' '}
										plan r{record.revisionId} · server status {record.status}
									</span>
									<span className="mono-id">{formatTimeAgo(record.at)}</span>
								</div>
							</div>
						))}
					</div>
				</section>
			) : null}
		</div>
	);
}