import { useState } from "react";
import type { ReactElement } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, postJson } from "../api.ts";
import { Icon } from "../icons.tsx";

/**
 * Versions (Publish programme stage 1): every checked build of the app.
 * Restore makes an earlier one the app you try below — and the one Publish
 * would put on the web. Nothing is deleted: the restored code becomes the
 * newest version, and the newer ones stay in the list.
 */

interface VersionItem {
  commitId: string;
  seq: number;
  kind: "feature" | "build" | "restore" | "import";
  title: string;
  createdAt: string;
  current: boolean;
  restorable: boolean;
}

interface VersionsResponse {
  versions: VersionItem[];
  blockedReason: string | null;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function AppVersions(props: { actorId: string; projectId: string; onRestored: () => Promise<unknown> | void }): ReactElement | null {
  const queryClient = useQueryClient();
  const versions = useQuery({
    queryKey: ["versions", props.actorId, props.projectId],
    queryFn: () => fetchJson<VersionsResponse>(`/api/projects/${encodeURIComponent(props.projectId)}/versions`),
  });
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = versions.data?.versions ?? [];
  // One version is the app itself; the list earns its space once there is something to go back to.
  if (list.length < 2) return null;
  const target = list.find((v) => v.commitId === confirm) ?? null;

  async function restore(version: VersionItem) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/projects/${encodeURIComponent(props.projectId)}/versions/${encodeURIComponent(version.commitId)}/restore`, {
        key: `restore-${version.commitId.slice(0, 12)}-${Date.now()}`,
      });
      setConfirm(null);
      await props.onRestored();
      void queryClient.invalidateQueries({ queryKey: ["publish", props.actorId, props.projectId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      void versions.refetch();
    }
  }

  return (
    <details className="app-versions" data-testid="app-versions">
      <summary>
        Versions <span className="app-versions-count">{list.length}</span>
        <Icon name="chevronDown" title="" className="app-versions-chevron" />
      </summary>
      <p className="state-detail app-versions-intro">Every time Caddie finished and checked the app. Go back to one to try it again or publish it.</p>
      {versions.data?.blockedReason ? <p className="publish-meta">{versions.data.blockedReason}</p> : null}
      <ul className="app-versions-list">
        {list.map((version) => (
          <li key={version.commitId} className="app-versions-row" data-testid={`version-${version.seq}`} data-current={version.current ? "true" : "false"}>
            <div className="app-versions-what">
              <span className="app-versions-name">
                Version {version.seq}
                {version.current ? (
                  <span className="badge" data-tone="ok">
                    Showing
                  </span>
                ) : null}
              </span>
              <span className="app-versions-title">{version.title}</span>
              <span className="app-versions-meta">{when(version.createdAt)}</span>
            </div>
            {version.restorable && confirm !== version.commitId ? (
              <button type="button" className="r-link" disabled={busy} onClick={() => setConfirm(version.commitId)} data-testid={`version-restore-${version.seq}`}>
                Go back to this one
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {target ? (
        <div className="publish-confirm" role="group" aria-label={`Go back to version ${target.seq}`}>
          <span>
            Go back to version {target.seq}? You&rsquo;ll try it below and can publish it. The newer versions stay in this list.
          </span>
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void restore(target)} data-testid="version-restore-confirm">
            {busy ? "Going back…" : `Go back to version ${target.seq}`}
          </button>
          <button type="button" className="r-link" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="publish-error">
          {error}
        </p>
      ) : null}
    </details>
  );
}
