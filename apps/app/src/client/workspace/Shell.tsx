import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Project } from '@caddie/contracts';
import { SignInPanel, authClient } from '../auth.ts';
import { failureKind, StatePanel } from '../states.tsx';
import {
	useArtifacts,
	useAuthStatus,
	useCreateProject,
	useProjects,
	useRunBindings,
	useSessionActor,
	watchAuthTransitions,
} from '../queries.ts';
import { BriefLane } from '../brief/DecisionCard.tsx';
import { RunInspector } from '../runs/RunInspector.tsx';
import { Channel } from '../conversation/Channel.tsx';
import { standbySource, useChannelStore } from '../conversation/channel-store.ts';

/**
 * Workspace shell — feature-ledger rows C5/H9 (Card/Tasks/Channel continuity
 * and the two-pane shell, adapted to typed payloads + TanStack Router/Query).
 *
 * Layout: topbar (wordmark, project selector, refresh, theme, sign-out) over a
 * two-pane split at >=768px (Brief/Runs aside + Channel) and a single pane
 * with a bottom tab bar below (Channel is the mobile home surface). The aside
 * is collapsible ("collapsible detail" in the design direction). All colors
 * come from the halo tokens; the theme switch is the data-theme attribute.
 *
 * Session hygiene (reference lesson, P00 audit): the authenticated shell is
 * KEYED by actor id, so an account switch remounts every per-user state fresh;
 * query keys carry the actor id and non-auth caches are wiped on transitions.
 */

function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(
		() => typeof window !== 'undefined' && window.matchMedia(query).matches,
	);
	useEffect(() => {
		const mq = window.matchMedia(query);
		const onChange = () => setMatches(mq.matches);
		mq.addEventListener('change', onChange);
		window.addEventListener('resize', onChange);
		return () => {
			mq.removeEventListener('change', onChange);
			window.removeEventListener('resize', onChange);
		};
	}, [query]);
	return matches;
}

type Tab = 'brief' | 'runs' | 'channel';

const THEME_KEY = 'caddie-theme';

