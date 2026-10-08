/**
 * WorkspaceChrome — the discovery-first two-panel shell.
 *
 * This replaces the old full-width header + nav-row chrome. The product
 * direction (2026-10-08 discovery-first redesign) exposes exactly three global
 * destinations — Home · Discover · Projects — and keeps ONE persistent Caddie
 * conversation on the right across Home, Discover, Projects and every project
 * surface. There are no global tabs for Chat/Decisions/Build/Ship/Evidence.
 *
 * Layout (per the layout clarification + desktop shell update):
 *   - Desktop (>=768px): two panels, independent scroll. Left = all navigable
 *     content with a floating rounded navigation capsule (Home · Discover ·
 *     Projects) plus compact Search and Account controls; page titles/identity
 *     render in the left content below the capsule. Right = the persistent
 *     conversation with a compact, explicit context label.
 *   - Mobile (<768px): the floating rounded bottom-nav (preserved aesthetics),
 *     three destinations, composer directly above it. The conversation is the
 *     "channel" pane (?pane=channel) shown full-height; otherwise the route
 *     content shows. The composer always targets the active scope.
 *
 * Conversation scoping (the safety-critical part): the conversation binds to
 * a project run. On the GLOBAL routes (Home/Discover/Projects/account surfaces)
 * it binds to the actor's Home project — the account-level, project-less scope
 * that already exists server-side (kind='home', build/gate-less) — so browsing
 * or asking a discovery question can NEVER retarget an unrelated build project.
 * On a PROJECT route it binds to the resolved selected project. Drafts and the
 * run transport key off the conversation scope id, so switching scope cannot
 * leak a draft or a run across contexts.
 *
 * Unauthenticated: the shell still crosses the boundary — the wordmark, a theme
 * control and a route back to the landing remain visible at the sign-in wall,
 * and the conversation/capsule are not rendered (no scope to bind).
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Project } from '@caddie/contracts';
import { authClient } from '../auth.ts';
import { Icon } from '../icons.tsx';
import { Composer } from '../conversation/Composer.tsx';
import { Channel } from '../conversation/Channel.tsx';
import { useChannelStore, standbySource as STANDBY, type ChannelDraft } from '../conversation/channel-store.ts';
import { useCoordinatorTransport, type CoordinatorTransport } from '../coordinator.ts';
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

/**
 * The three global destinations (Home · Discover · Projects) plus the two
 * secondary controls that live in the capsule (Search, Account). There is
 * deliberately NO nav entry for Chat/Decisions/Plan/Build/Ship/Evidence —
 * those are reached from within a project. `project` marks a project-scoped
 * route (its content renders in the left panel while the conversation binds to
 * the selected project); `account` marks account surfaces (Settings/Search/
 * Onboarding) that keep the general conversation.
 */
export type WorkspaceNavId = 'home' | 'discover' | 'projects' | 'project' | 'account' | 'none';

const NAV: ReadonlyArray<{ id: WorkspaceNavId; label: string; to: string; testid: string; title: string }> = [
	{ id: 'home', label: 'Home', to: '/', testid: 'nav-home', title: 'Your brief — what Caddie needs from you and what it found' },
	{ id: 'discover', label: 'Discover', to: '/discover', testid: 'nav-discover', title: 'Hackathons and opportunities that fit you' },
	{ id: 'projects', label: 'Projects', to: '/projects', testid: 'nav-projects', title: 'Your projects and where to start a new one' },
];

/** Conversation context classification for the shell. */
type ConversationKind = 'general' | 'project' | 'none';

interface WorkspaceChromeContextValue {
	actorId: string | null;
	authenticated: boolean;
	projectList: Project[];
	/** Build projects only (the Home project is excluded from the list). */
	buildProjects: Project[];
	selectedProject: Project | null;
	/** The actor's account-level Home project (may be null while loading). */
	homeProject: Project | null;
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
	/** Which scope the persistent conversation is bound to. */
	conversation: {
		kind: ConversationKind;
		projectId: string | null;
		label: string;
		/** True while the general (home) scope is still resolving. */
		resolving: boolean;
	};
	/** Mobile: is the conversation shown full-height instead of route content? */
	mobileConversation: boolean;
	setMobileConversation: (open: boolean) => void;
	isDesktop: boolean;
	/** The channel store + run transport, bound to the conversation scope. */
	channel: {
		drafts: readonly ChannelDraft[];
		addDraft: (text: string) => ChannelDraft | null;
		retryDraft: (id: string) => void;
		discardDraft: (id: string) => void;
		resolveDraft: (id: string) => void;
	};
	transport: CoordinatorTransport | null;
	sendText: (text: string) => void;
	openProject: (projectId: string) => void;
	/** Start a new project: route to the idea-first onboarding flow. */
	newProject: () => void;
	/** Move between a project's local tabs, keeping the ?project= binding so the
	 *  conversation never retargets to a different project. */
	goProjectTab: (path: string, search: Record<string, unknown>) => void;
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
	/** Which global destination this route is — controls aria-current + scope. */
	nav: WorkspaceNavId;
	/** Breadcrumb slot, rendered under the capsule inside the left panel. */
	crumbs?: ReactNode;
	/** New project handler; defaults to returning to the workspace. */
	onNewProject?: () => void;
	/** Optional contextual action rendered beside the page title slot. */
	children: ReactNode;
}

