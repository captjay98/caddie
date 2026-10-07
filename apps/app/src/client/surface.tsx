import { Fragment, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useSearch } from '@tanstack/react-router';
import { SignInPanel } from './auth.ts';
import { failureKind, StatePanel } from './states.tsx';
import { DiscoveryResults } from './discovery/Results.tsx';
import { JudgeScorecard } from './judge/Scorecard.tsx';
import { SubmissionPackage } from './submission/Package.tsx';
import { Schedules } from './tasks/Schedules.tsx';
import { EvidenceDrawer } from './evidence/Drawer.tsx';
import { ArtifactViewer, type ViewerRevision } from './artifacts/Viewer.tsx';
import { DesignReview } from './planning/DesignReview.tsx';
import { RepositoryPicker, type SelectedRepository } from './repositories/RepositoryPicker.tsx';
import {
	useArtifactRevisions,
	useAuthStatus,
	usePlanDocRevisions,
	useProjects,
	useSessionActor,
} from './queries.ts';
import { WorkspaceChrome, useWorkspaceChrome } from './workspace/Chrome.tsx';

/**
 * P11/P13 standalone surfaces — the workspace-shell integration pattern for
 * the unmounted slice-3 components (discovery results, judge scorecard,
 * submission package) plus the P12 schedules panel, following the /settings
 * page grammar: a `<main>` page route wrapping the real component.
 *
 * The gate is the SAME fail-closed contract as the Shell (feature-ledger
 * C5/P06): the real /api/auth/status probe decides sign-in vs. surface, the
 * project is resolved from the ?project= search param against the actor's OWN
 * project list (Shell semantics: first project is the fallback; a param
 * pointing at a project the account cannot see renders the explicit
 * not-in-your-list error — it is never probed or trusted directly), and every
 * failure kind renders as an explicit state panel. No component data is
 * fetched before a project is resolved, so a deep link can never leak another
 * account's rows (every query is actor-keyed, and the resolved surface is
 * keyed by actor like the Shell — an account switch remounts it fresh).
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

function ProjectSurface(props: { children: (projectId: string) => ReactElement }): ReactElement {
	const auth = useAuthStatus();
	const actor = useSessionActor(Boolean(auth.data?.authenticated));
	const projects = useProjects({ actorId: actor.data ?? null });
	const search = useSearch({ strict: false }) as { project?: string };

	if (auth.isPending) {
		return <StatePanel kind="loading" title="Checking your session…" />;
	}
	if (auth.error) {
		return (
			<StatePanel
				kind={failureKind(auth.error)}
				detail={auth.error instanceof Error ? auth.error.message : undefined}
				onRetry={() => void auth.refetch()}
				retryLabel="Check again"
			/>
		);
	}
	if (!auth.data.authenticated) {
		return <SignInGate />;
	}
	if (actor.isPending || projects.isPending) {
		return <StatePanel kind="loading" title="Fetching your projects…" />;
	}
	const loadError = actor.error ?? projects.error;
	if (loadError) {
		return (
			<StatePanel
				kind={failureKind(loadError)}
				detail={loadError instanceof Error ? loadError.message : undefined}
				onRetry={failureKind(loadError) === 'denied' ? undefined : () => void projects.refetch()}
			/>
		);
	}

	const projectList = projects.data?.projects ?? [];
	const paramProject = search.project;
	const selectedProject =
		projectList.find((project) => project.id === paramProject) ?? projectList[0] ?? null;
	const projectMissing = Boolean(paramProject) && projectList.length > 0 && !selectedProject;
	if (projectMissing) {
		return (
			<>
				<StatePanel
					kind="error"
					title="That project is not in your list"
					detail="The link points at a project your account cannot see (or that no longer exists)."
				/>
				<p>
					<a className="btn-ghost" href="./">
						Back to your projects
					</a>
				</p>
			</>
		);
	}
	if (!selectedProject) {
		return (
			<>
				<StatePanel
					kind="empty"
					title="No project selected"
					detail="Create a project in the workspace first — this surface reads one project's data."
				/>
				<p>
					<a className="btn-key" href="./">
						Open the workspace
					</a>
				</p>
			</>
		);
	}
	return (
		<Fragment key={actor.data ?? 'pending'}>
			{props.children(selectedProject.id)}
		</Fragment>
	);
}

export function DiscoveryPage(): ReactElement {
	return (
		<WorkspaceChrome active="discovery">
			<div className="shell-loading">
				<ProjectSurface>{(projectId) => <DiscoveryResults projectId={projectId} />}</ProjectSurface>
			</div>
		</WorkspaceChrome>
	);
}

export function JudgePage(): ReactElement {
	return (
		<WorkspaceChrome active="judge">
			<div className="shell-loading">
				<ProjectSurface>{(projectId) => <JudgeScorecard projectId={projectId} />}</ProjectSurface>
			</div>
		</WorkspaceChrome>
	);
}

export function SubmissionPage(): ReactElement {
	return (
		<WorkspaceChrome active="submission">
			<div className="shell-loading">
				<ProjectSurface>{(projectId) => <SubmissionPackage projectId={projectId} />}</ProjectSurface>
			</div>
		</WorkspaceChrome>
	);
}

export function SchedulesPage(): ReactElement {
	return (
		<WorkspaceChrome active="schedules">
			<div className="shell-loading">
				<ProjectSurface>{(projectId) => <Schedules projectId={projectId} />}</ProjectSurface>
			</div>
		</WorkspaceChrome>
	);
}

/** Board screen 09: the P10 evidence inspector, finally reachable. */
export function EvidencePage(): ReactElement {
	const search = useSearch({ strict: false }) as { claim?: string };
	return (
		<WorkspaceChrome active="none" crumbs={<span>Evidence · readings and their snapshots</span>}>
			<div className="shell-loading">
				<ProjectSurface>
					{(projectId) => <EvidenceDrawer projectId={projectId} focusClaimType={search.claim} />}
				</ProjectSurface>
			</div>
		</WorkspaceChrome>
	);
}

