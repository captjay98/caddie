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
	// v2 decision windows (§4): "Looks good — build it" (states the spend cap)
	// and "Suggest a change". Both act through the real approvals API.
	const [windowOpen, setWindowOpen] = useState<'approve' | 'changes' | null>(null);
	const [spendCap, setSpendCap] = useState<{ limit: string | null; settled: string | null } | null>(null);
	const [capLoading, setCapLoading] = useState(false);

	// The approve window states the real spend cap from /api/usage — "no budget
	// set" when none is configured, never a fabricated number.
	const openWindow = (which: 'approve' | 'changes') => {
		setWindowOpen(which);
		if (which === 'approve' && spendCap === null && !capLoading) {
			setCapLoading(true);
			void fetch('/api/usage', { credentials: 'same-origin' })
				.then((res) => (res.ok ? res.json() : null))
				.then((body: { payer?: { limitMinorUnits?: number | null; currency?: string }; totals?: { settledMinorUnits?: number } } | null) => {
					if (body?.payer && typeof body.payer.limitMinorUnits === 'number') {
						const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency: body.payer.currency ?? 'USD', maximumFractionDigits: 0 });
						setSpendCap({
							limit: fmt.format(body.payer.limitMinorUnits / 100),
							settled: typeof body.totals?.settledMinorUnits === 'number' ? fmt.format(body.totals.settledMinorUnits / 100) : null,
						});
					} else {
						setSpendCap({ limit: null, settled: null });
					}
				})
				.catch(() => setSpendCap({ limit: null, settled: null }))
				.finally(() => setCapLoading(false));
		}
	};

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
			{/* v2 §4 order: the "Is this OK?" decision bar comes FIRST, then the
			    plan itself. Both decisions act through the real approvals API. */}
			<section className="card-surface settings-panel" data-testid="design-review-decision-bar">
				<div className="r-section-head">
					<div>
						<p className="kicker" data-tone="action">
							IS THIS OK?
						</p>
						<h2 className="ev-title">Plan version {latest.revision}</h2>
						<p className="page-lede">
							Building starts only after you say it's good. Saying yes lets specialists build against
							this plan version, under policy {policyVersion}.
						</p>
					</div>
					{latestRecord ? (
						<span
							className="badge"
							data-tone={latestRecord.decision === 'approved' ? 'ok' : 'danger'}
							data-testid="design-review-outcome"
							data-decision={latestRecord.decision}
						>
							{latestRecord.decision} · version {latestRecord.revisionId}
						</span>
					) : (
						<span className="badge" data-tone="warn">
							waiting on you
						</span>
					)}
				</div>
				<div className="row-actions">
					<button type="button" className="btn-key" data-testid="plan-approve-open" disabled={busy !== null} onClick={() => openWindow('approve')}>
						Looks good — build it
					</button>
					<button type="button" className="btn-ghost" data-testid="plan-changes-open" disabled={busy !== null} onClick={() => openWindow('changes')}>
						Suggest a change
					</button>
				</div>
			</section>

			{windowOpen === 'approve' ? (
				<div className="modal-backdrop" data-testid="approve-plan-backdrop" onMouseDown={() => setWindowOpen(null)}>
					<div className="commit-panel card-surface" data-testid="approve-plan-window" onMouseDown={(e) => e.stopPropagation()}>
						<p className="kicker" data-tone="action">
							LOOKS GOOD — BUILD IT
						</p>
						<h3 className="state-title">Approve plan version {latest.revision}?</h3>
						<p className="state-detail">
							Caddie builds against this plan inside a test account. The approval is bound to the exact
							revision hash — if the plan changes, your decision stops applying.
						</p>
						<p className="state-detail" data-testid="approve-plan-spend">
							{capLoading
								? 'Checking your spending limit…'
								: spendCap?.limit
									? `This runs under your spending limit of ${spendCap.limit}${spendCap.settled ? ` (${spendCap.settled} used so far)` : ''}.`
									: 'No budget is set, so Caddie will ask before anything costs money.'}
						</p>
						{decisionError ? (
							<div role="alert" className="sign-in-error" data-testid="design-review-error">
								<b>Could not record the decision.</b>
								<span> {decisionError}</span>
							</div>
						) : null}
						<div className="row-actions">
							<button
								type="button"
								className="btn-key"
								data-testid="design-review-approve"
								disabled={busy !== null}
								onClick={() => {
									void decide('approved', latest).then(() => setWindowOpen(null));
								}}
							>
								{busy === 'approved' ? 'Saving…' : 'Approve and build'}
							</button>
							<button type="button" className="btn-ghost" onClick={() => setWindowOpen(null)} disabled={busy !== null}>
								Cancel
							</button>
						</div>
					</div>
				</div>
			) : null}
			{windowOpen === 'changes' ? (
				<div className="modal-backdrop" data-testid="request-changes-backdrop" onMouseDown={() => setWindowOpen(null)}>
					<div className="commit-panel card-surface" data-testid="request-changes-window" onMouseDown={(e) => e.stopPropagation()}>
						<p className="kicker" data-tone="action">
							SUGGEST A CHANGE
						</p>
						<h3 className="state-title">Send it back to Caddie?</h3>
						<p className="state-detail">
							Caddie redrafts the plan with your change. Nothing gets built, and nothing is charged —
							the current plan simply waits for a new version.
						</p>
						{decisionError ? (
							<div role="alert" className="sign-in-error" data-testid="design-review-error">
								<b>Could not record the decision.</b>
								<span> {decisionError}</span>
							</div>
						) : null}
						<div className="row-actions">
							<button
								type="button"
								className="btn-ghost btn-danger"
								data-testid="design-review-reject"
								disabled={busy !== null}
								onClick={() => {
									void decide('rejected', latest).then(() => setWindowOpen(null));
								}}
							>
								{busy === 'rejected' ? 'Saving…' : 'Yes — redraft the plan'}
							</button>
							<button type="button" className="btn-ghost" onClick={() => setWindowOpen(null)} disabled={busy !== null}>
								Cancel
							</button>
						</div>
					</div>
				</div>
			) : null}

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
				<h3 className="ev-head">What you're making — plan version {latest.revision}</h3>
				{latest.body.trim() === '' ? (
					<p className="state-detail">This revision carries no plan text.</p>
				) : (
					<pre className="plan-body" data-testid="plan-body-content">
						{latest.body}
					</pre>
				)}
			</section>

			{/* Earlier versions fold (§4 anchor #earlier): history stays reachable
			    without competing with the decision for the current version. */}
			<section className="card-surface settings-panel" id="earlier" data-testid="design-review-earlier">
				<details>
					<summary className="ev-head">Earlier versions · {props.planRevisions.length - 1}</summary>
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
										version <span className="mono-id">{revision.revision}</span>
										{index === 0 ? (
											<span className="badge" data-tone="action">
												current
											</span>
										) : (
											<span className="mono-id">superseded by version {props.planRevisions[0]!.revision}</span>
										)}
									</span>
									<span className="mono-id">{formatTimeAgo(revision.createdAt)}</span>
								</div>
							</div>
						))}
					</div>
				</details>
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