function currentTheme(): 'light' | 'dark' {
	return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function Shell(): ReactElement {
	const auth = useAuthStatus();

	if (auth.isPending) {
		return (
			<div className="shell" data-testid="shell">
				<div className="shell-loading">
					<StatePanel kind="loading" title="Checking your session…" />
				</div>
			</div>
		);
	}
	if (auth.error) {
		return (
			<div className="shell" data-testid="shell">
				<div className="shell-loading">
					<StatePanel
						kind={failureKind(auth.error)}
						detail={auth.error instanceof Error ? auth.error.message : undefined}
						onRetry={() => void auth.refetch()}
						retryLabel="Check again"
					/>
				</div>
			</div>
		);
	}
	if (!auth.data.authenticated) {
		// Unauthenticated /app shows the P01 sign-in state (composed build has
		// auth enabled; this is the real fail-closed probe, not a mock).
		return (
			<div className="shell" data-testid="shell">
				<main id="main" className="shell-loading">
					<section className="sign-in-card card-surface">
						<p className="kicker" data-tone="action">
							CADDIE · WORKSPACE
						</p>
						<h1 className="sign-in-title">Sign in to your workspace</h1>
						<SignInPanel callbackURL="/app/" />
					</section>
				</main>
			</div>
		);
	}
	return <AuthedShellGate />;
}

function AuthedShellGate(): ReactElement {
	const auth = useAuthStatus();
	const actor = useSessionActor(Boolean(auth.data?.authenticated));
	// Key by actor: an account switch remounts every per-user state fresh, so
	// neither channel drafts nor tab state can leak across accounts.
	return <AuthedShell key={actor.data ?? 'pending'} actorId={actor.data ?? null} />;
}

function AuthedShell(props: { actorId: string | null }): ReactElement {
	const actor = useMemo(() => ({ actorId: props.actorId }), [props.actorId]);
	const auth = useAuthStatus();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as { project?: string };

	const projects = useProjects(actor);
	const isDesktop = useMediaQuery('(min-width: 768px)');
	const [tab, setTab] = useState<Tab>(isDesktop ? 'brief' : 'channel');
	const [detailOpen, setDetailOpen] = useState(true);
	const [formOpen, setFormOpen] = useState(false);
	const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);

	const projectList: Project[] = projects.data?.projects ?? [];
	const paramProject = search.project;
	const selectedProject =
		projectList.find((project) => project.id === paramProject) ?? projectList[0] ?? null;
	const projectMissing =
		Boolean(paramProject) && projectList.length > 0 && !selectedProject;
	const effectiveProjectId = projectMissing ? null : (selectedProject?.id ?? null);

	const runBindings = useRunBindings(actor, effectiveProjectId);
	const artifacts = useArtifacts(actor, effectiveProjectId);
	const createProject = useCreateProject(actor);
	const channel = useChannelStore({ sessionKey: props.actorId ?? 'anon', projectId: effectiveProjectId });

	// Cross-account cache hygiene: on any auth/actor transition, wipe every
	// non-auth query so another account's rows can never be served or prefetched.
	const guard = useMemo(() => watchAuthTransitions(queryClient), [queryClient]);
	useEffect(() => {
		guard.maybe(auth.data?.authenticated, props.actorId);
	}, [guard, props.actorId, auth.data?.authenticated, queryClient]);

	function selectProject(projectId: string) {
		void navigate({
			to: '/',
			search: (prev: Record<string, unknown>) => ({
				...prev,
				project: projectId === '' ? undefined : projectId,
			}),
		});
	}

	function clearProjectParam() {
		void navigate({ to: '/', search: {} });
	}

	function refreshAll() {
		void queryClient.invalidateQueries({ queryKey: ['projects', props.actorId] });
		void queryClient.invalidateQueries({ queryKey: ['run-bindings', props.actorId] });
		void queryClient.invalidateQueries({ queryKey: ['artifacts', props.actorId] });
		void queryClient.invalidateQueries({ queryKey: ['plan-docs', props.actorId] });
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
		try {
			await authClient.signOut();
		} finally {
			void queryClient.invalidateQueries({ queryKey: ['auth'] });
		}
	}

	const projectsState = projects.isPending
		? 'loading'
		: projects.error
			? failureKind(projects.error)
			: 'empty';
	const briefStale = projects.isFetching && !projects.isPending;
	const asideHidden = tab === 'channel' || !detailOpen;

	return (
		<div className="shell" data-testid="shell" data-theme-name={theme}>
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<header className="topbar">
				<span className="wordmark">
					CADDIE<b>▸</b>
				</span>
				{projects.isPending ? (
					<span className="mono-id">loading projects…</span>
				) : (
					<label className="project-select-wrap">
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
				<div className="topbar-actions">
					<button
						type="button"
						className="btn-ghost"
						data-testid="new-project"
						onClick={() => setFormOpen((open) => !open)}
						aria-expanded={formOpen}
					>
						+ New project
					</button>
					<button
						type="button"
						className="icon-btn"
						title="Refresh data"
						aria-label="Refresh data"
						data-testid="refresh-data"
						onClick={refreshAll}
					>
						⟳
					</button>
					<button
						type="button"
						className="icon-btn"
						title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
						aria-label="Toggle theme"
						data-testid="theme-toggle"
						onClick={toggleTheme}
					>
						{theme === 'dark' ? '☀' : '☾'}
					</button>
					<button
						type="button"
						className="icon-btn"
						title={detailOpen ? 'Collapse detail pane' : 'Expand detail pane'}
						aria-expanded={detailOpen}
						aria-label="Toggle detail pane"
						data-testid="detail-toggle"
						onClick={() => setDetailOpen((open) => !open)}
					>
						{detailOpen ? '⇤' : '⇥'}
					</button>
					<button
						type="button"
						className="btn-ghost"
						data-testid="sign-out"
						onClick={() => void signOut()}
					>
						Sign out
					</button>
				</div>
			</header>

			{formOpen ? (
				<NewProjectForm
					onCancel={() => setFormOpen(false)}
					onSubmit={(input) =>
						createProject.mutateAsync(input).then((result) => {
							setFormOpen(false);
							selectProject(result.project.id);
						})
					}
					error={createProject.error}
					busy={createProject.isPending}
					hasProjects={projectList.length > 0}
					lastWorkspaceId={projectList[0]?.workspaceId}
				/>
			) : null}

			<div className="shell-body">
				<aside className="aside" data-collapsed={asideHidden} data-testid="aside">
					{isDesktop ? (
						<div className="aside-tabs" role="tablist" aria-label="Workspace panes">
							<button
								type="button"
								role="tab"
								className="tab-btn"
								aria-selected={tab === 'brief'}
								data-testid="tab-brief"
								onClick={() => setTab('brief')}
							>
								Brief
							</button>
							<button
								type="button"
								role="tab"
								className="tab-btn"
								aria-selected={tab === 'runs'}
								data-testid="tab-runs"
								onClick={() => setTab('runs')}
							>
								Runs
							</button>
						</div>
					) : null}

					<div className="aside-scroll" id="main">
						{projectMissing ? (
							<StatePanel
								kind="error"
								title="That project is not in your list"
								detail="The link points at a project your account cannot see (or that no longer exists)."
								onRetry={clearProjectParam}
								retryLabel="Back to your projects"
							/>
						) : projects.isPending ? (
							<StatePanel kind="loading" title="Fetching your projects…" />
						) : projects.fetchStatus === 'paused' ? (
							// TanStack pauses refetches while the browser reports
							// offline — that pause IS the offline state: last loaded
							// data stays visible, and the refetch resumes on reconnect.
							<StatePanel
								kind="offline"
								title="You are offline"
								detail="Showing the last loaded data. Refetching resumes automatically when you reconnect."
							/>
						) : projects.error ? (
							<StatePanel
								kind={failureKind(projects.error)}
								detail={projects.error instanceof Error ? projects.error.message : undefined}
								onRetry={
									failureKind(projects.error) === 'denied' ? undefined : () => void projects.refetch()
								}
							/>
						) : !effectiveProjectId ? (
							<StatePanel
								kind="empty"
								title="No project selected"
								detail="Select or create a project — its brief, runs and artifacts open here."
							/>
						) : tab === 'brief' ? (
							<BriefLane
								state={{
									kind: projectsState === 'empty' ? 'empty' : projectsState,
									error: projects.error,
									stale: briefStale,
									retry: () => void projects.refetch(),
								}}
								cards={[]}
							/>
						) : (
							<RunInspector
								runs={{
									isPending: runBindings.isPending,
									isFetching: runBindings.isFetching,
									error: runBindings.error,
									items: runBindings.data?.runBindings ?? [],
									retry: () => void runBindings.refetch(),
								}}
								artifacts={{
									isPending: artifacts.isPending,
									isFetching: artifacts.isFetching,
									error: artifacts.error,
									items: artifacts.data?.artifacts ?? [],
									retry: () => void artifacts.refetch(),
								}}
							/>
						)}
					</div>
				</aside>

				<Channel
					source={standbySource}
					drafts={channel.drafts}
					projectId={effectiveProjectId}
					onSend={channel.addDraft}
					onRetryDraft={channel.retryDraft}
					onDiscardDraft={channel.discardDraft}
				/>
			</div>

			<nav className="bottom-nav" aria-label="Workspace panes">
				<button
					type="button"
					className="tab-btn"
					aria-selected={tab === 'brief'}
					data-testid="tab-brief-mobile"
					onClick={() => setTab('brief')}
				>
					Brief
				</button>
				<button
					type="button"
					className="tab-btn"
					aria-selected={tab === 'runs'}
					data-testid="tab-runs-mobile"
					onClick={() => setTab('runs')}
				>
					Runs
				</button>
				<button
					type="button"
					className="tab-btn"
					aria-selected={tab === 'channel'}
					data-testid="tab-channel-mobile"
					onClick={() => setTab('channel')}
				>
					Channel
				</button>
			</nav>
		</div>
	);
}

function NewProjectForm(props: {
	onSubmit: (input: { name: string; description?: string; workspaceId?: string }) => Promise<unknown>;
	onCancel: () => void;
	error: unknown;
	busy: boolean;
	hasProjects: boolean;
	lastWorkspaceId?: string;
}): ReactElement {
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');

	return (
		<form
			className="new-project-form"
			data-testid="new-project-form"
			onSubmit={(event) => {
				event.preventDefault();
				const trimmed = name.trim();
				if (!trimmed || props.busy) return;
				void props.onSubmit({
					name: trimmed,
					...(description.trim() ? { description: description.trim() } : {}),
					...(props.hasProjects && props.lastWorkspaceId ? { workspaceId: props.lastWorkspaceId } : {}),
				});
			}}
		>
			<p className="kicker" data-tone="action">
				NEW PROJECT
			</p>
			<div className="row">
				<input
					className="input"
					placeholder="Project name"
					aria-label="Project name"
					data-testid="new-project-name"
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
				<button type="submit" className="btn-key" data-testid="new-project-submit" disabled={!name.trim() || props.busy}>
					{props.busy ? 'Creating…' : 'Create'}
				</button>
				<button type="button" className="btn-ghost" onClick={props.onCancel}>
					Cancel
				</button>
			</div>
			<input
				className="input"
				placeholder="One-line description (optional)"
				aria-label="Project description"
				data-testid="new-project-description"
				value={description}
				onChange={(event) => setDescription(event.target.value)}
			/>
			{!props.hasProjects ? (
				<p className="state-detail">A first project creates your Home workspace.</p>
			) : null}
			{props.error ? (
				<p className="form-error" role="alert" data-testid="new-project-error">
					{props.error instanceof Error ? props.error.message : 'Creating the project failed.'}
				</p>
			) : null}
		</form>
	);
}
