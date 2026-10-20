import { resumeWorkflow } from "../conversation/workflow-dispatch.ts";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Markdown } from "@caddie/ui/Markdown";
import type { ApprovalRecord } from "@caddie/contracts";
import { splitFeatureBlock } from "@caddie/contracts";
import { PlanFeatureList } from "../project/FeatureChecklist.tsx";
import type { ReactElement } from "react";
import { formatTimeAgo } from "@caddie/ui/time";
import { postJson } from "../api.ts";
import { StatePanel, failureKind } from "../states.tsx";
import { CopyableId } from "../copyable.tsx";
import type { WorkflowPhase } from "../workspace/project-status.ts";

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
  decision: "approved" | "rejected";
  revisionId: string;
  status: string;
  at: string;
}

/** What approving means, in one plain sentence (plan 5.3). */
export const APPROVE_MEANING =
  "Approving lets Caddie build exactly this plan in a private workspace; putting it online or changing real data always asks you first.";

/**
 * Once the plan is approved, the badge and the button follow the build itself
 * (plan 5.3), not only the approval: "Plan approved · Continue with Caddie"
 * stays for the phases before the build.
 */
function buildFollow(
  phase: WorkflowPhase | null | undefined,
): { badge: string; tone: "action" | "warn" | "ok"; action: string } | null {
  if (phase === "building") return { badge: "Building now", tone: "action", action: "See build progress" };
  if (phase === "blocked") return { badge: "Build paused", tone: "warn", action: "See what’s needed" };
  if (phase === "ready") return { badge: "App built", tone: "ok", action: "See your app" };
  return null;
}

