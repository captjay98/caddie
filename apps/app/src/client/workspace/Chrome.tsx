/**
 * WorkspaceChrome — the brief-first two-panel shell (approved navigation,
 * 2026-10-09).
 *
 * This replaces the old full-width header + nav-row chrome. Exactly three
 * global destinations — Brief · Discover · Projects — and ONE persistent
 * Caddie conversation on the right. The same root `/` renders Chat on mobile
 * (the default tab) and Brief beside the persistent conversation on desktop.
 * There are no global tabs for Chat/Build/Ship/Evidence.
 *
 * Layout (three bands, authoritative in workspace.css — mobile ≤760 / tablet
 * 761–1080 / desktop ≥1081; the two-panel split fires at `@media (min-width:
 * 1081px)` so the content column never drops under ~520px):
 *   - Desktop (>=1081px): two panels, independent scroll. Left = all navigable
 *     content with a floating rounded navigation capsule (Brief · Discover ·
 *     Projects) plus compact Search and Account controls. Right = the
 *     persistent conversation with a compact, explicit context label.
 *   - Tablet (761–1080px): single content column; Caddie opens as a right
 *     overlay (min(420px,100vw) + scrim) from the top-bar button.
 *   - Mobile (<=760px): the floating rounded bottom-nav (preserved aesthetics),
 *     four destinations Chat · Brief · Discover · Projects, composer directly
 *     above it. Chat is the initial default (the conversation full-height);
 *     Brief is the second tab.
 *
 * Read/badge semantics: the account brief (`GET /api/brief`, every authorised
 * project) feeds the unseen badge on the Brief entries and the compact urgent
 * notice in Chat. Read state is per-actor and NEVER resolves work: opening
 * Brief does not mark anything read; a card is marked read by its explicit
 * action or "mark all read".
 *
 * Restoration precedence: explicit deep link / current URL > restored
 * destination for this actor (sessionStorage, global destinations only,
 * project params validated) > platform default (mobile Chat, desktop Brief +
 * Chat). Account switching clears restored state because the key carries the
 * actor id.
 *
 * Conversation scoping (the safety-critical part): the conversation binds to
 * a project run. On the GLOBAL routes (Brief/Discover/Projects/account
 * surfaces) it binds to the actor's Home project — the account-level,
 * project-less scope that already exists server-side (kind='home',
 * build/gate-less). On a PROJECT route it binds to the resolved selected
 * project. Drafts and the run transport key off the conversation scope id,
 * and the run is created lazily on the FIRST send — opening a tab never
 * starts a paid run.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { DecisionCard as DecisionCardType, Project } from '@caddie/contracts';
import { authClient, SignInPanel } from '../auth.ts';
import { Icon } from '../icons.tsx';
import { Composer } from '../conversation/Composer.tsx';
import { Channel } from '../conversation/Channel.tsx';
import { useChannelStore, standbySource as STANDBY, type ChannelDraft } from '../conversation/channel-store.ts';
import { useCoordinatorTransport, type CoordinatorTransport } from '../coordinator.ts';
import { briefActionRoute } from '../brief/navigate.ts';
import { ConvResizeHandle, useConvWidth } from './ConvResize.tsx';
import { AskBar } from './AskBar.tsx';
import { ThemePicker } from './ThemePicker.tsx';
import { QuickSearch, useQuickSearchHotkey } from '../search/QuickSearch.tsx';
import { Mascot, type MascotMood } from '@caddie/ui/Mascot';
import { WORDS } from '../copy.ts';
import { sessionShareStorage, takeSharedDraft } from '../share-target.ts';
import { StatePanel, failureKind } from '../states.tsx';
import { applyTheme, browserStorage, currentTheme, saveThemeChoice, type Palette, type ThemeChoice, type ThemeMode } from '../theme.ts';
import {
	useAccountBrief,
	useAuthStatus,
	useHomeProject,
	useMarkBriefRead,
	useProjects,
	useSessionActor,
	useSessionDisplayName,
	useSessionEmail,
} from '../queries.ts';

/** Re-exported for existing importers; the theme module owns both keys. */
export { THEME_KEY, PALETTE_KEY } from '../theme.ts';

/**
 * The v2 shell breakpoints (HANDOFF §3.1). The two-panel threshold moved from
 * 768px to 1081px so the content column never drops under 520px; 761–1080 is a
 * tablet band where Caddie opens as a right overlay from a top-bar button.
 */
export type ViewportMode = 'mobile' | 'tablet' | 'desktop';

const CONV_OPEN_KEY = 'caddie:conv-open';

function loadConvOpen(): boolean {
	try {
		return localStorage.getItem(CONV_OPEN_KEY) !== '0';
	} catch {
		return true;
	}
}

function saveConvOpen(open: boolean): void {
	try {
		localStorage.setItem(CONV_OPEN_KEY, open ? '1' : '0');
	} catch {
		// private mode: open/closed stays session-only
	}
}

/**
 * The three global destinations (Brief · Discover · Projects) plus the two
 * secondary controls that live in the capsule (Search, Account). There is
 * deliberately NO nav entry for Chat/Plan/Build/Ship/Evidence — Chat IS the
 * persistent conversation (mobile default tab, desktop right panel) and the
 * project-local surfaces are reached from within a project. `project` marks a
 * project-scoped route (its content renders in the left panel while the
 * conversation binds to the selected project); `account` marks account
 * surfaces (Settings/Search/Onboarding) that keep the general conversation.
 */
export type WorkspaceNavId = 'brief' | 'discover' | 'projects' | 'project' | 'account' | 'none';

