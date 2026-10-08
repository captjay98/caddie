/**
 * WorkspaceChrome — the one header + one nav row shared by every route
 * (UI review board screens 02-05, 15, 17). Extracted from Shell.tsx so the
 * topbar, project selector, theme control and sign-out are never more than a
 * scroll away, and no destination renders as a bare `<main class="shell-loading">`.
 *
 * Header (6 controls): wordmark, project select, New project, refresh, theme,
 * Account menu (sign-out lives inside Account). The route links sit in a quiet
 * secondary nav row, matching the reference 3-zone header grammar.
 *
 * Unauthenticated: the chrome crosses the auth boundary — wordmark, theme and
 * a route back to the landing page stay visible at the sign-in wall.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Project } from '@caddie/contracts';
import { authClient } from '../auth.ts';
import { Icon } from '../icons.tsx';
import {
	useAuthStatus,
	useHomeProject,
	useProjects,
	useSessionActor,
	useSessionDisplayName,
} from '../queries.ts';

export const THEME_KEY = 'caddie-theme';

function currentTheme(): 'light' | 'dark' {
	return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export type WorkspaceNavId =
	| 'brief'
	| 'runs'
	| 'discovery'
	| 'judge'
	| 'submission'
	| 'schedules'
	| 'settings';

const NAV: ReadonlyArray<{ id: WorkspaceNavId; label: string; to: string; testid: string }> = [
	{ id: 'brief', label: 'Brief', to: '/', testid: 'nav-brief' },
	{ id: 'runs', label: 'Runs', to: '/runs', testid: 'nav-runs' },
	{ id: 'discovery', label: 'Discovery', to: '/discovery', testid: 'nav-discovery' },
	{ id: 'judge', label: 'Judge', to: '/judge', testid: 'nav-judge' },
	{ id: 'submission', label: 'Submission', to: '/submission', testid: 'nav-submission' },
	{ id: 'schedules', label: 'Schedules', to: '/schedules', testid: 'nav-schedules' },
	{ id: 'settings', label: 'Settings', to: '/settings', testid: 'nav-settings' },
];

interface WorkspaceChromeContextValue {
	actorId: string | null;
	authenticated: boolean;
	projectList: Project[];
	selectedProject: Project | null;
	effectiveProjectId: string | null;
	projectMissing: boolean;
	projectsPending: boolean;
	projectsPaused: boolean;
	projectsError: unknown;
	projectsFetching: boolean;
	selectProject: (projectId: string) => void;
	clearProjectParam: () => void;
	refreshAll: () => void;
	toggleTheme: () => void;
	theme: 'light' | 'dark';
	signOut: () => Promise<void>;
}

const WorkspaceChromeContext = createContext<WorkspaceChromeContextValue | null>(null);

export function useWorkspaceChrome(): WorkspaceChromeContextValue {
	const value = useContext(WorkspaceChromeContext);
	if (!value) {
		throw new Error('useWorkspaceChrome must be used inside WorkspaceChrome');
	}
	return value;
}

interface WorkspaceChromeProps {
	/** Which nav destination this route is — controls aria-current. */
	active: WorkspaceNavId | 'none';
	/** Breadcrumb slot, rendered under the nav row. */
	crumbs?: ReactNode;
	/** New project handler; defaults to returning to the workspace. */
	onNewProject?: () => void;
	children: ReactNode;
}

