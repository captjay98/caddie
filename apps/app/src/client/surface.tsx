import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import * as v from 'valibot';
import { ProjectExperienceSchema } from '@caddie/contracts';
import type { ApprovalRecord, DecisionCard as DecisionCardType, Project } from '@caddie/contracts';
import { SignInPanel } from './auth.ts';
import { Mascot } from '@caddie/ui/Mascot';
import { Markdown } from '@caddie/ui/Markdown';
import { failureKind, StatePanel } from './states.tsx';
import { formatMinorUnits, formatNextRun } from './settings/settings-model.ts';
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
	useAccountBrief,
	useArtifactRevisions,
	useArtifacts,
	useBriefCards,
	useWorkflowBrief,
	useCreateProject,
	usePlanDocRevisions,
	useProjectExperience,
	useRunBindings,
} from './queries.ts';
import { useQuery } from '@tanstack/react-query';
import { fetchJson } from './api.ts';
import { useWorkspaceChrome } from './workspace/Chrome.tsx';
import { NowPanel } from './project/NowPanel.tsx';
import { relativeUpdated } from './project/now-panel.ts';
import { ProjectTabs } from './workspace/ProjectTabs.tsx';
import { projectCardFromExperience, projectStatus } from './workspace/project-status.ts';

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

function SignInGate(): ReactElement {
	return (
		<div className="signin-split" data-testid="sign-in-gate">
			{/* LEFT: brand / mascot hero — a signed-out screen has no live session,
			    so this is an honest static hero (what Caddie does), never a faked
			    live feed. Themed entirely via tokens so it tracks mode + palette. */}
			<div className="signin-hero" aria-hidden="true">
				<div className="signin-hero-grid" />
				<p className="signin-hero-brand">CADDIE</p>
				<div className="signin-hero-center">
					<Mascot mood="ready" size={88} live />
					<div className="signin-hero-copy">
						<h2 className="signin-hero-title">Your caddie for the whole round.</h2>
						<p className="signin-hero-lede">
							Caddie finds the hackathons that fit you, plans the build, and ships it with you — step by
							step, nothing without your say-so.
						</p>
					</div>
					<ul className="signin-hero-chips">
						<li>Finds contests</li>
						<li>Plans the build</li>
						<li>Ships with you</li>
					</ul>
				</div>
				<p className="signin-hero-foot">Built for solo builders. Free to start.</p>
			</div>

			{/* RIGHT: the real sign-in form, vertically centered. */}
			<div className="signin-form">
				<div className="signin-col">
					<div className="signin-brand">
						<h1 className="signin-title">Sign in to Caddie</h1>
						<p className="signin-lede">Use the account you already have — it&rsquo;s free to start.</p>
					</div>
					<div className="signin-card">
						<SignInPanel callbackURL="/app/" />
					</div>
					<p className="signin-note">
						Signing in doesn&rsquo;t give Caddie your code. It asks separately, only if you bring code in.
					</p>
				</div>
			</div>
		</div>
	);
}

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

	const workspaceId = chrome.buildProjects[0]?.workspaceId;

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
							Caddie reads the repo you pick — at first only reads it. Writing, merging and deploying
							stay behind their own separate approvals.
						</p>
						{workspaceId ? (
							<RepositoryPicker workspaceId={workspaceId} onSelected={setPicked} />
						) : (
							<StatePanel kind="empty" title="No workspace yet" detail="Start a project first — a repository connects to a project's workspace." />
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
	if (!chrome.authenticated) return <SignInGate />;
	if (chrome.projectsPending) return <StatePanel kind="loading" title="Loading your projects…" />;
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
					return <ProjectCard key={project.id} project={project} fallback={fallback} />;
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
}): ReactElement {
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const experience = useProjectExperience(actor, props.project.id);
	const { project, fallback } = props;
	const parsed = experience.data ? v.safeParse(ProjectExperienceSchema, experience.data) : null;
	const card = parsed?.success ? projectCardFromExperience(parsed.output) : null;
	const purpose = project.description?.trim() || (project.contestUrl ? 'For the linked hackathon' : 'A personal project');
	const updatedMs = card && parsed?.success ? parsed.output.version : Date.parse(project.updatedAt);
	const updated = relativeUpdated(updatedMs, Date.now());

	return (
		<li className="project-row project-card card-surface" data-testid={`project-row-${project.id}`} data-working={card?.working ? 'true' : 'false'}>
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
			<p className="project-card-purpose" title={purpose}>
				{purpose}
			</p>
			<p className="project-card-detail">{card ? card.detail : fallback.detail}</p>
			<div className="project-card-foot">
				<span className="project-card-updated">{updated ?? ''}</span>
				{card ? (
					card.action.target === 'plan' ? (
						<Link className="btn-key" to="/design-review" search={{ project: project.id } as never} data-testid={`project-next-${project.id}`}>
							{card.action.label}
						</Link>
					) : (
						<button
							type="button"
							className="btn-key"
							data-testid={card.action.target === 'chat' ? `project-continue-${project.id}` : `project-next-${project.id}`}
							onClick={() => chrome.openProject(project.id, card.action.target === 'chat')}
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
						) : null}
						<button type="button" className={fallback.next ? 'btn-ghost' : 'btn-key'} onClick={() => chrome.openProject(project.id, true)} data-testid={`project-continue-${project.id}`}>
							Continue with Caddie
						</button>
					</span>
				)}
			</div>
		</li>
	);
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
	const workflowBrief = useWorkflowBrief(actor, props.projectId);
	// The same ProjectExperience the Now panel reads, so the idea/brief cards
	// can say honestly that Caddie is acting on this project right now.
	const experience = useProjectExperience(actor, props.projectId);
	const experienceParsed = experience.data ? v.safeParse(ProjectExperienceSchema, experience.data) : null;
	const experienceStage = experienceParsed?.success ? experienceParsed.output.stage : null;
	const workingStages: readonly string[] = ['planning', 'building', 'checking', 'repairing'];
	const working = experienceStage !== null && workingStages.includes(experienceStage);
	const navigate = useNavigate();
	// The full brief opens in a modal, NOT an inline <details>, so revealing it
	// never shifts the Overview layout (user steering, 2026-10-15).
	const [briefOpen, setBriefOpen] = useState(false);

	// "Your app so far" (§4): the project's real preview state from the P07
	// previews API (metadata only — the secret token is never re-readable).
	const [preview, setPreview] = useState<{ live: boolean; createdAt: string | null; error: boolean } | null>(null);
	useEffect(() => {
		let cancelled = false;
		void fetch(`/api/projects/${encodeURIComponent(props.projectId)}/previews`, { credentials: 'same-origin' })
			.then((res) => { if (!res.ok) throw new Error('Could not load previews'); return res.json(); })
			.then((body: { previews?: { revoked: boolean; expiresAt: string; createdAt: string }[] } | null) => {
				if (cancelled) return;
				const now = Date.now();
				const live = (body?.previews ?? []).find((p) => !p.revoked && new Date(p.expiresAt).getTime() > now);
				setPreview({ live: Boolean(live), createdAt: live?.createdAt ?? null, error: false });
			})
			.catch(() => {
				if (!cancelled) setPreview({ live: false, createdAt: null, error: true });
			});
		return () => {
			cancelled = true;
		};
	}, [props.projectId]);

	const cards = brief.data?.cards ?? [];
	const open = cards.filter((c) => c.status !== 'handled');
	const done = cards.filter((c) => c.status === 'handled');
	const next = open[0] ?? null;
	const nextDeadline = useMemo(() => {
		const nexts = cards
			.filter((c) => c.kind === 'deadline')
			.map((c) => {
				const m = /Next run ([^ (]+)/.exec(c.summary);
				return m ? m[1].slice(0, 10) : null;
			})
			.filter((v): v is string => v !== null)
			.sort();
		return nexts[0] ?? null;
	}, [cards]);

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
		}
	}

	return (
		<div className="settings-stack">
			{brief.isPending ? (
				<StatePanel kind="loading" title="Loading this project…" />
			) : brief.error ? (
				<StatePanel kind={failureKind(brief.error)} detail={brief.error instanceof Error ? brief.error.message : undefined} onRetry={() => void brief.refetch()} />
			) : (
				<>
					<div className="overview-grid">
					<div className="overview-main">
					{/* Now: what Caddie is doing on this project and the next action,
					    from the shared ProjectExperience projection. Projects with no
					    workflow yet keep the decision-card next step below. */}
					<NowPanel
						projectId={props.projectId}
						fallback={
					<section className="card-surface settings-panel" data-testid="overview-next-step">
						<p className="kicker" data-tone="action">
							NEXT STEP
						</p>
						{next ? (
							<>
								<h2 className="ev-title">{next.headline}</h2>
								<p className="page-lede">{next.summary}</p>
								<div className="row-actions">
									<button
										type="button"
										className="btn-key"
										data-testid="overview-next-action"
										onClick={() => {
											void navigate({
												to: onCardRoute(next, props.projectId).to as never,
												search: onCardRoute(next, props.projectId).search as never,
											});
										}}
									>
										{next.primaryAction.label}
									</button>
								</div>
							</>
						) : (
							<>
								<h2 className="ev-title">{cards.length === 0 ? "Let’s get started" : "Nothing needs you right now"}</h2>
								<p className="page-lede">
									{cards.length === 0 ? "Tell Caddie what you want to make. Your plan, decisions, and progress will appear here." : "You can keep working with Caddie or review your project below."}
								</p>
                                <div className="row-actions">
                                    <button type="button" className="btn-key" onClick={() => chrome.openProject(props.projectId, true)}>Continue with Caddie</button>
                                </div>
							</>
						)}
					</section>
						}
					/>
					</div>

					<aside className="overview-side">
					{/* Your idea: the one-line idea, with the brief Caddie wrote one click away.
					    While Caddie is acting on this project the card says so — the brief
					    never sits silent while a build runs (owner steering, 2026-10-15). */}
					<section className="card-surface settings-panel" data-testid="overview-idea">
						<p className="kicker">Your idea</p>
						<p className="overview-idea-line">
							{chrome.selectedProject?.description || 'Tell Caddie what you want to make and the idea appears here.'}
						</p>
						{workflowBrief.data ? (
							<button
								type="button"
								className="r-link overview-brief-open"
								data-testid="overview-brief-open"
								onClick={() => setBriefOpen(true)}
							>
								Read the full brief
							</button>
						) : null}
						{working ? (
							<p className="overview-build-note" data-testid="overview-brief-building">
								<span className="now-live" aria-hidden="true" />
								Caddie is working on this right now — its status is in “Now” above.
							</p>
						) : null}
					</section>

					{/* Your app: the real preview state, never a fake screenshot. */}
					<section className="card-surface settings-panel" data-testid="overview-preview">
						<p className="kicker">Your app</p>
						<div className="overview-app">
							<span className="overview-app-phone" data-live={preview?.live ? 'true' : 'false'} aria-hidden="true" />
							{preview === null ? (
								<p className="state-detail">Checking for a live preview…</p>
							) : preview.error ? (
								<p className="state-detail">The preview list could not be read just now.</p>
							) : preview.live ? (
								<p className="state-detail" data-testid="overview-preview-live">
									A private preview of your app is live{preview.createdAt ? ` (created ${new Date(preview.createdAt).toLocaleDateString()})` : ''}. The link lives in
									the chat where Caddie shared it — ask there to share it again.
								</p>
							) : (
								<p className="state-detail" data-testid="overview-preview-none">
									Your app appears here once the plan is approved and built. You’ll get a link to try it on your phone.
								</p>
							)}
						</div>
					</section>
					</aside>
					</div>

					<details className="card-surface settings-panel" data-testid="overview-todo" id="todo">
                        <summary className="ev-head">To-dos</summary>
						<Tasks projectId={props.projectId} embedded />
					</details>

					{done.length > 0 ? (
						<details className="card-surface settings-panel" data-testid="overview-recent">
							<summary className="ev-head">What happened recently · {done.length}</summary>
							<ul>
								{done.map((card) => (
									<li key={card.id} data-testid="overview-recent-item">
										<b>{card.headline}</b> — {card.summary}
									</li>
								))}
							</ul>
						</details>
					) : null}

					{briefOpen && workflowBrief.data ? (
						<div
							className="modal-backdrop"
							data-testid="overview-brief-backdrop"
							onMouseDown={() => setBriefOpen(false)}
						>
							<div
								className="commit-panel card-surface overview-brief-modal"
								role="dialog"
								aria-modal="true"
								aria-label="Full project brief"
								data-testid="overview-brief-modal"
								onMouseDown={(e) => e.stopPropagation()}
							>
								<div className="r-section-head">
									<p className="kicker" data-tone="action">The full brief</p>
									<button type="button" className="btn-ghost" data-testid="overview-brief-close" onClick={() => setBriefOpen(false)}>
										Close
									</button>
								</div>
								{working ? (
									<p className="overview-brief-status" data-testid="overview-brief-status">
										<span className="now-live" aria-hidden="true" />
										Caddie is acting on this brief right now — progress is in “Now” on the project page.
									</p>
								) : null}
								{/* The brief is stored as plain prose; it renders as paragraphs
								    (the same Markdown the plan body gets) instead of one collapsed
								    wall of text. */}
								<div className="overview-brief-text" data-testid="overview-brief-text">
									<Markdown text={workflowBrief.data} />
								</div>
							</div>
						</div>
					) : null}
				</>
			)}
		</div>
	);
}

