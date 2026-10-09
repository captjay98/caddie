import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { DecisionCard as DecisionCardType, Project } from '@caddie/contracts';
import { SignInPanel } from './auth.ts';
import { failureKind, StatePanel } from './states.tsx';
import { Icon } from './icons.tsx';
import { DiscoveryResults, type DiscoveryCandidateRecord } from './discovery/Results.tsx';
import { JudgeScorecard } from './judge/Scorecard.tsx';
import { SubmissionPackage } from './submission/Package.tsx';
import { Schedules, type ScheduleRow } from './tasks/Schedules.tsx';
import { Tasks } from './tasks/Tasks.tsx';
import { EvidenceDrawer } from './evidence/Drawer.tsx';
import { ArtifactViewer, type ViewerRevision } from './artifacts/Viewer.tsx';
import { DesignReview } from './planning/DesignReview.tsx';
import { RepositoryPicker, type SelectedRepository } from './repositories/RepositoryPicker.tsx';
import { RunInspector } from './runs/RunInspector.tsx';
import { Search } from './search/Search.tsx';
import { BriefLane } from './brief/DecisionCard.tsx';
import {
	useArtifactRevisions,
	useArtifacts,
	useBriefCards,
	useCreateProject,
	usePlanDocRevisions,
	useRunBindings,
} from './queries.ts';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from './api.ts';
import { useWorkspaceChrome } from './workspace/Chrome.tsx';
import { ProjectTabs, ProjectSubTabs } from './workspace/ProjectTabs.tsx';

/**
 * The routed surfaces for the discovery-first shell.
 *
 * Two families:
 *   - ACCOUNT surfaces (Discover, Projects, Search, Automations, Usage) render
 *     nav='discover'|'projects'|'account' so the persistent conversation stays
 *     bound to the actor's Home/general scope. They never require a build
 *     project first — that prerequisite is exactly what the redesign removes.
 *   - PROJECT surfaces (Overview/Plan/Build/Submission and their siblings)
 *     render nav='project': the conversation follows the selected project and
 *     the ?project= id is preserved by every tab link.
 *
 * The fail-closed contract is unchanged: the real /api/auth/status probe decides
 * sign-in vs. surface, the project is resolved from ?project= against the
 * actor's OWN list, an invisible id is a MISSING project (never a silent
 * fallback to another one), and every failure kind is an explicit state panel.
 * The scope resolution now lives once in WorkspaceChrome (its conversation must
 * bind to the same id the body reads), so surfaces consume it from context.
 */

function SignInGate(): ReactElement {
	return (
		<section className="sign-in-card card-surface">
			<p className="kicker" data-tone="action">
				CADDIE · WORKSPACE
			</p>
			<h1 className="sign-in-title">Sign in to your workspace</h1>
			<SignInPanel callbackURL="/app/" />
		</section>
	);
}

/**
 * Reads the resolved project scope from the chrome and renders the honest
 * states, then hands the concrete project id to the body. No fetch of project
 * data happens before the project is resolved.
 */
function ProjectGate(props: { children: (projectId: string) => ReactElement }): ReactElement | null {
	const chrome = useWorkspaceChrome();
	if (!chrome.authenticated) return <SignInGate />;
	if (chrome.projectsPending) return <StatePanel kind="loading" title="Fetching your projects…" />;
	if (chrome.projectsError) {
		return (
			<StatePanel
				kind={failureKind(chrome.projectsError)}
				detail={chrome.projectsError instanceof Error ? chrome.projectsError.message : undefined}
				onRetry={failureKind(chrome.projectsError) === 'denied' ? undefined : chrome.refreshAll}
			/>
		);
	}
	if (chrome.projectMissing) {
		return (
			<StatePanel
				kind="error"
				title="That project is not in your list"
				detail="The link points at a project your account cannot see (or that no longer exists). It was not opened, and no other project was substituted."
				onRetry={chrome.clearProjectParam}
				retryLabel="Back to your projects"
			/>
		);
	}
	if (!chrome.effectiveProjectId) {
		return (
			<StatePanel
				kind="empty"
				title="No project selected"
				detail="This screen reads one project's data. Choose a project from Projects, or start one."
			/>
		);
	}
	return props.children(chrome.effectiveProjectId);
}

