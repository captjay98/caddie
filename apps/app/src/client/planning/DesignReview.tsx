import { Mascot } from "@caddie/ui/Mascot";
import { resumeWorkflow } from "../conversation/workflow-dispatch.ts";
import { useState } from "react";
import * as v from "valibot";
import { Link } from "@tanstack/react-router";
import type { ApprovalRecord, DesignOverview } from "@caddie/contracts";
import { ProjectExperienceSchema } from "@caddie/contracts";
import { PlanReview } from "./PlanReview.tsx";
import type { ReactElement, ReactNode } from "react";
import { formatTimeAgo } from "@caddie/ui/time";
import { postJson } from "../api.ts";
import { useProjectExperience } from "../queries.ts";
import { useWorkspaceChrome } from "../workspace/Chrome.tsx";
import { PageSkeleton, StatePanel, failureKind } from "../states.tsx";
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

/** What approving means, in one plain sentence (plan 5.3) — two lines at most on a phone. */
export const APPROVE_MEANING =
  "Caddie builds exactly this plan, privately. It asks you before publishing or changing real data.";

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
  /** The "How your app works" panel, passed in by the shell (it needs the workspace's data). */
  howItWorks?: ReactNode;
  /** The project's name: the plan's `# Title` is hidden when it only repeats it. */
  projectName?: string;
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
  // Which earlier plan version is open to read, if any (null = the current one).
  const [viewing, setViewing] = useState<number | null>(null);

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
      let payload: { approval: { id: string; status: string } | null };
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
        if (!payload.approval) throw new Error('The decision could not be confirmed. Refresh the plan before trying again.');
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
      const savedApproval = payload.approval;
      if (savedApproval) setRecords((prev) => [
        { decision, revisionId: revision.id, status: savedApproval.status, at: new Date().toISOString() },
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
        <PageSkeleton page="plan" label="Reading your plan…" />
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
  // Only an unusual approval state earns a badge; the normal case is "IS THIS OK?".
  const approvalNote = props.approvalPending
    ? "Checking decision…"
    : props.approvalError
      ? "Decision unavailable"
      : expired
        ? "Approval expired"
        : persisted?.status === "revoked"
          ? "Approval revoked"
          : persisted?.status === "superseded"
            ? "Approval superseded"
            : null;
  // An earlier version opened to read (owner 2026-10-23): it takes the plan's
  // place with a "back" bar, instead of nesting a whole plan inside a row.
  const viewed = viewing === null ? null : props.planRevisions.find((revision) => revision.revision === viewing) ?? null;
  const showVersion = (revision: number | null) => {
    setViewing(revision);
    // Bring the swapped-in plan's top into view (the list sits below it).
    requestAnimationFrame(() => document.querySelector('[data-testid="design-review"]')?.scrollIntoView({ block: "start" }));
  };

  const decisionControls = <>
        <p className="page-lede" data-testid="approve-meaning">
          {props.autoBuild && !latestRecord ? 'Next, Caddie prepares the screens for you to review. Building starts only after you approve the design.' : APPROVE_MEANING}
        </p>
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
                Approve plan
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
  </>;

  const versionHistory = props.planRevisions.length > 1 ? (
        <section id="earlier" data-testid="design-review-earlier">
          <h3>
            Earlier versions
            <span className="fold-count">{props.planRevisions.length - 1}</span>
          </h3>
          <ul className="fold-list">
            {props.planRevisions.slice(1).map((revision) => (
              <li
                className="fold-row"
                data-testid="design-review-row"
                data-latest="false"
                key={revision.id}
              >
                <span className="fold-row-main">
                  <span className="fold-row-title">Version {revision.revision}</span>
                  <span className="fold-row-meta">Written {formatTimeAgo(revision.createdAt)} · replaced</span>
                </span>
                {revision.body.trim() ? (
                  <button
                    type="button"
                    className="btn-ghost fold-row-action"
                    data-testid={`earlier-version-view-${revision.revision}`}
                    disabled={viewing === revision.revision}
                    onClick={() => showVersion(revision.revision)}
                  >
                    {viewing === revision.revision ? "Showing" : "View"}
                  </button>
                ) : (
                  <span className="fold-row-meta">No saved text</span>
                )}
              </li>
            ))}
          </ul>
        </section>
  ) : null;

  return (
    <div
      data-testid="design-review"
      className="design-review-panel settings-stack plan-review-surface"
    >
      {/* The version/status header leads. Decision controls follow the readable
          review; both decisions still use the revision-bound approvals API. */}
      {viewed ? (
        <section className="plan-decision plan-viewing" data-testid="plan-viewing">
          <div className="plan-decision-head">
            <h2 className="ev-title">Plan version {viewed.revision}</h2>
            <span className="badge" data-tone="neutral">Replaced</span>
          </div>
          <p className="page-lede">
            Written {formatTimeAgo(viewed.createdAt)}. Version {latest.revision} replaced it — this one is kept to read.
          </p>
          <div className="row-actions">
            <button type="button" className="btn-key" data-testid="plan-viewing-back" onClick={() => showVersion(null)}>
              Back to version {latest.revision}
            </button>
          </div>
        </section>
      ) : (
      <section
        className="card-surface settings-panel plan-decision"
        data-testid="design-review-decision-bar"
      >
        {/* One title row (owner 2026-10-23): "Plan version N" with the ask —
            or, once decided, the outcome — on the right. A plain "Ready for
            review" pill is not repeated here: the Plan step above already
            says it, so a badge appears only for an unusual state. */}
        <div className="plan-decision-head">
          <div className="project-caddie-heading"><Mascot mood={approved ? "done" : "needs"} size={48} /><h2 className="ev-title">Plan version {latest.revision}</h2></div>
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
          ) : approvalNote ? (
            <span className="badge" data-tone="warn" data-testid="design-review-status">
              {approvalNote}
            </span>
          ) : (
            <p className="kicker plan-decision-ask" data-tone="action">
              IS THIS OK?
            </p>
          )}
        </div>

      </section>
      )}

      {/* "How your app works" (team mode, plan part B): the approved
          architecture in plain words — what it stores, who can see what, its
          screens, its parts (big app), payments and emails, and the architect
          review's findings. The shell passes it in (HowYourAppWorks reads the
          shared experience projection); absent for a non-team-mode project. */}
      {/* Architecture detail is available inside the full-plan view. */}

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
              {props.autoBuild ? 'Next, Caddie prepares the screens for you to review.' : 'This records your approval of this plan.'}
            </p>
            {/* Only say something if it is genuinely useful here: a spending
               limit the owner actually set. At plan-approval there is no app to
               publish and no money is spent, so those "reassurances" are noise. */}
            {spendCap?.limit ? (
              <p className="state-detail" data-testid="approve-plan-spend">
                {`Your spending limit is ${spendCap.limit}${spendCap.settled ? ` (${spendCap.settled} used so far)` : ""}.`}
              </p>
            ) : null}
            <details className="approval-more" data-testid="approve-plan-more">
              <summary>More details</summary>
              <p className="state-detail">Publishing, merging code, and destructive database changes each need a separate approval later — this decision does none of them.</p>
            </details>
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
                {busy === "approved" ? "Approving…" : "Approve plan"}
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
            className="commit-panel card-surface plan-change-dialog"
            data-testid="request-changes-window"
            role="dialog"
            aria-modal="true"
            aria-labelledby="request-changes-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="plan-change-heading">
              <h3 id="request-changes-title">Suggest a change</h3>
              <button type="button" className="plan-change-close" aria-label="Close change request" disabled={busy !== null} onClick={() => setWindowOpen(null)}>×</button>
            </div>
            <p className="state-detail" id="request-changes-description">
              Tell Caddie what to adjust. Your feedback stays with plan version {latest.revision}.
            </p>
            <label className="plan-change-field">
              <span>Your feedback</span>
              <textarea
                className="input"
                rows={6}
                autoFocus
                aria-describedby="request-changes-description"
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
            <div className="row-actions plan-change-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setWindowOpen(null)}
                disabled={busy !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-key"
                data-testid="design-review-reject"
                disabled={busy !== null || !changeNote.trim()}
                onClick={() => {
                  void decide("rejected", latest);
                }}
              >
                {busy === "rejected" ? "Saving…" : "Save feedback"}
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
          sentence. Before a decision the plan IS the page: the toggle line is
          hidden (the bar above already names the version) and only appears,
          as a fold row, once the plan is approved and folded away. */}
      {viewed ? (
        <div className="plan-body" data-testid="plan-version-view">
          {viewed.body.trim() === "" ? (
            <p className="state-detail">This version has no saved text.</p>
          ) : (
            <PlanReview body={viewed.body} projectName={props.projectName} revisionHash={viewed.bodyHash} history={versionHistory} />
          )}
        </div>
      ) : (
      <details
        className={approved ? "plan-review-details fold" : "plan-review-details"}
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
            <PlanReview body={latest.body} projectName={props.projectName} revisionHash={latest.bodyHash} context={props.howItWorks} history={versionHistory} decision={!latestRecord ? decisionControls : undefined} />
          </div>
        )}

      </details>
      )}

      {!viewed && latestRecord ? <section className="plan-decision-footer" data-testid="plan-decision-actions">
        <h3>Your recorded decision</h3>
        {decisionControls}
      </section> : null}

      {/* Earlier versions (§4 anchor #earlier): one fold row like the others,
          a flat list inside. "View" swaps the version into the plan's place
          (with a way back) instead of nesting a second plan in the list.
          Hidden when there is nothing earlier (owner steering, 2026-10-15). */}


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

