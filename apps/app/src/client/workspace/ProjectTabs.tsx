import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Icon } from '../icons.tsx';
import { WORDS } from '../copy.ts';
import { useWorkspaceChrome } from './Chrome.tsx';

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

	const stepsNav = (
		<nav className="project-steps" aria-label="Project steps" data-testid="project-tabs">
			{STEPS.map((step) => {
				const status = props.steps?.[step.id];
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
					<button
						type="button"
						className="project-head-gear"
						data-testid="project-settings-gear"
						disabled
						title="Project settings is coming"
						aria-label="Project settings (coming soon)"
					>
						<Icon name="panel" title="" />
					</button>
				</span>
			</div>
			{stepsNav}
		</header>
	);
}

/** Ids of the destinations the old sub-tab strips covered (kept for tests). */
export type ProjectSubId = 'runs' | 'artifacts' | 'schedules' | 'tasks' | 'submission' | 'evidence' | 'judge';