// --- DISCOVER (account-level, first-class, before any project) -------------------

export function DiscoverPage(): ReactElement {
	// The route component renders ONLY the chrome wrapper plus static markup — it
	// must not read the chrome context itself, because WorkspaceChrome's provider
	// mounts below this component. All chrome-consuming logic lives in DiscoverBody.
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<div className="r-section-head">
						<div>
							<p className="kicker" data-tone="action">
								DISCOVER
							</p>
							<h1 className="page-title">Hackathons</h1>
							<p className="page-lede">
								Contests Caddie is watching that fit you — before you have any project. Browse, save the
								ones you like, and explore ideas for one when you are ready. Nothing here creates a build
								until you say so.
							</p>
						</div>
					</div>
					<DiscoverBody />
				</div>
			</div>
		</>
	);
}

function DiscoverBody(): ReactElement {
	const chrome = useWorkspaceChrome();
	const createProject = useCreateProject(useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]));
	const navigate = useNavigate();
	const [exploreBusy, setExploreBusy] = useState(false);
	const [commitFor, setCommitFor] = useState<DiscoveryCandidateRecord | null>(null);
	const [commitName, setCommitName] = useState('');
	const [exploreError, setExploreError] = useState<string | null>(null);

	// Explore handoff: continue an existing project already linked to this
	// contest; otherwise open an explicit commit step (name + consequence +
	// visible errors) instead of creating a project on the first click. The
	// continue-first guard + the busy lock prevent a duplicate project on
	// retries; a save/accept never creates a build project.
	function onExplore(candidate: DiscoveryCandidateRecord) {
		if (exploreBusy) return;
		const existing = chrome.buildProjects.find((p) => p.contestUrl === candidate.url);
		if (existing) {
			chrome.openProject(existing.id);
			return;
		}
		setCommitName(candidate.title);
		setExploreError(null);
		setCommitFor(candidate);
	}

	function closeCommit() {
		if (exploreBusy) return;
		setCommitFor(null);
		setExploreError(null);
	}

	function submitCommit() {
		if (!commitFor || exploreBusy) return;
		setExploreBusy(true);
		setExploreError(null);
		void createProject
			.mutateAsync({
				name: commitName.trim() || commitFor.title,
				...(commitFor.summary ? { description: commitFor.summary } : {}),
				contestUrl: commitFor.url,
				workspaceId: chrome.buildProjects[0]?.workspaceId,
			})
			.then(
				(result) => {
					setExploreBusy(false);
					setCommitFor(null);
					void navigate({ to: '/project', search: { project: result.project.id } });
				},
				(cause) => {
					setExploreBusy(false);
					setExploreError(cause instanceof Error ? cause.message : String(cause));
				},
			);
	}

	if (!chrome.authenticated) return <SignInGate />;
	if (chrome.homeProject) {
		return (
			<>
				<DiscoveryResults projectId={chrome.homeProject.id} onExplore={onExplore} exploreBusy={exploreBusy} />
				{commitFor ? (
					<div className="modal-backdrop" data-testid="explore-commit-backdrop" onMouseDown={() => closeCommit()}>
						<form
							className="commit-panel card-surface"
							data-testid="explore-commit"
							onMouseDown={(e) => e.stopPropagation()}
							onSubmit={(e) => {
								e.preventDefault();
								submitCommit();
							}}
						>
							<p className="kicker" data-tone="action">
								EXPLORE IDEAS
							</p>
							<h3 className="state-title">Start a project for this contest</h3>
							<p className="state-detail">
								Opens a project for “{commitFor.title}”, linked to the contest. No build starts until you send
								your first message — nothing is submitted anywhere.
							</p>
							<label className="kicker" htmlFor="explore-commit-name">
								Project name
							</label>
							<input
								id="explore-commit-name"
								className="input"
								data-testid="explore-commit-name"
								value={commitName}
								onChange={(e) => setCommitName(e.target.value)}
								autoFocus
							/>
							{exploreError ? (
								<div role="alert" className="sign-in-error" data-testid="explore-commit-error">
									<b>Could not create the project.</b>
									<span> {exploreError}</span>
								</div>
							) : null}
							<div className="row-actions">
								<button
									type="submit"
									className="btn-key"
									data-testid="explore-commit-create"
									disabled={exploreBusy || commitName.trim() === ''}
								>
									{exploreBusy ? 'Creating…' : 'Create project'}
								</button>{' '}
								<button
									type="button"
									className="btn-ghost"
									data-testid="explore-commit-cancel"
									onClick={() => closeCommit()}
									disabled={exploreBusy}
								>
									Cancel
								</button>
							</div>
						</form>
					</div>
				) : null}
			</>
		);
	}
	if (chrome.projectsError) {
		return (
			<StatePanel
				kind={failureKind(chrome.projectsError)}
				detail={chrome.projectsError instanceof Error ? chrome.projectsError.message : undefined}
				onRetry={chrome.refreshAll}
			/>
		);
	}
	return <StatePanel kind="loading" title="Opening your account…" detail="Caddie is setting up your account scope so discovery works before you have any project." />;
}