export function WorkspaceChrome(props: WorkspaceChromeProps): ReactElement {
	const auth = useAuthStatus();
	const actor = useSessionActor(Boolean(auth.data?.authenticated));
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as { project?: string; pane?: string };
	const actorId = actor.data ?? null;
	const actorMemo = useMemo(() => ({ actorId }), [actorId]);

	const projects = useProjects(actorMemo);
	const displayName = useSessionDisplayName();
	const [theme, setTheme] = useState<'light' | 'dark'>(currentTheme);
	const [accountOpen, setAccountOpen] = useState(false);
	const isDesktop = useIsDesktop();

	const projectList: Project[] = projects.data?.projects ?? [];
	const buildProjects = useMemo(() => projectList.filter((p) => p.kind !== 'home'), [projectList]);
	const paramProject = search.project;

	// The Home project is the account scope. Resolve it as soon as the session
	// is authenticated (created server-side on first fetch), independent of
	// whether the actor has any build project — that's what lets Discover and the
	// general conversation exist with zero projects.
	const home = useHomeProject(actorMemo, Boolean(auth.data?.authenticated));
	const homeProject =
		projectList.find((project) => project.kind === 'home') ?? home.data?.project ?? null;

	// The selected BUILD project (data + project-scope conversation). The Home
	// project is never the "selected project" for build surfaces. A ?project=
	// that names a hidden/deleted id is a missing project, not a fallback cue.
	const selectedProject =
		(paramProject
			? projectList.find((project) => project.id === paramProject && project.kind !== 'home')
			: undefined) ??
		(paramProject ? null : buildProjects[0] ?? null);
	const projectMissing = Boolean(paramProject) && projectList.length > 0 && !selectedProject;
	const effectiveProjectId = projectMissing ? null : (selectedProject?.id ?? null);

	// Conversation scope — the safety-critical decision.
	const conversationKind: ConversationKind =
		!auth.data?.authenticated || props.nav === 'none'
			? 'none'
			: props.nav === 'project'
				? 'project'
				: 'general';
	const conversationProjectId =
		conversationKind === 'project'
			? effectiveProjectId
			: conversationKind === 'general'
				? (homeProject?.id ?? null)
				: null;
	const conversationLabel =
		conversationKind === 'project'
			? (selectedProject?.name ?? 'Project')
			: conversationKind === 'general'
				? 'General'
				: 'No conversation';
	const conversationResolving =
		conversationKind === 'general' && homeProject === null && !projects.error;

	// Mobile: the conversation is the home — the channel pane shows full-height
	// by default (owner direction: Home IS Chat), and the brief is the second
	// tab. On other routes the conversation opens on demand (?pane=channel).
	const mobileConversation =
		search.pane === 'channel' || (!isDesktop && props.nav === 'home' && search.pane === undefined);
	const setMobileConversation = (open: boolean) => {
		const nextPane: 'channel' | 'brief' | undefined = open ? 'channel' : props.nav === 'home' ? 'brief' : undefined;
		void navigate({
			to: '.',
			search: (prev: Record<string, unknown>) => ({
				...prev,
				pane: nextPane,
			}),
		});
	};

	// The channel store + run transport bind to the CONVERSATION scope (not the
	// selected build project), so global-route composer traffic stays on the
	// home/general conversation and can never retarget an unrelated project.
	const channel = useChannelStore({
		sessionKey: actorId ?? 'anon',
		projectId: conversationProjectId,
	});
	const transport = useCoordinatorTransport(actorMemo, conversationProjectId);
	const live =
		transport?.source.status === 'connecting' ||
		transport?.source.status === 'submitted' ||
		transport?.source.status === 'streaming';

	function sendText(text: string) {
		const draft = channel.addDraft(text);
		if (draft && transport) {
			transport.send(draft.text, draft.idempotencyKey).then(
				() => channel.resolveDraft(draft.id),
				() => channel.retryDraft(draft.id),
			);
		}
		// On mobile, jump to the conversation so the sent message and its reply
		// are actually visible (the composer rides every route, but the
		// transcript only shows in the channel pane).
		if (!isDesktop && conversationKind !== 'none') setMobileConversation(true);
	}

	// Home is created server-side on first fetch; refresh the list once so the
	// Projects surface shows it without a manual reload.
	useEffect(() => {
		if (home.data?.project && projectList.length > 0 && !projectList.some((p) => p.id === home.data!.project.id)) {
			void queryClient.invalidateQueries({ queryKey: ['projects', actorId] });
		}
	}, [home.data, projectList, queryClient, actorId]);

	const authenticated = Boolean(auth.data?.authenticated);

	function selectProject(projectId: string) {
		void navigate({
			to: '.',
			search: (prev: Record<string, unknown>) => ({
				...prev,
				project: projectId === '' ? undefined : projectId,
			}),
		});
	}

	function openProject(projectId: string) {
		void navigate({ to: '/project', search: { project: projectId } as Record<string, unknown> });
	}

	function newProject() {
		void navigate({ to: '/onboarding' });
	}

	function goProjectTab(path: string, tabSearch: Record<string, unknown>) {
		void navigate({ to: path as never, search: tabSearch as never });
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
		void queryClient.invalidateQueries({ queryKey: ['home-project', actorId] });
		void queryClient.invalidateQueries({ queryKey: ['discovery-candidates', actorId] });
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
		buildProjects,
		selectedProject,
		homeProject,
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
		conversation: {
			kind: conversationKind,
			projectId: conversationProjectId,
			label: conversationLabel,
			resolving: conversationResolving,
		},
		mobileConversation,
		setMobileConversation,
		isDesktop,
		channel,
		transport,
		sendText,
		openProject,
		newProject,
		goProjectTab,
	};

	return (
		<WorkspaceChromeContext.Provider value={context}>
			<div className="shell app-shell" data-testid="shell">
				<a className="skip-link" href="#main">
					Skip to content
				</a>
				<div className="app-split">
{/* ---------------- LEFT PANEL: capsule nav + content ---------------- */}
						<section className="shell-left" data-testid="shell-left" aria-label="Caddie content">
							{authenticated ? (
								isDesktop ? (
									<NavCapsule
										nav={props.nav}
										accountOpen={accountOpen}
										setAccountOpen={setAccountOpen}
										displayName={displayName.data ?? null}
									/>
								) : (
									<MobileHeader
										nav={props.nav}
										accountOpen={accountOpen}
										setAccountOpen={setAccountOpen}
										displayName={displayName.data ?? null}
									/>
								)
							) : (
								<header className="capsule-nav-unauth">
									<Link to="/" className="capsule-wordmark" data-testid="wordmark" search={keepSearch}>
										CADDIE<b>·</b>
									</Link>
									<span className="capsule-spacer" />
									<button
										type="button"
										className="capsule-icon"
										title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
										aria-label="Toggle theme"
										data-testid="theme-toggle"
										onClick={toggleTheme}
									>
										{theme === 'dark' ? <Icon name="sun" title="Switch to light theme" /> : <Icon name="moon" title="Switch to dark theme" />}
									</button>
									<Link to="/" className="capsule-tab" data-testid="back-to-landing" search={() => ({})}>
										<Icon name="arrowLeft" title="back to the landing page" /> Landing
									</Link>
								</header>
							)}
						{props.crumbs ? (
							<div className="crumbs" data-testid="breadcrumb">
								{props.crumbs}
							</div>
						) : null}
						<main id="main" className="shell-main" data-hidden={conversationKind !== 'none' && mobileConversation && !isDesktop}>
							{props.children}
						</main>
					</section>

					{/* ---------------- RIGHT PANEL: persistent conversation ---------------- */}
					{conversationKind !== 'none' ? (
					<aside
						className="shell-right"
						data-testid="conversation-panel"
						data-open={mobileConversation && !isDesktop ? 'true' : 'false'}
						aria-label="Caddie conversation"
					>
							{/* Floating conversation head — Today-inspired but our own: a slim
						    left-aligned row over the transcript. The Caddie mark sits
						    top-left at chip size; the pill beside it is the conversation
						    scope (General = the account-level chat; a project name inside
						    a project). Mobile gets the Search/Account chips on the right. */}
							<div className="conv-head-float" data-testid="conv-context" data-scope={conversationKind}>
								<span className="conv-head-left">
									<span className="conv-avatar" aria-hidden="true">
										C
									</span>
									<span className="conv-name-pill" data-testid="conv-context-label" title="The conversation you are in — General is your account-level chat with Caddie">
										{conversationLabel}
									</span>
								</span>
								{!isDesktop ? (
									<span className="conv-head-chips">
										<Link to="/search" className="conv-chip" data-testid="conv-search" title="Search" search={keepSearch}>
											<Icon name="search" title="Search" />
										</Link>
										<AccountMenu accountOpen={accountOpen} setAccountOpen={setAccountOpen} displayName={displayName.data ?? null} />
									</span>
								) : null}
							</div>
							<Channel
								source={transport?.source ?? STANDBY}
								transportLive={transport?.hasRun === true}
								drafts={channel.drafts}
								projectId={conversationProjectId}
								composerHidden={!isDesktop}
								resolving={conversationResolving}
								onSend={sendText}
								onRetryDraft={(id) => {
									channel.retryDraft(id);
									const draft: ChannelDraft | undefined = channel.drafts.find((d) => d.id === id);
									if (draft && transport) {
										transport.send(draft.text, draft.idempotencyKey).then(
											() => channel.resolveDraft(id),
											() => {},
										);
									}
								}}
								onDiscardDraft={channel.discardDraft}
							/>
						</aside>
					) : null}
				</div>

				{/* ---------------- MOBILE floating bottom nav + composer ----------------
				    Desktop renders its composer inside the persistent right-panel
				    Channel, so the bottom nav (with its own composer) is mobile-only —
				    rendering both would duplicate composer-input in the desktop DOM. */}
				{authenticated && !isDesktop ? (
					<MobileNav
						nav={props.nav}
						sendText={sendText}
						live={live}
						conversationOpen={mobileConversation}
						conversationKind={conversationKind}
						resolving={conversationResolving}
					/>
				) : null}
			</div>
		</WorkspaceChromeContext.Provider>
	);
}

