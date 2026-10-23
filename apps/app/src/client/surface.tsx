import { Mascot } from '@caddie/ui/Mascot';
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import * as v from 'valibot';
import { ProjectExperienceSchema, iconColor, iconLetter } from '@caddie/contracts';
import type { ApprovalRecord, DecisionCard as DecisionCardType, Project } from '@caddie/contracts';
import { SignInScreen } from './sign-in.tsx';
import { Markdown } from '@caddie/ui/Markdown';
import { failureKind, PageSkeleton, StatePanel, type SkeletonPage } from './states.tsx';
import { formatMinorUnits, formatNextRun } from './settings/settings-model.ts';
import { DiscoveryResults, type DiscoveryCandidateRecord } from './discovery/Results.tsx';
import { JudgeScorecard } from './judge/Scorecard.tsx';
import { SubmissionPackage } from './submission/Package.tsx';
import { Schedules, type ScheduleRow } from './tasks/Schedules.tsx';
import { Tasks } from './tasks/Tasks.tsx';
import { EvidenceDrawer } from './evidence/Drawer.tsx';
import { ArtifactViewer, type ViewerRevision } from './artifacts/Viewer.tsx';
import { briefActionRoute } from './brief/navigate.ts';
import { workflowQueryOptions } from './workflow-query.ts';
import { DesignReview, HowYourAppWorks } from './planning/DesignReview.tsx';
import { RepositoryPicker, type SelectedRepository } from './repositories/RepositoryPicker.tsx';
import { RunInspector } from './runs/RunInspector.tsx';
import { Search } from './search/Search.tsx';
import { BriefLane } from './brief/DecisionCard.tsx';
import {
	useAccountBrief,
	useArtifactRevisions,
	useArtifacts,
	useBriefCards,
	useWorkflowBrief,
	useCreateProject,
	usePlanDocRevisions,
	useProjectExperience,
	useRunBindings,
	useWorkflowPhase,
	useProjectHackathons,
	useProjectHackathon,
	type ProjectHackathonLine,
} from './queries.ts';
import { useQuery } from '@tanstack/react-query';
import { fetchJson, readableFailure } from './api.ts';
import { useWorkspaceChrome } from './workspace/Chrome.tsx';
import { NowPanel } from './project/NowPanel.tsx';
import { ProjectWorkflow } from './conversation/ProjectWorkflow.tsx';
import { relativeUpdated } from './project/now-panel.ts';
import { ProjectTabs } from './workspace/ProjectTabs.tsx';
import { projectCardFromCopiedApp, projectCardFromExperience, projectStatus, type CopiedAppSummary } from './workspace/project-status.ts';
import { deadlineText } from './workspace/project-header.ts';
import { Icon } from './icons.tsx';

/** A hackathon's deadline in words for its project card (plan 5.7); null when unknown. */
function dueWords(hackathon: ProjectHackathonLine): string | null {
	if (hackathon.ended) return 'Ended';
	if (hackathon.daysLeft === null) return null;
	if (hackathon.daysLeft === 0) return 'Due today';
	if (hackathon.daysLeft === 1) return 'Due tomorrow';
	return `Due in ${hackathon.daysLeft} days`;
}

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

/**
 * Explore-ideas quick prompts (§4): one-tap starters for the "What's the idea?"
 * step, so a nontechnical builder is never staring at an empty field. Clicking
 * one fills the editable idea input — the user still sees and confirms it before
 * anything is created. "Let's brainstorm together" is the no-fixed-idea path: it
 * tells Caddie to brainstorm WITH the user rather than committing to a concept.
 */
const EXPLORE_QUICK_PROMPTS: ReadonlyArray<{ id: string; label: string; text: string }> = [
	{ id: 'brainstorm', label: "Let's brainstorm together", text: "Let's brainstorm together — I don't have a fixed idea yet. Ask me a few questions about my skills and interests, then suggest a few directions that fit this hackathon." },
	{ id: 'strongest-fit', label: 'Something that fits my skills', text: 'Suggest a project that best fits my skills and this hackathon, and explain why it fits.' },
	{ id: 'quick-win', label: 'A quick, achievable build', text: 'Help me pick a small, achievable project I can realistically finish before the deadline.' },
	{ id: 'win', label: 'A standout project to win', text: 'Help me come up with an ambitious, standout project with a real shot at winning this hackathon — lean into what makes it impressive to judges.' },
];

/**
 * Reads the resolved project scope from the chrome and renders the honest
 * states, then hands the concrete project id to the body. No fetch of project
 * data happens before the project is resolved.
 */
/** A quiet gate: renders children only when a project is resolved, without
 *  state panels of its own — the full ProjectGate next to it owns errors. */
function ProjectGateSoft(props: { children: (projectId: string) => ReactElement }): ReactElement | null {
	const chrome = useWorkspaceChrome();
	if (!chrome.authenticated || !chrome.effectiveProjectId) return null;
	return props.children(chrome.effectiveProjectId);
}