// --- PROJECTS (list + start paths) ----------------------------------------------

export function ProjectsPage(): ReactElement {
	// Route component renders only the chrome wrapper + static markup; the two
	// start-path buttons read the chrome from a child (ProjectsActions) so nothing
	// above the provider calls useWorkspaceChrome.
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<div className="r-section-head">
						<div>
							<p className="kicker" data-tone="action">
								PROJECTS
							</p>
							<h1 className="page-title">Your projects</h1>
							<p className="page-lede">
								Every build you have started, with where it stands and the next thing it needs. Start a
								new one from an idea or an existing repository.
							</p>
						</div>
						<ProjectsActions />
					</div>
					<ProjectList />
				</div>
			</div>
		</>
	);
}

function ProjectsActions(): ReactElement {
	const chrome = useWorkspaceChrome();
	return (
		<span className="disc-actions">
			<button type="button" className="btn-key" data-testid="new-idea-project" onClick={() => void chrome.newProject()}>
				Start from an idea
			</button>{' '}
			<Link className="btn-ghost" to="/onboarding" data-testid="import-repo-project">
				Continue existing code
			</Link>
		</span>
	);
}

function ProjectList(): ReactElement {
	const chrome = useWorkspaceChrome();
	if (!chrome.authenticated) return <SignInGate />;
	if (chrome.projectsPending) return <StatePanel kind="loading" title="Fetching your projects…" />;
	if (chrome.projectsError) {
		return (
			<StatePanel
				kind={failureKind(chrome.projectsError)}
				detail={chrome.projectsError instanceof Error ? chrome.projectsError.message : undefined}
				onRetry={chrome.refreshAll}
			/>
		);
	}
	if (chrome.buildProjects.length === 0) {
		return (
			<StatePanel
				kind="empty"
				title="No projects yet"
				detail="Discover a hackathon and explore ideas for it, or start from an idea — Caddie drafts a plan before it builds anything."
			/>
		);
	}
	return (
		<ul className="project-list" data-testid="project-list">
			{chrome.buildProjects.map((project) => (
				<li key={project.id} className="project-row card-surface" data-testid={`project-row-${project.id}`}>
					<div className="project-row-main">
						<button type="button" className="row-title r-link" onClick={() => chrome.openProject(project.id)}>
							{project.name}
						</button>
						{project.contestUrl ? (
							<a className="project-contest" href={project.contestUrl} target="_blank" rel="noreferrer noopener">
								linked hackathon
							</a>
						) : (
							<span className="project-contest muted">no linked hackathon</span>
						)}
					</div>
					<div className="project-row-meta mono-id">
						<span data-status={project.status}>{project.status}</span> · updated {whenIso(project.updatedAt)}
					</div>
				</li>
			))}
		</ul>
	);
}

