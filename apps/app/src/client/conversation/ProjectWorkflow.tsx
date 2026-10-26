import { presentDesign } from "../planning/design-presentation.ts";
import { designCompletenessIssue } from "../../shared/design-completeness.ts";
import { ProjectDialog } from "../project/ProjectDialog.tsx";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { designWorkStatus } from "./design-work-status.ts";
import { useSharedAgentActivity, useSharedAgent } from "./agent-keeper.tsx";
import { Markdown } from "@caddie/ui/Markdown";
import type { PlanDocRevision, ApprovalRecord } from "@caddie/contracts";
import { parseAppTheme, parseLooks } from "@caddie/contracts";
import type { BuildWorkflow, WorkflowPhase } from "../../server/build-workflow.ts";
import { workflowHeaderStatus } from "../workspace/project-status.ts";
import { fetchJson, postJson } from "../api.ts";
import { useWorkspaceChrome } from "../workspace/Chrome.tsx";
import { useProjectRepo, useSourceSave, useBuildActivity, usePlanDocRevisions, type ProjectRepoView, type SourceSaveView } from "../queries.ts";
import { Icon } from "../icons.tsx";
import { InteractivePreview } from "../artifacts/InteractivePreview.tsx";
import { PrototypePreview } from "../artifacts/PrototypePreview.tsx";
import { DesignMockPreview } from "../artifacts/DesignMockPreview.tsx";
import { ReplyText } from "./ReplyText.tsx";
import { BuildProgress } from "../project/BuildProgress.tsx";
import { ModuleProgress } from "../project/ModuleProgress.tsx";
import { SavedFeatures } from "../project/FeatureChecklist.tsx";
import { PlanReview } from "../planning/PlanReview.tsx";
import { LooksPicker } from "../planning/LooksPicker.tsx";
import { AndroidDownload } from "../project/AndroidDownload.tsx";
import { AppKeys } from "../project/AppKeys.tsx";
import { PublishApp } from "../project/PublishApp.tsx";
import { AppVersions } from "../project/AppVersions.tsx";
import { AppAi } from "../project/AppAi.tsx";
import { TestInbox } from "../project/TestInbox.tsx";
import { AppJobs } from "../project/AppJobs.tsx";
import { ImportedApp, importedAppTitle } from "../project/ImportedApp.tsx";
import { CardHeader } from "../brief/CardFrame.tsx";
import type { CardDesign } from "../brief/card-design.ts";
import { workflowQueryOptions } from "../workflow-query.ts";
import { ProjectChatSummary } from "./ProjectChatSummary.tsx";
import { DesignOverviewPanel, designApprovalHold, useDesignOverview } from "../planning/DesignReview.tsx";

/** Phases before any build started: the copied app is still the one to try. */
const BEFORE_BUILD = new Set<WorkflowPhase>(["planning", "review", "looks", "looks-review", "design", "design-review"]);
const LABEL: Record<WorkflowPhase, string> = {
  planning: "Planning your app",
  review: "Your plan is ready",
  looks: "Preparing looks for your app",
  "looks-review": "Choose a look",
  design: "Designing your app",
  "design-review": "Your design is ready",
  building: "Building your app",
  blocked: "Needs attention",
  ready: "Your app is ready to try",
};
/** The detail stopWorkflow writes; marks a user stop (server: project-experience STOP_SENTINEL). */
const STOP_SENTINEL = "Stop requested.";
/** Approval statuses that mean the plan was approved at some point (server: planWasApproved). */
const PLAN_EVER_APPROVED: ReadonlySet<string> = new Set(["approved", "revoked", "expired"]);
/** A server-backed workspace inside the conversation, never model-markdown actions. */
export function ProjectWorkflow(props: {
  projectId: string;
  name?: string;
  showTranscript?: boolean;
  presentation?: "chat" | "workspace";
}) {
  if (props.presentation === "workspace" || props.showTranscript) return <ProjectWorkspace {...props} />;
  return <ProjectChatSummary projectId={props.projectId} name={props.name} />;
}