function ProjectGate(props: {
	children: (projectId: string) => ReactElement;
	/** Wait for the project list in this page's own shape (plan 5.6). */
	skeleton?: { page: SkeletonPage; label: string };
}): ReactElement | null {
	const chrome = useWorkspaceChrome();
	if (!chrome.authenticated) return <SignInScreen />;
	if (chrome.projectsPending) {
		return props.skeleton ? (
			<PageSkeleton page={props.skeleton.page} label={props.skeleton.label} />
		) : (
			<StatePanel kind="loading" title="Fetching your projects…" />
		);
	}
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
							<h1 className="page-title">Hackathons that fit you</h1>
							<p className="page-lede">
								Contests Caddie watches and ranks for fit. Nothing starts a build until you say so.
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
	const [commitStep, setCommitStep] = useState<'idea' | 'confirm'>('idea');
	const [commitIdea, setCommitIdea] = useState('');
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
		// v2 explore-ideas (§4): TWO steps — pick or type an idea, then confirm.
		// No project exists until the user confirms.
		setCommitIdea('');
		setCommitName(candidate.title);
		setCommitStep('idea');
		setExploreError(null);
		setCommitFor(candidate);
	}

	function closeCommit() {
		if (exploreBusy) return;
		setCommitFor(null);
		setCommitStep('idea');
		setExploreError(null);
	}

	function submitCommit() {
		if (!commitFor || exploreBusy) return;
		setExploreBusy(true);
		setExploreError(null);
		void createProject
			.mutateAsync({
				name: commitName.trim() || commitFor.title,
				description: commitIdea.trim() || commitFor.summary || undefined,
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

	if (!chrome.authenticated) return <SignInScreen />;
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
								if (commitStep === 'idea') setCommitStep('confirm');
								else submitCommit();
							}}
						>
							<p className="kicker" data-tone="action">
								EXPLORE IDEAS
							</p>
							{commitStep === 'idea' ? (
								<>
									<h3 className="state-title">What's the idea?</h3>
									<p className="state-detail">
										Pick or type an idea for “{commitFor.title}”. You'll confirm before anything is
										created.
									</p>
									<label className="kicker" htmlFor="explore-idea-text">
										The idea
									</label>
									<div className="explore-quick-prompts" data-testid="explore-quick-prompts">
										{EXPLORE_QUICK_PROMPTS.map((prompt) => (
											<button
												key={prompt.id}
												type="button"
												className="explore-quick-prompt"
												data-testid={`explore-quick-${prompt.id}`}
												data-selected={commitIdea.trim() === prompt.text ? 'true' : undefined}
												onClick={() => setCommitIdea(prompt.text)}
											>
												{prompt.label}
											</button>
										))}
									</div>
									<input
										id="explore-idea-text"
										className="input"
										data-testid="explore-idea-text"
										placeholder={commitFor.title}
										value={commitIdea}
										onChange={(e) => setCommitIdea(e.target.value)}
										autoFocus
									/>
									<div className="row-actions">
										<button
											type="submit"
											className="btn-key"
											data-testid="explore-ideas-next"
										>
											Next
										</button>
										<button
											type="button"
											className="btn-ghost"
											data-testid="explore-commit-cancel"
											onClick={() => closeCommit()}
										>
											Cancel
										</button>
									</div>
								</>
							) : (
								<>
									<h3 className="state-title">Start a project for this contest</h3>
									<p className="state-detail">
										Creates a project for “{commitFor.title}”{commitIdea.trim() ? ` — idea: ${commitIdea.trim()}` : ''}, linked to
										the contest. No build starts until you send your first message — nothing is submitted
										anywhere.
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
										</button>
										<button
											type="button"
											className="btn-ghost"
											data-testid="explore-commit-back"
											onClick={() => setCommitStep('idea')}
											disabled={exploreBusy}
										>
											Back
										</button>
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
								</>
							)}
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
							<h1 className="page-title">Your projects</h1>
							<p className="page-lede">
								Pick up where you left off, or start something new with Caddie.
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
	const [importOpen, setImportOpen] = useState(false);
	return (
		<span className="disc-actions">
			<button type="button" className="btn-key" data-testid="new-idea-project" onClick={() => void chrome.newProject()}>
				New project
			</button>
			<button type="button" className="btn-ghost" data-testid="import-repo-project" onClick={() => setImportOpen(true)}>
				Bring your code
			</button>
			{importOpen ? <ImportRepoWindow onClose={() => setImportOpen(false)} /> : null}
		</span>
	);
}

/**
 * The "Bring your code" window (v2, HANDOFF §4 import-repo): pick a repo from
 * the real GitHub installations, choose what it's for, confirm. The project is
 * created only on confirm, and the window states plainly that Caddie only
 * READS the repository at first — writing, merging and deploying stay behind
 * their own separate approvals.
 */
function ImportRepoWindow(props: { onClose: () => void }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const createProject = useCreateProject(actor);
	const navigate = useNavigate();
	const [picked, setPicked] = useState<SelectedRepository | null>(null);
	const [purpose, setPurpose] = useState<'improve' | 'contest'>('improve');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** After the copy: why Caddie won't build on it (or couldn't copy it), with the new project to open. */
	const [notice, setNotice] = useState<{ projectId: string; title: string; message: string } | null>(null);

	const workspaceId = chrome.buildProjects[0]?.workspaceId ?? chrome.homeProject?.workspaceId;

	function openProject(projectId: string) {
		props.onClose();
		void navigate({ to: '/project', search: { project: projectId } });
	}

	async function confirm() {
		if (!picked || busy) return;
		setBusy(true);
		setError(null);
		try {
			const shortName = picked.repoFullName.split('/').pop() ?? picked.repoFullName;
			const result = await createProject.mutateAsync({
				name: shortName,
				description:
					purpose === 'contest'
						? 'Imported from GitHub to enter a hackathon.'
						: 'Imported from GitHub to keep improving it.',
				...(workspaceId ? { workspaceId } : {}),
			});
			// Copy the repo in; when Caddie can build it, its code becomes the app's first version.
			const res = await fetch(`/api/projects/${encodeURIComponent(result.project.id)}/github/imports`, {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ installationId: picked.installationId, repoFullName: picked.repoFullName, start: true }),
			});
			const body = (await res.json().catch(() => ({}))) as { message?: string; start?: { ok: boolean; message?: string } };
			if (!res.ok) {
				setNotice({ projectId: result.project.id, title: "Caddie couldn't copy that repository.", message: body.message ?? 'Try again in a minute.' });
				setBusy(false);
				return;
			}
			if (body.start && !body.start.ok) {
				setNotice({ projectId: result.project.id, title: 'Caddie will start a new app instead.', message: body.start.message ?? '' });
				setBusy(false);
				return;
			}
			openProject(result.project.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	return (
		<div className="modal-backdrop" data-testid="import-repo-backdrop" onMouseDown={props.onClose}>
			<div className="commit-panel card-surface" data-testid="import-repo-window" onMouseDown={(e) => e.stopPropagation()}>
				<p className="kicker" data-tone="action">
					BRING YOUR CODE
				</p>
				{!picked ? (
					<>
						<h3 className="state-title">Which repository?</h3>
						<p className="state-detail">
							Choose a repository to copy into Caddie. We’ll check whether it can run. Your GitHub repository stays unchanged; writing back, merging and publishing require separate approval.
						</p>
						{workspaceId ? (
							<RepositoryPicker workspaceId={workspaceId} onSelected={setPicked} />
						) : (
							<StatePanel kind="empty" title="Preparing your workspace" detail="Your account workspace is not available yet. Close this window and refresh to try again." />
						)}
						<div className="row-actions">
							<button type="button" className="btn-ghost" onClick={props.onClose}>
								Cancel
							</button>
						</div>
					</>
				) : notice ? (
					<div data-testid="import-repo-notice">
						<h3 className="state-title">{notice.title}</h3>
						<p className="state-detail">{notice.message}</p>
						<div className="row-actions">
							<button type="button" className="btn-key" data-testid="import-repo-open" onClick={() => openProject(notice.projectId)}>
								Go to the project
							</button>
						</div>
					</div>
				) : (
					<>
						<h3 className="state-title">What is {picked.repoFullName} for?</h3>
						<p className="state-detail">
							Caddie copies the app&rsquo;s code into a new project and builds on it. Nothing changes in the repo
							without your OK.
						</p>
						<div className="row">
							<label className="check">
								<input
									type="radio"
									name="import-purpose"
									checked={purpose === 'improve'}
									onChange={() => setPurpose('improve')}
									data-testid="import-purpose-improve"
								/>
								<span>Keep improving it — my own project</span>
							</label>
						</div>
						<div className="row">
							<label className="check">
								<input
									type="radio"
									name="import-purpose"
									checked={purpose === 'contest'}
									onChange={() => setPurpose('contest')}
									data-testid="import-purpose-contest"
								/>
								<span>Enter it in a hackathon — link a contest after</span>
							</label>
						</div>
						{error ? (
							<div role="alert" className="sign-in-error" data-testid="import-repo-error">
								<b>Could not start from that repository.</b>
								<span> {error}</span>
							</div>
						) : null}
						<div className="row-actions">
							<button type="button" className="btn-key" data-testid="import-repo-confirm" disabled={busy} onClick={() => void confirm()}>
								{busy ? 'Starting…' : 'Start from this repo'}
							</button>
							<button type="button" className="btn-ghost" onClick={() => setPicked(null)} disabled={busy}>
								Back
							</button>
							<button type="button" className="btn-ghost" onClick={props.onClose} disabled={busy}>
								Cancel
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}


function ProjectList(): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const brief = useAccountBrief(actor);
	const hackathons = useProjectHackathons(actor);
	if (!chrome.authenticated) return <SignInScreen />;
	if (chrome.projectsPending) return <PageSkeleton page="projects" label="Loading your projects…" />;
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
				detail="Find a hackathon that fits, start from an idea, or bring your code — Caddie drafts a plan before it builds anything."
			/>
		);
	}
	const cardsByProject = new Map<string, DecisionCardType[]>();
	for (const card of brief.data?.cards ?? []) {
		const list = cardsByProject.get(card.projectId) ?? [];
		list.push(card);
		cardsByProject.set(card.projectId, list);
	}
	const active = chrome.buildProjects.filter((p) => p.status === 'active').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const archived = chrome.buildProjects.filter((p) => p.status !== 'active');
	return (
		<div data-testid="project-list">
            {brief.error ? <StatePanel kind={failureKind(brief.error)} title="Project updates are unavailable" detail="You can still open a project. Retry to load its latest decisions and progress." onRetry={() => void brief.refetch()} /> : null}
			<ul className="project-list">
				{active.map((project) => {
					const fallback = brief.isPending || brief.error
                        ? { label: brief.error ? 'Updates unavailable' : 'Loading updates…', detail: brief.error ? 'Open your project or retry loading its updates.' : 'Checking the latest decisions and progress.', next: null }
                        : projectStatus(cardsByProject.get(project.id) ?? []);
					return <ProjectCard key={project.id} project={project} fallback={fallback} hackathon={hackathons.data?.[project.id] ?? null} />;
				})}
			</ul>
			{archived.length > 0 ? (
				<details className="project-archived" data-testid="project-archived">
					<summary>Archived · {archived.length}</summary>
					<ul>
						{archived.map((project) => (
							<li key={project.id} className="project-row archived">
								<button type="button" className="row-title r-link" onClick={() => chrome.openProject(project.id)}>
									{project.name}
								</button>
								<span className="project-row-meta mono-id">archived · {whenIso(project.updatedAt)}</span>
							</li>
						))}
					</ul>
				</details>
			) : null}
		</div>
	);
}