const keepSearch = (prev: Record<string, unknown>) => ({ ...prev });

/** The desktop floating navigation capsule: wordmark + the three global
 *  destinations + Search, theme and Account, all in one rounded container
 *  that sticks inside the left panel. */
function NavCapsule(props: {
	nav: WorkspaceNavId;
	accountOpen: boolean;
	setAccountOpen: (open: boolean) => void;
	displayName: string | null;
}): ReactElement {
	const { theme, toggleTheme } = useWorkspaceChrome();
	return (
		<nav className="nav-capsule" aria-label="Primary" data-testid="nav-capsule">
			<Link to="/" className="capsule-wordmark" data-testid="wordmark" search={keepSearch}>
				CADDIE<b>·</b>
			</Link>
			<span className="capsule-divider" aria-hidden="true" />
			{NAV.map((item) => (
				<Link
					key={item.id}
					to={item.to}
					className="capsule-tab"
					data-testid={item.testid}
					title={item.title}
					aria-current={props.nav === item.id ? 'page' : undefined}
					search={keepSearch}
				>
					{item.label}
				</Link>
			))}
			<span className="capsule-spacer" />
			<Link
				to="/search"
				className="capsule-icon"
				data-testid="nav-search"
				title="Search your projects, plans, tasks and memory"
				search={keepSearch}
			>
				<Icon name="search" title="Search" />
			</Link>
			<button
				type="button"
				className="capsule-icon"
				title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
				aria-label="Toggle theme"
				data-testid="theme-toggle"
				onClick={toggleTheme}
			>
				{theme === 'dark' ? <Icon name="sun" title="Switch to light theme" /> : <Icon name="moon" title="Switch to dark theme" />}
			</button>
			<AccountMenu accountOpen={props.accountOpen} setAccountOpen={props.setAccountOpen} displayName={props.displayName} />
		</nav>
	);
}