function whenIso(iso: string): string {
	const date = new Date(iso);
	return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown';
}

// --- PROJECT OVERVIEW ------------------------------------------------------------

export function ProjectOverviewPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="overview" />
					<ProjectGate>{(projectId) => <ProjectOverviewBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

function ProjectOverviewBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const brief = useBriefCards(actor, props.projectId);
	const project: Project | null = chrome.selectedProject;

	// The project contract has no deadline field — the real deadlines live in
	// plan milestones and schedules. Derive the nearest one from the brief's
	// deadline cards so the header states a fact, never a placeholder.
	const nextDeadline = useMemo(() => {
		const nexts = (brief.data?.cards ?? [])
			.filter((c) => c.kind === 'deadline')
			.map((c) => {
				const m = /Next run ([^ (]+)/.exec(c.summary);
				return m ? m[1].slice(0, 10) : null;
			})
			.filter((v): v is string => v !== null)
			.sort();
		return nexts[0] ?? null;
	}, [brief.data]);

	function onCardAction(card: DecisionCardType) {
		const search = { project: props.projectId };
		switch (card.kind) {
			case 'approval':
				chrome.goProjectTab('/design-review', search);
				break;
			case 'change':
				chrome.goProjectTab(
					card.evidenceIds.length > 0 ? '/evidence' : '/artifacts',
					card.evidenceIds.length > 0 ? { ...search, claim: card.primaryAction.targetId } : search,
				);
				break;
			case 'deadline':
				chrome.goProjectTab('/schedules', search);
				break;
			case 'result':
				chrome.goProjectTab('/runs', search);
				break;
		}
	}

	return (
		<div className="settings-stack">
			<ProjectHeader projectId={props.projectId} project={project} nextDeadline={nextDeadline} />
			<section className="card-surface settings-panel" data-testid="overview-brief">
				<div className="r-section-head">
					<div>
						<p className="kicker" data-tone="action">
							OVERVIEW
						</p>
						<h2 className="ev-title">What this project needs</h2>
						<p className="page-lede">
							What Caddie has done, what is waiting on you, and the next step — from the project's real
							brief.
						</p>
					</div>
					<span className="disc-actions">
						<Link
							to="/tasks"
							className="btn-ghost"
							data-testid="overview-tasks-entry"
							search={{ project: props.projectId }}
						>
							Tasks
						</Link>
					</span>
				</div>
				<BriefLane
					state={{
						kind: 'empty',
						stale: chrome.projectsFetching,
						retry: chrome.refreshAll,
					}}
					cards={brief.data?.cards ?? []}
					feedPending={brief.isPending}
					feedError={brief.error}
					onAction={onCardAction}
				/>
			</section>
		</div>
	);
}

function ProjectHeader(props: {
	projectId: string;
	project: Project | null;
	nextDeadline?: string | null;
}): ReactElement {
	const project = props.project;
	if (!project) return <></>;
	return (
		<header className="project-header card-surface" data-testid="project-header" data-project={props.projectId}>
			<p className="kicker" data-tone="action">
				PROJECT
			</p>
			<h1 className="page-title">{project.name}</h1>
			{project.contestUrl ? (
				<p className="page-lede">
					Linked hackathon: <a href={project.contestUrl} target="_blank" rel="noreferrer noopener">{project.contestUrl}</a>
				</p>
			) : (
				<p className="page-lede muted">No linked hackathon yet.</p>
			)}
			{/* Honesty: the project contract has no deadline — milestone deadlines
			    live in the plan and schedules. State the nearest real one when the
			    brief knows it; otherwise say so plainly. */}
			<p className="project-facts mono-id" data-testid="project-facts">
				status: {project.status} ·{' '}
				{props.nextDeadline ? `next deadline: ${props.nextDeadline} (in Schedules)` : 'next deadline: none scheduled yet'} · progress: see Build
			</p>
		</header>
	);
}

// --- PLAN (design gate) ----------------------------------------------------------

export function DesignReviewPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="plan" />
					<ProjectGate>{(projectId) => <DesignReviewBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

function DesignReviewBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const planDocs = usePlanDocRevisions(actor, props.projectId);
	const revisions = [...(planDocs.data?.revisions ?? [])].sort((a, b) => b.revision - a.revision);
	return (
		<DesignReview
			projectId={props.projectId}
			planRevisions={revisions}
			isPending={planDocs.isPending}
			error={planDocs.error}
			retry={() => void planDocs.refetch()}
		/>
	);
}

// --- BUILD (Activity / Files / Automation) ---------------------------------------

export function RunsPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="build" />
					<ProjectSubTabs group="build" current="runs" />
					<ProjectGate>{(projectId) => <RunsBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

function RunsBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const runBindings = useRunBindings(actor, props.projectId);
	const artifacts = useArtifacts(actor, props.projectId);
	return (
		<div className="settings-stack">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						BUILD
					</p>
					<h2 className="ev-title">Activity</h2>
					<p className="page-lede">
						What Caddie is doing and what it produced — every run with its state and specialist, and the
						files each one wrote.
					</p>
				</div>
			</div>
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
				projectId={props.projectId}
			/>
		</div>
	);
}

export function ArtifactsPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="build" />
					<ProjectSubTabs group="build" current="artifacts" />
					<ProjectGate>{(projectId) => <ArtifactsBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

function ArtifactsBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const revisions = useArtifactRevisions<ViewerRevision>(actor, props.projectId);
	return (
		<ArtifactViewer
			projectId={props.projectId}
			revisions={revisions.data?.artifacts ?? []}
			isPending={revisions.isPending}
			error={revisions.error}
			retry={() => void revisions.refetch()}
		/>
	);
}

export function SchedulesPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="build" />
					<ProjectSubTabs group="build" current="schedules" />
					<ProjectGate>{(projectId) => <Schedules projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

// --- TASKS (Build sub-strip; real P12 server surface, audit S25) -----------------

export function TasksPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="build" />
					<ProjectSubTabs group="build" current="tasks" />
					<ProjectGate>{(projectId) => <Tasks projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

// --- SUBMISSION (Package / Evidence / Judge) -------------------------------------

export function SubmissionPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="submission" />
					<ProjectSubTabs group="submission" current="submission" />
					<ProjectGate>{(projectId) => <SubmissionPackage projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

export function EvidencePage(): ReactElement {
	const search = useSearch({ strict: false }) as { claim?: string };
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="submission" />
					<ProjectSubTabs group="submission" current="evidence" />
					<ProjectGate>
						{(projectId) => <EvidenceDrawer projectId={projectId} focusClaimType={search.claim} />}
					</ProjectGate>
				</div>
			</div>
		</>
	);
}

export function JudgePage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="submission" />
					<ProjectSubTabs group="submission" current="judge" />
					<ProjectGate>{(projectId) => <JudgeScorecard projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

// --- REPOSITORIES (setup, reached from onboarding + settings) --------------------

export function RepositoriesPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<RepositoriesGate />
				</div>
			</div>
		</>
	);
}

/**
 * The repository surface needs a project (the connection belongs to a
 * workspace). A brand-new account with zero projects gets a targeted start
 * path instead of the generic "no project selected" — the Chat welcome
 * panel's "Continue existing code" action must land somewhere useful
 * (approved navigation).
 */
function RepositoriesGate(): ReactElement {
	const chrome = useWorkspaceChrome();
	if (!chrome.authenticated) return <SignInGate />;
	if (chrome.projectsPending) return <StatePanel kind="loading" title="Fetching your projects…" />;
	if (chrome.projectsError) {
		return (
			<StatePanel
				kind={failureKind(chrome.projectsError)}
				detail={chrome.projectsError instanceof Error ? chrome.projectsError.message : undefined}
				onRetry={chrome.refreshAll}
			/>
		);
	}
	if (chrome.buildProjects.length === 0) {
		return (
			<section className="card-surface settings-panel" data-testid="repositories-start-first">
				<div className="r-section-head">
					<div>
						<p className="kicker" data-tone="action">
							SETUP
						</p>
						<h2 className="ev-title">Continue existing code</h2>
						<p className="page-lede">
							The repository connection belongs to a workspace, so it needs a project first. Start a
							project from an idea — Caddie drafts a plan before it builds anything — then connect the
							repository here.
						</p>
					</div>
				</div>
				<div className="row">
					<Link to="/onboarding" className="btn-key" data-testid="repositories-start-idea">
						Start from an idea
					</Link>
					<Link to="/discover" className="btn-ghost" data-testid="repositories-find-contest">
						Find a hackathon first
					</Link>
				</div>
			</section>
		);
	}
	return <RepositoriesBody projectId={chrome.effectiveProjectId ?? ''} />;
}

function RepositoriesBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const project = chrome.projectList.find((candidate) => candidate.id === props.projectId) ?? null;
	const [picked, setPicked] = useState<SelectedRepository | null>(null);
	if (!project) {
		return (
			<StatePanel
				kind="error"
				title="That project is not in your list"
				detail="The repository connection belongs to a workspace; the link points at a project your account cannot see."
			/>
		);
	}
	return (
		<div className="settings-stack">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						SETUP
					</p>
					<h2 className="ev-title">Repositories</h2>
					<p className="page-lede">
						The GitHub connection Caddie builds through. Reading lets Caddie plan and gather evidence from a
						repository — writing, merging and deploying stay behind their own separate approvals.
					</p>
				</div>
			</div>
			{picked ? (
				<section className="card-surface settings-panel" data-testid="picked-repo">
					<h3 className="ev-head">Picked {picked.repoFullName}</h3>
					<p className="state-detail">
						Reading allows planning and evidence from this repository. Writing, merging and deploying stay
						behind their own gates, each needing a separate approval. Open a project to start from it.
					</p>
				</section>
			) : null}
			<RepositoryPicker workspaceId={project.workspaceId} onSelected={setPicked} />
		</div>
	);
}

// --- ACCOUNT surfaces: Search / Automations / Usage ------------------------------

export function SearchPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<div className="r-section-head">
						<div>
							<p className="kicker" data-tone="action">
								SEARCH
							</p>
							<h1 className="page-title">Search</h1>
							<p className="page-lede">
								Find across your projects, plans, tasks and memory. Results are filtered by what your
								account can actually access — anything you cannot reach simply does not appear.
							</p>
						</div>
					</div>
					<SearchEnabled />
				</div>
			</div>
		</>
	);
}