function whenIso(iso: string): string {
	const date = new Date(iso);
	return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown';
}

/**
 * One Projects-list card: name, a short purpose (clamped — never the whole
 * intake brief), a TRUTHFUL state pill, one plain line, "Updated N ago" and ONE
 * action. State comes from the project's ProjectExperience (the same truth as
 * its Now panel); only a project with no workflow yet falls back to its
 * Brief-card summary. No run/evidence ids on the card face.
 */
function ProjectCard(props: {
	project: Project;
	fallback: { label: string; detail: string; next: DecisionCardType | null };
	/** The project's hackathon and deadline, when it has one (plan 5.7). */
	hackathon?: ProjectHackathonLine | null;
}): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const experience = useProjectExperience(actor, props.project.id);
	const { project, fallback } = props;
	const parsed = experience.data ? v.safeParse(ProjectExperienceSchema, experience.data) : null;
	const fromWorkflow = parsed?.success ? projectCardFromExperience(parsed.output) : null;
	const hackathon = props.hackathon ?? null;

	// The four project steps belong inside the project, not on every list card.
	const letter = iconLetter(project.name);
	// No workflow yet: a copied app (a judge's example, or a GitHub copy) may
	// already be ready to try. Read it from the same /workflow answer the
	// project page uses; only asked for once the projection says "no workflow".
	const noWorkflow = parsed?.success === true && parsed.output.version === 0;
	const copied = useQuery({
		...workflowQueryOptions(chrome.actorId, props.project.id),
		enabled: Boolean(chrome.actorId) && noWorkflow,
	});
	const copiedApp = noWorkflow ? (copied.data?.importPreview ?? null) : null;
	const card = fromWorkflow ?? (copiedApp ? projectCardFromCopiedApp(copiedApp) : null);
	const purpose = project.description?.trim() || (project.contestUrl ? 'For the linked hackathon' : 'A personal project');
	const updatedMs = fromWorkflow && parsed?.success ? parsed.output.version : Date.parse(project.updatedAt);
	const updated = relativeUpdated(updatedMs, Date.now());

	return (
		<li className="project-row project-card card-surface" data-testid={`project-row-${project.id}`} data-working={card?.working ? 'true' : 'false'}>
			<div className="project-card-main">
				{/* Title row: the app's letter tile (same letter + colour as the
				    published app's home-screen icon, until real screenshots exist)
				    and the project name, with the truthful state pill. */}
				<span className="project-card-tile" style={{ background: iconColor(project.id) }} data-testid={`project-tile-${project.id}`} aria-hidden="true">
					{letter ?? '•'}
				</span>
				<div className="project-card-head">
					<button type="button" className="row-title r-link" onClick={() => chrome.openProject(project.id)}>
						{project.name}
					</button>
					<span
						className="badge project-card-pill"
						data-tone={card ? card.tone : fallback.next?.status === 'blocked' ? 'danger' : fallback.next ? 'warn' : 'neutral'}
						data-testid={`project-step-text-${project.id}`}
					>
						{card?.working ? <span className="project-card-live" aria-hidden="true" /> : null}
						{card ? card.label : fallback.label}
					</span>
				</div>
			</div>
			{/* Purpose, full width beneath the title row (no longer squeezed into a
			    narrow column beside the icon). */}
			<p className="project-card-purpose" title={purpose}>
				{purpose}
			</p>
			<p className="project-card-detail">{card ? card.detail : fallback.detail}</p>
			<div className="project-card-foot">
				{/* Footer-left: the hackathon + deadline when the project has one,
				    otherwise the "Updated N ago" line. */}
				<span className="project-card-foot-meta">
					{hackathon ? (
						<span className="project-card-contest" data-testid={`project-contest-${project.id}`}>
							<Icon name="trophy" title="" />
							{hackathon.title}
							{dueWords(hackathon) ? (
								<>
									{/* Visually the pill stands alone; read aloud it needs the pause. */}
									<span className="sr-only"> · </span>
									<span className="project-card-due">{dueWords(hackathon)}</span>
								</>
							) : null}
						</span>
					) : null}
					<span className="project-card-updated">{updated ?? ''}</span>
				</span>
				{card ? (
					card.action.target === 'plan' || (parsed?.success && parsed.output.stage === 'design_review') ? (
						<Link className="btn-key" to="/design-review" search={{ project: project.id } as never} data-testid={`project-next-${project.id}`}>
							{card.action.label}
						</Link>
					) : (
						<button
							type="button"
							className="btn-key"
							data-testid={card.action.target === 'chat' ? `project-continue-${project.id}` : `project-next-${project.id}`}
							onClick={() => {
								const previewId = parsed?.success ? parsed.output.preview?.id : null;
								const readyId = parsed?.success && parsed.output.stage === 'ready' ? previewId : copiedApp?.status === 'ready' ? copiedApp.outputId : null;
								if (readyId) chrome.goProjectTab('/preview', { project: project.id, preview: readyId, source: 'workflow' });
								else chrome.openProject(project.id, card.action.target === 'chat');
							}}
						>
							{card.action.label}
						</button>
					)
				) : (
					<span className="row-actions project-row-actions">
						{fallback.next ? (
							<Link className="btn-key" to={onCardRoute(fallback.next, project.id).to as never} search={onCardRoute(fallback.next, project.id).search as never} data-testid={`project-next-${project.id}`}>
								{fallback.next.primaryAction.label}
							</Link>
						) : <button type="button" className="btn-key" onClick={() => chrome.openProject(project.id, true)} data-testid={`project-continue-${project.id}`}>
							Continue with Caddie
						</button>}
					</span>
				)}
			</div>
		</li>
	);
}

