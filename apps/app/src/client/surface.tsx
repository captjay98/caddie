import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { DecisionCard as DecisionCardType, Project } from '@caddie/contracts';
import { SignInPanel } from './auth.ts';
import { failureKind, StatePanel } from './states.tsx';
import { Icon } from './icons.tsx';
import { DiscoveryResults, type DiscoveryCandidateRecord } from './discovery/Results.tsx';
import { JudgeScorecard } from './judge/Scorecard.tsx';
import { SubmissionPackage } from './submission/Package.tsx';
import { Schedules } from './tasks/Schedules.tsx';
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
import { WorkspaceChrome, useWorkspaceChrome } from './workspace/Chrome.tsx';
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
		<WorkspaceChrome nav="discover">
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
		</WorkspaceChrome>
	);
}

function DiscoverBody(): ReactElement {
	const chrome = useWorkspaceChrome();
	const createProject = useCreateProject(useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]));
	const navigate = useNavigate();
	const [exploreBusy, setExploreBusy] = useState(false);

	// Explore handoff: continue an existing project already linked to this
	// contest, otherwise create one carrying the contest link. The guard
	// (continue-first + a busy lock) prevents a duplicate project on retries; a
	// save/accept never creates a build project.
	function onExplore(candidate: DiscoveryCandidateRecord) {
		if (exploreBusy) return;
		const existing = chrome.buildProjects.find((p) => p.contestUrl === candidate.url);
		if (existing) {
			chrome.openProject(existing.id);
			return;
		}
		setExploreBusy(true);
		void createProject
			.mutateAsync({
				name: candidate.title,
				...(candidate.summary ? { description: candidate.summary } : {}),
				contestUrl: candidate.url,
				workspaceId: chrome.buildProjects[0]?.workspaceId,
			})
			.then(
				(result) => {
					setExploreBusy(false);
					void navigate({ to: '/project', search: { project: result.project.id } });
				},
				() => setExploreBusy(false),
			);
	}

	if (!chrome.authenticated) return <SignInGate />;
	if (chrome.homeProject) {
		return <DiscoveryResults projectId={chrome.homeProject.id} onExplore={onExplore} exploreBusy={exploreBusy} />;
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
		<WorkspaceChrome nav="projects">
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
		</WorkspaceChrome>
	);
}

function ProjectsActions(): ReactElement {
	const chrome = useWorkspaceChrome();
	return (
		<span className="disc-actions">
			<button type="button" className="btn-key" data-testid="new-idea-project" onClick={() => void chrome.newProject()}>
				Start from an idea
			</button>{' '}
			<a className="btn-ghost" href="/onboarding" data-testid="import-repo-project">
				Continue existing code
			</a>
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
		<WorkspaceChrome nav="project">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="overview" />
					<ProjectGate>{(projectId) => <ProjectOverviewBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</WorkspaceChrome>
	);
}

function ProjectOverviewBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const brief = useBriefCards(actor, props.projectId);
	const project: Project | null = chrome.selectedProject;

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
			<ProjectHeader projectId={props.projectId} project={project} />
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

function ProjectHeader(props: { projectId: string; project: Project | null }): ReactElement {
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
			{/* Honesty: deadlines and progress are NOT on the project contract — we
			    never fabricate them. State their absence rather than guessing. */}
			<p className="project-facts mono-id" data-testid="project-facts">
				status: {project.status} · deadline: none recorded · progress: see Build
			</p>
		</header>
	);
}

// --- PLAN (design gate) ----------------------------------------------------------

