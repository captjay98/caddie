import { useState, type ReactElement } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, postJson } from "../api.ts";
import { Icon } from "../icons.tsx";

/**
 * Scheduled jobs with "Run now" (plan part N, screen 3). Each declared job has
 * a Run now button; nothing runs on a timer this week. The latest runs are
 * shown under the list with their one-line summaries. Run now signs a call to
 * the job's route and records the run; members may run it on the preview.
 */

interface DeclaredJob {
  id: string;
  plain: string;
  every: "hour" | "day" | "week";
}

interface JobRun {
  id: string;
  jobId: string;
  status: "running" | "done" | "failed";
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(seconds) || seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function AppJobs(props: { actorId: string; projectId: string; outputId: string }): ReactElement | null {
  const client = useQueryClient();
  const queryKey = ["app-job-runs", props.actorId, props.projectId];
  const data = useQuery({
    queryKey,
    queryFn: () => fetchJson<{ jobs: DeclaredJob[]; runs: JobRun[] }>(`/api/projects/${encodeURIComponent(props.projectId)}/workflow/job-runs`),
    refetchInterval: 4000,
  });
  const [running, setRunning] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (jobId: string) =>
      postJson<{ ok: boolean }>(`/api/projects/${encodeURIComponent(props.projectId)}/workflow/jobs/${encodeURIComponent(jobId)}/run`, {
        mode: "preview",
        outputId: props.outputId,
      }),
    onMutate: (jobId: string) => setRunning(jobId),
    onSettled: async () => {
      setRunning(null);
      await client.invalidateQueries({ queryKey });
    },
  });

  const jobs = data.data?.jobs ?? [];
  const runs = data.data?.runs ?? [];
  if (jobs.length === 0) return null;
  const now = Date.now();

  return (
    <div className="app-jobs" data-testid="app-jobs">
      <div className="app-jobs-head">
        <Icon name="clock" title="" />
        <h4>Jobs</h4>
      </div>
      <p className="state-detail app-jobs-note">Runs when you press Run now. Automatic schedules come after the hackathon.</p>
      <ul className="app-jobs-list">
        {jobs.map((job) => (
          <li key={job.id} className="app-jobs-row" data-testid="app-job">
            <span className="app-jobs-plain">{job.plain}</span>
            <button
              type="button"
              className="app-jobs-run"
              data-testid="app-job-run"
              disabled={running !== null}
              onClick={() => run.mutate(job.id)}
            >
              <Icon name="play" title="" />
              {running === job.id ? "Running…" : "Run now"}
            </button>
          </li>
        ))}
      </ul>
      {runs.length > 0 ? (
        <ul className="app-jobs-runs">
          {runs.map((r) => (
            <li key={r.id} className="app-jobs-run-row" data-testid="app-job-run-row" data-status={r.status}>
              <span className={`app-jobs-dot app-jobs-dot-${r.status}`} aria-hidden="true" />
              <span className="app-jobs-run-job">
                {jobs.find((job) => job.id === r.jobId)?.plain ?? "A job no longer in the design"}
                <span className="sr-only">{r.status === "done" ? " — done" : r.status === "failed" ? " — failed" : " — running"}</span>
              </span>
              <span className="app-jobs-run-summary">{r.summary ?? (r.status === "running" ? "Running…" : "No summary.")}</span>
              <span className="app-jobs-when">{ago(r.startedAt, now)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
