import { ProjectDialog } from "./ProjectDialog.tsx";
import { useState, type ReactElement } from "react";
import { Mascot } from "@caddie/ui/Mascot";
import { Icon, type IconName } from "../icons.tsx";
import { BuildFeatureList, hasFeatureList } from "./FeatureChecklist.tsx";
import { ModuleProgress } from "./ModuleProgress.tsx";
import { buildPresentation } from "./build-presentation.ts";
import {
  useBuildActivity,
  type BuildTimelineView,
  type TimelineFileArea,
  type TimelineStageView,
} from "../queries.ts";

/** One observed status, readable features, and optional exact activity evidence. */
export function BuildProgress(props: {
  actorId: string | null;
  projectId: string;
  latest?: string | null;
  onStop?: () => Promise<void>;
  onRefresh?: () => Promise<void>;
  /** Frameless when rendered inside another card (e.g. the Now panel), so the
   *  build status does not draw a card inside a card. */
  embedded?: boolean;
}): ReactElement | null {
  const panelClass = props.embedded
    ? "build-status-panel build-status-panel--embedded"
    : "build-status-panel";
  const activity = useBuildActivity(
    { actorId: props.actorId },
    props.projectId,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"checks" | "activity" | "history">("checks");
  const data = activity.data;
  if (!data?.timeline)
    return (
      <section
        className={panelClass}
        data-testid="build-status-loading"
      >
        <p className="state-detail" role={activity.error ? "alert" : "status"}>
          {activity.error
            ? "The build status could not be loaded. Your saved work is unchanged."
            : "Reading the latest build status…"}
        </p>
        {activity.error ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void activity.refetch()}
          >
            Try again
          </button>
        ) : null}
      </section>
    );
  if (["planning", "review", "looks", "looks-review", "design", "design-review"].includes(data.phase))
    return null;
  const t = data.timeline;
  const view = buildPresentation(data, Boolean(activity.error));
  async function refresh() {
    setRefreshing(true);
    setFeedback(null);
    setError(null);
    try {
      const [result] = await Promise.all([
        activity.refetch(),
        props.onRefresh?.(),
      ]);
      if (result.error) throw result.error;
      setFeedback(
        result.data?.phase === "building" && result.data.timeline.quiet
          ? "No new activity was reported. You can stop this build and retry after it stops."
          : "The latest build status is shown below.",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Couldn’t check the build status. Try again.",
      );
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <section
      className="build-progress build-progress--focused"
      data-testid="build-progress"
      data-phase={data.phase}
      data-quiet={view.quiet ? "true" : undefined}
    >
      <section className={panelClass} aria-label="Build status">
        <div className="build-status-heading">
          <Mascot
            mood={view.mood}
            size={46}
            live={!view.quiet && data.phase === "building"}
          />
          <div>
            <p className="build-status-label">{view.label}</p>
            <h2>{view.title}</h2>
          </div>
        </div>
        <p
          className="build-summary"
          role="status"
          aria-live="polite"
          data-testid="build-summary"
          data-quiet={view.quiet ? "true" : undefined}
        >
          {view.summary}
        </p>
        {t.tests || view.repairing ? (
          <div className="build-last-result" data-testid="build-last-result">
            <Icon name="info" title="" />
            <div>
              <strong>
                {view.quiet ? "Last reported result" : "Latest check"}
              </strong>
              <p>
                {t.tests?.failed
                  ? t.tests.failed === 1
                    ? "One check still needs attention."
                    : "Some checks still need attention."
                  : view.repairing
                    ? "A check failed. Its fix has not been confirmed yet."
                    : "The reported tests passed. Other required checks may still be running."}
              </p>
            </div>
          </div>
        ) : null}
      {hasFeatureList(data.features ?? []) ? (
        <BuildFeatureList
          projectId={props.projectId}
          features={data.features}
          compact
          stale={view.quiet}
        />
      ) : t.scope.length ? (
        <div className="build-scope" data-testid="build-scope">
          <span className="build-scope-head">What’s being built</span>
          <div className="build-scope-chips">
            {t.scope.map((item, index) => (
              <span key={index} className="build-scope-chip">
                {item}
              </span>
            ))}
          </div>
        </div>
      ) : null}
        <div className="build-status-actions">
          {view.quiet ? (
            <button
              type="button"
              className="btn-key"
              data-testid="build-refresh-status"
              disabled={refreshing || stopping}
              onClick={() => void refresh()}
            >
              {refreshing ? "Checking…" : "Check build status"}
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setTechnicalOpen(true)}
            >
              Build activity
            </button>
          )}
          {data.phase === "building" && props.onStop ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={refreshing || stopping}
              onClick={async () => {
                setStopping(true);
                setError(null);
                try {
                  await props.onStop!();
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Couldn’t stop the build. Try again.",
                  );
                } finally {
                  setStopping(false);
                }
              }}
            >
              {stopping ? "Stopping…" : "Stop build"}
            </button>
          ) : null}
        </div>
        {view.quiet ? <button type="button" className="build-text-action" onClick={() => setTechnicalOpen(true)}>Build activity</button> : null}
        {feedback ? (
          <p className="state-detail" role="status">
            {feedback}
          </p>
        ) : null}
        {error ? (
          <p className="state-detail" role="alert">
            {error}
          </p>
        ) : null}
        <p className="build-status-time" data-testid="build-timing">
          {t.elapsedMs !== null ? (
            <>Started {formatDuration(t.elapsedMs)} ago</>
          ) : null}
          {t.idleMs !== null ? (
            <> · Last activity {formatDuration(t.idleMs)} ago</>
          ) : null}
        </p>
      </section>
      <ModuleProgress projectId={props.projectId} />
      <ProjectDialog open={technicalOpen} onClose={() => setTechnicalOpen(false)} title="Build activity" wide>
        <nav className="review-subnav" aria-label="Build activity views">
          <button type="button" aria-pressed={detailTab === 'checks'} onClick={() => setDetailTab('checks')}>Checks</button>
          <button type="button" aria-pressed={detailTab === 'activity'} onClick={() => setDetailTab('activity')}>Files &amp; commands</button>
          {data.rounds.length ? <button type="button" aria-pressed={detailTab === 'history'} onClick={() => setDetailTab('history')}>Attempts</button> : null}
        </nav>
        {detailTab === 'checks' ? <div className="build-checks-view">
        <ol
          className="build-stages"
          aria-label="Build stages"
          data-testid="build-stages"
        >
          {t.stages.map((stage) => (
            <li
              key={stage.key}
              className="build-stage"
              data-state={stage.state}
              data-testid={`build-stage-${stage.key}`}
            >
              <span className="build-stage-top">
                <span className="build-stage-mark" aria-hidden="true">
                  <StageMark state={stage.state} />
                </span>
                <span className="build-stage-label">{stage.label}</span>
              </span>
              <span className="build-stage-state">{stage.state === 'done' ? 'Done' : stage.state === 'active' ? 'In progress' : stage.state === 'failed' ? 'Needs attention' : 'Not reported'}</span>
              {stage.detail ? <p className="build-stage-detail">{stage.detail}</p> : null}
            </li>
          ))}
        </ol>
        {t.tests ? (
          <p className="state-detail">
            Latest reported tests: {t.tests.passed} passed · {t.tests.failed}{" "}
            failed · {new Date(t.tests.at).toLocaleString()}
          </p>
        ) : null}
        {t.checks.length ? (
          <ul className="build-check-results">
            {t.checks.map((check, index) => (
              <li key={`${check.name}-${index}`}>
                <strong>
                  {check.label}: {check.passed ? "Passed" : "Failed"}
                </strong>
                <code>{check.name}</code>
                <span>
                  {new Date(check.at).toLocaleString()} ·{" "}
                  {formatDuration(check.durationMs)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        </div> : null}
        {detailTab === 'activity' ? <div className="build-activity-view" data-testid="build-detail">
          {!t.files.length && !t.commands.length ? <p className="build-detail-empty">No file or command activity has been reported yet.</p> : (() => {
            // Owner 2026-10-25: inspection one-liners (ls/pwd/echo…) are not
            // signal — folded into one quiet row; meaningful commands (tests,
            // builds, installs, migrations, anything that failed) stay as rows.
            const TRIVIAL = /^\s*(ls|pwd|echo|cat|head|tail|wc|find|which|env)(\s|$|&&|;|\|)/;
            const meaningful = t.commands.filter((c) => !(c.outcome === "ok" && TRIVIAL.test(c.command)));
            const trivial = t.commands.filter((c) => c.outcome === "ok" && TRIVIAL.test(c.command));
            const anyFailed = t.commands.some((c) => c.outcome === "failed");
            return <>
            {/* Summary banner: one honest headline over a count ring. The ring
                is full (ok) only when nothing a command reported failed. */}
            <div
              className="build-activity-banner"
              data-testid="build-activity-summary"
              data-tone={anyFailed ? "warn" : "ok"}
            >
              <span className="build-activity-ring" aria-hidden="true">
                <span>{t.files.length}</span>
              </span>
              <div>
                <h3>
                  {t.files.length} file{t.files.length === 1 ? "" : "s"} written
                  {t.commands.length ? ` · ${t.commands.length} command${t.commands.length === 1 ? "" : "s"}` : ""}
                  {t.commands.length ? (anyFailed ? ", one needs attention" : ", all ran ok") : ""}
                </h3>
                <p>{activitySummaryLine(t.fileAreas, anyFailed)}</p>
              </div>
            </div>
            {t.files.length ? (
              <div className="build-activity-card" data-testid="build-files">
                <h4 className="build-activity-card-head">
                  Files
                  <span className="build-activity-card-sub">{fileAreaBreakdown(t.fileAreas)}</span>
                  <span className="build-activity-card-n">{t.files.length}</span>
                </h4>
                <ul className="build-activity-list">
                  {t.files.map((file) => (
                    <li key={file.path} data-area={file.area}>
                      <span className="build-activity-mark" aria-hidden="true">
                        <Icon name={fileIcon(file.area)} title="" />
                      </span>
                      <span className="build-activity-body">
                        <span className="build-activity-mono">{file.path.replace(/^src\//, "")}</span>
                        <span className="build-activity-why">{filePurpose(file)}</span>
                      </span>
                      <span className="build-activity-meta">
                        {file.bytes !== null ? formatBytes(file.bytes) : ""}
                        {file.writes > 1 ? ` · ×${file.writes}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {t.commands.length ? (
              <div className="build-activity-card" data-testid="build-commands">
                <h4 className="build-activity-card-head">
                  Commands
                  <span className="build-activity-card-sub">newest first</span>
                  <span className="build-activity-card-n">{t.commands.length}</span>
                </h4>
                <p className="build-activity-note">
                  Command output and file diffs are not shown here. Exact recorded
                  results are kept in Check history when available.
                </p>
                <ul className="build-activity-list">
                  {meaningful.map((command, index) => (
                    <li key={index} data-outcome={command.outcome}>
                      <span className="build-activity-dot" aria-hidden="true" />
                      <span className="build-activity-body">
                        <span className="build-activity-mono">{command.command}</span>
                      </span>
                      <span className="build-activity-meta">
                        {command.outcome}
                        {command.exitCode !== null ? ` · exit ${command.exitCode}` : ""}
                        {" · "}{formatDuration(command.durationMs)}
                      </span>
                    </li>
                  ))}
                </ul>
                {trivial.length ? (
                  <details className="build-activity-trivial" data-testid="build-commands-trivial">
                    <summary>
                      {trivial.length} workspace check{trivial.length === 1 ? "" : "s"} (ls, pwd…) · all ok
                    </summary>
                    <ul className="build-activity-list">
                      {trivial.map((command, index) => (
                        <li key={index} data-outcome={command.outcome}>
                          <span className="build-activity-dot" aria-hidden="true" />
                          <span className="build-activity-body">
                            <span className="build-activity-mono">{command.command}</span>
                          </span>
                          <span className="build-activity-meta">
                            {formatDuration(command.durationMs)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ) : null}
            </>;
          })()}
        </div> : null}
      {detailTab === 'history' && data.rounds.length ? (
        <section className="build-history" data-testid="build-history">
          <h3>Check attempts</h3>
          <p className="state-detail">
            These are check attempts, not completed features. Most recent first.
          </p>
          <ul>
            {[...data.rounds].reverse().map((round, index) => (
              <li
                key={`${round.issue}-${index}`}
                data-outcome={round.outcome}
                data-testid="build-history-item"
              >
                <span className="build-history-text">
                  <b>{roundLabel(round.round)}</b>
                  {round.detail ? (
                    /^\s*[{[]/.test(round.detail) ? (
                      <details>
                        <summary>Exact recorded result</summary>
                        <pre className="build-history-detail">
                          {round.detail}
                        </pre>
                      </details>
                    ) : (
                      <span className="build-history-detail">
                        {" "}
                        — {round.detail}
                      </span>
                    )
                  ) : null}
                  <small className="build-recorded-at">
                    {round.issue} · {new Date(round.at).toLocaleString()}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {props.latest ? (
        <details className="build-latest" data-testid="build-latest">
          <summary>Latest message from Caddie</summary>
          <p className="build-latest-text">{props.latest}</p>
        </details>
      ) : null}
      </ProjectDialog>
    </section>
  );
}

function StageMark({
  state,
}: {
  state: TimelineStageView["state"];
}): ReactElement {
  if (state === "done") return <Icon name="check" title="done" />;
  if (state === "failed") return <Icon name="alert" title="failed" />;
  if (state === "active") return <span className="build-stage-spinner" />;
  return <span className="build-stage-dot" />;
}

/** "14 app · 6 tests · 3 config" — only the non-zero areas, plural-aware. */
function fileAreaBreakdown(areas: BuildTimelineView["fileAreas"]): string {
  const names: Record<keyof typeof areas, [string, string]> = {
    app: ["app", "app"],
    test: ["test", "tests"],
    style: ["style", "styles"],
    config: ["config", "config"],
    server: ["server", "server"],
  };
  const parts = (Object.keys(areas) as (keyof typeof areas)[])
    .filter((k) => areas[k] > 0)
    .map((k) => `${areas[k]} ${areas[k] === 1 ? names[k][0] : names[k][1]}`);
  return parts.length ? `(${parts.join(" · ")})` : "";
}

/** The file-type glyph for a row — one of the shared Icon set (no emoji). */
function fileIcon(area: TimelineFileArea): IconName {
  switch (area) {
    case "test":
      return "check";
    case "style":
      return "image";
    case "server":
      return "box";
    case "config":
      return "box";
    case "app":
    default:
      return "file";
  }
}

/** A plain-language "what this file is for", from its tracked area/role —
 *  never a guess about contents. Non-technical readers see the purpose, not
 *  the path. */
function filePurpose(file: {
  area: BuildTimelineView["files"][number]["area"];
  path: string;
  role: string | null;
}): string {
  const name = file.path.toLowerCase();
  if (name.endsWith(".sql") || name.includes("migration"))
    return "A database table the app needs";
  switch (file.area) {
    case "app":
      return "Part of the app you see and use";
    case "server":
      return "The backend that stores and serves data";
    case "test":
      return "A check that proves a feature works";
    case "style":
      return "How the app looks";
    case "config":
      return "A setup file for the build";
    default:
      return file.role ?? "Part of your app";
  }
}

/** One honest sentence under the summary ring, led by where the work landed. */
function activitySummaryLine(
  areas: BuildTimelineView["fileAreas"],
  anyFailed: boolean,
): string {
  const order: (keyof typeof areas)[] = ["app", "server", "test", "style", "config"];
  const nouns: Record<keyof typeof areas, string> = {
    app: "app screens",
    server: "the backend",
    test: "tests",
    style: "styling",
    config: "setup",
  };
  const present = order.filter((k) => areas[k] > 0).map((k) => nouns[k]);
  const where =
    present.length === 0
      ? "Caddie recorded no file writes yet"
      : present.length === 1
        ? `Work landed in ${present[0]}`
        : `Work spans ${present.slice(0, -1).join(", ")} and ${present[present.length - 1]}`;
  return anyFailed
    ? `${where}. One command reported a problem — see Checks.`
    : `${where}. No commands failed.`;
}

/** "40 s", "4 min", "1 h 05 min" — the client mirror of the model's formatter. */
export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24)
    return `${Math.floor(hours / 24)} ${hours < 48 ? "day" : "days"}, ${hours % 24} h`;
  return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** "700 B", "1.5 KB", "2.3 MB" — compact file sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Plain words for a run_rounds `round` kind. */
function roundLabel(round: string): string {
  switch (round) {
    case "repair_attempt":
      return "Tried a fix";
    case "verification":
      return "Ran a check";
    case "diagnosis":
      return "Looked into a problem";
    case "transport_retry":
      return "Retried after a hiccup";
    case "framework_recovery":
      return "Recovered and continued";
    default:
      return round;
  }
}
