import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFlueClient } from "@flue/sdk";
import { useFlueAgent } from "@flue/react";
import { Markdown } from "@caddie/ui/Markdown";
import type { PlanDocRevision, ApprovalRecord } from "@caddie/contracts";
import type { BuildWorkflow } from "../../server/build-workflow.ts";
import { fetchJson, postJson } from "../api.ts";
import { useWorkspaceChrome } from "../workspace/Chrome.tsx";
import { InteractivePreview } from "../artifacts/InteractivePreview.tsx";

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
          <h3>{LABEL[workflow.phase]}</h3>
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
            <Markdown text={plan.body} />
          </div>
          <p className="state-detail">
            Approving starts a sandbox build of this plan. Deployments and
            purchases need separate permission.
          </p>
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
        <p className="state-detail">
          Caddie is implementing the approved plan and running the checks. The
          preview appears here when they pass.
        </p>
      ) : null}
      {workflow.detail || workflow.phase === "blocked" ? (
        <p className="state-detail" role="status">
          {workflow.detail ?? "Build stopped. Your plan and saved files are retained."}
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
                      : "The build could not resume.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Resuming…" : "Retry build"}
          </button>
          <button
            className="btn-ghost"
            onClick={() => chrome.openProject(projectId, true)}
          >
            Review with Caddie
          </button>
        </div>
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
