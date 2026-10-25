import { useQuery } from "@tanstack/react-query";
import { workflowQueryOptions } from "../workflow-query.ts";
import { planReviewState } from "../planning/plan-decision.ts";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Icon } from "../icons.tsx";
import { WORDS } from "../copy.ts";
import { useWorkspaceChrome } from "./Chrome.tsx";
import {
  useBuildActivity,
  useProfile,
  useProjectExperience,
  useProjectHackathon,
} from "../queries.ts";
import { activeStep, workflowSteps } from "./project-status.ts";
import { hackathonChips } from "./project-header.ts";
import { deadlineTime } from "../discovery/deadline-time.ts";
import { ProjectDialog } from "../project/ProjectDialog.tsx";

/**
 * Project header + step bar (Caddie v2, HANDOFF §3.7) — replaces the old tab
 * strip. One place answers "where am I in this build":
 *
 *   Row 1: the project name (links to Overview), what it's for, a deadline
 *          chip when the brief knows one, and the gear (Project settings,
 *          enabled when its route exists — disabled with a reason until then).
 *   Row 2: the four steps Plan · Build · Check · Submit — Share for personal
 *          projects (no linked hackathon). Each step shows its own status in
 *          words, passed in from real server data by the page; a step is
 *          NEVER coloured done unless the caller's data says done, and no
 *          status is invented when nothing is known.
 *
 * Status tones (§3.7): done = green, needs = warn, current = accent, anything
 * else stays muted. Steps keep the ?project= binding so the conversation never
 * retargets.
 */

export type ProjectTabId =
  | "overview"
  | "plan"
  | "build"
  | "check"
  | "submission";

/** A step's status in words, from real data only. */
export interface StepStatus {
  text: string;
  tone: "done" | "needs" | "neutral";
}

/** The four steps; Overview is not one of them (it orients above them). */
export type ProjectStepId = "plan" | "build" | "check" | "submission";

const STEPS: ReadonlyArray<{
  id: ProjectStepId;
  label: string;
  to: string;
  testid: string;
}> = [
  {
    id: "plan",
    label: WORDS.plan,
    to: "/design-review",
    testid: "project-tab-plan",
  },
  { id: "build", label: WORDS.build, to: "/runs", testid: "project-tab-build" },
  {
    id: "check",
    label: WORDS.check,
    to: "/evidence",
    testid: "project-tab-evidence",
  },
  {
    id: "submission",
    label: WORDS.submit,
    to: "/submission",
    testid: "project-tab-submission",
  },
];