const NAV: ReadonlyArray<{ id: WorkspaceNavId; label: string; to: string; testid: string; title: string }> = [
	{ id: 'brief', label: 'Brief', to: '/', testid: 'nav-brief', title: 'Updates and decisions across your projects' },
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
	/** Flip the mode (dark <-> light), keeping the palette. */
	toggleTheme: () => void;
	/** The current MODE. Kept as `theme` for the existing toggle call sites. */
	theme: ThemeMode;
	/** The current palette (Caddie, Clearcut, Onesecos, Farmhand). */
	palette: Palette;
	/** Pick a palette and/or mode explicitly; only the part that changed is saved. */
	setThemeChoice: (next: Partial<ThemeChoice>) => void;
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
	/** The v2 viewport band: mobile (≤760) / tablet overlay (761–1080) / desktop two-panel (≥1081). */
	viewportMode: ViewportMode;
	/** The Caddie panel visibility for the CURRENT mode (excludes full-screen). */
	convVisible: boolean;
	/** Tablet: toggle the Caddie overlay from the top-bar button. */
	toggleConvOverlay: () => void;
	/** Desktop: close/reopen the persistent panel (closed = the 64px rail). */
	setConvOpen: (open: boolean) => void;
	/** The resizable panel width (desktop); `resetConvWidth` backs Settings › Appearance. */
	convWidth: { reset: () => void; frac: number };
	/** Caddie's current character mood, from real state only (U03). */
	caddieMood: MascotMood;
	/** The channel store + run transport, bound to the conversation scope. */
	channel: {
		drafts: readonly ChannelDraft[];
		addDraft: (text: string) => ChannelDraft | null;
		retryDraft: (id: string) => void;
		discardDraft: (id: string) => void;
		resolveDraft: (id: string) => void;
		/** Unsent typing, scoped actor+conversation, survives navigation (F01). */
		composerText: string;
		setComposerText: (text: string) => void;
	};
	transport: CoordinatorTransport | null;
	sendText: (text: string, attachments?: readonly import('@caddie/contracts').InputAttachment[]) => void;
	openProject: (projectId: string, showChat?: boolean) => void;
	/** Start a new project in the account conversation; onboarding is account setup. */
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
	const sessionEmail = useSessionEmail();
	const [themeChoice, setThemeChoiceState] = useState<ThemeChoice>(() => currentTheme());
	const theme = themeChoice.mode;
	const [accountOpen, setAccountOpen] = useState(false);
	const [quickSearchOpen, setQuickSearchOpen] = useState(false);
	const [startingProject, setStartingProject] = useState(false);
	useEffect(() => setStartingProject(false), [actorId]);
	const openQuickSearch = () => setQuickSearchOpen(true);
	useQuickSearchHotkey(openQuickSearch);
	const { mode: viewportMode, isDesktop } = useViewportMode();

	// The account brief (approved navigation 2026-10-09): ONE shared cache
	// entry feeds the unseen badge on the Brief entries, the compact urgent
	// notice in Chat, and the Brief surface itself.
	const accountBrief = useAccountBrief(actorMemo);
	const markBriefRead = useMarkBriefRead(actorMemo);
	const unseenCount = accountBrief.data?.unseenCount ?? 0;

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
				? WORDS.everything
				: 'No conversation';
	const conversationResolving =
		conversationKind === 'general' && homeProject === null && !projects.error;

	// Conversation panel states (v2 shell, HANDOFF §3.2): open / closed rail /
	// full screen (?pane=channel), per viewport band.
	//   desktop ≥1081  persistent right panel; closed = a 64px rail (remembered)
	//   tablet 761–1080 right overlay min(420px,100vw) + scrim, from the top bar
	//   mobile ≤760    the conversation IS the Chat tab (pane semantics, kept)
	const chatFull = search.pane === 'channel';

	// Mobile: Chat is the default tab — the conversation shows full-height on
	// `/` by default; the Brief tab is the second destination (?pane=brief).
	// On other routes the conversation opens on demand (?pane=channel).
	const mobileConversation =
		viewportMode === 'mobile' &&
		(search.pane === 'channel' || (props.nav === 'brief' && search.pane === undefined));
	const setMobileConversation = (open: boolean) => {
		const nextPane: 'channel' | 'brief' | undefined = open ? 'channel' : props.nav === 'brief' ? 'brief' : undefined;
		void navigate({
			to: '.',
			search: (prev: Record<string, unknown>) => ({
				...prev,
				pane: nextPane,
			}),
		});
	};

	// Desktop: the persistent panel's open/closed is remembered per browser.
	const [convOpen, setConvOpenState] = useState(loadConvOpen);
	const setConvOpen = (open: boolean) => {
		setConvOpenState(open);
		saveConvOpen(open);
	};

	// Tablet: the overlay is a transient choice (the button in the top bar).
	const [tabletOpen, setTabletOpen] = useState(false);
	const toggleConvOverlay = () => setTabletOpen((open) => !open);

	// Esc closes the tablet overlay (the scrim click does the same).
	useEffect(() => {
		if (viewportMode !== 'tablet' || !tabletOpen) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape') setTabletOpen(false);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [viewportMode, tabletOpen]);

	// The resizable width only applies to the desktop sized column.
	const convWidth = useConvWidth(viewportMode === 'desktop');

	const convVisible =
		viewportMode === 'desktop' ? convOpen : viewportMode === 'tablet' ? tabletOpen : mobileConversation;

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

	function sendText(text: string, attachments: readonly import('@caddie/contracts').InputAttachment[] = []) {
		setStartingProject(false);
		// A message is text, attachments, or both. The draft text keeps a visible
		// label when only attachments were sent, so the optimistic row is honest.
		const draftText = text || (attachments.length ? `(${attachments.length} attachment${attachments.length === 1 ? '' : 's'})` : '');
		const draft = channel.addDraft(draftText);
		if (draft && transport) {
			// The transport carries attachments alongside the text when its send
			// accepts them (Flue message parts); the idempotency key still guards
			// against a double-submit. Attachments ride as the third argument.
			const send = transport.send as (
				text: string,
				key: string,
				opts?: { attachments?: readonly import('@caddie/contracts').InputAttachment[] },
			) => Promise<unknown>;
			send(text, draft.idempotencyKey, attachments.length ? { attachments } : undefined).then(
				() => channel.resolveDraft(draft.id),
				() => channel.retryDraft(draft.id),
			);
		}
		// On mobile, jump to the conversation so the sent message and its reply
		// are actually visible (the composer rides every route, but the
		// transcript only shows in the channel pane).
		if (viewportMode === 'mobile' && conversationKind !== 'none') setMobileConversation(true);
	}

	// Home is created server-side on first fetch; refresh the list once so the
	// Projects surface shows it without a manual reload.
	useEffect(() => {
		if (home.data?.project && projectList.length > 0 && !projectList.some((p) => p.id === home.data!.project.id)) {
			void queryClient.invalidateQueries({ queryKey: ['projects', actorId] });
		}
	}, [home.data, projectList, queryClient, actorId]);

	const authenticated = Boolean(auth.data?.authenticated);
	// No answer at all from the auth check because the device is offline (an
	// installed app opened with no connection): say so, instead of asking a
	// signed-in user to sign in again.
	const authOffline = !auth.data && auth.error != null && failureKind(auth.error) === 'offline';

	// A link shared into Caddie from another app (manifest share_target) waits
	// in sessionStorage until the signed-in Home conversation is ready, then
	// goes under whatever is in its composer, for the user to read and send.
	// Nothing is sent for them. takeSharedDraft hands it over once.
	const [sharedArrived, setSharedArrived] = useState(false);
	useEffect(() => {
		if (!authenticated || !actorId || conversationKind !== 'general' || conversationResolving) return;
		const shared = takeSharedDraft(sessionShareStorage());
		if (!shared) return;
		channel.appendComposerText(shared);
		setSharedArrived(true);
		if (viewportMode === 'desktop') setConvOpen(true);
		else if (viewportMode === 'tablet') setTabletOpen(true);
		else if (!mobileConversation) setMobileConversation(true);
		// Runs when the conversation becomes ready; the rest is read at that moment.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [authenticated, actorId, conversationKind, conversationResolving]);

	// --- Chat starting point + urgent decisions (approved navigation) ----------
	// The welcome panel is a DETERMINISTIC first-run teaching surface: real
	// action buttons, no fabricated assistant message, no model call. It shows
	// only while the general conversation has no transcript and the actor has
	// not engaged it; sending a message hides it permanently (transcript
	// non-empty) and the seen flag is account-isolated in sessionStorage.
	const [welcomeSeen, setWelcomeSeen] = useState(() => {
		try {
			return sessionStorage.getItem(`caddie:welcome-seen:${actorId ?? 'anon'}`) === '1';
		} catch {
			return false;
		}
	});
	const markWelcomeSeen = () => {
		setWelcomeSeen(true);
		try {
			sessionStorage.setItem(`caddie:welcome-seen:${actorId ?? 'anon'}`, '1');
		} catch {
			// private mode: the transcript gate still hides the panel after first use
		}
	};
	const source = transport?.source ?? STANDBY;
	const showWelcome =
		authenticated &&
		conversationKind === 'general' &&
		!conversationResolving &&
		source.messages.length === 0 &&
		!welcomeSeen;
	// The urgent notice: the top UNSEEN actionable card (needs-you first —
	// the account brief is already ranked). Reading it never resolves the
	// decision; opening it navigates to the exact work and marks it read.
	const urgentCard =
		accountBrief.data?.cards.find(
			(card) => !card.seen && (card.status === 'needs-you' || card.status === 'blocked'),
		) ?? null;
	const openUrgentCard = () => {
		if (!urgentCard) return;
		if (urgentCard.key) void markBriefRead.mutate([urgentCard.key]);
		const route = briefActionRoute(urgentCard, homeProject?.id ?? null);
		void navigate({ to: route.to as never, search: route.search as never });
	};

	// Caddie's character mood (v2, HANDOFF §7): derived from REAL state only —
	// a live transport means Caddie is working; an unseen needs-you or blocked
	// card means something waits for your OK; otherwise it's ready.
	const caddieMood: MascotMood = live
		? 'thinking'
		: urgentCard
			? 'needs'
			: 'ready';

	// --- Restoration precedence (approved navigation) --------------------------
	// 1. Explicit deep link / current URL wins (any path, pane or project param).
	// 2. A valid restored global destination for this actor (sessionStorage,
	//    keyed by actor id — account switching clears it).
	// 3. Platform default: mobile Chat (`/`), desktop Brief + Chat (`/`).
	// Restore is one-shot per SPA session so it never fights a deliberate
	// return to the default; a deleted/unauthorised project is never restored.
	const location = useLocation();
	const didRestore = useRef(false);
	useEffect(() => {
		if (!authenticated || !actorId) return;
		const path = location.pathname.replace(/^\/app/, '') || '/';
		const globalPaths = ['/', '/discover', '/projects'];
		if (!globalPaths.includes(path) || search.project) return;
		// Record non-default destinations only — the bare default ('/' with no
		// pane) is the platform default, never a deliberate choice, and must
		// not clobber the stored destination before restoration reads it.
		if (!(path === '/' && search.pane === undefined)) {
			try {
				const stored = sessionStorage.getItem(`caddie:last-dest:${actorId}`);
				const current = JSON.stringify({ to: path, pane: search.pane ?? null });
				if (stored !== current) sessionStorage.setItem(`caddie:last-dest:${actorId}`, current);
			} catch {
				// private mode: no restoration memory
			}
		}
		if (didRestore.current || path !== '/' || search.pane !== undefined) return;
		let last: { to?: string; pane?: string | null } | null = null;
		try {
			last = JSON.parse(sessionStorage.getItem(`caddie:last-dest:${actorId}`) ?? 'null') as { to?: string; pane?: string | null } | null;
		} catch {
			last = null;
		}
		const to = last?.to ?? null;
		const pane = last?.pane ?? null;
		if (to && to !== '/') {
			didRestore.current = true;
			const restoreSearch: Record<string, unknown> = pane ? { pane } : {};
			void navigate({ to: to as never, search: restoreSearch as never, replace: true });
		} else if (pane === 'brief') {
			didRestore.current = true;
			void navigate({ to: '/', search: { pane: 'brief' } as Record<string, unknown> as never, replace: true });
		}
	}, [authenticated, actorId, location.pathname, search.pane, search.project, navigate]);

	function selectProject(projectId: string) {
		void navigate({
			to: '.',
			search: (prev: Record<string, unknown>) => ({
				...prev,
				project: projectId === '' ? undefined : projectId,
			}),
		});
	}

	function openProject(projectId: string, showChat = false) {
        if (showChat) { setConvOpen(true); setTabletOpen(true); }
        void navigate({ to: '/project', search: { project: projectId, ...(showChat && !isDesktop ? { pane: 'channel' } : {}) } as Record<string, unknown> });
    }

    function newProject() {
        setStartingProject(true);
        setConvOpen(true);
        setTabletOpen(true);
        void navigate({ to: '/', search: isDesktop ? {} : { pane: 'channel' } });
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
		void queryClient.invalidateQueries({ queryKey: ['brief', 'account', actorId] });
		void queryClient.invalidateQueries({ queryKey: ['home-project', actorId] });
		void queryClient.invalidateQueries({ queryKey: ['discovery-candidates', actorId] });
	}

	/** Read the live <html> state (not React state) so rapid clicks never act on a stale choice. */
	function setThemeChoice(patch: Partial<ThemeChoice>) {
		const previous = currentTheme();
		const next: ThemeChoice = { palette: patch.palette ?? previous.palette, mode: patch.mode ?? previous.mode };
		applyTheme(next);
		saveThemeChoice(browserStorage(), next, previous);
		setThemeChoiceState(next);
	}

	function toggleTheme() {
		setThemeChoice({ mode: currentTheme().mode === 'dark' ? 'light' : 'dark' });
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
		palette: themeChoice.palette,
		setThemeChoice,
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
		viewportMode,
		convVisible,
		toggleConvOverlay,
		setConvOpen,
		convWidth: { reset: convWidth.reset, frac: convWidth.frac },
		caddieMood,
		channel,
		transport,
		sendText,
		openProject,
		newProject,
		goProjectTab,
	};

	const panelState = chatFull ? 'full' : convVisible ? 'open' : 'closed';

	return (
		<WorkspaceChromeContext.Provider value={context}>
			<div className="shell app-shell" data-testid="shell" data-viewport={viewportMode}>
				<a className="skip-link" href="#main">
					Skip to content
				</a>
				<div className="app-split" data-conv-state={panelState} data-testid="app-split">
{/* ---------------- LEFT PANEL: capsule nav + content ---------------- */}
						<section className="shell-left" data-testid="shell-left" aria-label="Caddie content">
							{authenticated ? (
								viewportMode === 'mobile' ? (
									<MobileHeader
										nav={props.nav}
										accountOpen={accountOpen}
										setAccountOpen={setAccountOpen}
										displayName={displayName.data ?? null}
									/>
								) : (
									<NavCapsule
										nav={props.nav}
										accountOpen={accountOpen}
										setAccountOpen={setAccountOpen}
										displayName={displayName.data ?? null}
										unseenCount={unseenCount}
										showConvToggle={viewportMode === 'tablet'}
										convOpen={tabletOpen}
										onQuickSearch={openQuickSearch}
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
										className="capsule-icon theme-toggle-btn"
										title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
										aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
										data-testid="theme-toggle"
										onClick={toggleTheme}
									>
										{theme === 'dark' ? <Icon name="sun" title="Switch to light theme" /> : <Icon name="moon" title="Switch to dark theme" />}
									</button>
									<a href={import.meta.env.DEV ? 'http://localhost:4321/' : '/'} className="capsule-tab" data-testid="back-to-landing">
										<Icon name="arrowLeft" title="back to the landing page" /> Landing
									</a>
								</header>
							)}
						{props.crumbs ? (
							<div className="crumbs" data-testid="breadcrumb">
								{props.crumbs}
							</div>
						) : null}
						<main id="main" className="shell-main" data-hidden={conversationKind !== 'none' && mobileConversation && !isDesktop}>
							{authenticated ? (
								props.children
							) : authOffline ? (
								<div className="shell-loading" data-testid="offline-launch">
									<StatePanel
										kind="offline"
										detail="Caddie needs a connection to open your workspace. Connect, then try again."
										onRetry={() => void auth.refetch()}
										retryLabel="Try again"
										busy={auth.isFetching}
										askCaddie={false}
									/>
								</div>
							) : (
								<div className="signin-view" data-testid="sign-in-gate">
									<div className="signin-col">
										<div className="signin-brand">
											<Mascot mood="ready" size={56} live />
											<h1 className="signin-title">Sign in to Caddie</h1>
											<p className="signin-lede">
												Use the account you already have
												<br />
												it&rsquo;s free to start.
											</p>
										</div>
										<div className="signin-card">
											<SignInPanel callbackURL="/app/" />
										</div>
										<p className="signin-note">
											Signing in doesn&rsquo;t give Caddie your code. It asks separately, only if you
											bring code in.
										</p>
									</div>
								</div>
							)}
						</main>
					</section>

					{/* ---------------- RIGHT PANEL: persistent conversation ---------------- */}
					{conversationKind !== 'none' ? (
					<>
						{/* Tablet (761–1080): the overlay opens over a scrim from the
						    top-bar Caddie button; clicking the scrim or Esc closes it. */}
						{viewportMode === 'tablet' && tabletOpen && !chatFull ? (
							<div className="conv-scrim" data-testid="conv-scrim" onClick={() => setTabletOpen(false)} />
						) : null}
					<aside
						className="shell-right"
						data-testid="conversation-panel"
						data-open={viewportMode === 'mobile' && mobileConversation ? 'true' : 'false'}
						data-conv-state={panelState}
						aria-label="Caddie conversation"
						style={
							viewportMode === 'desktop' && convOpen && !chatFull
								? { width: `${convWidth.widthPx}px` }
								: undefined
						}
					>
							{/* Closed rail (desktop): only the character, click reopens. */}
							{viewportMode === 'desktop' && !convOpen && !chatFull ? (
								<div className="conv-rail" data-testid="conv-rail">
									<button
										type="button"
										className="conv-rail-button"
										data-testid="conv-rail-open"
										aria-label="Show Caddie"
										onClick={() => setConvOpen(true)}
									>
										<Mascot mood={caddieMood} size={36} live />
									</button>
								</div>
							) : null}
							{/* The resizable left edge (desktop two-panel only). */}
							{viewportMode === 'desktop' && convOpen && !chatFull ? <ConvResizeHandle width={convWidth} /> : null}
							{/* Floating conversation head — Today-inspired but our own: a slim
							    left-aligned row over the transcript. The Caddie mark sits
							    top-left at chip size; the pill beside it is the conversation
							    scope (General = the account-level chat; a project name inside
							    a project). Mobile gets the Search/Account chips on the right;
							    desktop gets expand (full-screen chat) and close (the rail). */}
							<div className="conv-head-float" data-testid="conv-context" data-scope={conversationKind}>
								<span className="conv-head-left">
									<Mascot mood={caddieMood} size={30} live />
									<TalkingAbout conversationKind={conversationKind} label={conversationLabel} />
									<CaddieStatus mood={caddieMood} />
								</span>
								<span className="conv-head-chips">
									{!isDesktop ? (
										<>
											<Link to="/search" className="conv-chip" data-testid="conv-search" title="Search" search={withoutPane}>
												<Icon name="search" title="Search" />
											</Link>
											<AccountMenu accountOpen={accountOpen} setAccountOpen={setAccountOpen} displayName={displayName.data ?? null} />
										</>
									) : null}
									{chatFull ? (
										<button
											type="button"
											className="conv-head-btn"
											data-testid="conv-exit-full"
											aria-label="Back to the page"
											title="Back to the page"
											onClick={() => {
												void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, pane: undefined }) });
											}}
										>
											<Icon name="collapse" title="Back to the page" />
										</button>
									) : null}
									{viewportMode === 'desktop' && convOpen && !chatFull ? (
										<>
											<button
												type="button"
												className="conv-head-btn"
												data-testid="conv-expand"
												aria-label="Open Caddie full screen"
												title="Open Caddie full screen"
											onClick={() => {
												void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, pane: 'channel' as const }) });
											}}
											>
												<Icon name="expand" title="Open Caddie full screen" />
											</button>
											<button
												type="button"
												className="conv-head-btn"
												data-testid="conv-collapse"
												aria-label="Hide Caddie"
												title="Hide Caddie"
												onClick={() => setConvOpen(false)}
											>
												<Icon name="panel" title="Hide Caddie" />
											</button>
										</>
									) : null}
									{viewportMode === 'tablet' && tabletOpen && !chatFull ? (
										<button
											type="button"
											className="conv-head-btn"
											data-testid="conv-collapse"
											aria-label="Close Caddie"
											title="Close Caddie"
											onClick={() => setTabletOpen(false)}
										>
											<Icon name="x" title="Close Caddie" />
										</button>
									) : null}
								</span>
							</div>
							{/* The urgent decision notice: real state, one compact line, never
							    covers the transcript or the composer; opening it navigates to
							    the exact work and marks the card read (never resolves it). */}
							{authenticated && conversationKind === 'general' && !conversationResolving && urgentCard ? (
								<div className="urgent-notice" data-testid="urgent-notice" data-kind={urgentCard.kind}>
									<span className="urgent-notice-text">
										<Icon name="alert" title="Needs your decision" /> {urgentCard.headline}
									</span>
									<button
										type="button"
										className="btn-ghost urgent-notice-action"
										data-testid="urgent-notice-open"
										onClick={openUrgentCard}
									>
										{urgentCard.primaryAction.label}
									</button>
								</div>
							) : null}
							{startingProject && conversationKind === 'general' ? (
                                <section className="project-start-panel card-surface" data-testid="project-start-panel" aria-label="Start a project">
                                    <p className="kicker" data-tone="action">NEW PROJECT</p>
                                    <h3 className="state-title">What would you like to build?</h3>
                                    <p className="state-detail">Describe your idea in the message box. Include who it’s for and what it should do. You don’t need to choose technologies yet.</p>
                                    <button type="button" className="btn-ghost" onClick={() => setStartingProject(false)}>Cancel</button>
                                </section>
                            ) : showWelcome ? (
								<WelcomePanel
									onFind={() => {
										markWelcomeSeen();
										// Chat-first: start a discovery CONVERSATION with Caddie
										// (it reads your profile and proposes matches), rather than
										// bouncing to the standalone Discover page.
										setConvOpen(true);
										setTabletOpen(true);
										void navigate({ to: '/', search: isDesktop ? {} : { pane: 'channel' } });
										sendText('Help me find my first hackathon — something that fits what I like building.');
									}}
									onIdea={() => {
										markWelcomeSeen();
										newProject();
									}}
									onImport={() => {
										markWelcomeSeen();
										void navigate({ to: '/repositories' });
									}}
								/>
							) : null}
							<Channel
								source={transport?.source ?? STANDBY}
								transportLive={transport?.hasRun === true}
                                hideEmptyState={showWelcome || (startingProject && conversationKind === 'general')}
                                emptyTitle={conversationKind === 'project' ? 'What would you like to do next?' : undefined}
                                emptyDetail={conversationKind === 'project' ? 'Ask a question about this project or describe what you would like to change.' : undefined}
								drafts={channel.drafts}
								projectId={conversationProjectId}
								composerHidden={viewportMode === 'mobile'}
								composerText={channel.composerText}
								onComposerTextChange={channel.setComposerText}
								composerNote={sharedArrived ? 'Shared to Caddie · not sent yet' : undefined}
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
								onEditDraft={channel.editDraft}
								onDiscardDraft={channel.discardDraft}
							/>
						</aside>
					</>
					) : null}
				</div>

				{/* ---------------- MOBILE floating bottom nav + composer ----------------
				    Desktop renders its composer inside the persistent right-panel
				    Channel, so the bottom nav (with its own composer) is mobile-only —
				    rendering both would duplicate composer-input in the desktop DOM. */}
{authenticated && viewportMode === 'mobile' ? (
						<MobileNav
							nav={props.nav}
							sendText={sendText}
							live={live}
							conversationOpen={mobileConversation}
							conversationKind={conversationKind}
							resolving={conversationResolving}
							unseenCount={unseenCount}
						/>
					) : null}
			</div>
			<QuickSearch open={quickSearchOpen} onClose={() => setQuickSearchOpen(false)} />
		</WorkspaceChromeContext.Provider>
	);
}