/**
 * The mobile page-aware header (owner direction): identity on the left —
 * "Caddie" on Home, the page name on every other destination — and the
 * global actions (Search, Account) on the right. The capsule's three tabs
 * are not repeated here: the bottom bar owns navigation on mobile.
 */
function MobileHeader(props: {
	nav: WorkspaceNavId;
	accountOpen: boolean;
	setAccountOpen: (open: boolean) => void;
	displayName: string | null;
}): ReactElement {
	const location = useLocation();
	const chrome = useWorkspaceChrome();
	let identity = 'Caddie';
	if (props.nav === 'home') {
		// Home IS the conversation on mobile; the brief is its own tab.
		identity = chrome.mobileConversation ? 'Caddie' : 'Brief';
	} else if (props.nav === 'discover') identity = 'Discover';
	else if (props.nav === 'projects') identity = 'Projects';
	else if (props.nav === 'project') identity = chrome.selectedProject?.name ?? 'Project';
	else if (props.nav === 'account') {
		const path = location.pathname;
		if (path.endsWith('/search')) identity = 'Search';
		else if (path.endsWith('/usage')) identity = 'Usage & budget';
		else if (path.endsWith('/automations')) identity = 'Automations';
		else if (path.endsWith('/onboarding')) identity = 'Start';
		else identity = 'Settings';
	}

	// One page-relevant action on the right, per destination (owner direction:
	// the header is page-aware, so it earns its space): refresh on the Brief
	// and Discover, "New project" on Projects. Search lives in the Account
	// menu now (stable fallback), and the avatar itself stays.
	let action: ReactElement | null = null;
	if (props.nav === 'home' && !chrome.mobileConversation) {
		action = (
			<button type="button" className="mobile-header-action" data-testid="mobile-action-refresh" title="Refresh the brief" onClick={chrome.refreshAll}>
				<Icon name="refresh" title="Refresh the brief" />
			</button>
		);
	} else if (props.nav === 'discover') {
		action = (
			<button type="button" className="mobile-header-action" data-testid="mobile-action-refresh" title="Refresh the feed" onClick={chrome.refreshAll}>
				<Icon name="refresh" title="Refresh the feed" />
			</button>
		);
	} else if (props.nav === 'projects') {
		action = (
			<button type="button" className="mobile-header-action mobile-action-new" data-testid="mobile-action-new" title="Start a new project" onClick={chrome.newProject}>
				<Icon name="plus" title="Start a new project" />
			</button>
		);
	}

	return (
		<header className="mobile-header" data-testid="mobile-header">
			{identity === 'Caddie' ? (
				<Link to="/" className="mobile-header-brand" data-testid="wordmark" search={keepSearch}>
					Caddie<b>·</b>
				</Link>
			) : (
				<span className="mobile-header-title" data-testid="mobile-header-title">
					{identity}
				</span>
			)}
			<span className="mobile-header-spacer" />
			{action}
			<AccountMenu accountOpen={props.accountOpen} setAccountOpen={props.setAccountOpen} displayName={props.displayName} />
		</header>
	);
}