/** Route for an overview card action (same targeting rules as the brief). */
function onCardRoute(card: DecisionCardType, projectId: string): { to: string; search: Record<string, string | undefined> } {
	const search = { project: projectId };
	switch (card.kind) {
		case 'approval':
			return { to: '/design-review', search };
		case 'deadline':
			return { to: '/schedules', search };
		case 'result':
			return { to: '/runs', search };
		case 'change':
			return card.evidenceIds.length > 0
				? { to: '/evidence', search: { ...search, claim: card.primaryAction.targetId } }
				: { to: '/artifacts', search };
	}
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
	// PRD revisions share a counter; spec/note counters are incomparable.
    const revisions = [...(planDocs.data?.revisions ?? [])].filter((revision) => revision.kind === 'prd').sort((a, b) => b.revision - a.revision);
    const latest = revisions[0];
    const approval = useQuery({
        queryKey: ['plan-approval', chrome.actorId, props.projectId, latest?.id, latest?.bodyHash],
        enabled: Boolean(chrome.actorId && latest),
        queryFn: () => fetchJson<{ approval: ApprovalRecord | null }>(`/api/approvals?${new URLSearchParams({ projectId: props.projectId, action: 'design', resourceId: latest!.id, revisionHash: latest!.bodyHash, policyVersion: 'v1' })}`),
    });
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
					<ProjectGate>{(projectId) => <RunsBody projectId={projectId} />}</ProjectGate>
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
	const artifactRevisions = useArtifactRevisions<ViewerRevision>(actor, props.projectId);
	const buildLive = chrome.transport?.source.status === 'streaming' || chrome.transport?.source.status === 'submitted';
	const [changeOpen, setChangeOpen] = useState(false);
	const [changeText, setChangeText] = useState('');
	return (
		<div className="settings-stack">
			{buildLive ? (
				<section className="card-surface settings-panel build-live" data-testid="build-status" role="status">
					<p className="now-head">
						<span className="now-live" aria-hidden="true" />
						<span className="kicker" data-tone="action">
							Building now
						</span>
					</p>
					<p className="page-lede">
						Caddie is building your app in this project's chat. Step-by-step progress lives in “Now” on
						the project home — when it finishes, the result shows up in the list below.
					</p>
				</section>
			) : null}
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						BUILD
					</p>
					<h2 className="ev-title">{tab === 'files' ? 'Code — for developers' : 'What Caddie has built'}</h2>
					{tab === 'files' ? null : (
						<p className="page-lede">
							Every build Caddie runs for this project, newest first — so you can reopen a working
							version, see what it built, or ask for a change. Approve a plan in the chat and the
							next build appears here.
						</p>
					)}
				</div>
				<div className="tabs" role="tablist" aria-label="Build views" data-testid="build-tabs">
					<button
						type="button"
						role="tab"
						aria-selected={tab === 'activity'}
						data-testid="build-tab-activity"
						onClick={() => void navigate({ to: '/runs', search: { project: props.projectId, tab: undefined } })}
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
				<div className="page-col">
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
				<div className="page-col">
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
				<div className="page-col">
					<ProjectTabs current="build" />
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
					<ProjectGate>{(projectId) => <SubmissionPackage projectId={projectId} />}</ProjectGate>
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
				<div className="page-col">
					<ProjectTabs current="submission" />
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
	const personal = !chrome.selectedProject?.contestUrl;
	const base = `/api/projects/${encodeURIComponent(props.projectId)}/submission`;
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
				if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [base]);

	const checklist = detail?.checklist ?? [];
	const verified = checklist.filter((item) => item.status === 'verified').length;
	const FIX_HINT: Record<string, string> = {
		missing: 'Not in the package yet — add it or point Caddie at the evidence in the chat.',
		declared: 'You said you have it — Caddie has not verified it against the rules yet.',
		conflict: 'The evidence disagrees with what you declared — resolve it in the chat.',
		verified: '',
	};

	return (
		<div className="settings-stack">
			{/* N of M ready (§4): from the real checklist, never an estimate. */}
			<section className="card-surface settings-panel" data-testid="check-readiness">
				<p className="kicker" data-tone="action">
					CHECK
				</p>
				{loadError ? (
					<StatePanel kind="error" title="Could not load the checklist" detail={loadError} onRetry={() => window.location.reload()} />
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

			{/* What judges look for — with the honest personal-project variant. */}
			{personal ? (
				<section className="card-surface settings-panel" data-testid="check-no-judges">
					<p className="kicker" data-tone="action">
						JUDGES
					</p>
					<h2 className="ev-title">No judges here</h2>
					<p className="state-detail">
						This is a personal project, so this step is optional — there is no jury to score it. You can
						still check the readiness list above.
					</p>
				</section>
			) : (
				<section className="card-surface settings-panel" data-testid="check-judges" id={props.openScore ? 'score' : undefined}>
					<p className="kicker" data-tone="action">
						JUDGES
					</p>
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

	if (!chrome.authenticated) return <SignInGate />;
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

	if (!chrome.authenticated) return <SignInGate />;
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