// --- PROJECT OVERVIEW ------------------------------------------------------------

export function ProjectOverviewPage(): ReactElement {
	return <div className="shell-loading shell-page"><div className="page-col focused-project-page">
		<ProjectGate>{projectId => <FocusedProjectHome projectId={projectId} />}</ProjectGate>
	</div></div>;
}

/** Opening a project follows its work; explicit step routes stay where the user put them. */
function FocusedProjectHome({ projectId }: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const experience = useProjectExperience(actor, projectId);
	const workflow = useQuery(workflowQueryOptions(chrome.actorId, projectId));
	if (experience.isPending || workflow.isPending) return <PageSkeleton page="build" label="Reading your project…" />;
	if (workflow.error) return <StatePanel kind={failureKind(workflow.error)} title="Your project could not be loaded" onRetry={() => void workflow.refetch()} />;
	const parsed = experience.data ? v.safeParse(ProjectExperienceSchema, experience.data) : null;
	const stage = parsed?.success && parsed.output.version > 0 ? parsed.output.stage : null;
	const phase = workflow.data?.workflow?.phase;
	const planNotApproved = parsed?.success && parsed.output.plan?.approved === false;
	const step = stage === 'planning_blocked' || (stage === 'stopped' && planNotApproved) ? 'plan' : stage === 'ready' || stage === 'repairing' || stage === 'checking' ? 'check'
		: stage === 'building' || stage === 'blocked' || stage === 'stopped' ? 'build'
		: phase === 'building' || phase === 'blocked' ? 'build' : phase === 'ready' ? 'check' : 'plan';
	// Option B Overview (owner 2026-10-23): a short plain-language summary of
	// where the project stands, above the four steps (the tappable step bar
	// below). From the shared ProjectExperience — the same truth as the Projects
	// card and the Now panel — so every surface tells one story.
	const reviewingPlan = phase === 'review';
	const overview = parsed?.success && parsed.output.version > 0 ? projectCardFromExperience(parsed.output) : null;
	return <>
		<ProjectTabs current={step} context={reviewingPlan ? <ProjectSupportingDetails projectId={projectId} /> : null} />
		{overview && phase !== 'review' && phase !== 'design-review' ? (
			<p className="project-overview-summary" data-testid="project-overview-summary" data-tone={overview.tone}>
				{overview.working ? <span className="project-overview-live" aria-hidden="true" /> : null}
				<b>{overview.label}.</b> {overview.detail}
			</p>
		) : null}
		<div className="focused-project-content" data-testid="focused-project-home" data-step={step}>
			{reviewingPlan ? <DesignReviewBody projectId={projectId} /> : workflow.data?.workflow || workflow.data?.importPreview ? <ProjectWorkflow projectId={projectId} presentation="workspace" />
				: <section className="focused-project-empty project-caddie-empty"><Mascot mood="ready" size={56} /><div><h2>What would you like to build?</h2><p className="page-lede">Tell Caddie what this project should do. Your plan appears here before anything is built.</p><button type="button" className="btn-key" onClick={() => chrome.openProject(projectId, true)}>Continue with Caddie</button></div></section>}
		</div>
		{!reviewingPlan ? <ProjectSupportingDetails projectId={projectId} /> : null}
	</>;
}

/** Useful context stays reachable, without competing with the current step. */
function ProjectSupportingDetails({ projectId }: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const brief = useBriefCards(actor, projectId);
	const workflowBrief = useWorkflowBrief(actor, projectId);
	const [tasksOpen, setTasksOpen] = useState(false);
	const experience = useProjectExperience(actor, projectId);
	const parsed = experience.data ? v.safeParse(ProjectExperienceSchema, experience.data) : null;
	const earlierPreview = parsed?.success && parsed.output.stage !== 'ready' ? parsed.output.preview?.id : null;
	return <div className="project-supporting" data-testid="project-supporting-details">
		{earlierPreview ? <button type="button" className="btn-ghost" onClick={() => chrome.goProjectTab('/preview', { project: projectId, preview: earlierPreview, source: 'workflow' })}>Try the earlier saved app</button> : null}
		<details><summary>Project brief</summary>{workflowBrief.data ? <Markdown text={workflowBrief.data} /> : <p className="state-detail">{workflowBrief.isPending ? 'Reading the brief…' : workflowBrief.error ? 'The brief could not be loaded. Try opening this section again after refreshing.' : chrome.selectedProject?.description || 'The brief appears after you plan with Caddie.'}</p>}</details>
		<details data-testid="overview-todo" id="todo" onToggle={event => setTasksOpen(event.currentTarget.open)}><summary>To-dos</summary>{tasksOpen ? <Tasks projectId={projectId} embedded /> : null}</details>
		<details data-testid="overview-recent"><summary>Earlier decisions & updates</summary>
			{brief.isPending ? <p className="state-detail">Reading the project’s updates…</p> : brief.error ? <StatePanel compact kind={failureKind(brief.error)} title="Couldn’t load the updates." detail={brief.error instanceof Error ? brief.error.message : undefined} onRetry={() => void brief.refetch()} /> :
				(brief.data?.cards ?? []).length ? <ul className="fold-list">{brief.data!.cards.map(card => <li key={card.id}><button type="button" className="fold-row fold-row-link" onClick={() => { const route = onCardRoute(card, projectId); chrome.goProjectTab(route.to, route.search); }}><span className="fold-row-main"><span className="fold-row-title">{card.headline}</span>{card.summary ? <span className="fold-row-meta">{card.summary}</span> : null}</span><span className="fold-row-chevron" aria-hidden="true">›</span></button></li>)}</ul> : <p className="state-detail">Decisions and updates will be kept here.</p>}
		</details>
		<nav className="project-resource-links" aria-label="Project resources">
			<Link to="/runs" search={{ project: projectId, tab: 'files' }}>Files & code</Link>
			<Link to="/runs" search={{ project: projectId, tab: 'activity' }}>Build history</Link>
			<Link to="/schedules" search={{ project: projectId }}>Routines</Link>
		</nav>
	</div>;
}

