import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFlueClient } from "@flue/sdk";
import { useFlueAgent } from "@flue/react";
import { Markdown } from "@caddie/ui/Markdown";
import type { PlanDocRevision, ApprovalRecord } from "@caddie/contracts";
import { splitFeatureBlock } from "@caddie/contracts";
import type { BuildWorkflow } from "../../server/build-workflow.ts";
import { fetchJson, postJson } from "../api.ts";
import { useWorkspaceChrome } from "../workspace/Chrome.tsx";
import { useProjectRepo } from "../queries.ts";
import { Icon } from "../icons.tsx";
import { InteractivePreview } from "../artifacts/InteractivePreview.tsx";
import { BuildProgress } from "../project/BuildProgress.tsx";
import { PlanFeatureList, SavedFeatures } from "../project/FeatureChecklist.tsx";

interface Snapshot {
  workflow: BuildWorkflow | null;
  plan: PlanDocRevision | null;
  approval: ApprovalRecord | null;
}
const LABEL = {
  planning: "Planning your app",
  review: "Your plan is ready",
  building: "Building your app",
  blocked: "Needs attention",
  ready: "Your app is ready to try",
};
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
  const planApproved = state.data?.approval?.status === "approved";
  const repoQuery = useProjectRepo(
    { actorId: chrome.actorId },
    chrome.homeProject?.id === projectId ? null : projectId,
  );
  const linkedRepo = repoQuery.data?.repo ?? null;
  // A block BEFORE any approved plan is a stuck plan, not a stuck build:
  // there is nothing built to "retry". Tell the truth and resume planning.
  const planningBlocked = workflow?.phase === "blocked" && !planApproved;
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
  if (!workflow) return null;
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
            await createFlueClient({ url: `/agents/coordinator/${encodeURIComponent(workflow.conversationId)}` }).abort();
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
      {latestMessage && workflow.phase !== "review" ? (
        <details className="workflow-updates">
          <summary>{active ? "Caddie is working…" : "Latest update"}</summary>
          {latestMessage.parts
            .filter((p) => p.type === "text")
            .map((p, i) =>
              p.type === "text" ? <Markdown key={i} text={p.text} /> : null,
            )}
        </details>
      ) : null}
      {workflow.phase === "ready" && workflow.previewId && chrome.actorId ? (
        <>
          <p className="state-detail">
            Build checks passed. Try the app below and tell Caddie what you’d
            like to change.
          </p>
          <InteractivePreview
            actorId={chrome.actorId}
            projectId={projectId}
            artifactId={workflow.previewId}
            contentUrl={`/api/projects/${encodeURIComponent(projectId)}/workflow/preview/${encodeURIComponent(workflow.previewId)}`}
          />
          <SaveToGithub
            projectId={projectId}
            runId={workflow.runId}
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

/**
 * Save to GitHub (v2 "GitHub is the home for each project's code"): pushes the
 * built app's HTML to the project's linked repo as `index.html`, over the real
 * delivery route (mode: merge-default-branch). Writing the default branch runs
 * behind the P03 approval gate — a gate refusal is surfaced honestly as "this
 * needs your approval", never silently retried. When no repo is linked yet, it
 * points the user at Code settings instead of pretending it can push.
 */
function SaveToGithub(props: {
  projectId: string;
  runId: string;
  previewId: string | null;
  repo: import("../queries.ts").ProjectRepoView | null;
  onConnect: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ htmlUrl: string | null; reconciled: boolean } | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);

  const repo = props.repo;

  async function save() {
    if (busy || !repo || !props.previewId) return;
    setBusy(true);
    setError(null);
    setNeedsApproval(false);
    try {
      // The built app is served as one HTML document; save it as index.html.
      const html = await fetch(
        `/api/projects/${encodeURIComponent(props.projectId)}/workflow/preview/${encodeURIComponent(props.previewId)}`,
      ).then((r) => {
        if (!r.ok) throw new Error("The built app could not be read.");
        return r.text();
      });
      const result = await postJson<{ delivery: { htmlUrl: string | null }; reconciled: boolean }>(
        `/api/projects/${encodeURIComponent(props.projectId)}/github/deliveries`,
        {
          mode: "merge-default-branch",
          runId: props.runId,
          installationId: repo.installationId,
          repoFullName: repo.repoFullName,
          title: "Save built app from Caddie",
          body: "The current built app, saved from Caddie.",
          files: [{ path: "index.html", content: html }],
        },
      );
      setSaved({ htmlUrl: result.delivery.htmlUrl, reconciled: result.reconciled });
    } catch (cause) {
      // The P03 gate refuses an unapproved default-branch write — that is the
      // expected, honest path, not a failure to hide.
      const code = (cause as { kind?: string; code?: string }).kind ?? (cause as { code?: string }).code;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (
        code === "approval_required" ||
        code === "effect_requires_approval" ||
        /approv/i.test(message)
      ) {
        setNeedsApproval(true);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
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

  return (
    <div className="save-github" data-testid="save-github">
      {saved ? (
        <p className="state-detail" data-testid="save-github-done">
          Saved to{" "}
          {saved.htmlUrl ? (
            <a href={saved.htmlUrl} target="_blank" rel="noopener noreferrer">
              {repo.repoFullName}
            </a>
          ) : (
            repo.repoFullName
          )}
          {saved.reconciled ? " (already up to date)." : "."}
        </p>
      ) : needsApproval ? (
        <p className="state-detail" role="status" data-testid="save-github-approval">
          Saving to <b>{repo.repoFullName}</b> writes its default branch, so it needs your approval
          first. Review and approve the change with Caddie, then save again.
        </p>
      ) : (
        <>
          <p className="state-detail">
            Save the built app to <b>{repo.repoFullName}</b>. Writing the repo runs behind your approval —
            Caddie never pushes on its own.
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="btn-key"
              data-testid="save-github-save"
              disabled={busy || !props.previewId}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save to GitHub"}
            </button>
          </div>
        </>
      )}
      {error ? (
        <div role="alert" className="state-detail" data-testid="save-github-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
