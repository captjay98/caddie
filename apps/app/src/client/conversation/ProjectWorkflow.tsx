import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { useFlueAgent } from "@flue/react";
import { Markdown } from "@caddie/ui/Markdown";
import type { PlanDocRevision, ApprovalRecord } from "@caddie/contracts";
import { splitFeatureBlock, splitDesignMocks } from "@caddie/contracts";
import type { BuildWorkflow, WorkflowPhase } from "../../server/build-workflow.ts";
import { fetchJson, postJson } from "../api.ts";
import { useWorkspaceChrome } from "../workspace/Chrome.tsx";
import { useProjectRepo, useSourceSave, type ProjectRepoView, type SourceSaveView } from "../queries.ts";
import { Icon } from "../icons.tsx";
import { InteractivePreview } from "../artifacts/InteractivePreview.tsx";
import { DesignMockPreview } from "../artifacts/DesignMockPreview.tsx";
import { ReplyText } from "./ReplyText.tsx";
import { BuildProgress } from "../project/BuildProgress.tsx";
import { PlanFeatureList, SavedFeatures } from "../project/FeatureChecklist.tsx";
import { AndroidDownload } from "../project/AndroidDownload.tsx";
import { AppKeys } from "../project/AppKeys.tsx";
import { PublishApp } from "../project/PublishApp.tsx";
import { AppVersions } from "../project/AppVersions.tsx";
import { AppAi } from "../project/AppAi.tsx";
import { TestInbox } from "../project/TestInbox.tsx";
import { ImportedApp, importedAppTitle } from "../project/ImportedApp.tsx";
import type { ImportPreviewView } from "../../server/import-preview.ts";

interface Snapshot {
  workflow: BuildWorkflow | null;
  plan: PlanDocRevision | null;
  approval: ApprovalRecord | null;
  design: PlanDocRevision | null;
  designApproval: ApprovalRecord | null;
  /** The checked build has a server (relay /api calls; offer Reset test data). */
  previewHasServer?: boolean;
  /** "flutter": an Android app's browser preview (Track 3). */
  previewKind?: "web" | "flutter";
  /** "Start from my GitHub repo": the copied app, until the first build has its own preview. */
  importPreview?: ImportPreviewView | null;
}
/** Phases before any build started: the copied app is still the one to try. */
const BEFORE_BUILD = new Set<WorkflowPhase>(["planning", "review", "design", "design-review"]);
const LABEL: Record<WorkflowPhase, string> = {
  planning: "Planning your app",
  review: "Your plan is ready",
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
export function ProjectWorkflow({
  projectId,
  name,
  showTranscript = true,
}: {
  projectId: string;
  name?: string;
  showTranscript?: boolean;
}) {
  const chrome = useWorkspaceChrome();
  const state = useQuery({
    queryKey: ["build-workflow", chrome.actorId, projectId],
    enabled: Boolean(chrome.actorId && chrome.homeProject?.id !== projectId),
    queryFn: () =>
      fetchJson<Snapshot>(
        `/api/projects/${encodeURIComponent(projectId)}/workflow`,
      ),
    refetchInterval: 2000,
  });
  const workflow = state.data?.workflow;
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
  const agent = useFlueAgent({
    url:
      workflow && showTranscript
        ? `/agents/coordinator/${encodeURIComponent(workflow.conversationId)}`
        : undefined,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState(false);
  const [note, setNote] = useState("");
  const retryKey = useRef<string | null>(null);
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
        className="project-workflow"
        data-testid="project-workflow"
        data-phase="imported"
        aria-label={name ? `${name} project` : "Your project"}
      >
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
  const latestMessage = showTranscript
    ? [...agent.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "assistant" &&
            m.parts.some((p) => p.type === "text" && p.text.trim()),
        )
    : null;
  // Plain-text of the latest assistant line, for the build-progress "latest"
  // row (joined non-empty text parts, trimmed to a readable length).
  const buildLatestText = latestMessage
    ? (latestMessage.parts
        .map((p) => (p.type === "text" ? p.text.trim() : ""))
        .filter((text) => text.length > 0)
        .join(" ")
        .slice(0, 240) || null)
    : null;
  return (
    <section
      className="project-workflow"
      data-testid="project-workflow"
      data-phase={workflow.phase}
      aria-label={name ? `${name} project` : "Your project"}
    >
      <div className="workflow-heading">
        <div>
          <p className="kicker">{name ?? "YOUR PROJECT"}</p>
          <h3>{planningBlocked ? "Plan needs another pass" : LABEL[workflow.phase]}</h3>
        </div>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => chrome.openProject(projectId, true)}
        >
          Open project
        </button>
      </div>
      {workflow.phase === "building" || (workflow.phase === "blocked" && active) ? (
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
        <p className="state-detail">
          Caddie is turning your request into a plan. You’ll review it before
          building starts.
        </p>
      ) : null}
      {workflow.phase === "review" && plan ? (
        <>
          <div className="workflow-plan">
            <Markdown text={splitFeatureBlock(plan.body).display} />
            <PlanFeatureList body={plan.body} />
          </div>
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
      ) : null}
      {workflow.phase === "design" ? (
        <p className="state-detail">
          Caddie is turning the approved plan into a design — the screens, the
          states and the look. You’ll review it before building starts.
        </p>
      ) : null}
      {workflow.phase === "design-review" && state.data?.design ? (
        <>
          {(() => {
            const { display, mocks } = splitDesignMocks(state.data.design.body);
            return (
              <>
                {mocks.length > 0 ? <DesignMockPreview mocks={mocks} /> : null}
                <div className="workflow-plan" data-testid="workflow-design-brief">
                  <Markdown text={display} />
                </div>
              </>
            );
          })()}
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
              disabled={busy}
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
          <p className="state-detail">
            Caddie is implementing the approved plan and running the checks.
            Here’s what’s happening — the preview opens here when they pass.
          </p>
          {chrome.actorId ? (
            <BuildProgress
              actorId={chrome.actorId}
              projectId={projectId}
              latest={buildLatestText}
            />
          ) : null}
        </>
      ) : null}
      {workflow.detail || workflow.phase === "blocked" ? (
        <p className="state-detail" role="status">
          {workflow.detail ??
            (planningBlocked
              ? "Caddie didn't finish the plan. Nothing was built — continue and it will pick up your request and feedback."
              : "Build stopped. Your plan and saved files are retained.")}
        </p>
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
              p.type === "text" ? <ReplyText key={i} text={p.text} streaming={p.state === "streaming"} /> : null,
            )}
        </details>
      ) : null}
      {workflow.phase === "ready" && workflow.previewId && chrome.actorId ? (
        <>
          <p className="state-detail" data-testid="workflow-ready-detail" data-app-preview="">
            {workflow.detail ?? "Build checks passed. Try the app below and tell Caddie what you’d like to change."}
          </p>
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
          <SavedFeatures actorId={chrome.actorId} projectId={projectId} />
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
