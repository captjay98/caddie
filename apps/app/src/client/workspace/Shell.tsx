import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { SignInPanel } from '../auth.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { Icon } from '../icons.tsx';
import { Start } from '../onboarding/Start.tsx';
import {
	useArtifacts,
	useAuthStatus,
	useBriefCards,
	useCreateProject,
	useRunBindings,
	useSessionActor,
	watchAuthTransitions,
} from '../queries.ts';
import { BriefLane } from '../brief/DecisionCard.tsx';
import { RunInspector } from '../runs/RunInspector.tsx';
import { Channel } from '../conversation/Channel.tsx';
import { standbySource as STANDBY, useChannelStore, type ChannelDraft } from '../conversation/channel-store.ts';
import { useCoordinatorTransport } from '../coordinator.ts';
import { WorkspaceChrome, useWorkspaceChrome } from './Chrome.tsx';

/**
 * Workspace shell — feature-ledger rows C5/H9 (Card/Tasks/Channel continuity
 * and the two-pane shell, adapted to typed payloads + TanStack Router/Query).
 *
 * The topbar, project selector, theme control, refresh and sign-out live in the
 * shared WorkspaceChrome (one header + one nav row on every route); this
 * component owns the workspace body: a two-pane split at >=768px (Brief/Runs
 * aside + Channel) and a single pane with a bottom tab bar below (Channel is
 * the mobile home surface). All colors come from the halo tokens; the theme
 * switch is the data-theme attribute.
 *
 * Session hygiene (reference lesson, P00 audit): the authenticated body is
 * KEYED by actor id, so an account switch remounts every per-user state fresh;
 * query keys carry the actor id and non-auth caches are wiped on transitions.
 */

export function Shell(): ReactElement {
	return <WorkspaceBody />;
}

function WorkspaceBody(): ReactElement {
	const auth = useAuthStatus();
	// The New project action lives in the chrome (above this body), so the
	// inline form's open state is owned here and passed down.
	const [formOpen, setFormOpen] = useState(false);
	const openForm = () => setFormOpen(true);

	if (auth.isPending) {
		return (
			<WorkspaceChrome active="brief">
				<div className="shell-loading">
					<StatePanel kind="loading" title="Checking your session…" />
				</div>
			</WorkspaceChrome>
		);
	}
	if (auth.error) {
		return (
			<WorkspaceChrome active="brief">
				<div className="shell-loading">
					<StatePanel
						kind={failureKind(auth.error)}
						detail={auth.error instanceof Error ? auth.error.message : undefined}
						onRetry={() => void auth.refetch()}
						retryLabel="Check again"
					/>
				</div>
			</WorkspaceChrome>
		);
	}
	if (!auth.data.authenticated) {
		// Unauthenticated /app shows the P01 sign-in state (composed build has
		// auth enabled; this is the real fail-closed probe, not a mock). The
		// chrome crosses the auth boundary; the hero says what Caddie is in
		// one plain sentence BEFORE asking who you are.
		return (
			<WorkspaceChrome active="brief">
				<div className="auth-hero">
					<p className="auth-hero-kicker">CADDIE · your build assistant</p>
					<h1 className="auth-hero-title">
						It reads the rules, drafts the plan, and builds it.
						<span className="auth-hero-sub">You approve every step.</span>
					</h1>
				</div>
				<div className="shell-loading">
					<section className="sign-in-card card-surface">
						<p className="kicker" data-tone="action">
							CADDIE · WORKSPACE
						</p>
						<h2 className="sign-in-title">Sign in to your workspace</h2>
						<SignInPanel callbackURL="/app/" />
					</section>
				</div>
			</WorkspaceChrome>
		);
	}
	return (
		<WorkspaceChrome active="brief" onNewProject={openForm}>
			<AuthedWorkspaceGate formOpen={formOpen} onOpenForm={openForm} onCloseForm={() => setFormOpen(false)} />
		</WorkspaceChrome>
	);
}

function AuthedWorkspaceGate(props: {
	formOpen: boolean;
	onOpenForm: () => void;
	onCloseForm: () => void;
}): ReactElement {
	const auth = useAuthStatus();
	const actor = useSessionActor(Boolean(auth.data?.authenticated));
	// Key by actor: an account switch remounts every per-user state fresh, so
	// neither channel drafts nor tab state can leak across accounts.
	return (
		<AuthedWorkspace
			key={actor.data ?? 'pending'}
			actorId={actor.data ?? null}
			formOpen={props.formOpen}
			onOpenForm={props.onOpenForm}
			onCloseForm={props.onCloseForm}
		/>
	);
}