/** Board screen 10: the P07 artifact viewer, finally reachable. */
export function ArtifactsPage(): ReactElement {
	return (
		<WorkspaceChrome active="none" crumbs={<span>Artifacts · content-addressed revisions</span>}>
			<div className="shell-loading">
				<ProjectSurface>{(projectId) => <ArtifactsBody projectId={projectId} />}</ProjectSurface>
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

/** Board screen 11: the design gate — the decision that unblocks all building. */
export function DesignReviewPage(): ReactElement {
	return (
		<WorkspaceChrome active="none" crumbs={<span>Design gate · the plan revision approval</span>}>
			<div className="shell-loading">
				<ProjectSurface>{(projectId) => <DesignReviewBody projectId={projectId} />}</ProjectSurface>
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

/** Board screen 12: the P08 repository picker — reachable from onboarding. */
export function RepositoriesPage(): ReactElement {
	return (
		<WorkspaceChrome active="none" crumbs={<span>Repositories · the GitHub App connection</span>}>
			<div className="shell-loading">
				<ProjectSurface>{(projectId) => <RepositoriesBody projectId={projectId} />}</ProjectSurface>
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
		<div className="settings-stack" style={undefined}>
			{picked ? (
				<section className="card-surface settings-panel" data-testid="picked-repo">
					<h3 className="ev-head">Picked {picked.repoFullName}</h3>
					<p className="state-detail">
						Reading allows planning and evidence from this repository. Writing, merging and deploying stay
						behind their own gates, each needing a separate approval.{' '}
						<a className="r-link" href="./">
							Open the workspace
						</a>{' '}
						to start from it.
					</p>
				</section>
			) : null}
			<RepositoryPicker workspaceId={project.workspaceId} onSelected={setPicked} />
		</div>
	);
}