/** Full controls belong in the project workspace, never nested inside chat. */
function ProjectWorkspace({
  projectId,
  name,
  showTranscript = false,
}: {
  projectId: string;
  name?: string;
  showTranscript?: boolean;
}) {
  const chrome = useWorkspaceChrome();
  const state = useQuery({
    ...workflowQueryOptions(chrome.actorId, projectId),
    enabled: Boolean(chrome.actorId && chrome.homeProject?.id !== projectId),
  });
  const workflow = state.data?.workflow;
  // "How your app works" and its safety review, read only while the design is
  // up for review (it decides whether the design can be approved).
  const designOverview = useDesignOverview(workflow?.phase === "design-review" ? projectId : null);
  const activity = useBuildActivity({ actorId: chrome.actorId }, workflow?.phase === "building" ? projectId : null, false);
  const repairing = workflow?.phase === "building" && Boolean(activity.data && (activity.data.openIssues > 0 || activity.data.timeline?.stages.some(stage => stage.state === "failed")));
  const repoQuery = useProjectRepo(
    { actorId: chrome.actorId },
    chrome.homeProject?.id === projectId ? null : projectId,
  );
  const linkedRepo = repoQuery.data?.repo ?? null;
  // A block BEFORE any approved plan is a stuck plan, not a stuck build:
  // there is nothing built to "retry". Tell the truth and resume planning.
  // Same rule as the server (project-experience stageOf + retryWorkflow): a
  // user stop is always a stopped build (stopWorkflow only stops a build),
  // and a plan whose approval later expired or was revoked was still
  // approved, so its retry resumes the build, not planning.
  const stopped = workflow?.phase === "blocked" && Boolean(workflow.detail?.startsWith(STOP_SENTINEL));
  const planEverApproved = PLAN_EVER_APPROVED.has(state.data?.approval?.status ?? "");
  const planningBlocked = workflow?.phase === "blocked" && !stopped && !planEverApproved;
  // Shared warm session (agent-keeper): visiting the project page adopts the
  // already-reduced transcript instead of replaying the whole stream per mount.
  const agent = useSharedAgent(
    workflow && (showTranscript || ["planning", "looks", "design"].includes(workflow.phase))
      ? `/agents/coordinator/${encodeURIComponent(workflow.conversationId)}`
      : undefined,
  );
  const observedActivity = useSharedAgentActivity(workflow ? `/agents/coordinator/${encodeURIComponent(workflow.conversationId)}` : undefined);
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => { if (!workflow || !["planning","looks","design"].includes(workflow.phase)) return; const timer=setInterval(()=>setNowMs(Date.now()),15_000); return ()=>clearInterval(timer); },[workflow?.phase]);
  const designStatus = designWorkStatus({ source:agent, updatedAt:workflow?.updatedAt ?? '', observedAt:observedActivity, now:nowMs });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState(false);
  const [note, setNote] = useState("");
  const retryKey = useRef<string | null>(null);
  const designRetryKey = useRef<string | null>(null);
  const designRetrying = useRef(false);
  async function retryDesign() {
    if (designRetrying.current) return;
    designRetrying.current=true; setBusy(true); setError(null);
    designRetryKey.current ??= `design-retry:${crypto.randomUUID()}`;
    try {
      await agent.sendMessage('Continue preparing the design for the already approved plan and chosen look. Preserve the saved scope and theme. Save the complete design and stop for my review; do not build yet.',{idempotencyKey:designRetryKey.current});
      designRetryKey.current=null;
      await state.refetch();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The design could not be resumed. Try again.'); }
    finally {designRetrying.current=false;setBusy(false);}
  }

  // R02: dispatch is server-owned. The browser no longer drives it — it only
  // observes the workflow state via the polling refetch below. The old
  // resume-on-pendingKey effect is gone; a pending message is delivered to the
  // coordinator DO by the decision/retry route, and the DO drain owns re-delivery.
  async function decide(decision: "approved" | "rejected") {
    if (!state.data?.plan) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(
        `/api/projects/${encodeURIComponent(projectId)}/workflow/decision`,
        {
          planId: state.data.plan.id,
          decision,
          note: decision === "rejected" ? note : undefined,
        },
      );
      setChanges(false);
      setNote("");
      chrome.refreshAll();
      await state.refetch();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Caddie could not save your decision.",
      );
    } finally {
      setBusy(false);
    }
  }
  // The DESIGN-brief gate (parallel to decide, which gates the PRD): approve ->
  // building, request changes -> re-author the brief.
  async function decideDesignBrief(decision: "approved" | "rejected") {
    if (!state.data?.design) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(
        `/api/projects/${encodeURIComponent(projectId)}/workflow/design-decision`,
        {
          designId: state.data.design.id,
          decision,
          note: decision === "rejected" ? note : undefined,
        },
      );
      setChanges(false);
      setNote("");
      chrome.refreshAll();
      await state.refetch();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Caddie could not save your decision.",
      );
    } finally {
      setBusy(false);
    }
  }
  // The LOOKS gate: choose a look -> design (the brief is written in that
  // look), or ask for different looks -> back to the looks step. Server-owned
  // dispatch, like the design decision, so the next step runs even if the
  // browser closes.
  async function decideLooks(body: { looksId: string; choice?: string; more?: boolean; note?: string }) {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/looks-decision`, body);
      setNote("");
      chrome.refreshAll();
      await state.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Caddie could not save your choice.");
    } finally {
      setBusy(false);
    }
  }
  if (chrome.homeProject?.id === projectId) return null;
  if (state.isPending)
    return (
      <p role="status" className="state-detail">
        Loading your project…
      </p>
    );
  if (state.error)
    return (
      <div role="alert" className="state-detail">
        Your project could not be loaded.{" "}
        <button className="btn-ghost" onClick={() => void state.refetch()}>
          Try again
        </button>
      </div>
    );
  const importPreview = state.data?.importPreview ?? null;
  if (!workflow) {
    // Right after "Start from my GitHub repo", before anything is planned.
    if (!importPreview || !chrome.actorId) return null;
    return (
      <section
        className="caddie-card project-workflow"
        data-testid="project-workflow"
        data-phase="imported"
        data-design={importPreview.status === "ready" ? "preview" : "update"}
        data-tone={importPreview.status === "failed" ? "quiet" : importPreview.status === "ready" ? "green" : "blue"}
        aria-label={name ? `${name} project` : "Your project"}
      >
        <CardHeader design={importPreview.status === "ready" ? "preview" : "update"} context={name} status={importPreview.status === "ready" ? "Ready to try" : importPreview.status === "failed" ? "Needs attention" : "Checking"} />
      <div className="workflow-heading">
          <div>
            <p className="kicker">{name ?? "YOUR PROJECT"}</p>
            <h3>{importedAppTitle(importPreview)}</h3>
          </div>
        </div>
        <ImportedApp
          actorId={chrome.actorId}
          projectId={projectId}
          preview={importPreview}
          onChange={() => void state.refetch()}
        />
      </section>
    );
  }
  const plan = state.data?.plan;
  const active = agent.status === "streaming" || agent.status === "submitted";
  const lastSettlement = agent.settlements.at(-1);
  const failed = lastSettlement && lastSettlement.outcome !== "completed";
  // Prefer the newest SETTLED text: while a message streams, its text parts are
  // state:"streaming" and "any text" would flip the pick between the previous
  // message and the streaming one on every publish — the visible alternation
  // above the card. A settled pick only changes when a message completes.
  const textPart = (p: { type: string; state?: string; text?: string }, settled: boolean) =>
    p.type === "text" && (p.text ?? "").trim() && (!settled || p.state === "done");
  const withText = (settled: boolean) =>
    [...agent.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.parts.some((p) => textPart(p, settled)));
  const latestMessage = showTranscript ? (withText(true) ?? withText(false)) : null;
  // Plain-text of the latest assistant line, for the build-progress "latest"
  // row (joined non-empty text parts, trimmed to a readable length).
  const buildLatestText = latestMessage
    ? (latestMessage.parts
        .map((p) => (p.type === "text" ? p.text.trim() : ""))
        .filter((text) => text.length > 0)
        .join(" ")
        .slice(0, 240) || null)
    : null;
  const design: CardDesign = workflow.phase === 'ready' ? 'preview' : workflow.phase === 'building' ? repairing ? 'repair' : 'build' : workflow.phase === 'blocked' ? 'update' : 'plan';
  // The status text the header badge shows, and the phase title — kept apart so
  // the title only renders when it adds something the badge does not.
  const headerStatus = workflowHeaderStatus({ phase: workflow.phase, previewId: workflow.previewId }, { designFailed: workflow.phase === 'design' && designStatus.kind === 'failed', repairing });
  const phaseTitle = workflow.phase === 'design' && designStatus.kind === 'failed' ? 'Design needs attention' : planningBlocked ? 'Plan needs another pass' : LABEL[workflow.phase];
  return (
    <section
      className="caddie-card project-workflow"
      data-testid="project-workflow"
      data-phase={workflow.phase}
      data-design={design}
      data-tone={design === "preview" ? "green" : design === "repair" ? "amber" : "blue"}
      aria-label={name ? `${name} project` : "Your project"}
    >
      {workflow.phase !== "building" ? <>
        <CardHeader design={design} context={name} status={headerStatus} />
        {/* Owner 2026-10-25: no "YOUR PROJECT" kicker and no heading that merely
            repeats the badge/tab status — the phase title renders only when it
            says something the badge does not ("Choose a look", "Your plan is
            ready"). */}
        {phaseTitle !== headerStatus ? (
        <div className="workflow-heading">
          <div>
            <h3>{phaseTitle}</h3>
          </div>
          {/* In this project's own chat its page is already open (beside the chat
              on desktop, under it on a phone), so "Open project" would go nowhere. */}
          {chrome.conversation.kind === "project" && chrome.conversation.projectId === projectId ? null : (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => chrome.openProject(projectId, true)}
            >
              Open project
            </button>
          )}
        </div>
        ) : null}
      </> : null}
      {workflow.phase === "blocked" && active ? (
        <button type="button" className="btn-ghost" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try {
            // One Stop for every button (plan 3.2): the server stops the
            // workflow, then the running turn.
            await postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/stop`, {});
            await state.refetch();
          } catch (cause) { setError(cause instanceof Error ? cause.message : "The stop request failed."); }
          finally { setBusy(false); }
        }}>Stop build</button>
      ) : null}
      {workflow.phase === "planning" ? (
        state.data?.dispatchStalled ? (
          <div className="state-detail state-detail--error" data-testid="dispatch-stalled">
            <p>
              Caddie couldn’t pick up your request to turn it into a plan. Nothing
              was charged and nothing was lost — your request is saved. Retry and
              Caddie will try again.
            </p>
            <button
              type="button"
              className="btn-ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  // Re-poll the workflow route, which re-runs the server-side
                  // recovery (recoverStalledDispatch) with the SAME idempotency
                  // key — so a retry can never start a second plan or charge.
                  await state.refetch();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "The retry request failed.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : (
          <p className="state-detail">
            Caddie is turning your request into a plan. You’ll review it before
            building starts.
          </p>
        )
      ) : null}
      {workflow.phase === "review" && plan ? (
        <PlanReview
          body={plan.body}
          title={name}
          projectName={name ?? chrome.selectedProject?.name}
          version={plan.revision}
          decision={
            <>
              {/* Reassurance STRIP: the safety facts the host actually enforces
                  (sandbox build; deploy/spend gated behind a separate approval),
                  as glanceable chips instead of a grey paragraph the user must
                  read to feel safe. */}
              <div className="workflow-assurance" data-testid="workflow-assurance">
                <span className="workflow-chip workflow-chip-ok">
                  <Icon name="shield" title="" /> Runs in a sandbox
                </span>
                <span className="workflow-chip">No deploy</span>
                <span className="workflow-chip">No spending</span>
                <span className="workflow-assurance-note">— those need separate permission</span>
              </div>
              <div className="row-actions">
                <button
                  className="btn-key"
                  disabled={busy}
                  onClick={() => void decide("approved")}
                >
                  {busy ? "Saving…" : "Approve plan"}
                </button>
                <button
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => setChanges(!changes)}
                >
                  Suggest a change
                </button>
              </div>
              {/* Repo connection is OPTIONAL housekeeping, not a warning about
                  approving: one quiet footnote BELOW the actions, never a
                  caution-coloured paragraph above the primary button. */}
              {!repoQuery.isPending && !linkedRepo ? (
                <p className="state-detail workflow-repo-nudge" data-testid="workflow-repo-nudge">
                  <Icon name="github" title="" /> Your code lives only in the sandbox for now.{" "}
                  <button
                    type="button"
                    className="r-link"
                    data-testid="workflow-connect-repo"
                    onClick={() => chrome.goProjectTab("/project/settings", { project: projectId })}
                  >
                    Connect a GitHub repo
                  </button>{" "}
                  to save it — now or after the build.
                </p>
              ) : null}
              {changes ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void decide("rejected");
                  }}
                >
                  <label htmlFor={`change-${projectId}`} className="state-detail">
                    What should change?
                  </label>
                  <textarea
                    id={`change-${projectId}`}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={2000}
                    rows={3}
                  />
                  <button className="btn-key" disabled={busy || !note.trim()}>
                    {busy ? "Saving…" : "Send feedback"}
                  </button>
                </form>
              ) : null}
            </>
          }
        />
      ) : null}
      {workflow.phase === "looks" ? (
        <p className="state-detail">
          Caddie is putting together a few looks for your app — different colours
          and styles to choose from. You’ll pick one before the screens are
          designed.
        </p>
      ) : null}
      {workflow.phase === "looks-review" && state.data?.looks ? (
        (() => {
          const parsed = parseLooks(state.data.looks.body);
          if (!parsed.ok)
            return (
              <p className="state-detail" role="status" data-testid="looks-unavailable">
                Caddie is still preparing the looks. This will refresh on its own.
              </p>
            );
          return (
            <LooksPicker key={state.data.looks.id}
              set={parsed.set}
              busy={busy}
              onChoose={(lookId, lookNote) =>
                void decideLooks({ looksId: state.data!.looks!.id, choice: lookId, note: lookNote || undefined })
              }
              onMore={(lookNote) =>
                void decideLooks({ looksId: state.data!.looks!.id, more: true, note: lookNote || undefined })
              }
            />
          );
        })()
      ) : null}
      {workflow.phase === "design" ? (
        <div className="design-work-progress" data-testid="design-work-progress" data-state={designStatus.kind}>
          <p role={designStatus.kind === 'failed' ? 'alert' : 'status'}><strong>{designStatus.title}</strong></p>
          <p className="state-detail">{designStatus.detail}</p>
          <p className="state-detail">You’ll review the screens before building starts.</p>
          <div className="row-actions">
            {designStatus.kind === 'failed' || designStatus.kind === 'waiting' ? <button type="button" className="btn-key" disabled={busy} onClick={() => void retryDesign()}>{busy ? 'Continuing…' : designStatus.kind === 'failed' ? 'Retry design' : 'Continue design'}</button> : <button type="button" className="btn-ghost" onClick={() => { agent.refresh(); void state.refetch(); }}>Check status</button>}
            <button type="button" className="btn-ghost" onClick={() => chrome.openProject(projectId,true)}>Discuss with Caddie</button>
          </div>
        </div>
      ) : null}
      {workflow.phase === "design-review" && state.data?.design ? (
        <>
          {/* "How your app works" (team mode, part B): the plain summary and
              the safety review of this exact design, read before approving. */}
          {designOverview ? <DesignOverviewPanel overview={designOverview} framed={false} /> : null}
          <DesignBriefPreview projectId={projectId} design={state.data.design} looks={state.data.looks} />
          {/* Same reassurance the plan review carries — approving the design is
              the gate to a sandbox build, and deploy/spend stay separate. */}
          <div className="workflow-assurance" data-testid="workflow-design-assurance">
            <span className="workflow-chip workflow-chip-ok">
              <Icon name="shield" title="" /> Runs in a sandbox
            </span>
            <span className="workflow-chip">No deploy</span>
            <span className="workflow-chip">No spending</span>
            <span className="workflow-assurance-note">— those need separate permission</span>
          </div>
          <div className="row-actions">
            <button
              className="btn-key"
              disabled={busy || designApprovalHold(designOverview) !== null || designCompletenessIssue(state.data.design.body) !== null}
              data-testid="workflow-approve-design"
              onClick={() => void decideDesignBrief("approved")}
            >
              {busy ? "Saving…" : "Looks good — build it"}
            </button>
            <button
              className="btn-ghost"
              disabled={busy}
              onClick={() => setChanges(!changes)}
            >
              Suggest a change
            </button>
          </div>
          {designCompletenessIssue(state.data.design.body) ? <p role="status" className="state-detail">{designCompletenessIssue(state.data.design.body)} Use “Suggest a change” to ask Caddie to combine the saved parts.</p> : null}
          {designApprovalHold(designOverview) ? (
            <p className="state-detail" data-testid="workflow-approve-hold">
              {designApprovalHold(designOverview)}
            </p>
          ) : null}
          {changes ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void decideDesignBrief("rejected");
              }}
            >
              <label htmlFor={`design-change-${projectId}`} className="state-detail">
                What should change about the design?
              </label>
              <textarea
                id={`design-change-${projectId}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                rows={3}
              />
              <button className="btn-key" disabled={busy || !note.trim()}>
                {busy ? "Saving…" : "Send feedback"}
              </button>
            </form>
          ) : null}
        </>
      ) : null}
      {workflow.phase === "building" ? (
        <>
          {chrome.actorId ? (
            <BuildProgress
              actorId={chrome.actorId}
              projectId={projectId}
              latest={buildLatestText}
              onRefresh={async () => {
                const result = await state.refetch();
                if (result.error) throw result.error;
              }}
              onStop={async () => {
                await postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/stop`, {});
                const result = await state.refetch();
                if (result.error) throw result.error;
              }}
            />
          ) : null}
        </>
      ) : null}
      {workflow.detail || workflow.phase === "blocked" ? (
        <div className="state-detail" role="status">
          {(() => {
            const detail = workflow.detail;
            // Human-written details (a user stop, short pointers) read as-is.
            // The raw multi-sentence coordinator report is developer language:
            // lead with one plain sentence, keep the full report honestly
            // available behind the disclosure (owner 2026-10-25).
            if (!detail) {
              return planningBlocked
                ? "Caddie didn't finish the plan. Nothing was built — continue and it will pick up your request and feedback."
                : "Build stopped. Your plan and saved files are retained.";
            }
            if (detail.startsWith(STOP_SENTINEL) || detail.length <= 200) return detail;
            return (
              <>
                Caddie hit a blocker while building. Nothing was lost — retry when
                you’re ready, or ask Caddie what happened.
                <details className="state-detail-report">
                  <summary>Technical report</summary>
                  {detail}
                </details>
              </>
            );
          })()}
        </div>
      ) : null}
      {workflow.phase === "blocked" ? (
        <div className="row-actions">
          <button
            className="btn-key"
            disabled={busy || active}
            onClick={() => {
              retryKey.current ??= `resume:${crypto.randomUUID()}`;
              setBusy(true);
              setError(null);
              void postJson(
                `/api/projects/${encodeURIComponent(projectId)}/workflow/retry`,
                { key: retryKey.current },
              )
                .then(() => state.refetch())
                .then(() => {
                  retryKey.current = null;
                })
                .catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : planningBlocked
                        ? "The plan could not resume."
                        : "The build could not resume.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy
              ? planningBlocked
                ? "Continuing…"
                : "Resuming…"
              : planningBlocked
                ? "Continue the plan"
                : "Retry build"}
          </button>
          <button
            className="btn-ghost"
            onClick={() => chrome.openProject(projectId, true)}
          >
            Review with Caddie
          </button>
        </div>
      ) : null}
      {workflow.phase === "blocked" && !planningBlocked && chrome.actorId ? (
        <SavedFeatures actorId={chrome.actorId} projectId={projectId} />
      ) : null}
      {importPreview && chrome.actorId && (BEFORE_BUILD.has(workflow.phase) || planningBlocked) ? (
        <ImportedApp
          actorId={chrome.actorId}
          projectId={projectId}
          preview={importPreview}
          onChange={() => void state.refetch()}
          titled
        />
      ) : null}
      {latestMessage && workflow.phase !== "review" ? (
        <details className="workflow-updates">
          <summary>{active ? "Caddie is working…" : "Latest update"}</summary>
          {latestMessage.parts
            .filter((p) => p.type === "text")
            .map((p, i) =>
              p.type === "text" ? <ReplyText key={i} text={p.text} streaming={p.state === "streaming"} guardedArtifacts /> : null,
            )}
        </details>
      ) : null}
      {workflow.phase === "ready" && workflow.previewId && chrome.actorId ? (
        <>
          <p className="state-detail" data-testid="workflow-ready-detail" data-app-preview="">
            {workflow.detail ?? "Build checks passed. Try the app below and tell Caddie what you’d like to change."}
          </p>
          {/* A big app finished without some parts: the board lists them, each with Try again. */}
          <div data-testid="ready-parts">
            <ModuleProgress projectId={projectId} missingOnly />
          </div>
          <InteractivePreview
            actorId={chrome.actorId}
            projectId={projectId}
            artifactId={workflow.previewId}
            contentUrl={`/api/projects/${encodeURIComponent(projectId)}/workflow/preview/${encodeURIComponent(workflow.previewId)}`}
            {...(state.data?.previewKind === "flutter" ? { kind: "flutter" as const } : {})}
            {...(state.data?.previewHasServer
              ? {
                  appRequestUrl: `/api/projects/${encodeURIComponent(projectId)}/workflow/preview/${encodeURIComponent(workflow.previewId)}/app`,
                  onResetData: async () => {
                    await postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/preview-data/reset`, {});
                  },
                }
              : {})}
          />
          {state.data?.previewHasServer ? <TestInbox actorId={chrome.actorId} projectId={projectId} /> : null}
          {state.data?.previewHasServer ? <AppJobs actorId={chrome.actorId} projectId={projectId} outputId={workflow.previewId} /> : null}
          <details className="workflow-checks"><summary>What Caddie checked</summary>
            <SavedFeatures actorId={chrome.actorId} projectId={projectId} />
          </details>
          <details className="workflow-app-options"><summary>App settings, versions & delivery</summary>
          <AppKeys actorId={chrome.actorId} projectId={projectId} hasServer={Boolean(state.data?.previewHasServer)} />
          <PublishApp actorId={chrome.actorId} projectId={projectId} />
          {state.data?.previewKind === "flutter" ? <AndroidDownload actorId={chrome.actorId} projectId={projectId} /> : null}
          <AppVersions actorId={chrome.actorId} projectId={projectId} onRestored={() => state.refetch()} />
          <AppAi actorId={chrome.actorId} projectId={projectId} />
          <SaveToGithub
            actorId={chrome.actorId}
            projectId={projectId}
            previewId={workflow.previewId}
            repo={linkedRepo}
            onConnect={() => chrome.goProjectTab("/project/settings", { project: projectId })}
          />
          </details>
        </>
      ) : null}
      {failed && workflow.phase !== "ready" && !active ? (
        <p role="status" className="state-detail">
          A previous attempt stopped. Your plan and saved files are retained.
          Continue with Caddie to diagnose it.
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="state-detail">
          {error}
          <button
            className="btn-ghost"
            disabled={busy}
            onClick={() => {
              setError(null);
              void state.refetch();
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** "42 files · left out node_modules/, dist/, .env" — what the save carried, in one line. */
function sourceSummary(save: SourceSaveView): string {
  const leftOut = save.skipped.filter((skip) => skip.reason !== "noise").map((skip) => skip.path);
  const parts = [`${save.fileCount} ${save.fileCount === 1 ? "file" : "files"}`];
  if (leftOut.length > 0)
    parts.push(`left out ${leftOut.slice(0, 3).join(", ")}${leftOut.length > 3 ? ` and ${leftOut.length - 3} more` : ""}`);
  if (save.deleted.length > 0)
    parts.push(`removes ${save.deleted.length} deleted ${save.deleted.length === 1 ? "file" : "files"}`);
  return parts.join(" · ");
}

/**
 * Save the code to GitHub. The SERVER reads the checked build's source from
 * its sandbox image and opens a pull request on its own branch, never the
 * default branch, so saving needs no approval. The live pull request then
 * offers Merge, which records an approval for exactly its head commit before
 * the merge runs, and Close. With no repo linked yet it points at Code
 * settings instead of pretending it can save.
 */
function SaveToGithub(props: {
  actorId: string;
  projectId: string;
  previewId: string;
  repo: ProjectRepoView | null;
  onConnect: () => void;
}): ReactElement {
  const repo = props.repo;
  const status = useSourceSave({ actorId: props.actorId }, repo ? props.projectId : null);
  const [busy, setBusy] = useState<"save" | "merge" | "close" | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const githubPath = `/api/projects/${encodeURIComponent(props.projectId)}/github`;

  async function act(kind: "save" | "merge" | "close", run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await run();
      setConfirmMerge(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      void status.refetch();
    }
  }

  if (!repo) {
    return (
      <div className="save-github" data-testid="save-github-no-repo">
        <p className="state-detail">
          Want to keep this code? GitHub is the home for each project&rsquo;s code.{" "}
          <button type="button" className="r-link" onClick={props.onConnect} data-testid="save-github-connect">
            Connect a repo in Code settings
          </button>{" "}
          and come back to save it.
        </p>
      </div>
    );
  }

  const save = status.data?.save ?? null;
  const pr = status.data?.pullRequest ?? null;
  const mergeIntent = status.data?.mergeIntent ?? null;
  const savedThisBuild = save !== null && save.outputId === props.previewId && save.pullRequestNumber !== null;
  const base = pr?.baseBranch || "main";
  const prLink = (label: string, url: string | null) =>
    url ? (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    ) : (
      label
    );

  return (
    <div className="save-github" data-testid="save-github">
      {!savedThisBuild ? (
        <>
          <p className="state-detail">
            Save this app&rsquo;s code to <b>{repo.repoFullName}</b> as a pull request. Nothing changes in the
            repo until you merge it.
          </p>
          {save?.pullRequestNumber ? (
            <p className="save-github-meta" data-testid="save-github-earlier">
              An earlier build is saved as {prLink(`pull request #${save.pullRequestNumber}`, save.htmlUrl)}.
            </p>
          ) : null}
          <div className="row-actions">
            <button
              type="button"
              className="btn-key"
              data-testid="save-github-save"
              disabled={busy !== null || status.isPending}
              onClick={() => void act("save", () => postJson(`${githubPath}/source`, { outputId: props.previewId }))}
            >
              <Icon name="github" title="" /> {busy === "save" ? "Saving…" : "Save code to GitHub"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="state-detail" data-testid="save-github-pr">
            Saved as {prLink(`pull request #${save.pullRequestNumber}`, pr?.htmlUrl ?? save.htmlUrl)} on{" "}
            <b>{repo.repoFullName}</b>.
          </p>
          <p className="save-github-meta">{sourceSummary(save)}</p>
          {status.data?.pullRequestError ? (
            <p className="save-github-meta" role="status">
              Couldn&rsquo;t check the pull request on GitHub: {status.data.pullRequestError}{" "}
              <button type="button" className="r-link" onClick={() => void status.refetch()}>
                Check again
              </button>
            </p>
          ) : pr?.state === "merged" ? (
            <p className="state-detail save-github-state" data-state="merged" data-testid="save-github-merged">
              <Icon name="check" title="" />
              <span>
                Merged into <b>{base}</b>.
              </span>
            </p>
          ) : pr?.state === "closed" ? (
            <p className="state-detail" data-testid="save-github-closed">
              Closed without merging. {prLink("Reopen it on GitHub", pr.htmlUrl)} to merge it.
            </p>
          ) : pr?.state === "open" && confirmMerge ? (
            <div className="save-github-confirm" role="group" aria-label={`Merge pull request #${pr.number}`}>
              <span className="save-github-confirm-text">
                Merge pull request #{pr.number} into <b>{base}</b>? Caddie merges exactly commit{" "}
                <code>{pr.headSha.slice(0, 7)}</code>. A merge can&rsquo;t be undone from Caddie.
              </span>
              <button
                type="button"
                className="btn-key"
                data-testid="save-github-merge-confirm"
                disabled={busy !== null || !mergeIntent}
                onClick={() =>
                  void act("merge", async () => {
                    // The approval is for this PR at this exact commit; the server
                    // re-checks it and pins the merge to the same commit.
                    await postJson("/api/approvals", { intent: mergeIntent, decision: "approved" });
                    await postJson(`${githubPath}/pulls/${pr.number}/merge`, {
                      repoFullName: save.repoFullName,
                      headSha: pr.headSha,
                    });
                  })
                }
              >
                {busy === "merge" ? "Merging…" : "Approve and merge"}
              </button>
              <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => setConfirmMerge(false)}>
                Cancel
              </button>
            </div>
          ) : pr?.state === "open" ? (
            <>
              {pr.mergeable === false ? (
                <p className="save-github-meta" role="status" data-testid="save-github-conflict">
                  GitHub reports a conflict with <b>{base}</b>. Resolve it on GitHub, then merge.
                </p>
              ) : null}
              <div className="row-actions">
                <button
                  type="button"
                  className="btn-key"
                  data-testid="save-github-merge"
                  disabled={busy !== null || pr.mergeable === false || !mergeIntent}
                  onClick={() => setConfirmMerge(true)}
                >
                  Merge into {base}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  data-testid="save-github-close"
                  disabled={busy !== null}
                  onClick={() =>
                    void act("close", () =>
                      postJson(`${githubPath}/pulls/${pr.number}/close`, { repoFullName: save.repoFullName }),
                    )
                  }
                >
                  {busy === "close" ? "Closing…" : "Close pull request"}
                </button>
              </div>
            </>
          ) : null}
        </>
      )}
      {error ? (
        <div role="alert" className="state-detail save-github-error" data-testid="save-github-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

/** The saved design remains readable after approval without repeating its controls. */
export function DesignBriefPreview({ projectId, design, looks, readOnly = false }: { projectId: string; design: PlanDocRevision; looks?: PlanDocRevision | null; readOnly?: boolean }) {
  const chrome = useWorkspaceChrome();
  const revisions = usePlanDocRevisions({actorId:chrome.actorId}, projectId);
  const [open, setOpen] = useState(false);
  const [compare, setCompare] = useState(false);
  const [lookId, setLookId] = useState<string | null>(null);
  const [revisionId, setRevisionId] = useState(design.id);
  const versions = (revisions.data?.revisions ?? []).filter(item => item.kind === 'design').sort((a,b) => b.revision-a.revision);
  const selected = readOnly ? versions.find(item => item.id === revisionId) ?? design : design;
  const {notes, mocks, prototype} = presentDesign(selected.body);
  const parsed = parseAppTheme(selected.body);
  const theme = parsed.ok ? parsed.theme : null;
  const lookSet = looks ? parseLooks(looks.body) : null;
  const earlierLook = lookSet?.ok ? lookSet.set.looks.find(item => item.id === lookId) ?? lookSet.set.looks[0] : null;
  return <div className="design-review-content">
    <header className="design-review-toolbar">
      <div><h3>{theme?.name ?? 'Screen designs'}</h3><p>{mocks.length} {mocks.length === 1 ? 'screen' : 'screens'} in this saved version</p></div>
      {/* Owner 2026-10-25: the version picker lives on the header row, and the
          split-design explanation folds into it (title + sr-only) instead of a
          full warning banner — reconciliation language, not user language. */}
      {versions.length > 1 ? <label className="design-version-picker" title={designCompletenessIssue(selected.body) ? 'This is one part of a split design. Earlier saved parts are available in the version list; they are not alternative designs.' : undefined}>Saved version{designCompletenessIssue(selected.body) ? <span className="sr-only"> This is one part of a split design. Earlier saved parts are available in the version list; they are not alternative designs.</span> : null}<select value={selected.id} onChange={event => setRevisionId(event.target.value)}>{versions.map(item => <option key={item.id} value={item.id}>Version {item.revision}{designCompletenessIssue(item.body) ? ' · saved part' : ''}</option>)}</select></label> : null}
    </header>
    {mocks.length ? <DesignMockPreview mocks={mocks} theme={theme} /> : <p className="state-detail">This version has no screen previews. Its design notes are available below.</p>}
    {prototype ? <PrototypePreview key={selected.id} prototype={prototype} theme={theme} /> : null}
    <footer className="design-review-footer"><span>Screen mockups, before the working app.</span><span className="design-review-footer-actions">{lookSet?.ok ? <button type="button" className="btn-ghost" onClick={() => setCompare(true)}>Compare earlier looks</button> : null}<button type="button" className="btn-ghost" onClick={() => setOpen(true)}>Design details</button></span></footer>
    <ProjectDialog open={open} onClose={() => setOpen(false)} title="Design details" wide>
      <div className="design-notes-intro"><h3>About these screens</h3><p>{mocks.length} screens saved in version {selected.revision}. The preview shows the visual design; it does not test saving or other app behaviour.</p></div>
      {mocks.length ? <ul className="design-screen-index">{mocks.map((mock,index) => <li key={index}>{mock.title}</li>)}</ul> : null}
      <details className="design-source-notes"><summary>Read the saved specification</summary><div className="workflow-plan" data-testid="workflow-design-brief"><Markdown text={notes} /></div></details>
    </ProjectDialog>
    <ProjectDialog open={compare} onClose={() => setCompare(false)} title="Earlier look options" wide>
      <p className="state-detail">These were the visual directions proposed before the screen design. Comparing them does not change your chosen look or the active build.</p>
      {lookSet?.ok && earlierLook ? <>
        <nav className="review-subnav" aria-label="Earlier looks">{lookSet.set.looks.map(look => <button type="button" key={look.id} aria-pressed={earlierLook.id === look.id} onClick={() => setLookId(look.id)}>{look.name}</button>)}</nav>
        <p>{earlierLook.why}</p><DesignMockPreview mocks={[earlierLook.screen ?? lookSet.set.screen]} theme={earlierLook} />
      </> : null}
    </ProjectDialog>
  </div>;
}