export function DesignReviewPage(): ReactElement {
	return (
		<WorkspaceChrome nav="project">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="plan" />
					<ProjectGate>{(projectId) => <DesignReviewBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</WorkspaceChrome>
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
		<WorkspaceChrome nav="project">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="build" />
					<ProjectSubTabs group="build" current="runs" />
					<ProjectGate>{(projectId) => <RunsBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</WorkspaceChrome>
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
		<WorkspaceChrome nav="project">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="build" />
					<ProjectSubTabs group="build" current="artifacts" />
					<ProjectGate>{(projectId) => <ArtifactsBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</WorkspaceChrome>
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
		<WorkspaceChrome nav="project">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="build" />
					<ProjectSubTabs group="build" current="schedules" />
					<ProjectGate>{(projectId) => <Schedules projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</WorkspaceChrome>
	);
}

// --- SUBMISSION (Package / Evidence / Judge) -------------------------------------

export function SubmissionPage(): ReactElement {
	return (
		<WorkspaceChrome nav="project">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="submission" />
					<ProjectSubTabs group="submission" current="submission" />
					<ProjectGate>{(projectId) => <SubmissionPackage projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</WorkspaceChrome>
	);
}

export function EvidencePage(): ReactElement {
	const search = useSearch({ strict: false }) as { claim?: string };
	return (
		<WorkspaceChrome nav="project">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="submission" />
					<ProjectSubTabs group="submission" current="evidence" />
					<ProjectGate>
						{(projectId) => <EvidenceDrawer projectId={projectId} focusClaimType={search.claim} />}
					</ProjectGate>
				</div>
			</div>
		</WorkspaceChrome>
	);
}

export function JudgePage(): ReactElement {
	return (
		<WorkspaceChrome nav="project">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectTabs current="submission" />
					<ProjectSubTabs group="submission" current="judge" />
					<ProjectGate>{(projectId) => <JudgeScorecard projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</WorkspaceChrome>
	);
}

// --- REPOSITORIES (setup, reached from onboarding + settings) --------------------

export function RepositoriesPage(): ReactElement {
	return (
		<WorkspaceChrome nav="account">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectGate>{(projectId) => <RepositoriesBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</WorkspaceChrome>
	);
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
		<WorkspaceChrome nav="account">
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
					{useSearchEnabled()}
				</div>
			</div>
		</WorkspaceChrome>
	);
}

// The Search panel gates itself on the session; render it only when signed in so
// the wall stays a clean sign-in, matching every other surface.
function useSearchEnabled(): ReactElement {
	const chrome = useWorkspaceChrome();
	return chrome.authenticated ? <Search /> : <SignInGate />;
}

export function AutomationsPage(): ReactElement {
	// Route component renders only the chrome wrapper + static header; the project
	// list (which reads the chrome) lives in the AutomationsBody child so nothing
	// above the provider calls useWorkspaceChrome.
	return (
		<WorkspaceChrome nav="account">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<div className="r-section-head">
						<div>
							<p className="kicker" data-tone="action">
								AUTOMATION
							</p>
							<h1 className="page-title">Automations</h1>
							<p className="page-lede">
								Scheduled runs live inside a project — pick one to see and manage its automations.
							</p>
						</div>
					</div>
					<AutomationsBody />
				</div>
			</div>
		</WorkspaceChrome>
	);
}

function AutomationsBody(): ReactElement {
	const chrome = useWorkspaceChrome();
	if (!chrome.authenticated) return <SignInGate />;
	if (chrome.projectsPending) return <StatePanel kind="loading" title="Fetching your projects…" />;
	if (chrome.buildProjects.length === 0) {
		return <StatePanel kind="empty" title="No projects to automate yet" detail="Start a project first — automations are scheduled runs within a project." />;
	}
	return (
		<ul className="project-list" data-testid="automations-project-list">
			{chrome.buildProjects.map((project) => (
				<li key={project.id} className="project-row card-surface">
					<div className="project-row-main">
						<button
							type="button"
							className="row-title r-link"
							data-testid={`automations-open-${project.id}`}
							onClick={() => chrome.goProjectTab('/schedules', { project: project.id })}
						>
							{project.name}
						</button>
					</div>
				</li>
			))}
		</ul>
	);
}

export function UsagePage(): ReactElement {
	return (
		<WorkspaceChrome nav="account">
			<div className="shell-loading shell-page">
				<div className="page-col">
					<div className="r-section-head">
						<div>
							<p className="kicker" data-tone="action">
								USAGE
							</p>
							<h1 className="page-title">Usage &amp; budget</h1>
							<p className="page-lede">
								Caddie spends model credits through a per-run budget the server enforces. A read-only
								usage summary over that budget is not exposed by the API yet.
							</p>
						</div>
					</div>
					<section className="card-surface settings-panel" data-testid="usage-panel">
						<div className="inspector-row" data-testid="usage-budget-state">
							<div className="row-main">
								<span className="row-title">Budget reporting</span>
								<span className="status-pill" data-status="planned">
									not exposed
								</span>
							</div>
							<div className="row-details">
								Budgets are enforced at run time on the server, but there is no account usage/budget
							 endpoint to read yet — so no numbers are shown here rather than guessed. Tracking runs:
							 open a project's Build → Activity.
							</div>
						</div>
						<p className="state-detail">
							<Icon name="info" title="note" /> This is an honest gap, not a loading failure. See the
							backend gap list in the redesign handoff.
						</p>
					</section>
				</div>
			</div>
		</WorkspaceChrome>
	);
}