/** Avatar + the account menu (Profile, Memory, Connections, Automations,
 *  Usage, Settings, theme, Sign out) — shared by the desktop capsule and the
 *  mobile header. */
function AccountMenu(props: {
	accountOpen: boolean;
	setAccountOpen: (open: boolean) => void;
	displayName: string | null;
}): ReactElement {
	const { signOut, theme, toggleTheme } = useWorkspaceChrome();
	return (
		<div
			className="account-menu"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node)) props.setAccountOpen(false);
			}}
		>
			<button
				type="button"
				className="avatar-btn"
				aria-label="Account"
				aria-expanded={props.accountOpen}
				data-testid="account-menu"
				title={props.displayName ?? 'Account'}
				onClick={() => props.setAccountOpen(!props.accountOpen)}
			>
				{props.displayName ? (
					<span className="avatar-initial">{props.displayName.trim()[0]!.toUpperCase()}</span>
				) : (
					<Icon name="user" title="Account" />
				)}
			</button>
			{props.accountOpen ? (
				<div className="account-menu-pop" role="menu" data-testid="account-menu-pop">
					<Link to="/search" search={keepSearch} role="menuitem" data-testid="account-search" onClick={() => props.setAccountOpen(false)}>
						<Icon name="search" title="Search" /> Search
					</Link>
					<Link to="/settings" search={keepSearch} role="menuitem" data-testid="account-profile" onClick={() => props.setAccountOpen(false)}>
						<Icon name="user" title="Profile" /> Profile &amp; preferences
					</Link>
					<Link to="/settings" search={{ section: 'memory' } as Record<string, unknown>} role="menuitem" data-testid="account-memory" onClick={() => props.setAccountOpen(false)}>
						<Icon name="doc" title="Memory" /> What Caddie remembers
					</Link>
					<Link to="/settings" search={{ section: 'connections' } as Record<string, unknown>} role="menuitem" data-testid="account-connections" onClick={() => props.setAccountOpen(false)}>
						<Icon name="link" title="Connections" /> Connections
					</Link>
					<Link to="/automations" search={keepSearch} role="menuitem" data-testid="account-automations" onClick={() => props.setAccountOpen(false)}>
						<Icon name="calendar" title="Automations" /> Automations
					</Link>
					<Link to="/usage" search={keepSearch} role="menuitem" data-testid="account-usage" onClick={() => props.setAccountOpen(false)}>
						<Icon name="box" title="Usage" /> Usage &amp; budget
					</Link>
					<Link to="/settings" search={{ section: 'settings' } as Record<string, unknown>} role="menuitem" data-testid="account-settings" onClick={() => props.setAccountOpen(false)}>
						<Icon name="doc" title="Settings" /> Settings
					</Link>
					<button type="button" role="menuitem" data-testid="theme-menu-item" onClick={toggleTheme}>
						{theme === 'dark' ? <Icon name="sun" title="Switch to light theme" /> : <Icon name="moon" title="Switch to dark theme" />}
						{theme === 'dark' ? 'Light theme' : 'Dark theme'}
					</button>
					<button type="button" role="menuitem" data-testid="sign-out" onClick={() => void signOut()}>
						<Icon name="arrowLeft" title="Sign out" /> Sign out
					</button>
				</div>
			) : null}
		</div>
	);
}