// The Search panel gates itself on the session; render it only when signed in so
// the wall stays a clean sign-in, matching every other surface. A CHILD
// component — hooks reading the chrome must run below the provider, never in
// the route component (same rule as ProjectsActions/AutomationsBody; calling
// this as a hook crashed /search with "useWorkspaceChrome must be used inside
// WorkspaceChrome").
function SearchEnabled(): ReactElement {
	const chrome = useWorkspaceChrome();
	return chrome.authenticated ? <Search /> : <SignInGate />;
}

export function AutomationsPage(): ReactElement {
	// Route component renders only the chrome wrapper + static header; the project
	// list (which reads the chrome) lives in the AutomationsBody child so nothing
	// above the provider calls useWorkspaceChrome.
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<div className="r-section-head">
						<div>
							<p className="kicker" data-tone="action">
								AUTOMATION
							</p>
							<h1 className="page-title">Automations</h1>
							<p className="page-lede">
								Every scheduled check Caddie runs for you, across all your projects — read from each
								project's real schedule table. Open a project to manage its automations.
							</p>
						</div>
					</div>
					<AutomationsBody />
				</div>
			</div>
		</>
	);
}

function AutomationsBody(): ReactElement {
	const chrome = useWorkspaceChrome();
	// Audit F12: Automations aggregates the REAL schedules of every project
	// instead of being a bare project picker. Each project's read is
	// independent — a failure names the project instead of blanking the page.
	const [perProject, setPerProject] = useState<
		Record<string, { state: 'loading' } | { state: 'ready'; schedules: ScheduleRow[] } | { state: 'error'; message: string }>
	>({});
	const [readDone, setReadDone] = useState(false);

	useEffect(() => {
		if (!chrome.authenticated) return;
		const projects = chrome.buildProjects;
		setPerProject(Object.fromEntries(projects.map((p) => [p.id, { state: 'loading' }])));
		setReadDone(false);
		let cancelled = false;
		void Promise.all(
			projects.map(async (project) => {
				try {
					const payload = await fetchJson<{ schedules: ScheduleRow[] }>(
						`/api/projects/${encodeURIComponent(project.id)}/schedules`,
					);
					if (!cancelled)
						setPerProject((prev) => ({ ...prev, [project.id]: { state: 'ready', schedules: payload.schedules } }));
				} catch (error) {
					if (!cancelled)
						setPerProject((prev) => ({
							...prev,
							[project.id]: {
								state: 'error',
								message: (error as Error).message || 'The schedules could not be read.',
							},
						}));
				}
			}),
		).then(() => {
			if (!cancelled) setReadDone(true);
		});
		return () => {
			cancelled = true;
		};
	}, [chrome.authenticated, chrome.buildProjects]);

	if (!chrome.authenticated) return <SignInGate />;
	if (chrome.projectsPending) return <StatePanel kind="loading" title="Fetching your projects…" />;
	if (chrome.buildProjects.length === 0) {
		return <StatePanel kind="empty" title="No projects to automate yet" detail="Start a project first — automations are scheduled runs within a project." />;
	}
	if (!readDone) return <StatePanel kind="loading" title="Reading your automations…" />;
	return (
		<ul className="project-list" data-testid="automations-list">
			{chrome.buildProjects.map((project) => {
				const row = perProject[project.id];
				if (row?.state === 'error') {
					return (
						<li key={project.id} className="project-row card-surface" data-testid={`automations-error-${project.id}`}>
							<div className="row-main">
								<span className="row-title">{project.name}</span>
								<div role="alert" className="row-error">
									<b>Could not read its schedules.</b> {row.message}
								</div>
							</div>
						</li>
					);
				}
				const schedules = row?.state === 'ready' ? row.schedules : [];
				return (
					<li key={project.id} className="project-row card-surface" data-testid={`automations-project-${project.id}`}>
						<div className="row-main">
							<button
								type="button"
								className="row-title r-link"
								data-testid={`automations-open-${project.id}`}
								onClick={() => chrome.goProjectTab('/schedules', { project: project.id })}
							>
								{project.name}
							</button>
							{schedules.length === 0 ? (
								<span className="mono-id muted">no schedules yet</span>
							) : (
								<span className="mono-id" data-testid={`automations-count-${project.id}`}>
									{schedules.length} scheduled check{schedules.length === 1 ? '' : 's'}
								</span>
							)}
						</div>
						{schedules.map((schedule) => (
							<div className="row-main" key={schedule.id} data-testid={`automations-schedule-${schedule.id}`}>
								<span className="row-title">{schedule.name}</span>
								<span className="row-status" data-status={schedule.paused ? 'paused' : 'active'}>
									{schedule.paused ? 'paused' : 'active'}
								</span>
								<span className="mono-id">
									{schedule.cron} · {schedule.timezone}
								</span>
								<span className="mono-id">next {schedule.nextRunAt}</span>
							</div>
						))}
					</li>
				);
			})}
		</ul>
	);
}