export function ProjectTabs(props: {
  current: ProjectTabId;
  /** Optional project resources, mounted only when Info is open. */
  context?: ReactNode;
  /** Per-step status in words, from each page's real data (optional). */
  steps?: Partial<Record<ProjectStepId, StepStatus>>;
  /** The nearest real deadline, when the page's data knows one. */
  deadline?: string | null;
}): ReactElement {
  const chrome = useWorkspaceChrome();
  const project = chrome.selectedProject;
  const location = useLocation();
  const [infoOpen, setInfoOpen] = useState(location.hash === 'todo');
  useEffect(() => { if (location.hash === 'todo') setInfoOpen(true); }, [location.hash]);
  const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
  const hackathon = useProjectHackathon(actor, project?.id ?? null);
  const profile = useProfile(actor);
  // A project is for a hackathon when it has a contest link OR was started
  // from a proposal for one (those never got a contest link).
  const isPersonal = !project?.contestUrl && !hackathon.data?.hackathon;
  const lastLabel = isPersonal ? WORDS.share : WORDS.submit;
  const deadline = props.deadline ?? null;

  // Self-source the step statuses from the REAL workflow phase when the page
  // did not pass its own. A page with richer data (e.g. Check's readiness
  // count) overrides by passing `steps` explicitly; both are real server
  // state, never a client guess.
  const workflow = useQuery(workflowQueryOptions(chrome.actorId, project?.id ?? null));
  const phase = workflow.data?.workflow?.phase ?? null;
  const reviewLabel = phase === "review" ? planReviewState(workflow.data?.plan, workflow.data?.approval).label : undefined;
  // Whether the plan was approved, from the project status (the same shared
  // query as the Now card): it tells a paused build from a stuck plan, which
  // the `blocked` phase alone cannot. Unknown while it loads or if it fails.
  const experience = useProjectExperience(actor, project?.id ?? null);
  const planApproved = experience.data
    ? experience.data.plan?.approved === true
    : undefined;
  const derivedSteps = useMemo(
    () =>
      project
        ? workflowSteps(phase ?? null, {
            personal: isPersonal,
            planApproved,
            reviewLabel,
          })
        : undefined,
    [project, phase, isPersonal, planApproved, reviewLabel],
  );
  const activity = useBuildActivity(
    actor,
    phase === "building" ? (project?.id ?? null) : null,
    false,
  );
  const quiet =
    phase === "building" &&
    Boolean(activity.data?.timeline?.quiet || activity.error);
  const steps = quiet
    ? {
        ...(props.steps ?? derivedSteps),
        build: {
          text: activity.error ? "Status unavailable" : "No recent activity",
          tone: "needs" as const,
        },
      }
    : (props.steps ?? derivedSteps);
  const active = project
    ? activeStep(phase ?? null, { planApproved })
    : null;
  const activeIndex = active
    ? STEPS.findIndex((step) => step.id === active)
    : -1;
  const activeLabel = active
    ? active === "submission"
      ? lastLabel
      : STEPS[activeIndex]!.label
    : null;

  const stepsNav = (
    <nav className="project-steps-wrap" aria-label="Project steps">
      {activeLabel ? (
        // Phones: one line + a bar instead of four cramped cards (CSS hides it on wider screens).
        <div
          className="project-steps-compact"
          data-testid="project-steps-compact"
        >
          <span className="project-steps-compact-text">
            <b>
              Step {activeIndex + 1} of {STEPS.length} · {activeLabel}
            </b>
            {steps?.[active!]?.text ? (
              <span> — {steps[active!]!.text}</span>
            ) : null}
          </span>
          <span className="project-steps-bar" aria-hidden="true">
            {STEPS.map((step, index) => (
              <span
                key={step.id}
                data-filled={index <= activeIndex ? "true" : "false"}
              />
            ))}
          </span>
        </div>
      ) : null}
      <div className="project-steps" data-testid="project-tabs">
        {STEPS.map((step) => {
          const status = steps?.[step.id];
          const isCurrent = props.current === step.id;
          const isActive = active === step.id;
          const label = step.id === "submission" ? lastLabel : step.label;
          const stepClass = [
            "project-step",
            isCurrent ? "current" : "",
            isActive ? "active" : "",
            status?.tone === "done" ? "done" : "",
            status?.tone === "needs" ? "needs" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <Link
              key={step.id}
              to={step.to}
              className={stepClass}
              data-testid={step.testid}
              data-active={isActive ? "true" : undefined}
              aria-current={isCurrent ? "page" : isActive ? "step" : undefined}
              search={(prev: Record<string, unknown>) => ({ ...(typeof prev.project === 'string' ? { project: prev.project } : {}), ...(prev.pane === 'channel' ? { pane: 'channel' as const } : {}) })}
            >
              <span className="step-top">
                <span className="step-num" aria-hidden="true">
                  {status?.tone === "done" ? "✓" : STEPS.indexOf(step) + 1}
                </span>
                {label}
              </span>
              {status?.text ? (
                <span className="step-state">{status.text}</span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </nav>
  );

  if (!project) {
    // No project resolved yet (or a bad ?project=): the steps still orient;
    // the header facts stay hidden until a real project exists.
    return <div className="project-head project-head-empty">{stepsNav}</div>;
  }

  const chips = hackathonChips(hackathon.data?.hackathon ?? null);
  // The routine deadline chip stays only when the hackathon gives no deadline.
  const showRoutineDeadline =
    deadline && !chips.some((chip) => chip.id === "deadline");
  const urgent = chips.find(
    (chip) =>
      chip.id === "deadline" &&
      (chip.tone === "warn" || chip.tone === "danger"),
  );
  const localDeadline = deadlineTime(
    hackathon.data?.hackathon?.deadline,
    profile.data?.profile?.timezone ?? undefined,
  ).local;

  return (
    <header
      className="project-head focused-project-head"
      data-testid="project-header"
    >
      {/* One title row (owner 2026-10-23): back arrow, name, Settings. The
			    arrow sits beside the name instead of taking a row of its own, and
			    everything below starts at the same left edge as the page. */}
      <div className="project-head-title">
        <Link
          to="/projects"
          search={{}}
          className="project-back"
          aria-label="Back to Projects"
        >
          <Icon name="arrowLeft" title="" />
        </Link>
        <Link
          to="/project"
          className="project-head-name"
          data-testid="project-head-name"
          search={(prev: Record<string, unknown>) => ({ ...(typeof prev.project === 'string' ? { project: prev.project } : {}), ...(prev.pane === 'channel' ? { pane: 'channel' as const } : {}) })}
        >
          {project.name}
        </Link>
        <button
          type="button"
          className="project-head-info"
          aria-label="About this project"
          title="About this project"
          onClick={() => setInfoOpen(true)}
        >
          <Icon name="info" title="" />
        </button>
        <Link
          to="/project/settings"
          className="btn-ghost project-head-settings"
          data-testid="project-settings-gear"
          aria-label="Project settings"
          search={(prev: Record<string, unknown>) => ({ ...(typeof prev.project === 'string' ? { project: prev.project } : {}), ...(prev.pane === 'channel' ? { pane: 'channel' as const } : {}) })}
        >
          <Icon name="settings" title="" />
          <span>Settings</span>
        </Link>
      </div>
      {urgent ? (
        <p
          className="project-head-urgent"
          data-testid="project-urgent-deadline"
        >
          <Icon name="clock" title="" />
          {localDeadline
            ? `${hackathon.data?.hackathon?.ended ? "Closed" : "Closes"} ${localDeadline} · Your time`
            : urgent.text}
        </p>
      ) : null}
      <ProjectDialog
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        title="About this project"
      >
        <div className="project-info-body">
          <h3>{project.name}</h3>
          <p data-testid="project-head-for">
            {project.description ||
              (project.contestUrl
                ? "For the linked hackathon"
                : "A personal project")}
          </p>
          {hackathon.isPending ? (
            <p className="state-detail">Reading the event details…</p>
          ) : hackathon.error ? (
            <p className="state-detail">
              Event details could not be loaded.{" "}
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void hackathon.refetch()}
              >
                Try again
              </button>
            </p>
          ) : null}
          {chips.length || showRoutineDeadline || project.contestUrl ? (
            <section
              className="project-info-facts"
              data-testid="project-head-chips"
            >
              <h3>Event and deadline</h3>
              {chips
                .filter((chip) => chip.id !== "deadline" || !localDeadline)
                .map((chip) => (
                  <p key={chip.id} data-testid={`project-chip-${chip.id}`}>
                    {chip.href ? (
                      <a
                        href={chip.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {chip.text}
                      </a>
                    ) : (
                      chip.text
                    )}
                  </p>
                ))}
              {!chips.some((chip) => chip.id === "event") &&
              project.contestUrl ? (
                <a
                  href={project.contestUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open the linked hackathon
                </a>
              ) : null}
              {localDeadline ? (
                <p data-testid="project-local-deadline">
                  {localDeadline} · Your time
                </p>
              ) : hackathon.data?.hackathon?.deadline ? (
                <p className="state-detail">
                  The exact closing time and time zone have not been confirmed.
                </p>
              ) : null}
              {showRoutineDeadline ? (
                <p data-testid="project-deadline-chip">{deadline}</p>
              ) : null}
            </section>
          ) : null}
          {props.context}
        </div>
      </ProjectDialog>
      {stepsNav}
      {/* No separate "Ask Caddie" entry: the project chat is always present
			    (docked beside the page on desktop, the composer above the mobile
			    nav), so a second input here would only duplicate it. */}
    </header>
  );
}

/** Ids of the destinations the old sub-tab strips covered (kept for tests). */
export type ProjectSubId =
  | "runs"
  | "artifacts"
  | "schedules"
  | "tasks"
  | "submission"
  | "evidence"
  | "judge";