/**
 * The shared experience projection's "How your app works" overview for a
 * project, or null when there is none (a non-team-mode project, or a design
 * without a `caddie-architecture` block). Pass null to skip the read.
 */
export function useDesignOverview(projectId: string | null): DesignOverview | null {
  const chrome = useWorkspaceChrome();
  const experience = useProjectExperience({ actorId: chrome.actorId }, projectId);
  if (!experience.data) return null;
  const parsed = v.safeParse(ProjectExperienceSchema, experience.data);
  return parsed.success ? (parsed.output.design ?? null) : null;
}

/**
 * "How your app works" on the Plan tab, once the design is approved: what the
 * person approved, in plain words (team mode, plan part B, section 7 screen 1).
 * Before approval the same panel is shown where the design is decided
 * (ProjectWorkflow's design review), so here it renders NOTHING until this
 * exact design was approved: no bare heading, no empty card.
 */
export function HowYourAppWorks(props: { projectId: string }): ReactElement | null {
  const overview = useDesignOverview(props.projectId);
  if (!overview?.approved) return null;
  return <DesignOverviewPanel overview={overview} />;
}

/**
 * Why this design can't be approved yet, in one plain sentence, or null when it
 * can. Mirrors the server's design gate: a team-mode design needs the safety
 * review of this exact design, with no open security issue.
 */
