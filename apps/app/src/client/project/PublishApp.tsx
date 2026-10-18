import { useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApprovalIntent } from "@caddie/contracts";
import { fetchJson, postJson } from "../api.ts";
import { Icon } from "../icons.tsx";

/**
 * Publish (Publish programme stage 4): put the checked app on the web at
 * <address>.<apps domain>. One click for the owner — the click records the
 * deploy-production approval for exactly this version, then Caddie does the
 * rest. Unpublish keeps the data; earlier versions can be put back.
 */

interface PublishStep {
  step: string;
  outcome: "ok" | "failed" | "skipped";
  detail?: string;
}

export interface PublishStatusView {
  available: boolean;
  reason: string | null;
  appsDomain: string | null;
  pendingCheck: { startedAt: string } | null;
  publication: {
    slug: string;
    url: string;
    status: "live" | "paused" | "blocked";
    outputId: string | null;
    publishedAt: string;
    hasServer: boolean;
    blockedReason: string | null;
  } | null;
  current: {
    outputId: string;
    publishable: boolean;
    upToDate: boolean;
    intent: ApprovalIntent | null;
    destructive: { name: string; intent: ApprovalIntent }[];
  } | null;
  suggestedSlug: string | null;
  missingKeys: string[];
  runs: { id: string; kind: string; status: "running" | "succeeded" | "failed"; error: string | null; steps: PublishStep[]; startedAt: string }[];
  versions: { outputId: string; publishedAt: string; live: boolean; intent: ApprovalIntent | null }[];
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export const publishQueryKey = (actorId: string, projectId: string) => ["publish", actorId, projectId] as const;

function publishPath(projectId: string, suffix = ""): string {
  return `/api/projects/${encodeURIComponent(projectId)}/publish${suffix}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** "farm log" -> "farm-log" while typing. */
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 32);
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function PublishApp(props: { actorId: string; projectId: string }): ReactElement | null {
  const status = useQuery({
    queryKey: publishQueryKey(props.actorId, props.projectId),
    queryFn: () => fetchJson<PublishStatusView>(publishPath(props.projectId)),
    // While a new version is being checked (or an update is running), keep the card current on its own.
    refetchInterval: (query) => {
      const view = query.state.data as Partial<PublishStatusView> | undefined;
      return view?.pendingCheck || view?.runs?.[0]?.status === "running" ? 4000 : false;
    },
  });
  const [busy, setBusy] = useState<"publish" | "unpublish" | "rollback" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState(false);
  const [slug, setSlug] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"destructive" | "unpublish" | { rollback: string } | null>(null);

  const raw = status.data;
  if (!raw) {
    return status.isError ? (
      <div className="publish-app" data-testid="publish-app">
        <p role="alert" className="state-detail">
          Couldn&rsquo;t load publishing.{" "}
          <button type="button" className="r-link" onClick={() => void status.refetch()}>
            Try again
          </button>
        </p>
      </div>
    ) : null;
  }
  // Tolerate a partial answer: anything missing reads as "not available".
  const data: PublishStatusView = {
    available: raw.available === true,
    reason: raw.reason ?? "Publishing isn't set up on this Caddie server yet.",
    appsDomain: raw.appsDomain ?? null,
    pendingCheck: raw.pendingCheck ?? null,
    publication: raw.publication ? { ...raw.publication, blockedReason: raw.publication.blockedReason ?? null } : null,
    current: raw.current ? { ...raw.current, destructive: raw.current.destructive ?? [] } : null,
    suggestedSlug: raw.suggestedSlug ?? null,
    missingKeys: raw.missingKeys ?? [],
    runs: raw.runs ?? [],
    versions: raw.versions ?? [],
  };

  async function act(kind: "publish" | "unpublish" | "rollback", run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await run();
      setConfirm(null);
      setEditingSlug(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
      void status.refetch();
    }
  }

  const approve = (intent: ApprovalIntent) => postJson("/api/approvals", { intent, decision: "approved" });

  const publish = (withDestructive: boolean) => {
    const current = data.current;
    if (!current?.intent) return;
    const intent = current.intent;
    void act("publish", async () => {
      if (withDestructive) for (const item of current.destructive) await approve(item.intent);
      await approve(intent);
      await postJson(publishPath(props.projectId), {
        outputId: current.outputId,
        ...(data.publication ? {} : { slug: slug ?? data.suggestedSlug }),
      });
    });
  };

  const rollback = (version: PublishStatusView["versions"][number]) => {
    if (!version.intent) return;
    const intent = version.intent;
    void act("rollback", async () => {
      await approve(intent);
      await postJson(publishPath(props.projectId, "/rollback"), { outputId: version.outputId });
    });
  };

  const publication = data.publication;
  const current = data.current;
  const lastRun = data.runs[0] ?? null;
  const domain = data.appsDomain ?? (publication ? hostOf(publication.url).split(".").slice(1).join(".") : "");
  const chosenSlug = slug ?? data.suggestedSlug ?? "";
  const slugOk = SLUG_PATTERN.test(chosenSlug) && !chosenSlug.includes("--");
  const canPublish = Boolean(current?.publishable && current.intent) && data.missingKeys.length === 0 && busy === null;
  const needsUpdate = Boolean(current && !current.upToDate);
  const destructive = current?.destructive ?? [];
  const earlier = data.versions.filter((v) => !v.live);

  const publishButton = (label: string) =>
    destructive.length > 0 ? (
      <button type="button" className="btn-key" disabled={!canPublish || (!publication && !slugOk)} data-testid="publish-go" onClick={() => setConfirm("destructive")}>
        {label}
      </button>
    ) : (
      <button type="button" className="btn-key" disabled={!canPublish || (!publication && !slugOk)} data-testid="publish-go" onClick={() => publish(false)}>
        {busy === "publish" ? "Publishing…" : label}
      </button>
    );

  return (
    <div className="publish-app" data-testid="publish-app" data-state={publication?.status ?? "unpublished"}>
      <div className="publish-head">
        <Icon name="globe" title="" />
        <h4>Publish</h4>
        {publication?.status === "live" ? (
          <span className="badge" data-tone="ok">
            Live
          </span>
        ) : null}
      </div>

      {!data.available ? (
        <p className="state-detail" data-testid="publish-unavailable">
          {data.reason}
        </p>
      ) : publication?.status === "blocked" ? (
        <div className="publish-blocked" role="status" data-testid="publish-blocked">
          <p className="state-detail">This app was taken down for breaking Caddie&rsquo;s rules, so it isn&rsquo;t on the web.</p>
          {publication.blockedReason ? <p className="publish-meta">Reason: {publication.blockedReason}</p> : null}
          <p className="publish-meta">A person at Caddie reviews every takedown.</p>
        </div>
      ) : (
        <>
          {publication?.status === "live" ? (
            <p className="state-detail publish-live" data-testid="publish-live">
              Live at{" "}
              <a href={publication.url} target="_blank" rel="noopener noreferrer">
                {hostOf(publication.url)}
              </a>
              <span className="publish-meta"> · published {when(publication.publishedAt)}</span>
            </p>
          ) : publication?.status === "paused" ? (
            <p className="state-detail" data-testid="publish-paused">
              Not on the web right now. Its data is kept; publish again to bring it back at {hostOf(publication.url)}.
            </p>
          ) : (
            <p className="state-detail">Put this app on the web at a link anyone can open.</p>
          )}

          {!publication ? (
            editingSlug ? (
              <form
                className="publish-slug-form"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  if (slugOk) setEditingSlug(false);
                }}
              >
                <label htmlFor="publish-slug" className="publish-label">
                  Address
                </label>
                <div className="publish-slug-field">
                  <input
                    id="publish-slug"
                    className="input"
                    value={chosenSlug}
                    onChange={(event) => setSlug(toSlug(event.target.value))}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="publish-slug-hint"
                    data-testid="publish-slug-input"
                    autoFocus
                  />
                  <span className="publish-slug-domain">.{domain || "your apps domain"}</span>
                </div>
                <span id="publish-slug-hint" className="publish-hint">
                  3–32 lowercase letters, digits and hyphens. It can&rsquo;t change after publishing.
                </span>
                <div className="row-actions">
                  <button type="submit" className="btn-ghost" disabled={!slugOk}>
                    Use this address
                  </button>
                </div>
              </form>
            ) : (
              <p className="publish-address" data-testid="publish-address">
                <span>
                  {chosenSlug}
                  {domain ? `.${domain}` : ""}
                </span>
                {data.pendingCheck ? null : (
                  <button type="button" className="r-link" onClick={() => setEditingSlug(true)} data-testid="publish-slug-change">
                    Change
                  </button>
                )}
              </p>
            )
          ) : null}

          {data.missingKeys.length > 0 ? (
            <p className="state-detail publish-needs" data-testid="publish-needs-keys">
              Add the keys this app needs first: {data.missingKeys.join(", ")}.
            </p>
          ) : null}
          {current && !current.publishable ? (
            <p className="state-detail publish-needs" data-testid="publish-rebuild">
              This version was checked before publishing was possible. Ask Caddie to check the app again, then publish.
            </p>
          ) : null}
          {publication?.status === "live" && needsUpdate && current?.publishable ? (
            <p className="state-detail" data-testid="publish-update-ready">
              A newer version is ready. Visitors still see the one published {when(publication.publishedAt)}.
            </p>
          ) : null}

          {data.pendingCheck ? (
            <p className="state-detail publish-checking" role="status" data-testid="publish-checking">
              Caddie is checking the new version for safety before visitors see it. This usually takes a minute or two
              {publication?.status === "live" ? "; visitors keep the current version meanwhile." : "."}
            </p>
          ) : confirm === "destructive" ? (
            <div className="publish-confirm" role="group" aria-label="Confirm deleting data">
              <span>
                This update deletes data from the live app ({destructive.map((d) => d.name).join(", ")}). This can&rsquo;t be undone.
              </span>
              <button type="button" className="btn-key" disabled={busy !== null} onClick={() => publish(true)} data-testid="publish-destructive-confirm">
                {busy === "publish" ? "Publishing…" : "Publish and delete it"}
              </button>
              <button type="button" className="r-link" onClick={() => setConfirm(null)}>
                Not now
              </button>
            </div>
          ) : confirm === "unpublish" ? (
            <div className="publish-confirm" role="group" aria-label="Confirm unpublishing">
              <span>Take the app off the web? Its data is kept and you can publish it again.</span>
              <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void act("unpublish", () => postJson(publishPath(props.projectId, "/unpublish"), {}))} data-testid="publish-unpublish-confirm">
                {busy === "unpublish" ? "Unpublishing…" : "Unpublish"}
              </button>
              <button type="button" className="r-link" onClick={() => setConfirm(null)}>
                Keep it live
              </button>
            </div>
          ) : confirm && typeof confirm === "object" ? (
            <div className="publish-confirm" role="group" aria-label="Confirm putting back an earlier version">
              <span>Put this earlier version back on the web? The app&rsquo;s data stays as it is now.</span>
              <button
                type="button"
                className="btn-ghost"
                disabled={busy !== null}
                data-testid="publish-rollback-confirm"
                onClick={() => {
                  const version = data.versions.find((v) => v.outputId === confirm.rollback);
                  if (version) rollback(version);
                }}
              >
                {busy === "rollback" ? "Putting it back…" : "Put it back"}
              </button>
              <button type="button" className="r-link" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row-actions">
              {!publication
                ? publishButton("Publish")
                : publication.status === "paused"
                  ? publishButton("Publish again")
                  : needsUpdate
                    ? publishButton("Publish update")
                    : null}
              {publication?.status === "live" ? (
                <button type="button" className="r-link" disabled={busy !== null} onClick={() => setConfirm("unpublish")} data-testid="publish-unpublish">
                  Unpublish
                </button>
              ) : null}
            </div>
          )}
          {busy === "publish" ? (
            <p className="publish-meta" role="status">
              Publishing can take up to a minute.
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="publish-error" data-testid="publish-error">
              {error}
            </p>
          ) : lastRun?.status === "failed" && lastRun.error ? (
            <p role="status" className="publish-error" data-testid="publish-last-error">
              Last attempt: {lastRun.error}
            </p>
          ) : null}

          {earlier.length > 0 && publication ? (
            <details className="publish-versions">
              <summary>Earlier versions</summary>
              <ul>
                {earlier.map((version) => (
                  <li key={version.outputId} data-testid={`publish-version-${version.outputId}`}>
                    <span>Published {when(version.publishedAt)}</span>
                    <button
                      type="button"
                      className="r-link"
                      disabled={busy !== null || !version.intent}
                      onClick={() => setConfirm({ rollback: version.outputId })}
                      data-testid={`publish-rollback-${version.outputId}`}
                    >
                      Put back
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}