function AuthedWorkspace(props: {
	actorId: string | null;
	formOpen: boolean;
	onOpenForm: () => void;
	onCloseForm: () => void;
}): ReactElement {
	const actor = useMemo(() => ({ actorId: props.actorId }), [props.actorId]);
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as { project?: string };
	const chrome = useWorkspaceChrome();

	const isDesktop = useIsDesktop();
	const [tab, setTab] = useState<'brief' | 'runs' | 'channel'>(isDesktop ? 'brief' : 'channel');
	const [detailOpen, setDetailOpen] = useState(true);

	const paramProject = search.project;
	const projectMissing =
		Boolean(paramProject) && chrome.projectList.length > 0 && !chrome.projectList.some((p) => p.id === paramProject);
	const effectiveProjectId = chrome.effectiveProjectId;

	// The coordinator run transport: live agent snapshot + sends for the
	// selected project's active run (null → the channel keeps its standby).
	const transport = useCoordinatorTransport(actor, effectiveProjectId);

	const runBindings = useRunBindings(actor, effectiveProjectId);
	const artifacts = useArtifacts(actor, effectiveProjectId);
	const brief = useBriefCards(actor, effectiveProjectId);
	const createProject = useCreateProject(actor);
	const channel = useChannelStore({ sessionKey: props.actorId ?? 'anon', projectId: effectiveProjectId });

	// Cross-account cache hygiene: on any auth/actor transition, wipe every
	// non-auth query so another account's rows can never be served or
	// prefetched. This body mounts only after auth+actor have settled, so the
	// guard initializes on a known identity and never wipes during load.
	const guardAuth = useAuthStatus();
	const guard = useMemo(() => watchAuthTransitions(queryClient), [queryClient]);
	useEffect(() => {
		guard.maybe(guardAuth.data?.authenticated, props.actorId);
	}, [guard, guardAuth.data?.authenticated, props.actorId, queryClient]);

	const projectsState = chrome.projectsPending
		? 'loading'
		: chrome.projectsError
			? failureKind(chrome.projectsError)
			: 'empty';
	const briefStale = chrome.projectsFetching;
	const asideHidden = tab === 'channel' || !detailOpen;

	// Board screen 06: every card carries a link into the screen it refers to.
	// The action's targetId is server-authored data — the mapping here is by
	// card kind + the evidenceIds the card itself cites, never parsed prose.
	function onCardAction(card: DecisionCardType) {
		const search = { project: effectiveProjectId ?? undefined };
		switch (card.kind) {
			case 'approval':
				void navigate({ to: '/design-review', search });
				break;
			case 'change':
				// a conflict cites claim ids; a stale artifact cites none
				if (card.evidenceIds.length > 0) {
					void navigate({ to: '/evidence', search: { ...search, claim: card.primaryAction.targetId } });
				} else {
					void navigate({ to: '/artifacts', search });
				}
				break;
			case 'deadline':
				void navigate({ to: '/schedules', search });
				break;
			case 'result':
				// the honest destination for a failed run today is the Runs lane
				void navigate({ to: '/', search });
				break;
		}
	}

	return (
		<>
			{props.formOpen ? (
				<NewProjectForm
					onCancel={props.onCloseForm}
					onSubmit={(input) =>
						createProject.mutateAsync(input).then((result) => {
							props.onCloseForm();
							chrome.selectProject(result.project.id);
						})
					}
					error={createProject.error}
					busy={createProject.isPending}
					hasProjects={chrome.projectList.length > 0}
					lastWorkspaceId={chrome.projectList[0]?.workspaceId}
				/>
			) : null}

			{/* Mobile-only context row: project switching + refresh live with the
			    content on mobile (the topbar carries 3 controls, today.ai style),
			    and the desktop header row is hidden. */}
			<div className="mobile-context-row">
				{chrome.projectsPending ? (
					<span className="mono-id">loading projects…</span>
				) : (
					<select
						className="input project-select"
						aria-label="Project"
						data-testid="project-selector-mobile"
						value={chrome.selectedProject?.id ?? ''}
						onChange={(event) => chrome.selectProject(event.target.value)}
					>
						{chrome.projectList.length === 0 ? <option value="">No projects yet</option> : null}
						{chrome.projectList.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name}
							</option>
						))}
					</select>
				)}
				<button
					type="button"
					className="icon-btn"
					title="Refresh data"
					aria-label="Refresh data"
					data-testid="refresh-data-mobile"
					onClick={chrome.refreshAll}
				>
					<Icon name="refresh" title="Refresh data" />
				</button>
				<button
					type="button"
					className="btn-key mobile-new-project"
					data-testid="new-project-mobile"
					onClick={props.onOpenForm}
				>
					New project
				</button>
			</div>

			{/* Zero projects + a clean load = the onboarding IS the workspace.
			    Any doubt (pending, offline, error, a stale ?project= param) keeps
			    the honest state panels below — onboarding never masks a failure. */}
			{!chrome.projectsPending &&
			!chrome.projectsPaused &&
			!chrome.projectsError &&
			!projectMissing &&
			chrome.projectList.length === 0 ? (
				<Start onStartIdea={props.onOpenForm} />
			) : (
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

						<div className="aside-scroll">
							{projectMissing ? (
								<StatePanel
									kind="error"
									title="That project is not in your list"
									detail="The link points at a project your account cannot see (or that no longer exists)."
									onRetry={chrome.clearProjectParam}
									retryLabel="Back to your projects"
								/>
							) : chrome.projectsPending ? (
								<StatePanel kind="loading" title="Fetching your projects…" />
							) : chrome.projectsPaused ? (
								// TanStack pauses refetches while the browser reports
								// offline — that pause IS the offline state: last loaded
								// data stays visible, and the refetch resumes on reconnect.
								<StatePanel
									kind="offline"
									title="You are offline"
									detail="Showing the last loaded data. Refetching resumes automatically when you reconnect."
								/>
							) : chrome.projectsError ? (
								<StatePanel
									kind={failureKind(chrome.projectsError)}
									detail={chrome.projectsError instanceof Error ? chrome.projectsError.message : undefined}
									onRetry={
										failureKind(chrome.projectsError) === 'denied' ? undefined : () => void queryClient.refetchQueries({ queryKey: ['projects', props.actorId] })
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
									error: chrome.projectsError,
									stale: briefStale,
									retry: () => void queryClient.refetchQueries({ queryKey: ['projects', props.actorId] }),
								}}
								cards={brief.data?.cards ?? []}
								feedPending={brief.isPending}
								feedError={brief.error}
								onAction={onCardAction}
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
								projectId={effectiveProjectId}
							/>
						)}
						</div>
					</aside>

					<Channel
						source={transport?.source ?? STANDBY}
						transportLive={transport?.hasRun === true}
						drafts={channel.drafts}
						projectId={effectiveProjectId}
						onSend={(text) => {
							const draft = channel.addDraft(text);
							if (draft && transport) {
								// admitted → the draft is superseded by the transport's own
								// message; rejected → it stays with its attempt counted
								transport.send(draft.text, draft.idempotencyKey).then(
									() => channel.discardDraft(draft.id),
									() => channel.retryDraft(draft.id),
								);
							}
						}}
						onRetryDraft={(id) => {
							channel.retryDraft(id);
							const draft: ChannelDraft | undefined = channel.drafts.find((d) => d.id === id);
							if (draft && transport) {
								// same idempotency key — the transport deduplicates anyway
								transport.send(draft.text, draft.idempotencyKey).then(
									() => channel.discardDraft(id),
									() => {},
								);
							}
						}}
						onDiscardDraft={channel.discardDraft}
					/>
				</div>
			)}

			<nav className="bottom-nav" aria-label="Workspace panes">
				<button
					type="button"
					className="tab-btn"
					aria-selected={tab === 'brief'}
					data-testid="tab-brief-mobile"
					onClick={() => setTab('brief')}
				>
					<Icon name="doc" title="" />
					Brief
				</button>
				<button
					type="button"
					className="tab-btn"
					aria-selected={tab === 'runs'}
					data-testid="tab-runs-mobile"
					onClick={() => setTab('runs')}
				>
					<Icon name="box" title="" />
					Runs
				</button>
				<button
					type="button"
					className="tab-btn"
					aria-selected={tab === 'channel'}
					data-testid="tab-channel-mobile"
					onClick={() => setTab('channel')}
				>
					<Icon name="sparkCheck" title="" />
					Channel
				</button>
				<Link to="/discovery" className="tab-btn" data-testid="nav-discovery-mobile" search={(prev: Record<string, unknown>) => ({ ...prev })}>
					<Icon name="target" title="" />
					Discovery
				</Link>
				<Link to="/schedules" className="tab-btn" data-testid="nav-schedules-mobile" search={(prev: Record<string, unknown>) => ({ ...prev })}>
					<Icon name="calendar" title="" />
					Schedules
				</Link>
			</nav>
		</>
	);
}

function useIsDesktop(): boolean {
	const [matches, setMatches] = useState(
		() => typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
	);
	useMediaQueryEffect('(min-width: 768px)', setMatches);
	return matches;
}

function useMediaQueryEffect(query: string, onChange: (matches: boolean) => void): void {
	const [mq] = useState(() => window.matchMedia(query));
	useEffect(() => {
		const handler = () => onChange(mq.matches);
		mq.addEventListener('change', handler);
		window.addEventListener('resize', handler);
		return () => {
			mq.removeEventListener('change', handler);
			window.removeEventListener('resize', handler);
		};
	}, [mq, onChange]);
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