export function designApprovalHold(overview: DesignOverview | null): string | null {
  if (!overview) return null;
  if (!overview.review) return "Caddie hasn’t finished the safety check of this design yet, so it can’t be approved.";
  if (overview.review.blocks) return "Caddie has to fix the safety problems above before you can approve this design.";
  return null;
}

/**
 * The overview itself (pure presentation). `framed` draws it as its own card
 * (the Plan tab); unframed, it sits inside the design-review card without a
 * card of its own.
 */
export function DesignOverviewPanel(props: {
  overview: DesignOverview;
  framed?: boolean;
}): ReactElement {
  const { overview } = props;
  const framed = props.framed ?? true;
  const big = overview.app === "big";
  const review = overview.review;
  const Heading = framed ? "h2" : "h3";
  const Sub = framed ? "h3" : "h4";
  const lede = overview.approved
    ? big
      ? "Your app is built in parts. Here is what it does, in plain words."
      : "Here is what your app does, in plain words."
    : big
      ? "Your app is big, so it is built in parts. Here is what it does, in plain words."
      : "Here is what your app does, in plain words, before anything is built.";
  // A big app groups its screens under their part; a small app lists them flat.
  const screensByModule = new Map<string, string[]>();
  for (const screen of overview.screens) {
    const list = screensByModule.get(screen.module) ?? [];
    list.push(screen.plain);
    screensByModule.set(screen.module, list);
  }
  return (
    <section
      className={framed ? "card-surface settings-panel how-app-works" : "how-app-works how-app-works-inline"}
      data-testid="how-app-works"
      data-app={overview.app}
      data-approved={overview.approved ? "true" : "false"}
    >
      <div className="r-section-head">
        <div>
          <p className="kicker" data-tone="action" data-testid="how-app-kicker">
            {overview.approved ? "What you approved" : "Before you approve"}
          </p>
          <Heading className="ev-title">How your app works</Heading>
          <p className="page-lede">{lede}</p>
        </div>
      </div>

      {/* The architect's review — security issues block approval, advisory
          issues are shown. Only drawn when the architect has run. */}
      {review ? (
        <div
          className="how-app-review"
          data-testid="how-app-review"
          data-blocks={review.blocks ? "true" : "false"}
        >
          {review.security.length > 0 ? (
            <div className="how-app-block" data-testid="how-app-security" role="alert">
              <Sub className="how-app-block-head">
                Caddie must fix these before building
              </Sub>
              <ul className="how-app-list">
                {review.security.map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="how-app-safe" data-testid="how-app-safe">
              Caddie’s safety review found nothing that blocks building.
            </p>
          )}
          {review.advisory.length > 0 ? (
            <div className="how-app-advisory" data-testid="how-app-advisory">
              <Sub className="how-app-block-head">Things to consider</Sub>
              <ul className="how-app-list">
                {review.advisory.map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The plain-words sections: what it stores, who can see what, sign-in,
          outside services, AI, and test-mode features. Each is non-empty. */}
      <div className="how-app-sections">
        {overview.sections.map((section) => (
          <div
            className="how-app-section"
            key={section.key}
            data-testid={`how-app-section-${section.key}`}
          >
            <Sub className="how-app-section-head">{section.heading}</Sub>
            <ul className="how-app-list">
              {section.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Its parts (modules), for a big app. */}
      {big && overview.modules && overview.modules.length > 0 ? (
        <div className="how-app-section" data-testid="how-app-modules">
          <Sub className="how-app-section-head">Its parts</Sub>
          <ul className="how-app-list">
            {overview.modules.map((module) => (
              <li key={module.id}>{module.plain}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Its screens, grouped by part when the app is big. */}
      <div className="how-app-section" data-testid="how-app-screens">
        <Sub className="how-app-section-head">Its screens</Sub>
        {big ? (
          (overview.modules ?? []).map((module) => {
            const screens = screensByModule.get(module.id) ?? [];
            if (screens.length === 0) return null;
            return (
              <div className="how-app-screen-group" key={module.id}>
                <span className="how-app-screen-group-head">{module.plain}</span>
                <ul className="how-app-list">
                  {screens.map((plain, i) => (
                    <li key={i}>{plain}</li>
                  ))}
                </ul>
              </div>
            );
          })
        ) : (
          <ul className="how-app-list">
            {overview.screens.map((screen, i) => (
              <li key={i}>{screen.plain}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
