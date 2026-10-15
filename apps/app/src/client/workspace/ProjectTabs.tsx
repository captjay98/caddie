import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { Icon } from '../icons.tsx';
import { WORDS } from '../copy.ts';
import { useWorkspaceChrome } from './Chrome.tsx';
import { useWorkflowPhase } from '../queries.ts';
import { workflowSteps } from './project-status.ts';

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
	const isPersonal = !project?.contestUrl;
	const lastLabel = isPersonal ? WORDS.share : WORDS.submit;
	const deadline = props.deadline ?? null;

	// Self-source the step statuses from the REAL workflow phase when the page
	// did not pass its own. A page with richer data (e.g. Check's readiness
	// count) overrides by passing `steps` explicitly; both are real server
	// state, never a client guess.
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const phase = useWorkflowPhase(actor, project?.id ?? null);
	const derivedSteps = useMemo(
		() => (project ? workflowSteps(phase.data ?? null, { personal: isPersonal }) : undefined),
		[project, phase.data, isPersonal],
	);
	const steps = props.steps ?? derivedSteps;

	const stepsNav = (
		<nav className="project-steps" aria-label="Project steps" data-testid="project-tabs">
			{STEPS.map((step) => {
				const status = steps?.[step.id];
				const isCurrent = props.current === step.id;
				const label = step.id === 'submission' ? lastLabel : step.label;
				const stepClass = [
					'project-step',
					isCurrent ? 'current' : '',
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
						aria-current={isCurrent ? 'page' : undefined}
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
		</nav>
	);

	if (!project) {
		// No project resolved yet (or a bad ?project=): the steps still orient;
		// the header facts stay hidden until a real project exists.
		return <div className="project-head project-head-empty">{stepsNav}</div>;
	}

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
					<span className="project-head-for">
						{project.description
							? project.description
							: project.contestUrl
								? 'For the linked hackathon'
								: 'A personal project'}
					</span>
				</span>
				<span className="project-head-side">
					{deadline ? (
						<span className="project-deadline-chip" data-testid="project-deadline-chip" title="The nearest deadline Caddie knows about (in Routines)">
							<Icon name="calendar" title="" /> {deadline}
						</span>
					) : null}
					<Link
						to="/project/settings"
						className="project-head-gear"
						data-testid="project-settings-gear"
						title="Project settings"
						aria-label="Project settings"
						search={(prev: Record<string, unknown>) => ({ ...prev })}
					>
						<Icon name="panel" title="" />
					</Link>
				</span>
			</div>
			{stepsNav}
			{/* The one line that sets the mental model (§3.7, redesign direction):
			    the chat is the steering wheel; these steps are the dashboard. A
			    nontechnical user otherwise reads four tabs as four things THEY
			    must operate. Shown once, in the header, on every project page. */}
			<p className="project-head-model" data-testid="project-head-model">
				<Icon name="chat" title="" />
				<span>
					<strong>Talk to Caddie to move things forward.</strong> These steps show you where your
					project is — Caddie does the work in the chat.
				</span>
			</p>
		</header>
	);
}

/** Ids of the destinations the old sub-tab strips covered (kept for tests). */
export type ProjectSubId = 'runs' | 'artifacts' | 'schedules' | 'tasks' | 'submission' | 'evidence' | 'judge';