/** Route for an overview card action (same targeting rules as the brief). */
function onCardRoute(card: DecisionCardType, _projectId: string): { to: string; search: Record<string, string | undefined> } {
	return briefActionRoute(card);
}

// --- PLAN (design gate) ----------------------------------------------------------

export function DesignReviewPage(): ReactElement {
	const chrome = useWorkspaceChrome();
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col focused-project-page">
					<ProjectTabs current="plan" context={chrome.selectedProject ? <ProjectSupportingDetails projectId={chrome.selectedProject.id} /> : null} />
					<ProjectGate skeleton={{ page: 'plan', label: 'Reading your plan…' }}>{(projectId) => <div className="focused-project-content"><DesignReviewBody projectId={projectId} /></div>}</ProjectGate>
				</div>
			</div>
		</>
	);
}

function DesignReviewBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const search = useSearch({ strict: false }) as { approval?: string };
	const historical = useQuery({
        queryKey: ['approval-record', chrome.actorId, props.projectId, search.approval],
        enabled: Boolean(chrome.actorId && search.approval),
        queryFn: () => fetchJson<{ approval: ApprovalRecord }>(`/api/approvals/${encodeURIComponent(search.approval!)}`),
    });
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const planDocs = usePlanDocRevisions(actor, props.projectId);
	// The build's own phase: once the plan is approved, the Plan tab follows it (plan 5.3).
	const buildPhase = useWorkflowPhase(actor, props.projectId);
	const fullWorkflow = useQuery(workflowQueryOptions(chrome.actorId, props.projectId));
	// PRD revisions share a counter; spec/note counters are incomparable.
    const revisions = [...(planDocs.data?.revisions ?? [])].filter((revision) => revision.kind === 'prd').sort((a, b) => b.revision - a.revision);
    const latest = revisions[0];
    const approval = useQuery({
        queryKey: ['plan-approval', chrome.actorId, props.projectId, latest?.id, latest?.bodyHash],
        enabled: Boolean(chrome.actorId && latest && !search.approval),
        queryFn: () => fetchJson<{ approval: ApprovalRecord | null }>(`/api/approvals?${new URLSearchParams({ projectId: props.projectId, action: 'design', resourceId: latest!.id, revisionHash: latest!.bodyHash, policyVersion: 'v1' })}`),
    });
    if (search.approval) {
        if (historical.isPending || planDocs.isPending) return <StatePanel kind="loading" title="Reading the decision record…" />;
        if (historical.error || planDocs.error) return <StatePanel kind="error" title="This decision could not be loaded" onRetry={() => { void historical.refetch(); void planDocs.refetch(); }} />;
        const record = historical.data?.approval;
        if (!record || record.projectId !== props.projectId) return <StatePanel kind="error" title="This decision does not belong to this project" />;
        const original = planDocs.data?.revisions.find(revision => revision.id === record.resourceId && revision.bodyHash === record.revisionHash);
        return <section className="card-surface caddie-card decision-history" data-testid="decision-history">
            <p className="kicker">Decision record · {record.status}</p><h1>This decision is kept on record</h1>
            <p>This is the exact decision you opened. Reading it does not approve, restart or change anything.</p>
            {original ? <div data-testid="decision-original-content"><h2>Original content · revision {original.revision}</h2><Markdown text={original.body} /></div> : <p role="status">The original content is not available here. Its identity is retained below; the latest plan has not been substituted.</p>}
            <details><summary>Record details</summary><dl><dt>Decision</dt><dd>{record.id}</dd><dt>Action</dt><dd>{record.action}</dd><dt>Resource</dt><dd>{record.resourceId}</dd><dt>Revision</dt><dd>{record.revisionHash}</dd></dl></details>
            <button type="button" className="btn-ghost" onClick={() => chrome.goProjectTab('/design-review', { project: props.projectId })}>View current plan</button>
        </section>;
    }
	const planEverApproved = ['approved', 'revoked', 'expired'].includes(fullWorkflow.data?.approval?.status ?? '');
	if (buildPhase.data === 'design' || buildPhase.data === 'design-review' || (buildPhase.data === 'blocked' && !planEverApproved)) return <ProjectWorkflow projectId={props.projectId} presentation="workspace" />;
	return (
		<DesignReview
            autoBuild
            key={`${chrome.actorId}:${props.projectId}:${latest?.id ?? 'empty'}`}
            approval={approval.data?.approval ?? null}
            approvalPending={Boolean(latest) && approval.isPending}
            approvalError={approval.error}
            retryApproval={() => void approval.refetch()}
            onDecisionSaved={() => { void approval.refetch(); chrome.refreshAll(); }}
            onContinue={() => chrome.openProject(props.projectId, true)}
            buildPhase={buildPhase.data ?? null}
            howItWorks={<HowYourAppWorks projectId={props.projectId} />}
			projectName={chrome.selectedProject?.name}
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
				<div className="page-col focused-project-page">
					<ProjectTabs current="build" />
					<ProjectGate skeleton={{ page: 'build', label: 'Reading your builds…' }}>{(projectId) => <RunsBody projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

/**
 * Build (v2, HANDOFF §4): opens on the working app (the private preview, when
 * one is live), "Building now" when the transport is live, past builds as
 * sentences, and two tabs — Activity and Files ("Code — for developers").
 */
function RunsBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as { tab?: 'activity' | 'files' };
	const tab = search.tab === 'files' ? 'files' : 'activity';
	const runBindings = useRunBindings(actor, props.projectId);
	const workflow = useQuery(workflowQueryOptions(chrome.actorId, props.projectId));
	const artifactRevisions = useArtifactRevisions<ViewerRevision>(actor, props.projectId);
	const [changeOpen, setChangeOpen] = useState(false);
	const [changeText, setChangeText] = useState('');
	// Secondary history never blocks the independent live workflow controls.
	// The Build step must NOT duplicate the Plan step. Before any build has run
	// (the plan is still being written/reviewed), showing the full workflow here
	// renders the plan + Approve a second time — exactly what the Plan tab shows.
	// So pre-build, the Build tab says plainly that a build starts after approval
	// and points to the Plan step; the live build only appears once it exists.
	const buildPhase = workflow.data?.workflow?.phase;
	// Only when the workflow actually LOADED and is still at the plan stage: a
	// failed or pending read is not "no build yet".
	const beforeBuild = workflow.isSuccess && !workflow.data?.importPreview && Boolean(workflow.data?.workflow) && ['planning', 'review', 'design', 'design-review'].includes(buildPhase ?? '');
	// "What Caddie has built" appears once there is something in it (a build
	// or saved files), or when a link asked for it (?tab=). Before the first
	// build it was a heading, a paragraph and two tabs around nothing.
	const nothingBuilt = runBindings.isSuccess && artifactRevisions.isSuccess && (runBindings.data?.runBindings ?? []).length === 0 && (artifactRevisions.data?.artifacts ?? []).length === 0;
	const showHistory = Boolean(search.tab) || !nothingBuilt;
	return (
		<div className="settings-stack">
			{/* The build's status from its own record, exactly as the chat card and
			    the project home show it (plan 3.5). It once followed this browser's
			    chat connection, so a paused build said nothing here. */}
			{beforeBuild ? (
				<div className="focused-project-content"><section className="focused-project-empty project-caddie-empty" data-testid="build-not-started">
                    <Mascot mood="needs" size={56} />
                    <div>
                      <h2>Let’s get ready to build</h2>
                      <p className="state-detail">First, review the plan with Caddie. You’ll see what your app will do before you approve the build.</p>
                      <button type="button" className="btn-key" onClick={() => chrome.goProjectTab('/design-review', { project: props.projectId })}>Go to Plan</button>
                    </div>
				</section></div>
			) : (
				<div className="focused-project-content"><ProjectWorkflow projectId={props.projectId} presentation="workspace" /></div>
			)}
			{!workflow.isPending && !workflow.data?.workflow && !workflow.data?.importPreview ? <NowPanel projectId={props.projectId} fallback={<p className="state-detail">The build appears here after you approve a plan.</p>} /> : null}
			{showHistory ? (
			<details className="project-secondary" open={Boolean(search.tab)} data-testid="project-build-resources">
			<summary><h2 className="fold-title">What Caddie has built</h2></summary>
			{/* Builds or files: a two-way switch, not a second row of tabs
			    under the step bar. */}
			<div className="build-view-switch" role="tablist" aria-label="Build views" data-testid="build-tabs">
				<button
					type="button"
					role="tab"
					aria-selected={tab === 'activity'}
					data-testid="build-tab-activity"
					onClick={() => void navigate({ to: '/runs', search: { project: props.projectId, tab: 'activity' } })}
				>
					Builds
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === 'files'}
					data-testid="build-tab-files"
					onClick={() => void navigate({ to: '/runs', search: { project: props.projectId, tab: 'files' } })}
				>
					Files — for developers
				</button>
			</div>
			{tab === 'files' ? (
				<ArtifactViewer
					projectId={props.projectId}
					revisions={artifactRevisions.data?.artifacts ?? []}
					isPending={artifactRevisions.isPending}
					error={artifactRevisions.error}
					retry={() => void artifactRevisions.refetch()}
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
					projectId={props.projectId}
					onAskChange={() => setChangeOpen(true)}
				/>
			)}
			</details>
			) : null}
			<ProjectSupportingDetails projectId={props.projectId} />
			{changeOpen ? (
				<div className="modal-backdrop" data-testid="change-request-backdrop" onMouseDown={() => setChangeOpen(false)}>
					<div className="commit-panel card-surface" data-testid="change-request-window" onMouseDown={(e) => e.stopPropagation()}>
						<p className="kicker" data-tone="action">
							ASK FOR A CHANGE
						</p>
						<h3 className="state-title">What should change?</h3>
						<p className="state-detail">
							Your request goes to this project's chat. Caddie answers there and drafts the plan update
							if one is needed — nothing changes in the app until you approve the new plan.
						</p>
						<textarea
							className="input"
							rows={3}
							data-testid="change-request-text"
							placeholder="e.g. Add a dark mode toggle to the header"
							value={changeText}
							onChange={(e) => setChangeText(e.target.value)}
						/>
						<div className="row-actions">
							<button
								type="button"
								className="btn-key"
								data-testid="change-request-send"
								disabled={changeText.trim() === ''}
								onClick={() => {
									// The ask becomes the draft in THIS project's chat; the user
									// sends it — no fabricated Caddie response, no silent write.
									chrome.channel.setComposerText(`Please change: ${changeText.trim()}`);
									setChangeOpen(false);
									setChangeText('');
									void navigate({ to: '.', search: { project: props.projectId, pane: 'channel' } });
								}}
							>
								Open in chat
							</button>
							<button type="button" className="btn-ghost" onClick={() => setChangeOpen(false)}>
								Cancel
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

export function ArtifactsPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col focused-project-page">
					<ProjectTabs current="build" />
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
				<div className="page-col focused-project-page">
					<ProjectTabs current="build" />
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
				<div className="page-col focused-project-page">
					<ProjectTabs current="build" />
					<ProjectGate>{(projectId) => <Tasks projectId={projectId} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

// --- SUBMISSION (Package / Evidence / Judge) -------------------------------------

/**
 * Submit body (v2): the real SubmissionPackage, handed the hackathon deadline
 * so it can show it prominently next to the hand-in checklist. Presentation
 * only — the deadline is read-only header data, never a new submission action.
 */
function SubmissionBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const hackathon = useProjectHackathon(actor, props.projectId);
	const deadline = hackathon.data?.hackathon ? deadlineText(hackathon.data.hackathon) : null;
	return <SubmissionPackage projectId={props.projectId} deadline={deadline} />;
}

export function SubmissionPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col focused-project-page">
					<ProjectTabs current="submission" />
					<ProjectGate>{(projectId) => <div className="focused-project-content" data-testid="project-submission"><SubmissionBody projectId={projectId} /></div>}</ProjectGate>
					<ProjectGateSoft>
						{(projectId) => (
							<nav className="submission-related" data-testid="submission-related" aria-label="Related surfaces">
								<Link to="/evidence" className="related-card card-surface" data-testid="submission-evidence-link" search={{ project: projectId }}>
									<b>See what Caddie checked</b>
									<span>The rules it read and the proof behind every line of the checklist.</span>
								</Link>
								<Link to="/judge" className="related-card card-surface" data-testid="submission-judge-link" search={{ project: projectId }}>
									<b>What judges look for</b>
									<span>Caddie's honest read of each criterion — never a predicted score.</span>
								</Link>
							</nav>
						)}
					</ProjectGateSoft>
				</div>
			</div>
		</>
	);
}

export function EvidencePage(): ReactElement {
	const search = useSearch({ strict: false }) as { claim?: string; open?: 'score' };
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col focused-project-page">
					<ProjectTabs current="check" />
					<ProjectGate>{(projectId) => <CheckBody projectId={projectId} openScore={search.open === 'score'} focusClaimType={search.claim} />}</ProjectGate>
				</div>
			</div>
		</>
	);
}

/**
 * Check (v2, HANDOFF §4): "N of M ready" from the submission package's real
 * checklist, the hand-in list with one fix per gap, what judges look for with
 * Caddie's honest read, the "Score it yourself" drawer (old /judge links land
 * here via ?open=score), and the proof drawer with the evidence claims.
 * Personal projects have no judges: the section is replaced by "No judges
 * here" and the step stays optional.
 */
function CheckBody(props: { projectId: string; openScore: boolean; focusClaimType?: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const workflow = useQuery(workflowQueryOptions(chrome.actorId, props.projectId));
	// Same rule as the header: a project is for a hackathon when it has a
	// contest link OR was started from a hackathon proposal (those have no
	// contest link). Checking the link alone called Farmhand — a Nebius x
	// NVIDIA entry — "a personal project" (owner 2026-10-23). Until the lookup
	// answers, neither judges section is claimed.
	const hackathon = useProjectHackathon(actor, props.projectId);
	const contestLinked = Boolean(chrome.selectedProject?.contestUrl);
	const personal = !contestLinked && hackathon.isSuccess && !hackathon.data?.hackathon;
	const judgingKnown = contestLinked || hackathon.isSuccess;
	const base = `/api/projects/${encodeURIComponent(props.projectId)}/submission`;
	const [attempt, setAttempt] = useState(0);
	const [packages, setPackages] = useState<readonly { id: string; title: string }[] | null>(null);
	const [detail, setDetail] = useState<null | {
		readiness: { status: string; reasons: readonly string[] };
		checklist: readonly {
			id: string;
			kind: string;
			status: 'missing' | 'declared' | 'verified' | 'conflict';
			requirementText: string;
			citation: { quote: string; url: string };
		}[];
	}>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const listResponse = await fetch(`${base}/packages`, { credentials: 'same-origin' });
				if (!listResponse.ok) throw new Error(`packages ${listResponse.status}`);
				const list = (await listResponse.json()) as { packages: { id: string; title: string }[] };
				if (cancelled) return;
				setPackages(list.packages ?? []);
				if ((list.packages ?? []).length === 0) {
					setDetail(null);
					return;
				}
				const detailResponse = await fetch(`${base}/packages/${encodeURIComponent(list.packages[0]!.id)}`, { credentials: 'same-origin' });
				if (!detailResponse.ok) throw new Error(`package ${detailResponse.status}`);
				const body = (await detailResponse.json()) as NonNullable<typeof detail>;
				if (!cancelled) setDetail(body);
			} catch (cause) {
				if (!cancelled) setLoadError(readableFailure(cause));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [base, attempt]);
	const retryChecklist = () => {
		setLoadError(null);
		setPackages(null);
		setAttempt((value) => value + 1);
	};

	const checklist = detail?.checklist ?? [];
	const verified = checklist.filter((item) => item.status === 'verified').length;
	const FIX_HINT: Record<string, string> = {
		missing: 'Not in the package yet — add it or point Caddie at the evidence in the chat.',
		declared: 'You said you have it — Caddie has not verified it against the rules yet.',
		conflict: 'The evidence disagrees with what you declared — resolve it in the chat.',
		verified: '',
	};

	const phase = workflow.data?.workflow?.phase;
	const hasApp = phase === 'ready' || phase === 'building' || Boolean(workflow.data?.importPreview);
	const preBuild = workflow.isSuccess && !hasApp && (!phase || ['planning', 'review', 'design', 'design-review'].includes(phase));

	return (
		<div className="settings-stack">
			<div className="focused-project-content" data-testid="project-app-checks">
				{hasApp ? (
                    <><div className="project-step-guide project-caddie-heading"><Mascot mood="ready" size={48} /><div><h2>Try and check your app</h2><p className="state-detail">Try the main tasks yourself, then review what Caddie has checked.</p></div></div><ProjectWorkflow projectId={props.projectId} presentation="workspace" /></>
				) : workflow.isPending ? (
					<p className="state-detail">Reading the latest build…</p>
				) : workflow.error ? (
					<StatePanel compact kind={failureKind(workflow.error)} title="Couldn’t load the build." detail={readableFailure(workflow.error)} onRetry={() => void workflow.refetch()} />
				) : preBuild ? (
					<section className="focused-project-empty project-caddie-empty" data-testid="check-not-yet">
                        <Mascot mood="needs" size={56} /><div>
						<h2>We’ll check your app here</h2>
						<p className="state-detail">Caddie checks your app here once it’s built. Approve the plan first.</p>
						<button type="button" className="btn-ghost" onClick={() => chrome.goProjectTab('/design-review', { project: props.projectId })}>Go to Plan</button></div>
					</section>
				) : (
					<section className="focused-project-empty project-caddie-empty"><Mascot mood="needs" size={56} /><div>
						<h2>Try and check your app</h2>
						<p className="state-detail">The app and its checks appear here after the build.</p>
						<button type="button" className="btn-ghost" onClick={() => chrome.goProjectTab('/runs', { project: props.projectId })}>Open Build</button></div>
					</section>
				)}
			</div>
			<details className="project-secondary" open={props.openScore || Boolean(props.focusClaimType)} data-testid="project-entry-checks"><summary>{personal ? 'Project evidence' : 'Submission readiness, rules & judging'}</summary>
			{/* N of M ready (§4): from the real checklist, never an estimate. */}
			<section className="card-surface settings-panel" data-testid="check-readiness">
				{loadError ? (
					<StatePanel compact kind="error" title="Couldn’t load the hand-in list." detail={loadError} onRetry={retryChecklist} />
				) : packages === null ? (
					<StatePanel kind="loading" title="Loading the hand-in list…" />
				) : packages.length === 0 ? (
					<p className="state-detail" data-testid="check-empty">
						No checklist yet — prepare the submission package and the hand-in list appears here.
					</p>
				) : (
					<>
						<h2 className="ev-title" data-testid="check-ready-count">
							{verified} of {checklist.length} things are ready
						</h2>
						<ul className="disc-list" data-testid="check-handin-list">
							{checklist.map((item) => (
								<li key={item.id} className="disc-item" data-status={item.status} data-testid="check-handin-item">
									<div className="disc-head">
										<code>{item.kind}</code>
										<span
											className="badge"
											data-tone={item.status === 'verified' ? 'ok' : item.status === 'conflict' ? 'action' : item.status === 'declared' ? 'warn' : 'danger'}
										>
											{item.status === 'verified' ? 'READY' : item.status === 'declared' ? 'ALMOST' : item.status === 'conflict' ? 'CONFLICT' : 'MISSING'}
										</span>
										<span className="disc-claim-line">{item.requirementText}</span>
									</div>
									{FIX_HINT[item.status] ? <div className="disc-meta">{FIX_HINT[item.status]}</div> : null}
								</li>
							))}
						</ul>
					</>
				)}
			</section>

			{/* What judges look for — with the honest personal-project variant.
			    Neither is shown until it is KNOWN which applies. */}
			{!judgingKnown ? null : personal ? (
				<section className="card-surface settings-panel" data-testid="check-no-judges">
					<h2 className="ev-title">No judges here</h2>
					<p className="state-detail">
						This is a personal project, so this step is optional — there is no jury to score it. You can
						still check the readiness list above.
					</p>
				</section>
			) : (
				<section className="card-surface settings-panel" data-testid="check-judges" id={props.openScore ? 'score' : undefined}>
					<h2 className="ev-title">What judges look for</h2>
					<p className="state-detail">
						Caddie's honest read of each criterion, with the evidence it can actually see — never a
						predicted score.
					</p>
					<JudgeScorecard projectId={props.projectId} />
				</section>
			)}

			{/* Proof: the evidence behind the readiness lines. The drawer owns its
			    own header and sections — wrapping it in another fold made cards
			    three deep (owner steering, 2026-10-15), so it renders directly. */}
			<EvidenceDrawer projectId={props.projectId} focusClaimType={props.focusClaimType} />
			</details>
			<ProjectSupportingDetails projectId={props.projectId} />
		</div>
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
	if (!chrome.authenticated) return <SignInScreen />;
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
					<h2 className="ev-title">Your code on GitHub</h2>
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
	return chrome.authenticated ? <Search /> : <SignInScreen />;
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
							<h1 className="page-title">Routines</h1>
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

export function AutomationsBody(): ReactElement {
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

	if (!chrome.authenticated) return <SignInScreen />;
	if (chrome.projectsPending) return <StatePanel kind="loading" title="Fetching your projects…" />;
	if (chrome.buildProjects.length === 0) {
		return <StatePanel kind="empty" title="No routines yet" detail="Routines are checks Caddie runs for a project on a schedule — like watching a hackathon deadline. Start a project first." />;
	}
	if (!readDone) return <StatePanel kind="loading" title="Reading your routines…" />;
	return (
		<div className="settings-section-body" data-testid="automations-list">
			{chrome.buildProjects.map((project) => {
				const row = perProject[project.id];
				const schedules = row?.state === 'ready' ? row.schedules : [];
				return (
					<section key={project.id} className="settings-group" data-testid={row?.state === 'error' ? `automations-error-${project.id}` : `automations-project-${project.id}`}>
						<div className="settings-group-head">
							<h2 className="settings-subhead">{project.name}</h2>
							<button
								type="button"
								className="r-link settings-group-link"
								data-testid={`automations-open-${project.id}`}
								onClick={() => chrome.goProjectTab('/schedules', { project: project.id })}
							>
								Manage
							</button>
						</div>
						{row?.state === 'error' ? (
							<p role="alert" className="form-error">Couldn’t read this project’s routines. {row.message}</p>
						) : schedules.length === 0 ? (
							<p className="settings-row-detail">No routines yet.</p>
						) : (
							<ul className="settings-rows" data-testid={`automations-count-${project.id}`} data-count={schedules.length}>
								{schedules.map((schedule) => {
									const next = formatNextRun(schedule.nextRunAt);
									return (
										<li className="settings-row" key={schedule.id} data-testid={`automations-schedule-${schedule.id}`}>
											<div className="settings-row-main">
												<span className="settings-row-title">{schedule.name}</span>
												<span className="settings-row-detail">
													{schedule.paused ? 'Paused' : next ? `Next run: ${next}` : 'Scheduled'}
												</span>
											</div>
											<span className="status-pill" data-status={schedule.paused ? 'planned' : 'handled'}>
												{schedule.paused ? 'Paused' : 'On'}
											</span>
										</li>
									);
								})}
							</ul>
						)}
					</section>
				);
			})}
		</div>
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
							<h1 className="page-title">Spending</h1>
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

export function UsageBody(): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const usage = useQuery({
		queryKey: ['usage', chrome.actorId ?? 'pending'],
		queryFn: () => fetchJson<UsageResponse>('/api/usage'),
		enabled: chrome.authenticated && chrome.actorId !== null,
	});

	if (!chrome.authenticated) return <SignInScreen />;
	if (usage.isPending) {
		return (
			<section className="settings-section-body" data-testid="usage-panel">
				<StatePanel kind="loading" title="Reading your spending…" />
			</section>
		);
	}
	if (usage.error) {
		return (
			<section className="settings-section-body" data-testid="usage-panel">
				<StatePanel
					kind={failureKind(usage.error)}
					detail={usage.error instanceof Error ? usage.error.message : undefined}
					onRetry={() => void usage.refetch()}
				/>
			</section>
		);
	}

	const data = usage.data;
	const currency = data?.payer?.currency ?? 'USD';
	const money = (minor: number) => formatMinorUnits(minor, currency);

	return (
		<section className="settings-section-body" data-testid="usage-panel">
			<ul className="settings-rows">
				<li className="settings-row" data-testid="usage-budget-state">
					<div className="settings-row-main">
						<span className="settings-row-title">Spending limit</span>
						<span className="settings-row-detail">
							{data?.unavailable
								? 'Spending isn’t tracked on this server yet, so nothing is charged here.'
								: data?.payer
									? 'Caddie checks this before every build and stops before going over it.'
									: 'You don’t have a limit yet. One is set up the first time a build needs it.'}
						</span>
					</div>
					{data?.payer && !data.unavailable ? (
						<span className="settings-amount" data-testid="usage-limit">{money(data.payer.limitMinorUnits)}</span>
					) : (
						<span className="status-pill" data-status="planned">{data?.unavailable ? 'Not tracked' : 'Not set'}</span>
					)}
				</li>
				{data && !data.unavailable ? (
					<>
						<li className="settings-row" data-testid="usage-reserved">
							<div className="settings-row-main">
								<span className="settings-row-title">Held for builds in progress</span>
								<span className="settings-row-detail">Released or charged when each build finishes.</span>
							</div>
							<span className="settings-amount">{money(data.totals.reservedMinorUnits)}</span>
						</li>
						<li className="settings-row" data-testid="usage-settled">
							<div className="settings-row-main">
								<span className="settings-row-title">Spent so far</span>
								<span className="settings-row-detail">
									Across {data.totals.reservations.toLocaleString()} build{data.totals.reservations === 1 ? '' : 's'}.
								</span>
							</div>
							<span className="settings-amount">{money(data.totals.settledMinorUnits)}</span>
						</li>
					</>
				) : null}
			</ul>
			<p className="settings-row-detail">These are the exact amounts the server checks — nothing here is an estimate. Each project’s build activity shows what a single build cost.</p>
		</section>
	);
}

