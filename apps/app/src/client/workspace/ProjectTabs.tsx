import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

/**
 * ProjectTabs — the four project-LOCAL destinations that answer "where am I in
 * this build" (discovery-first redesign): Overview · Plan · Build · Submission.
 *
 * These live one level below the global capsule (Brief · Discover · Projects):
 * they never appear on a global route, only inside a project, and they keep the
 * same ?project= in the URL so the persistent conversation stays bound to THIS
 * project. The nested siblings (Files/Automation under Build, Evidence/Judge
 * under Submission) render as a secondary sub-strip so nothing is orphaned.
 */

export type ProjectTabId = 'overview' | 'plan' | 'build' | 'submission';

const PRIMARY: ReadonlyArray<{ id: ProjectTabId; label: string; to: string; testid: string }> = [
	{ id: 'overview', label: 'Overview', to: '/project', testid: 'project-tab-overview' },
	{ id: 'plan', label: 'Plan', to: '/design-review', testid: 'project-tab-plan' },
	{ id: 'build', label: 'Build', to: '/runs', testid: 'project-tab-build' },
	{ id: 'submission', label: 'Submission', to: '/submission', testid: 'project-tab-submission' },
];

export function ProjectTabs(props: { current: ProjectTabId }): ReactElement {
	return (
		<nav className="project-tabs" aria-label="Project sections" data-testid="project-tabs">
			{PRIMARY.map((tab) => (
				<Link
					key={tab.id}
					to={tab.to}
					className="project-tab"
					data-testid={tab.testid}
					aria-current={props.current === tab.id ? 'page' : undefined}
					search={(prev: Record<string, unknown>) => ({ ...prev })}
				>
					{tab.label}
				</Link>
			))}
		</nav>
	);
}

/** Secondary strip nested under a primary destination (Build, Submission). */
export type ProjectSubId = 'runs' | 'artifacts' | 'schedules' | 'tasks' | 'submission' | 'evidence' | 'judge';

const SECONDARY: Record<'build' | 'submission', ReadonlyArray<{ id: ProjectSubId; label: string; to: string; testid: string }>> = {
	build: [
		{ id: 'runs', label: 'Activity', to: '/runs', testid: 'sub-tab-activity' },
		{ id: 'artifacts', label: 'Files', to: '/artifacts', testid: 'sub-tab-files' },
		{ id: 'schedules', label: 'Automation', to: '/schedules', testid: 'sub-tab-automation' },
		{ id: 'tasks', label: 'Tasks', to: '/tasks', testid: 'sub-tab-tasks' },
	],
	submission: [
		{ id: 'submission', label: 'Package', to: '/submission', testid: 'sub-tab-package' },
		{ id: 'evidence', label: 'Evidence', to: '/evidence', testid: 'sub-tab-evidence' },
		{ id: 'judge', label: 'Judge review', to: '/judge', testid: 'sub-tab-judge' },
	],
};

export function ProjectSubTabs(props: { group: 'build' | 'submission'; current: ProjectSubId }): ReactElement {
	return (
		<nav className="project-subtabs" aria-label={`${props.group} sections`} data-testid={`project-subtabs-${props.group}`}>
			{SECONDARY[props.group].map((tab) => (
				<Link
					key={tab.id}
					to={tab.to}
					className="project-subtab"
					data-testid={tab.testid}
					aria-current={props.current === tab.id ? 'page' : undefined}
					search={(prev: Record<string, unknown>) => ({ ...prev })}
				>
					{tab.label}
				</Link>
			))}
		</nav>
	);
}
