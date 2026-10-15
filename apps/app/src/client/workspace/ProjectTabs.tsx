import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { Icon } from '../icons.tsx';
import { WORDS } from '../copy.ts';
import { useWorkspaceChrome } from './Chrome.tsx';
import { useProjectHackathon, useWorkflowPhase } from '../queries.ts';
import { activeStep, workflowSteps } from './project-status.ts';
import { hackathonChips, oneLineIdea } from './project-header.ts';

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

export type ProjectTabId = 'overview' | 'plan' | 'build' | 'submission';

/** A step's status in words, from real data only. */
export interface StepStatus {
	text: string;
	tone: 'done' | 'needs' | 'neutral';
}

/** The four steps; Overview is not one of them (it orients above them). */
export type ProjectStepId = 'plan' | 'build' | 'check' | 'submission';

const STEPS: ReadonlyArray<{ id: ProjectStepId; label: string; to: string; testid: string }> = [
	{ id: 'plan', label: WORDS.plan, to: '/design-review', testid: 'project-tab-plan' },
	{ id: 'build', label: WORDS.build, to: '/runs', testid: 'project-tab-build' },
	{ id: 'check', label: WORDS.check, to: '/evidence', testid: 'project-tab-evidence' },
	{ id: 'submission', label: WORDS.submit, to: '/submission', testid: 'project-tab-submission' },
];

export function ProjectTabs(props: {
	current: ProjectTabId;
	/** Per-step status in words, from each page's real data (optional). */
	steps?: Partial<Record<ProjectStepId, StepStatus>>;
	/** The nearest real deadline, when the page's data knows one. */
	deadline?: string | null;
}): ReactElement {
	const chrome = useWorkspaceChrome();
	const project = chrome.selectedProject;
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const hackathon = useProjectHackathon(actor, project?.id ?? null);
	// A project is for a hackathon when it has a contest link OR was started
	// from a proposal for one (those never got a contest link).
	const isPersonal = !project?.contestUrl && !hackathon.data?.hackathon;
	const lastLabel = isPersonal ? WORDS.share : WORDS.submit;
	const deadline = props.deadline ?? null;

	// Self-source the step statuses from the REAL workflow phase when the page
	// did not pass its own. A page with richer data (e.g. Check's readiness
	// count) overrides by passing `steps` explicitly; both are real server
	// state, never a client guess.
	const phase = useWorkflowPhase(actor, project?.id ?? null);
	const derivedSteps = useMemo(
		() => (project ? workflowSteps(phase.data ?? null, { personal: isPersonal }) : undefined),
		[project, phase.data, isPersonal],
	);
	const steps = props.steps ?? derivedSteps;
	const active = project ? activeStep(phase.data ?? null) : null;
	const activeIndex = active ? STEPS.findIndex((step) => step.id === active) : -1;
	const activeLabel = active ? (active === 'submission' ? lastLabel : STEPS[activeIndex]!.label) : null;

	const stepsNav = (
		<nav className="project-steps-wrap" aria-label="Project steps">
		{activeLabel ? (
			// Phones: one line + a bar instead of four cramped cards (CSS hides it on wider screens).
			<div className="project-steps-compact" data-testid="project-steps-compact">
				<span className="project-steps-compact-text">
					<b>
						Step {activeIndex + 1} of {STEPS.length} · {activeLabel}
					</b>
					{steps?.[active!]?.text ? <span> — {steps[active!]!.text}</span> : null}
				</span>
				<span className="project-steps-bar" aria-hidden="true">
					{STEPS.map((step, index) => (
						<span key={step.id} data-filled={index <= activeIndex ? 'true' : 'false'} />
					))}
				</span>
			</div>
		) : null}
		<div className="project-steps" data-testid="project-tabs">
			{STEPS.map((step) => {
				const status = steps?.[step.id];
				const isCurrent = props.current === step.id;
				const isActive = active === step.id;
				const label = step.id === 'submission' ? lastLabel : step.label;
				const stepClass = [
					'project-step',
					isCurrent ? 'current' : '',
					isActive ? 'active' : '',
					status?.tone === 'done' ? 'done' : '',
					status?.tone === 'needs' ? 'needs' : '',
				]
					.filter(Boolean)
					.join(' ');
				return (
					<Link
						key={step.id}
						to={step.to}
						className={stepClass}
						data-testid={step.testid}
						data-active={isActive ? 'true' : undefined}
						aria-current={isCurrent ? 'page' : isActive ? 'step' : undefined}
						search={(prev: Record<string, unknown>) => ({ ...prev })}
					>
						<span className="step-top">
							<span className="step-num" aria-hidden="true">
								{status?.tone === 'done' ? '✓' : STEPS.indexOf(step) + 1}
							</span>
							{label}
						</span>
						{status?.text ? <span className="step-state">{status.text}</span> : null}
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

	const idea = oneLineIdea(project.description);
	const chips = hackathonChips(hackathon.data?.hackathon ?? null);
	// The routine deadline chip stays only when the hackathon gives no deadline.
	const showRoutineDeadline = deadline && !chips.some((chip) => chip.id === 'deadline');

	return (
		<header className="project-head" data-testid="project-header">
			<div className="project-head-title">
				<span className="project-head-text">
					<Link
						to="/project"
						className="project-head-name"
						data-testid="project-head-name"
						search={(prev: Record<string, unknown>) => ({ ...prev })}
					>
						{project.name}
					</Link>
					<span className="project-head-for" data-testid="project-head-for" title={project.description ?? undefined}>
						{idea ?? (project.contestUrl ? 'For the linked hackathon' : 'A personal project')}
					</span>
				</span>
				<span className="project-head-side">
					<Link
						to="/project/settings"
						className="btn-ghost project-head-settings"
						data-testid="project-settings-gear"
						search={(prev: Record<string, unknown>) => ({ ...prev })}
					>
						<Icon name="settings" title="" />
						<span>Settings</span>
					</Link>
				</span>
			</div>
			{chips.length || showRoutineDeadline ? (
				<div className="project-head-chips" data-testid="project-head-chips">
					{chips.map((chip) =>
						chip.href ? (
							<a key={chip.id} className="project-chip" data-tone={chip.tone} data-testid={`project-chip-${chip.id}`} href={chip.href} target="_blank" rel="noopener noreferrer">
								{chip.text}
							</a>
						) : (
							<span key={chip.id} className="project-chip" data-tone={chip.tone} data-testid={`project-chip-${chip.id}`}>
								{chip.id === 'eligibility' && chip.tone === 'ok' ? <Icon name="check" title="" /> : null}
								{chip.text}
							</span>
						),
					)}
					{showRoutineDeadline ? (
						<span className="project-chip" data-tone="neutral" data-testid="project-deadline-chip" title="The nearest deadline Caddie knows about (in Routines)">
							<Icon name="calendar" title="" /> {deadline}
						</span>
					) : null}
				</div>
			) : null}
			{stepsNav}
			{/* No separate "Ask Caddie" entry: the project chat is always present
			    (docked beside the page on desktop, the composer above the mobile
			    nav), so a second input here would only duplicate it. */}
		</header>
	);
}

/** Ids of the destinations the old sub-tab strips covered (kept for tests). */
export type ProjectSubId = 'runs' | 'artifacts' | 'schedules' | 'tasks' | 'submission' | 'evidence' | 'judge';