/**
 * The mobile bottom nav (today.ai grammar, preserved): one floating rounded
 * container with the composer directly above a row of THREE destinations —
 * Home · Discover · Projects. The input rides every route (the current
 * clarification supersedes the older five-tab / chat-slot design). The
 * conversation on mobile is reached from the composer (which opens the channel
 * pane) or by tapping the current destination's context; nothing here creates a
 * global Chat/Build tab.
 */
function MobileNav(props: {
	nav: WorkspaceNavId;
	sendText: (text: string) => void;
	live: boolean;
	conversationOpen: boolean;
	conversationKind: ConversationKind;
	resolving: boolean;
}): ReactElement {
	const onDiscover = props.nav === 'discover';
	const onProjects = props.nav === 'projects';
	// The conversation IS the mobile home: the Chat tab is current whenever
	// the channel pane is open; the Brief tab owns the home's left content.
	const chatOpen = props.conversationOpen && props.conversationKind !== 'none';
	const briefActive = props.nav === 'home' && !chatOpen;
	const disabled = props.live || props.conversationKind === 'none' || props.resolving;
	const disabledReason = props.live
		? 'A run is working — wait for it to settle.'
		: props.resolving
			? 'Connecting your assistant…'
			: props.conversationKind === 'none'
				? 'No conversation here.'
				: undefined;

	return (
		<nav className="bottom-nav" aria-label="Primary" data-testid="bottom-nav">
			<div className="bottom-nav-composer">
				<Composer
					onSend={props.sendText}
					disabled={disabled}
					disabledReason={disabledReason}
					placeholder={onDiscover ? 'Ask Caddie about these hackathons…' : 'Message Caddie…'}
				/>
			</div>
			<div className="bottom-nav-row">
				<Link
					to="/"
					className="tab-btn"
					data-testid="tab-chat-mobile"
					aria-current={chatOpen ? 'page' : undefined}
					search={(prev: Record<string, unknown>) => ({ ...prev, pane: 'channel' as const })}
				>
					<Icon name="chat" title="" />
					Chat
				</Link>
				<Link
					to="/"
					className="tab-btn"
					data-testid="tab-brief-mobile"
					aria-current={briefActive ? 'page' : undefined}
					search={(prev: Record<string, unknown>) => ({ ...prev, pane: 'brief' as const })}
				>
					<Icon name="doc" title="" />
					Brief
				</Link>
				<Link
					to="/discover"
					className="tab-btn"
					data-testid="nav-discover-mobile"
					aria-current={onDiscover ? 'page' : undefined}
					search={keepSearch}
				>
					<Icon name="target" title="" />
					Discover
				</Link>
				<Link
					to="/projects"
					className="tab-btn"
					data-testid="nav-projects-mobile"
					aria-current={onProjects ? 'page' : undefined}
					search={keepSearch}
				>
					<Icon name="box" title="" />
					Projects
				</Link>
			</div>
		</nav>
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
