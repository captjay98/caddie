import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { WORDS } from '../copy.ts';

/**
 * ProjectTabs — the four project-LOCAL destinations that answer "where am I in
 * this build": Overview · Plan · Build · Submit (v2 plain words, HANDOFF §6 —
 * personal projects read the last step as Share; U06/U07 make that dynamic).
 *
 * These live one level below the global capsule (Brief · Discover · Projects):
 * they never appear on a global route, only inside a project, and they keep the
 * same ?project= in the URL so the persistent conversation stays bound to THIS
 * project. The nested siblings (Files/Routines under Build, Check/Judge under
 * Submit) render as a secondary sub-strip until U06/U07 fold them into tabs.
 */

export type ProjectTabId = 'overview' | 'plan' | 'build' | 'submission';

const PRIMARY: ReadonlyArray<{ id: ProjectTabId; label: string; to: string; testid: string }> = [
	{ id: 'overview', label: 'Overview', to: '/project', testid: 'project-tab-overview' },
	{ id: 'plan', label: WORDS.plan, to: '/design-review', testid: 'project-tab-plan' },
	{ id: 'build', label: WORDS.build, to: '/runs', testid: 'project-tab-build' },
	{ id: 'submission', label: WORDS.submit, to: '/submission', testid: 'project-tab-submission' },
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

/** Secondary strip nested under a primary destination (Build, Submit). */
export type ProjectSubId = 'runs' | 'artifacts' | 'schedules' | 'tasks' | 'submission' | 'evidence' | 'judge';

const SECONDARY: Record<'build' | 'submission', ReadonlyArray<{ id: ProjectSubId; label: string; to: string; testid: string }>> = {
	build: [
		{ id: 'runs', label: 'Activity', to: '/runs', testid: 'sub-tab-activity' },
		{ id: 'artifacts', label: WORDS.files, to: '/artifacts', testid: 'sub-tab-files' },
		{ id: 'schedules', label: WORDS.routines, to: '/schedules', testid: 'sub-tab-automation' },
		{ id: 'tasks', label: WORDS.toDos, to: '/tasks', testid: 'sub-tab-tasks' },
	],
	submission: [
		{ id: 'submission', label: 'Package', to: '/submission', testid: 'sub-tab-package' },
		{ id: 'evidence', label: WORDS.check, to: '/evidence', testid: 'sub-tab-evidence' },
		{ id: 'judge', label: 'What judges look for', to: '/judge', testid: 'sub-tab-judge' },
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