export function UsagePage(): ReactElement {
	// The usage page is an ACCOUNT surface (it reads /api/usage, which is
	// session-scoped), so it may read the chrome directly: the provider is
	// above every route now (F01 layout).
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<div className="r-section-head">
						<div>
							<p className="kicker" data-tone="action">
								USAGE
							</p>
							<h1 className="page-title">Usage &amp; budget</h1>
							<p className="page-lede">
								What Caddie reserved and spent against your budget — read straight from the same
								numbers the server enforces before every run.
							</p>
						</div>
					</div>
					<UsageBody />
				</div>
			</div>
		</>
	);
}

interface UsageResponse {
	payer: { payerId: string; limitMinorUnits: number; currency: string } | null;
	totals: { reservedMinorUnits: number; settledMinorUnits: number; reservations: number };
	unavailable?: string;
}

function UsageBody(): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const usage = useQuery({
		queryKey: ['usage', chrome.actorId ?? 'pending'],
		queryFn: () => fetchJson<UsageResponse>('/api/usage'),
		enabled: chrome.authenticated && chrome.actorId !== null,
	});

	if (!chrome.authenticated) return <SignInGate />;
	if (usage.isPending) {
		return (
			<section className="card-surface settings-panel" data-testid="usage-panel">
				<StatePanel kind="loading" title="Reading your budget…" />
			</section>
		);
	}
	if (usage.error) {
		return (
			<section className="card-surface settings-panel" data-testid="usage-panel">
				<StatePanel
					kind={failureKind(usage.error)}
					detail={usage.error instanceof Error ? usage.error.message : undefined}
					onRetry={() => void usage.refetch()}
				/>
			</section>
		);
	}

	const data = usage.data;
	const fmt = (n: number, currency?: string) => `${n.toLocaleString()}${currency ? ` ${currency}` : ''}`;

	return (
		<section className="card-surface settings-panel" data-testid="usage-panel">
			<div className="inspector-row" data-testid="usage-budget-state">
				<div className="row-main">
					<span className="row-title">Budget</span>
					{data?.unavailable ? (
						<span className="status-pill" data-status="planned">
							not configured
						</span>
					) : data?.payer ? (
						<span className="status-pill" data-status="handled">
							configured
						</span>
					) : (
						<span className="status-pill" data-status="planned">
							no budget yet
						</span>
					)}
				</div>
				<div className="row-details">
					{data?.unavailable ? (
						<>This deployment has no budget tracking configured — nothing is spent or tracked here yet.</>
					) : data?.payer ? (
						<>
							Run budget limit: <b>{fmt(data.payer.limitMinorUnits, data.payer.currency)}</b> (minor
							units, enforced by the server before every run).
						</>
					) : (
						<>No budget is configured for your account yet. One is set up the first time a run needs one.</>
					)}
				</div>
			</div>
			{data && !data.unavailable ? (
				<div className="row-list">
					<div className="inspector-row" data-testid="usage-reserved">
						<div className="row-main">
							<span className="row-title">Currently reserved</span>
							<span className="row-status">{fmt(data.totals.reservedMinorUnits, data.payer?.currency)}</span>
						</div>
						<div className="row-details">Held by runs in progress; released or settled when they finish.</div>
					</div>
					<div className="inspector-row" data-testid="usage-settled">
						<div className="row-main">
							<span className="row-title">Settled so far</span>
							<span className="row-status">{fmt(data.totals.settledMinorUnits, data.payer?.currency)}</span>
						</div>
						<div className="row-details">
							Actual billed usage across {data.totals.reservations.toLocaleString()} reservation
							{data.totals.reservations === 1 ? '' : 's'}.
						</div>
					</div>
				</div>
			) : null}
			<p className="state-detail">
				<Icon name="info" title="note" /> Numbers come straight from the budget ledger the server enforces —
				nothing here is estimated. Per-run detail lives in a project's Build → Activity.
			</p>
		</section>
	);
}