export function WorkspaceChrome(props: WorkspaceChromeProps): ReactElement {
	const auth = useAuthStatus();
	const actor = useSessionActor(Boolean(auth.data?.authenticated));
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as { project?: string };
	const actorId = actor.data ?? null;
	const actorMemo = useMemo(() => ({ actorId }), [actorId]);

	const projects = useProjects(actorMemo);
	const displayName = useSessionDisplayName();
	const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);
	const [accountOpen, setAccountOpen] = useState(false);

	const projectList: Project[] = projects.data?.projects ?? [];
	const paramProject = search.project;
	const home = useHomeProject(actorMemo, projectList.length > 0);
	const homeProject = projectList.find((project) => project.kind === 'home') ?? home.data?.project ?? null;
	const selectedProject =
		(paramProject ? projectList.find((project) => project.id === paramProject) : undefined) ??
		homeProject ??
		projectList[0] ??
		null;
	const projectMissing =
		Boolean(paramProject) && projectList.length > 0 && !projectList.some((p) => p.id === paramProject);
	const effectiveProjectId = projectMissing ? null : (selectedProject?.id ?? null);

	// Home is created server-side on first fetch; refresh the list once so the
	// selector shows it without a manual reload.
	useEffect(() => {
		if (home.data?.project && projectList.length > 0 && !projectList.some((p) => p.id === home.data!.project.id)) {
			void queryClient.invalidateQueries({ queryKey: ['projects', actorId] });
		}
	}, [home.data, projectList, queryClient, actorId]);

	const authenticated = Boolean(auth.data?.authenticated);

	function selectProject(projectId: string) {
		// Search-only navigation keeps the current route; the surface reads the
		// ?project= param and refetches (Shell semantics, surface.tsx gate).
		void navigate({
			to: '.',
			search: (prev: Record<string, unknown>) => ({
				...prev,
				project: projectId === '' ? undefined : projectId,
			}),
		});
	}

	function clearProjectParam() {
		void navigate({ to: '.', search: {} });
	}

	function refreshAll() {
		void queryClient.invalidateQueries({ queryKey: ['projects', actorId] });
		void queryClient.invalidateQueries({ queryKey: ['run-bindings', actorId] });
		void queryClient.invalidateQueries({ queryKey: ['artifacts', actorId] });
		void queryClient.invalidateQueries({ queryKey: ['plan-docs', actorId] });
		void queryClient.invalidateQueries({ queryKey: ['brief', actorId] });
	}

	function toggleTheme() {
		const next = currentTheme() === 'dark' ? 'light' : 'dark';
		document.documentElement.setAttribute('data-theme', next);
		try {
			localStorage.setItem(THEME_KEY, next);
		} catch {
			// private mode: theme stays session-only
		}
		setTheme(next);
	}

	async function signOut() {
		setAccountOpen(false);
		try {
			await authClient.signOut();
		} finally {
			void queryClient.invalidateQueries({ queryKey: ['auth'] });
		}
	}

	const context: WorkspaceChromeContextValue = {
		actorId,
		authenticated,
		projectList,
		selectedProject,
		effectiveProjectId,
		projectMissing,
		projectsPending: projects.isPending,
		projectsPaused: projects.fetchStatus === 'paused',
		projectsError: projects.error,
		projectsFetching: projects.isFetching && !projects.isPending,
		selectProject,
		clearProjectParam,
		refreshAll,
		toggleTheme,
		theme,
		signOut,
	};

	const onNewProject = props.onNewProject ?? (() => void navigate({ to: '/' }));

	return (
		<WorkspaceChromeContext.Provider value={context}>
			<div className="shell app-shell" data-testid="shell">
				<a className="skip-link" href="#main">
					Skip to content
				</a>
				<header className="topbar">
					<Link to="/" className="wordmark" data-testid="wordmark">
						CADDIE<b>·</b>
					</Link>
					{authenticated ? (
						<>
							{projects.isPending ? (
								<span className="mono-id topbar-context">loading projects…</span>
							) : (
								<label className="project-select-wrap topbar-context">
									<span className="kicker">Project</span>
									<select
										className="input project-select"
										aria-label="Project"
										data-testid="project-selector"
										value={selectedProject?.id ?? ''}
										onChange={(event) => selectProject(event.target.value)}
									>
										{projectList.length === 0 ? <option value="">No projects yet</option> : null}
										{projectList.map((project) => (
											<option key={project.id} value={project.id}>
												{project.name}
												{project.status === 'archived' ? ' (archived)' : ''}
											</option>
										))}
									</select>
								</label>
							)}
							<button
								type="button"
								className="btn-ghost topbar-context"
								data-testid="new-project"
								onClick={onNewProject}
							>
								<Icon name="plus" title="New project" /> New project
							</button>
						</>
					) : (
						<span className="topbar-actions">
							<Link to="/" className="r-link" data-testid="back-to-landing">
								<Icon name="arrowLeft" title="back to the landing page" /> Landing
							</Link>
						</span>
					)}
					<span className="topbar-actions">
						{authenticated ? (
							<button
								type="button"
								className="icon-btn topbar-context"
								title="Refresh data"
								aria-label="Refresh data"
								data-testid="refresh-data"
								onClick={refreshAll}
							>
								<Icon name="refresh" title="Refresh data" />
							</button>
						) : null}
						<button
							type="button"
							className="icon-btn"
							title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
							aria-label="Toggle theme"
							data-testid="theme-toggle"
							onClick={toggleTheme}
						>
							{theme === 'dark' ? <Icon name="sun" title="Switch to light theme" /> : <Icon name="moon" title="Switch to dark theme" />}
						</button>
						{authenticated ? (
							<div
								className="account-menu"
								onBlur={(event) => {
									// Close when focus leaves the menu entirely.
									if (!event.currentTarget.contains(event.relatedTarget as Node)) {
										setAccountOpen(false);
									}
								}}
							>
<button
								type="button"
								className="avatar-btn"
								aria-label="Account"
								aria-expanded={accountOpen}
								data-testid="account-menu"
								title={displayName.data ?? 'Account'}
								onClick={() => setAccountOpen((open) => !open)}
							>
								{displayName.data ? (
									<span className="avatar-initial">{displayName.data.trim()[0]!.toUpperCase()}</span>
								) : (
									<Icon name="user" title="Account" />
								)}
							</button>
								{accountOpen ? (
									<div className="account-menu-pop" role="menu" data-testid="account-menu-pop">
										<button
											type="button"
											role="menuitem"
											data-testid="account-new-project"
											onClick={() => {
												setAccountOpen(false);
												onNewProject();
											}}
										>
											<Icon name="plus" title="New project" /> New project
										</button>
										<Link
											to="/settings"
											role="menuitem"
											search={(prev: Record<string, unknown>) => ({ ...prev })}
											onClick={() => setAccountOpen(false)}
										>
											<Icon name="user" title="Settings" /> Settings
										</Link>
										<button type="button" role="menuitem" data-testid="sign-out" onClick={() => void signOut()}>
											Sign out
										</button>
									</div>
								) : null}
							</div>
						) : null}
					</span>
				</header>
				{authenticated ? (
					<nav className="app-nav" aria-label="Workspace" data-testid="workspace-nav">
						<span className="nav-group">Work</span>
						{NAV.map((item) => (
							<Link
								key={item.id}
								to={item.to}
								data-testid={item.testid}
								aria-current={props.active === item.id ? 'page' : undefined}
								search={(prev: Record<string, unknown>) => ({ ...prev })}
							>
								{item.label}
							</Link>
						))}
						<span className="spacer"></span>
						<Link
							to="/settings"
							data-testid="nav-integrations"
							search={(prev: Record<string, unknown>) => ({ ...prev })}
						>
							<Icon name="plug" title="integrations" /> Integrations
						</Link>
					</nav>
				) : null}
				{props.crumbs ? <div className="crumbs" data-testid="breadcrumb">{props.crumbs}</div> : null}
				<main id="main" className="shell-main">
					{props.children}
				</main>
			</div>
		</WorkspaceChromeContext.Provider>
	);
}