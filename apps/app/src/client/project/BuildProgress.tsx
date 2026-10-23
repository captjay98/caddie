import { useRef, useState, type ReactElement } from "react";
import { Mascot } from "@caddie/ui/Mascot";
import { Icon } from "../icons.tsx";
import { BuildFeatureList, hasFeatureList } from "./FeatureChecklist.tsx";
import { ModuleProgress } from "./ModuleProgress.tsx";
import { buildPresentation } from "./build-presentation.ts";
import {
  useBuildActivity,
  type BuildTimelineView,
  type TimelineStageView,
} from "../queries.ts";

/** One observed status, readable features, and optional exact activity evidence. */
export function BuildProgress(props: {
  actorId: string | null;
  projectId: string;
  latest?: string | null;
  onStop?: () => Promise<void>;
  onRefresh?: () => Promise<void>;
}): ReactElement | null {
  const activity = useBuildActivity(
    { actorId: props.actorId },
    props.projectId,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const technical = useRef<HTMLDetailsElement>(null);
  const data = activity.data;
  if (!data?.timeline)
    return (
      <section
        className="build-status-panel"
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
  if (["planning", "review", "design", "design-review"].includes(data.phase))
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
      <section className="build-status-panel" aria-label="Build status">
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
              onClick={() => {
                if (technical.current)
                  technical.current.open = !technical.current.open;
              }}
            >
              View build details
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
        {data.phase === "building" && props.onStop ? (
          <p className="build-stop-note">
            Stopping retains your plan and saved files.
          </p>
        ) : null}
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
      {hasFeatureList(data.features ?? []) ? (
        <BuildFeatureList
          projectId={props.projectId}
          features={data.features}
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
      <details className="build-technical" ref={technical}>
        <summary>
          Build details <span>checks, files &amp; commands</span>
        </summary>
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
              <span className="build-stage-detail">
                {stage.detail ??
                  (stage.durationMs !== null
                    ? formatDuration(stage.durationMs)
                    : "—")}
              </span>
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
        <div className="build-detail" data-testid="build-detail">
          {t.files.length ? (
            <div className="build-detail-card" data-testid="build-files">
              <div className="build-detail-head">
                Files written · {t.files.length}
                <span className="build-detail-sub">
                  {" "}
                  {fileAreaBreakdown(t.fileAreas)}
                </span>
              </div>
              <ul className="build-detail-list">
                {t.files.map((file) => (
                  <li key={file.path} data-area={file.area}>
                    <span className="build-detail-mono">{file.path}</span>
                    <span className="build-detail-meta">
                      {file.writes > 1 ? `×${file.writes} · ` : ""}
                      {file.bytes !== null
                        ? formatBytes(file.bytes)
                        : ""} · {new Date(file.lastAt).toLocaleString()}
                      {file.role ? ` · ${file.role}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {t.commands.length ? (
            <div className="build-detail-card" data-testid="build-commands">
              <div className="build-detail-head">Commands · newest first</div>
              <p className="state-detail">
                Command output and file diffs are not included in this activity
                feed. Exact recorded results are retained in Check history when
                available.
              </p>
              <ul className="build-detail-list">
                {t.commands.map((command, index) => (
                  <li key={index} data-outcome={command.outcome}>
                    <span className="build-detail-mono">{command.command}</span>
                    <span className="build-detail-meta">
                      {command.outcome} ·{" "}
                      {command.exitCode !== null
                        ? `exit ${command.exitCode} · `
                        : ""}
                      {formatDuration(command.durationMs)} ·{" "}
                      {new Date(command.at).toLocaleString()}
                      {command.role ? ` · ${command.role}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </details>
      {data.rounds.length ? (
        <details className="build-history" data-testid="build-history">
          <summary>Check history · {data.rounds.length} attempts</summary>
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
        </details>
      ) : null}
      {props.latest ? (
        <details className="build-latest" data-testid="build-latest">
          <summary>Latest message from Caddie</summary>
          <p className="build-latest-text">{props.latest}</p>
        </details>
      ) : null}
      {data.phase === "building" ? (
        <p className="build-preview-note">
          Your preview appears after the required checks pass.
        </p>
      ) : null}
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