export function DesignReview(props: {
  projectId: string;
  autoBuild?: boolean;
  /** Newest first, matching the plan-docs list route's ordering. */
  planRevisions: readonly DesignReviewRevision[];
  /** Part of the approval intent hash; stable per policy revision. */
  policyVersion?: string;
  approval?: ApprovalRecord | null;
  approvalPending?: boolean;
  approvalError?: unknown;
  retryApproval?: () => void;
  onDecisionSaved?: () => void;
  onContinue?: () => void;
  /** The build's own phase; once the plan is approved the badge and button follow it. */
  buildPhase?: WorkflowPhase | null;
  isPending?: boolean;
  error?: unknown;
  retry?: () => void;
}): ReactElement {
  const policyVersion = props.policyVersion ?? "v1";
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [records, setRecords] = useState<DecisionRecord[]>([]);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  // Decision windows confirm the plan or collect a concrete change request.
  // Approval remains bound to the exact revision through the approvals API.
  const [windowOpen, setWindowOpen] = useState<"approve" | "changes" | null>(
    null,
  );
  const [spendCap, setSpendCap] = useState<{
    limit: string | null;
    settled: string | null;
  } | null>(null);
  const [capLoading, setCapLoading] = useState(false);
  const [changeNote, setChangeNote] = useState("");

  // The approve window states the real spend cap from /api/usage — "no budget
  // set" when none is configured, never a fabricated number.
  const openWindow = (which: "approve" | "changes") => {
    setWindowOpen(which);
    if (which === "approve" && spendCap === null && !capLoading) {
      setCapLoading(true);
      void fetch("/api/usage", { credentials: "same-origin" })
        .then((res) => (res.ok ? res.json() : null))
        .then(
          (
            body: {
              payer?: { limitMinorUnits?: number | null; currency?: string };
              totals?: { settledMinorUnits?: number };
            } | null,
          ) => {
            if (body?.payer && typeof body.payer.limitMinorUnits === "number") {
              const fmt = new Intl.NumberFormat(undefined, {
                style: "currency",
                currency: body.payer.currency ?? "USD",
                maximumFractionDigits: 0,
              });
              setSpendCap({
                limit: fmt.format(body.payer.limitMinorUnits / 100),
                settled:
                  typeof body.totals?.settledMinorUnits === "number"
                    ? fmt.format(body.totals.settledMinorUnits / 100)
                    : null,
              });
            } else {
              setSpendCap({ limit: null, settled: null });
            }
          },
        )
        .catch(() => setSpendCap({ limit: null, settled: null }))
        .finally(() => setCapLoading(false));
    }
  };

  const decide = async (
    decision: "approved" | "rejected",
    revision: DesignReviewRevision,
  ) => {
    setBusy(decision);
    setDecisionError(null);
    try {
      let payload: { approval: { id: string; status: string } };
      if (props.autoBuild) {
        payload = await postJson(
          `/api/projects/${encodeURIComponent(props.projectId)}/workflow/decision`,
          {
            planId: revision.id,
            decision,
            note: decision === "rejected" ? changeNote.trim() : undefined,
          },
        );
      } else {
        payload = await postJson<{ approval: { id: string; status: string } }>(
          "/api/approvals",
          {
            intent: {
              projectId: props.projectId,
              action: "design",
              resourceId: revision.id,
              revisionHash: revision.bodyHash,
              policyVersion,
            },
            decision,
          },
        );
        // A dated decision record — the newest is the live outcome; older
        // ones stay on screen instead of being overwritten.
        if (decision === "rejected") {
          try {
            await postJson(
              `/api/projects/${encodeURIComponent(props.projectId)}/plan-docs/${encodeURIComponent(revision.id)}/decision`,
              {
                decision: "changes",
                note: changeNote.trim(),
                approvalId: payload.approval.id,
              },
            );
          } catch {
            throw new Error(
              "The decision was saved, but your feedback could not be saved. Please try again.",
            );
          }
        }
      }
      props.onDecisionSaved?.();
      setWindowOpen(null);
      setRecords((prev) => [
        {
          decision,
          revisionId: revision.id,
          status: payload.approval.status,
          at: new Date().toISOString(),
        },
        ...prev,
      ]);
      if (props.autoBuild) {
        try {
          await resumeWorkflow(props.projectId);
        } catch (error) {
          setDecisionError(
            `Your decision is saved, but Caddie could not continue. Open the project in Chat to retry. ${error instanceof Error ? error.message : ""}`,
          );
        }
      }
    } catch (error) {
      setDecisionError(
        error instanceof Error
          ? error.message
          : "The decision could not be recorded.",
      );
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
          detail={
            props.error instanceof Error ? props.error.message : undefined
          }
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
          title="Your plan will appear here"
          detail="Tell Caddie what you want to build in the chat. Review the plan here before approving it."
        />
      </div>
    );
  }

  const latest = props.planRevisions[0]!;
  const persisted =
    props.approval?.resourceId === latest.id &&
    props.approval.revisionHash === latest.bodyHash
      ? props.approval
      : null;
  const expiresAt = persisted ? new Date(persisted.expiresAt).getTime() : null;
  const expired =
    expiresAt !== null &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.now());
  const latestRecord = persisted
    ? !expired &&
      (persisted.status === "approved" || persisted.status === "rejected")
      ? { decision: persisted.status, revisionId: latest.id }
      : null
    : (records.find((record) => record.revisionId === latest.id) ?? null);
  const decisionsDisabled =
    busy !== null ||
    Boolean(
      props.approvalPending ||
      props.approvalError ||
      latestRecord ||
      expired ||
      (persisted && persisted.status !== "pending"),
    );
  const approved = latestRecord?.decision === "approved";
  const follow = approved ? buildFollow(props.buildPhase) : null;

  return (
    <div
      data-testid="design-review"
      className="design-review-panel settings-stack"
    >
      {/* v2 §4 order: the "Is this OK?" decision bar comes FIRST, then the
			    plan itself. Both decisions act through the real approvals API. */}
      <section
        className="card-surface settings-panel"
        data-testid="design-review-decision-bar"
      >
        <div className="r-section-head">
          <div>
            <p className="kicker" data-tone="action">
              {latestRecord ? "YOUR PLAN" : "IS THIS OK?"}
            </p>
            <h2 className="ev-title">Plan version {latest.revision}</h2>
            <p className="page-lede" data-testid="approve-meaning">
              {APPROVE_MEANING}
            </p>
          </div>
          {latestRecord ? (
            <span
              className="badge"
              data-tone={follow ? follow.tone : approved ? "ok" : "danger"}
              data-testid="design-review-outcome"
              data-decision={latestRecord.decision}
            >
              {follow ? follow.badge : approved ? "Plan approved" : "Changes requested"}{" "}
              · version {latest.revision}
            </span>
          ) : (
            <span className="badge" data-tone="warn">
              {props.approvalPending
                ? "Checking decision…"
                : props.approvalError
                  ? "Decision unavailable"
                  : expired
                    ? "Approval expired"
                    : persisted?.status === "revoked"
                      ? "Approval revoked"
                      : persisted?.status === "superseded"
                        ? "Approval superseded"
                        : "Ready for review"}
            </span>
          )}
        </div>
        <div className="row-actions">
          {follow ? (
            <Link
              to="/runs"
              search={(prev: Record<string, unknown>) => ({ ...prev })}
              className="btn-key"
              data-testid="plan-see-build"
            >
              {follow.action}
            </Link>
          ) : latestRecord && props.onContinue ? (
            <button
              type="button"
              className="btn-key"
              onClick={props.onContinue}
            >
              Continue with Caddie
            </button>
          ) : null}
          {!latestRecord ? (
            <>
              <button
                type="button"
                className="btn-key"
                data-testid="plan-approve-open"
                disabled={decisionsDisabled}
                onClick={() => openWindow("approve")}
              >
                {props.autoBuild ? "Approve and build" : "Approve plan"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                data-testid="plan-changes-open"
                disabled={decisionsDisabled}
                onClick={() => openWindow("changes")}
              >
                Suggest a change
              </button>
            </>
          ) : null}
        </div>
      </section>

      {props.approvalError ? (
        <StatePanel
          kind={failureKind(props.approvalError)}
          title="Could not load your decision"
          detail="Your plan is available below. Retry before recording a decision."
          onRetry={props.retryApproval}
        />
      ) : null}

      {windowOpen === "approve" ? (
        <div
          className="modal-backdrop"
          data-testid="approve-plan-backdrop"
          onMouseDown={() => {
            if (busy === null) setWindowOpen(null);
          }}
        >
          <div
            className="commit-panel card-surface"
            data-testid="approve-plan-window"
            role="dialog"
            aria-modal="true"
            aria-labelledby="approve-plan-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="kicker" data-tone="action">
              APPROVE PLAN
            </p>
            <h3 id="approve-plan-title" className="state-title">
              Approve plan version {latest.revision}?
            </h3>
            <p className="state-detail">
              Your approval covers building this version in a private workspace.
              Publishing, merging code, and destructive database changes need
              separate approval.
            </p>
            <p className="state-detail" data-testid="approve-plan-spend">
              {capLoading
                ? "Checking your spending limit…"
                : spendCap?.limit
                  ? `Your configured spending limit is ${spendCap.limit}${spendCap.settled ? ` (${spendCap.settled} used so far)` : ""}.`
                  : "No spending limit is configured. This decision approves the plan; it does not set a budget."}
            </p>
            {decisionError ? (
              <div
                role="alert"
                className="sign-in-error"
                data-testid="design-review-error"
              >
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
                  void decide("approved", latest);
                }}
              >
                {busy === "approved"
                  ? "Starting…"
                  : props.autoBuild
                    ? "Approve and build"
                    : "Approve plan"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setWindowOpen(null)}
                disabled={busy !== null}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {windowOpen === "changes" ? (
        <div
          className="modal-backdrop"
          data-testid="request-changes-backdrop"
          onMouseDown={() => {
            if (busy === null) setWindowOpen(null);
          }}
        >
          <div
            className="commit-panel card-surface"
            data-testid="request-changes-window"
            role="dialog"
            aria-modal="true"
            aria-labelledby="request-changes-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <p className="kicker" data-tone="action">
              SUGGEST A CHANGE
            </p>
            <h3 id="request-changes-title" className="state-title">
              What would you like to change?
            </h3>
            <p className="state-detail">
              Describe what should change. Your feedback is saved with this plan
              version for review with Caddie.
            </p>
            <label className="field">
              <span>Your feedback</span>
              <textarea
                className="input"
                rows={4}
                maxLength={2000}
                value={changeNote}
                onChange={(event) => setChangeNote(event.target.value)}
                data-testid="plan-change-note"
                placeholder="For example, keep the first version focused on adding and completing tasks."
              />
            </label>
            {decisionError ? (
              <div
                role="alert"
                className="sign-in-error"
                data-testid="design-review-error"
              >
                <b>Could not record the decision.</b>
                <span> {decisionError}</span>
              </div>
            ) : null}
            <div className="row-actions">
              <button
                type="button"
                className="btn-ghost btn-danger"
                data-testid="design-review-reject"
                disabled={busy !== null || !changeNote.trim()}
                onClick={() => {
                  void decide("rejected", latest);
                }}
              >
                {busy === "rejected" ? "Saving…" : "Save feedback"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setWindowOpen(null)}
                disabled={busy !== null}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {decisionError ? (
        <StatePanel
          kind={failureKind(decisionError)}
          title="Decision refused"
          detail={decisionError}
        />
      ) : null}

      {/* The plan to read. It folds once approved (plan 5.3), so the decision
          and the build lead the page; what approving means is the bar's one
          sentence. */}
      <details
        className="card-surface settings-panel plan-review-details"
        data-testid="design-review-plan-body"
        open={!approved}
      >
        <summary className="ev-head">
          What you're making — plan version {latest.revision}
        </summary>
        {latest.body.trim() === "" ? (
          <p className="state-detail">This revision carries no plan text.</p>
        ) : (
          <div className="plan-body" data-testid="plan-body-content">
            <Markdown text={splitFeatureBlock(latest.body).display} />
            <PlanFeatureList body={latest.body} />
          </div>
        )}
        <details className="ev-devdetail">
          <summary className="kicker">For developers — exact revision hash</summary>
          <div className="ev-field">
            <span className="fk">revision hash</span>
            <CopyableId value={latest.bodyHash} label="revision hash" />
          </div>
        </details>
      </details>

      {/* Earlier versions fold (§4 anchor #earlier): history stays reachable
				    without competing with the decision for the current version. Hidden
				    entirely when there is nothing earlier — an empty "Earlier versions · 0"
				    fold is noise (owner steering, 2026-10-15). */}
      {props.planRevisions.length > 1 ? (
        <section
          className="card-surface settings-panel"
          id="earlier"
          data-testid="design-review-earlier"
        >
          <details>
            <summary className="ev-head">
              Earlier versions · {props.planRevisions.length - 1}
            </summary>
            <div className="row-list">
              {props.planRevisions.slice(1).map((revision) => (
                <div
                  className="inspector-row"
                  data-testid="design-review-row"
                  data-latest="false"
                  key={revision.id}
                >
                  <div className="row-main">
                    <span className="row-title">
                      Version <span className="mono-id">{revision.revision}</span> — replaced
                    </span>
                    <span className="mono-id">
                      {formatTimeAgo(revision.createdAt)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </details>
        </section>
      ) : null}

      {records.length > 0 ? (
        <details
          className="card-surface settings-panel"
          data-testid="design-review-record"
        >
          <summary className="ev-head">Your decisions this session</summary>
          <div className="row-list">
            {records.map((record) => (
              <div
                className="inspector-row"
                key={`${record.revisionId}:${record.at}`}
              >
                <div className="row-main">
                  <span className="row-title">
                    <span
                      className="badge"
                      data-tone={
                        record.decision === "approved" ? "ok" : "danger"
                      }
                    >
                      {record.decision}
                    </span>{" "}
                    Plan version{" "}
                    {props.planRevisions.find(
                      (revision) => revision.id === record.revisionId,
                    )?.revision ?? "previous"}
                  </span>
                  <span className="mono-id">{formatTimeAgo(record.at)}</span>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