const keepSearch = (prev: Record<string, unknown>) => ({ ...prev });

/** Destination navigation strips the mobile pane flag (audit F04): a chat
 *  pane open on one surface must never conceal the destination the user
 *  explicitly navigated to. Project selection is preserved. */
const withoutPane = (prev: Record<string, unknown>) => {
	const { pane: _pane, ...rest } = prev;
	return rest;
};

/** The desktop/tablet floating navigation capsule: wordmark + the three global
 *  destinations + Search, theme and Account, all in one rounded container
 *  that sticks inside the left panel. The unseen brief badge sits on the
 *  Brief tab — absolutely positioned so it never shifts tab alignment. In the
 *  tablet band (761–1080) the capsule also carries the Caddie button that
 *  opens the conversation as a right overlay (HANDOFF §3.1). */
function NavCapsule(props: {
	nav: WorkspaceNavId;
	accountOpen: boolean;
	setAccountOpen: (open: boolean) => void;
	displayName: string | null;
	unseenCount: number;
	showConvToggle?: boolean;
	convOpen?: boolean;
	onQuickSearch?: () => void;
}): ReactElement {
	const { theme, toggleTheme, toggleConvOverlay } = useWorkspaceChrome();
	return (
		<nav className="nav-capsule" aria-label="Primary" data-testid="nav-capsule">
			<Link to="/" className="capsule-wordmark" data-testid="wordmark" search={withoutPane}>
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
					search={withoutPane}
				>
					{item.label}
					{item.id === 'brief' && props.unseenCount > 0 ? (
						<BriefBadge count={props.unseenCount} testid="nav-brief-badge" />
					) : null}
				</Link>
			))}
			<span className="capsule-spacer" />
			{props.showConvToggle ? (
				<button
					type="button"
					className="capsule-conv-toggle"
					data-testid="conv-toggle"
					aria-expanded={props.convOpen ? 'true' : 'false'}
					aria-label={props.convOpen ? 'Hide Caddie' : 'Show Caddie'}
					title={props.convOpen ? 'Hide Caddie' : 'Show Caddie'}
					onClick={toggleConvOverlay}
				>
					<Icon name="chat" title="Caddie" />
					Caddie
				</button>
			) : null}
			<button
				type="button"
				className="capsule-icon"
				data-testid="nav-search"
				title="Quick search (⌘K)"
				aria-label="Quick search"
				onClick={props.onQuickSearch}
			>
				<Icon name="search" title="Search" />
			</button>
			<button
				type="button"
				className="capsule-icon theme-toggle-btn"
				title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
				aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
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
	if (props.nav === 'brief') {
		// Chat is the mobile default; the Brief tab is the second destination.
		identity = chrome.mobileConversation ? 'Caddie' : 'Brief';
	} else if (props.nav === 'discover') identity = 'Discover';
	else if (props.nav === 'projects') identity = 'Projects';
	else if (props.nav === 'project') identity = chrome.selectedProject?.name ?? 'Project';
	else if (props.nav === 'account') {
		const path = location.pathname;
		if (path.endsWith('/search')) identity = 'Search';
		else if (path.endsWith('/usage')) identity = 'Spending';
		else if (path.endsWith('/automations')) identity = 'Routines';
		else if (path.endsWith('/onboarding')) identity = 'Start';
		else identity = 'Settings';
	}

	// One page-relevant action on the right, per destination (owner direction:
	// the header is page-aware, so it earns its space): refresh on the Brief
	// and Discover, "New project" on Projects. Search lives in the Account
	// menu now (stable fallback), and the avatar itself stays.
	let action: ReactElement | null = null;
	if (props.nav === 'brief' && !chrome.mobileConversation) {
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
					<Mascot mood={chrome.caddieMood} size={22} live />
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

/** Avatar + the account menu. The menu head states the real session identity:
 *  the name and the account email (U01). The sign-in provider is NOT shown —
 *  `/api/auth/get-session` carries no provider, and the client never fabricates
 *  one (evidence rule); a provider line needs a server field first. */
function AccountMenu(props: {
	accountOpen: boolean;
	setAccountOpen: (open: boolean) => void;
	displayName: string | null;
}): ReactElement {
	const { signOut, theme, palette, setThemeChoice } = useWorkspaceChrome();
	const email = useSessionEmail().data ?? null;
	// The name the user gave Caddie in the welcome (v2 §4) is used everywhere
	// the account name appears; the session name is the fallback.
	const savedName = (() => {
		try {
			return localStorage.getItem('caddie:profile-name');
		} catch {
			return null;
		}
	})();
	const shownName = (savedName && savedName.trim() !== '' ? savedName : props.displayName) ?? null;
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
				title={shownName ?? 'Account'}
				onClick={() => props.setAccountOpen(!props.accountOpen)}
			>
				{shownName ? (
					<span className="avatar-initial">{shownName.trim()[0]!.toUpperCase()}</span>
				) : (
					<Icon name="user" title="Account" />
				)}
			</button>
			{props.accountOpen ? (
				<div className="account-menu-pop" role="menu" data-testid="account-menu-pop">
					<div className="account-menu-head" data-testid="account-menu-head">
						<span className="account-menu-name" data-testid="account-menu-name">{shownName ?? 'Your account'}</span>
						{email ? <span className="account-menu-email">{email}</span> : null}
					</div>
					<Link to="/search" search={keepSearch} role="menuitem" data-testid="account-search" onClick={() => props.setAccountOpen(false)}>
						<Icon name="search" title="Search" /> Search
					</Link>
					<Link to="/settings" search={{ tab: 'profile' } as Record<string, unknown>} role="menuitem" data-testid="account-profile" onClick={() => props.setAccountOpen(false)}>
						<Icon name="user" title="Profile" /> Profile &amp; interests
					</Link>
					<Link to="/settings" search={{ tab: 'knows' } as Record<string, unknown>} role="menuitem" data-testid="account-memory" onClick={() => props.setAccountOpen(false)}>
						<Icon name="memory" title="What Caddie knows" /> What Caddie knows
					</Link>
					<Link to="/settings" search={{ tab: 'accounts' } as Record<string, unknown>} role="menuitem" data-testid="account-connections" onClick={() => props.setAccountOpen(false)}>
						<Icon name="link" title="Connected accounts" /> Connected accounts
					</Link>
					<Link to="/settings" search={{ tab: 'routines' } as Record<string, unknown>} role="menuitem" data-testid="account-automations" onClick={() => props.setAccountOpen(false)}>
						<Icon name="calendar" title="Routines" /> Routines
					</Link>
					<Link to="/settings" search={{ tab: 'spending' } as Record<string, unknown>} role="menuitem" data-testid="account-usage" onClick={() => props.setAccountOpen(false)}>
						<Icon name="box" title="Spending" /> Spending
					</Link>
					<div className="account-menu-sep" role="separator" />
					<ThemePicker variant="menu" palette={palette} mode={theme} onChange={setThemeChoice} />
					<div className="account-menu-sep" role="separator" />
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
 * container with the composer directly above a row of FOUR destinations —
 * Chat · Brief · Discover · Projects (approved navigation 2026-10-09; Chat is
 * the initial default tab). The input rides every route. Destination links
 * strip stale ?pane params so a destination is never concealed.
 */
function MobileNav(props: {
	nav: WorkspaceNavId;
	sendText: (text: string, attachments?: readonly import('@caddie/contracts').InputAttachment[]) => void;
	live: boolean;
	conversationOpen: boolean;
	conversationKind: ConversationKind;
	resolving: boolean;
	unseenCount: number;
}): ReactElement {
	const chrome = useWorkspaceChrome();
	const { channel, setMobileConversation } = chrome;
	const onDiscover = props.nav === 'discover';
	const scopeName = props.conversationKind === 'project' ? (chrome.selectedProject?.name ?? null) : null;
	const onProjects = props.nav === 'projects';
	// The conversation IS the mobile Chat tab: it is current whenever the
	// channel pane is open; the Brief tab owns the default's left content.
	const chatOpen = props.conversationOpen && props.conversationKind !== 'none';
	const briefActive = props.nav === 'brief' && !chatOpen;
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
			<div className="bottom-nav-composer bottom-nav-pill">
				{chatOpen ? (
					<Composer
						onSend={props.sendText}
						disabled={disabled}
						disabledReason={disabledReason}
						value={channel.composerText}
						onValueChange={channel.setComposerText}
						placeholder={onDiscover ? 'Ask Caddie about these hackathons…' : 'Ask Caddie or tell it what to do…'}
					/>
				) : (
					<AskBar
						onOpen={() => setMobileConversation(true)}
						scopeName={props.conversationKind === 'project' ? (scopeName ?? undefined) : undefined}
						mood={chrome.caddieMood}
					/>
				)}
			</div>
			<div className="bottom-nav-row bottom-nav-pill">
				<Link
					to="/"
					className="tab-btn"
					data-testid="tab-chat-mobile"
					aria-current={chatOpen ? 'page' : undefined}
					search={(prev: Record<string, unknown>) => ({ ...prev, pane: 'channel' as const })}
				>
					<Mascot mood={chrome.caddieMood} size={22} live />
					Caddie
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
					{props.unseenCount > 0 ? <BriefBadge count={props.unseenCount} testid="tab-brief-badge" /> : null}
				</Link>
				<Link
					to="/discover"
					className="tab-btn"
					data-testid="nav-discover-mobile"
					aria-current={onDiscover ? 'page' : undefined}
					search={withoutPane}
				>
					<Icon name="target" title="" />
					Discover
				</Link>
				<Link
					to="/projects"
					className="tab-btn"
					data-testid="nav-projects-mobile"
					aria-current={onProjects ? 'page' : undefined}
					search={withoutPane}
				>
					<Icon name="box" title="" />
					Projects
				</Link>
			</div>
		</nav>
	);
}

/**
 * The v2 viewport bands (HANDOFF §3.1): ≤760 mobile, 761–1080 tablet overlay,
 * ≥1081 two-panel desktop. Evaluated on every resize so a window dragged
 * across a boundary switches layout immediately.
 */
function useViewportMode(): { mode: ViewportMode; isDesktop: boolean } {
	const [mode, setMode] = useState<ViewportMode>(() => {
		if (typeof window === 'undefined') return 'desktop';
		const w = window.innerWidth;
		return w >= 1081 ? 'desktop' : w > 760 ? 'tablet' : 'mobile';
	});
	useEffect(() => {
		const evaluate = () => {
			const w = window.innerWidth;
			const next: ViewportMode = w >= 1081 ? 'desktop' : w > 760 ? 'tablet' : 'mobile';
			setMode((current) => (current === next ? current : next));
		};
		evaluate();
		window.addEventListener('resize', evaluate);
		return () => window.removeEventListener('resize', evaluate);
	}, []);
	return { mode, isDesktop: mode === 'desktop' };
}

/**
 * The "Talking about" switch (v2 shell, HANDOFF §3.5): Everything plus one
 * entry per active project. Selecting a scope navigates to it — the
 * conversation binds to the route's scope, and drafts are kept per scope by
 * the channel store. Separate chat THREADS per scope are B05 (not landed), so
 * the menu says what it does ("switches what this chat is about") and never
 * claims independent threads.
 */
function TalkingAbout(props: { conversationKind: ConversationKind; label: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const currentId = props.conversationKind === 'project' ? chrome.effectiveProjectId : null;

	function goScope(projectId: string | null) {
		setOpen(false);
		// Keep the chat pane open on mobile so the switched chat is visible;
		// on desktop ?pane=channel means full-screen, which is not the intent.
		const keepPane = !chrome.isDesktop && props.conversationKind !== 'none';
		if (projectId === null) {
			void navigate({ to: '/', search: keepPane ? { pane: 'channel' } : {} });
		} else {
			void navigate({ to: '/project', search: { project: projectId, ...(keepPane ? { pane: 'channel' } : {}) } as Record<string, unknown> as never });
		}
	}

	return (
		<span
			className="talking-about"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
			}}
		>
			<button
				type="button"
				className="talking-about-btn talking-about-pill"
				data-testid="talking-about"
				aria-haspopup="menu"
				aria-expanded={open}
				title="Switch what this chat is about — the project page you are on, or everything"
				onClick={() => setOpen((value) => !value)}
			>
				<span className="talking-about-kicker visually-hidden">Talking about</span>
				<span className="talking-about-scope" data-testid="conv-context-label">
					{props.label}
				</span>
				<Icon name="chevronDown" title="" className="talking-about-chev" />
			</button>
			{open ? (
				<span className="talking-about-menu" role="menu" data-testid="talking-about-menu">
					<span className="talking-about-note">Switches what this chat is about.</span>
					<button type="button" role="menuitem" data-testid="scope-everything" aria-current={currentId === null ? 'true' : undefined} onClick={() => goScope(null)}>
						<Icon name="chat" title="" /> Everything
					</button>
					{chrome.buildProjects.map((project) => (
						<button
							type="button"
							role="menuitem"
							key={project.id}
							data-testid={`scope-${project.id}`}
							aria-current={currentId === project.id ? 'true' : undefined}
							onClick={() => goScope(project.id)}
						>
							<Icon name="box" title="" /> {project.name}
						</button>
					))}
				</span>
			) : null}
		</span>
	);
}

/**
 * Header A status cue: turns the dead header space into a live readiness
 * signal driven by the same caddieMood the mascot uses. 'thinking' = a live
 * transport (working), 'needs' = something waits for your OK, else ready.
 */
function CaddieStatus(props: { mood: MascotMood }): ReactElement {
	const STATUS: Partial<Record<MascotMood, { tone: string; label: string }>> = {
		thinking: { tone: 'working', label: 'Working…' },
		building: { tone: 'working', label: 'Building…' },
		needs: { tone: 'needs', label: 'Needs you' },
		stuck: { tone: 'needs', label: 'Stuck' },
		ready: { tone: 'ready', label: 'Ready' },
	};
	const s = STATUS[props.mood] ?? STATUS.ready!;
	return (
		<span className="caddie-status" data-tone={s.tone} data-testid="caddie-status">
			<span className="caddie-status-dot" aria-hidden="true" />
			<span className="caddie-status-label">{s.label}</span>
		</span>
	);
}

/** The unseen-brief badge: absolutely positioned so it never shifts tab
 *  alignment. Count = unseen important updates from the account brief. */
function BriefBadge(props: { count: number; testid: string }): ReactElement {
	return (
		<span className="nav-badge" data-testid={props.testid} aria-label={`${props.count} unseen update${props.count === 1 ? '' : 's'}`}>
			{props.count > 99 ? '99+' : props.count}
		</span>
	);
}

/**
 * The deterministic first-run welcome (approved navigation): real actions,
 * never a fabricated assistant message and never a paid model call. Priority
 * order is fixed: find a hackathon (discovery/profile-guided matching),
 * start from an idea (idea capture/scoping), continue existing code
 * (repository import). Visible only while the general conversation has no
 * transcript and the actor has not engaged it.
 */
function WelcomePanel(props: {
	onFind: () => void;
	onIdea: () => void;
	onImport: () => void;
}): ReactElement {
	return (
		<section className="welcome-panel" data-testid="welcome-panel" aria-label="Start here">
			<div className="welcome-intro">
				<span className="welcome-mascot" aria-hidden="true">
					<Mascot mood="ready" size={56} live />
				</span>
				<h3 className="state-title">Let's find a hackathon that fits you</h3>
				<p className="state-detail">
					Pick a starting point below, or just tell Caddie what you want. It reads the rules, drafts a
					plan and builds it — you approve every step. Nothing builds until you say so.
				</p>
			</div>
			<div className="welcome-templates" role="group" aria-label="Starting points">
				<button type="button" className="welcome-card" data-testid="welcome-find" onClick={props.onFind}>
					<span className="welcome-card-icon">
						<Icon name="target" title="" />
					</span>
					<span className="welcome-card-title">Find my first hackathon</span>
					<span className="welcome-card-sub">Caddie matches one to your interests and skills</span>
				</button>
				<button type="button" className="welcome-card" data-testid="welcome-idea" onClick={props.onIdea}>
					<span className="welcome-card-icon">
						<Icon name="sparkCheck" title="" />
					</span>
					<span className="welcome-card-title">Start from an idea</span>
					<span className="welcome-card-sub">Describe what you want to build — Caddie scopes it</span>
				</button>
				<button type="button" className="welcome-card" data-testid="welcome-import" onClick={props.onImport}>
					<span className="welcome-card-icon">
						<Icon name="github" title="" />
					</span>
					<span className="welcome-card-title">Continue existing code</span>
					<span className="welcome-card-sub">Bring a repo and pick up where you left off</span>
				</button>
			</div>
		</section>
	);
}
