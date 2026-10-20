import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { OnboardingGate, useOnboarding, onboardingKey, returnKey, type OnboardingStatus } from './onboarding/Gate.tsx';
import { postJson } from './api.ts';
import { SignInPanel } from './auth.ts';
import { Link, Outlet, createBrowserHistory, createRootRoute, createRoute, createRouter, redirect, useMatches } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { WorkspaceChrome, type WorkspaceNavId } from './workspace/Chrome.tsx';
import { Shell } from './workspace/Shell.tsx';
import { Settings } from './settings/Settings.tsx';
import { WelcomeIntro } from './onboarding/Start.tsx';
import { OnboardingProfile } from './onboarding/Profile.tsx';
import { ProjectSettingsPage } from './settings/ProjectSettings.tsx';
import { Mascot } from '@caddie/ui/Mascot';
import { StatePanel, failureKind } from './states.tsx';
import {
	DiscoverPage,
	ProjectsPage,
	ProjectOverviewPage,
	SearchPage,
	SubmissionPage,
	EvidencePage,
	RunsPage,
	DesignReviewPage,
} from './surface.tsx';

/**
 * TanStack Router setup (SPA mode) for the discovery-first shell.
 *
 * The Worker serves the SPA under /app with a client-routing fallback
 * (tests/routing.test.ts), so the browser history basepath is /app in the
 * composed build; `bun run dev` serves at the root. The selected project lives
 * in the ?project= search param — refresh and deep links retain it.
 *
 * THREE GLOBAL DESTINATIONS only (Brief · Discover · Projects) plus account
 * surfaces (Search/Automations/Usage/Settings) and the project-local surfaces
 * (Overview/Plan/Build/Submission and their nested siblings). Every route renders
 * inside WorkspaceChrome, so no destination is a chrome-less dead end and the
 * persistent conversation is always present with an explicit context label.
 */

function OnboardingFlow(): ReactElement {
 const { auth, actor, status } = useOnboarding();
 const cache = useQueryClient();
 const [busy, setBusy] = useState(false);
 const [atProfile, setAtProfile] = useState(false);
 const [error, setError] = useState<string | null>(null);
 // A user who already finished onboarding and navigates BACK to /onboarding
 // must not get stuck on the "Getting your workspace ready…" message — it has
 // no completion action to run. Send them into the app (saved destination if
 // one was captured, else the Brief). Only when NOT mid-finish (busy), so the
 // real completion redirect in finish() still owns that path.
 useEffect(() => {
  if (busy || !auth.data?.authenticated || !status.data?.completedAt || !actor.data) return;
  let target = '/app/';
  try {
   const saved = sessionStorage.getItem(returnKey(actor.data));
   sessionStorage.removeItem(returnKey(actor.data));
   if (saved) {
    const url = new URL(saved, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith('/app/') &&
        (url.pathname !== '/app/' || Boolean(url.search || url.hash)) && !/\/onboarding\/?$/.test(url.pathname)) {
     target = url.pathname + url.search + url.hash;
    }
   }
  } catch { /* no storage: fall through to the app root */ }
  window.location.replace(target);
 }, [busy, auth.data?.authenticated, status.data?.completedAt, actor.data]);
 async function finish() {
  if (busy || !actor.data) return;
  setBusy(true);
  setError(null);
  try {
   const result = await postJson<OnboardingStatus>('/api/onboarding/complete', {});
   cache.setQueryData(onboardingKey(actor.data), result);
   let destination: string | null = null;
   try {
    destination = sessionStorage.getItem(returnKey(actor.data));
    sessionStorage.removeItem(returnKey(actor.data));
   } catch { /* Fall through to the app root without browser storage. */ }
   // Onboarding hands straight off to the app — there is no interstitial start
   // screen. Restore a saved same-origin destination if the gate captured one;
   // otherwise land on the app root (the Brief).
   let target = '/app/';
   if (destination) {
    const url = new URL(destination, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith('/app/') &&
        (url.pathname !== '/app/' || Boolean(url.search || url.hash)) && !/\/onboarding\/?$/.test(url.pathname)) {
     target = url.pathname + url.search + url.hash;
    }
   }
   window.location.replace(target);
  } catch {
   setError('We couldn’t save your progress. Please try again.');
   throw new Error('We couldn’t finish setup. Please try again.');
  } finally { setBusy(false); }
 }
 return (
  <main id="main" data-testid="onboarding-page" style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 'clamp(16px, 4vw, 48px)' }}><div style={{ width: '100%', maxWidth: 720 }}>
   {!auth.data?.authenticated ? <SignInPanel callbackURL="/app/onboarding" /> : status.data?.completedAt ? (
    <StatePanel kind="loading" title="Getting your workspace ready…" />
   ) : (
    <><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
     {atProfile && actor.data ? <OnboardingProfile actorId={actor.data} onDone={finish} /> : <WelcomeIntro onDone={() => setAtProfile(true)} />}
    </fieldset>{busy ? <p role="status">Saving your progress…</p> : null}
    {error ? <p role="alert">{error}</p> : null}</>
   )}
  </div></main>
 );
}

/**
 * The designed error page (P06 state grammar). A render fault anywhere in the
 * route tree lands here instead of the router's bare "Something went wrong"
 * box.
 *
 * CHROME-FREE BY DESIGN — this is the load-bearing decision. An error boundary
 * must render something SIMPLER than what failed: it must NOT re-mount the very
 * subtree that crashed. WorkspaceChrome mounts the live conversation (Channel /
 * ReasoningView); if the fault came from there and the boundary wrapped itself
 * in WorkspaceChrome, the error page would re-mount the crashing tree, re-throw
 * with nothing above to catch it, and the user would see a BLANK SCREEN. So the
 * error page renders only the themed canvas + the card — no chrome, no
 * conversation, no queries. It uses NO router hooks either, since the router
 * subtree itself may be the thing that broke.
 *
 * RECOVERY — "Try again" does a HARD reload (window.location), never a bare
 * boundary reset(): resetting re-renders the same (possibly still-faulting)
 * tree in place, which is the other way to land on a blank screen. A reload
 * guarantees a clean mount. "Ask Caddie" is a plain anchor to the app root —
 * a full document load, so it too starts from a healthy tree.
 *
 * PRODUCTION SAFETY: the raw error message is shown ONLY in dev
 * (`import.meta.env.DEV`). Vite statically removes the dead branch from the
 * production bundle, so no stack text, internal message, or "hooks" diagnostic
 * is ever shipped to or shown to real users — they get the friendly line only.
 */
function WorkspaceError({ error, info }: { error: unknown; reset?: () => void; info?: { componentStack?: string } }): ReactElement {
	// Classify known API failures (denied/limit/offline) distinctly from an
	// unexpected render fault, reusing the shared failure mapping.
	const kind = failureKind(error);
	// Dev-only: the raw message, as a diagnostic aid. Never rendered in prod.
	const devMessage =
		import.meta.env.DEV && error instanceof Error && error.message ? error.message : null;
	// Dev-only: the React component stack names the EXACT component that threw —
	// the only reliable way to pinpoint a hooks-order fault, which otherwise
	// reports only a generic message. Logged to the console too (full stack),
	// shown trimmed in the panel. Stripped from prod with the dev branch.
	const devComponentStack =
		import.meta.env.DEV && typeof info?.componentStack === 'string' ? info.componentStack.trim() : null;
	if (import.meta.env.DEV && devComponentStack) {
		// eslint-disable-next-line no-console
		console.error('[WorkspaceError] render fault\n', error, '\ncomponent stack:', devComponentStack);
	}
	// The app's base path: '/app' in the composed Worker build, '/' under
	// `bun run dev`. Mirror the router's own detectBasepath so both land right.
	const base =
		typeof window !== 'undefined' && window.location.pathname.startsWith('/app') ? '/app' : '';
	// A full-document load onto a FRESH tree. Reopening the conversation with an
	// in-SPA navigation would just re-mount whatever crashed and loop straight
	// back to this error page; a hard load guarantees a clean mount of the Brief
	// with the chat pane open, which is what "ask Caddie" should actually do.
	function askCaddie() {
		if (typeof window !== 'undefined') window.location.href = `${base}/?pane=channel`;
	}
	return (
		<div className="route-error-view" data-testid="route-error-view">
			<section className="route-error-card card-surface" data-state={kind} data-testid="route-error">
				<span className="route-error-halo" aria-hidden="true">
					<Mascot mood="stuck" size={64} />
				</span>
				<p className="kicker" data-tone="error">
					FAULT
				</p>
				<h3 className="route-error-title">Something went wrong on this page</h3>
				<p className="route-error-lede" data-testid="route-error-safety">
					Your work is safe — this is only the view. Reload the page, and if it keeps happening, ask Caddie.
				</p>
				{devMessage ? (
					<div className="route-error-detail" data-testid="route-error-detail">
						<span className="route-error-detail-label">DEV DETAIL · HIDDEN IN PRODUCTION</span>
						<code>{devMessage}</code>
						{devComponentStack ? (
							<code className="route-error-stack" data-testid="route-error-stack">
								{devComponentStack.split('\n').slice(0, 6).join('\n')}
							</code>
						) : null}
					</div>
				) : null}
				<div className="route-error-actions">
					<button
						type="button"
						className="btn-key"
						data-testid="route-error-retry"
						onClick={() => {
							// Hard reload: a clean mount, never an in-place reset that
							// could re-render the same faulting tree into a blank screen.
							if (typeof window !== 'undefined') window.location.reload();
						}}
					>
						Reload the page
					</button>
					<button
						type="button"
						className="btn-ghost"
						data-testid="route-error-ask"
						onClick={askCaddie}
					>
						Ask Caddie what happened
						</button>
					</div>
				</section>
		</div>
	);
}

const rootRoute = createRootRoute({
	component: () => <Outlet />,
	errorComponent: WorkspaceError,
	notFoundComponent: function WorkspaceNotFound() {
		// The gate keeps an incomplete account out of the chrome here too — a
		// mistyped URL must not become a way around onboarding.
		return (
			<OnboardingGate>
			<WorkspaceChrome nav="none">
				<div className="shell-loading">
					<section className="state-panel card-surface" data-testid="not-found">
						<span className="state-mascot" aria-hidden="true">
							<Mascot mood="stuck" size={56} />
						</span>
						<p className="kicker" data-tone="error">
							NOT FOUND
						</p>
						<h3 className="state-title">We couldn't find that page</h3>
						<p className="state-detail">
							The link may be old or mistyped. Your work is safe — everything lives in the workspace:{' '}
							<Link to="/">open the workspace</Link>.
						</p>
						<p className="state-detail">
					Paths under <code>/app</code> are the app; anything else returns the landing page — two halves,
						one product.
					</p>
					</section>
				</div>
			</WorkspaceChrome>
			</OnboardingGate>
		);
	},
});

/**
 * Shared ?project= selection + the mobile conversation pane flag. The redesign
 * keeps `?pane=channel` (mobile: show the conversation full-height) and still
 * ACCEPTS the legacy `?pane=brief|runs` so old deep links resolve to a real
 * surface (Home shows the brief; the old Runs pane is now the Build surface)
 * rather than throwing. `section` anchors the account menu inside Settings.
 */
function validateSearch(search: Record<string, unknown>): {
	project?: string;
	pane?: 'channel' | 'brief' | 'runs';
	section?: string;
} {
	const project = search.project;
	const pane = search.pane;
	const section = search.section;
	return {
		...(typeof project === 'string' && project.trim() !== '' ? { project } : {}),
		...(pane === 'channel' || pane === 'brief' || pane === 'runs' ? { pane } : {}),
		...(typeof section === 'string' && section.trim() !== '' ? { section } : {}),
	};
}

/**
 * /runs accepts ?tab=files|activity (v2: Build owns Files as a tab). Unknown
 * values fall back to the default activity tab.
 */
function validateRunsSearch(search: Record<string, unknown>): { project?: string; tab?: 'activity' | 'files'; pane?: 'channel' | 'brief' | 'runs' } {
	const base = validateSearch(search);
	const tab = search.tab;
	return {
		...base,
		...(tab === 'files' || tab === 'activity' ? { tab } : {}),
	};
}

/**
 * ?project=<id> + ?claim=<type> for the evidence inspector's focus mode, plus
 * ?open=score (v2: the "Score it yourself" drawer opens from the old /judge
 * links).
 */
function validateEvidenceSearch(search: Record<string, unknown>): { project?: string; claim?: string; open?: 'score' } {
	const project = search.project;
	const claim = search.claim;
	const open = search.open;
	return {
		...(typeof project === 'string' && project.trim() !== '' ? { project } : {}),
		...(typeof claim === 'string' && claim.trim() !== '' ? { claim } : {}),
		...(open === 'score' ? { open } : {}),
	};
}

/**
 * The stable shell layout (audit F01): WorkspaceChrome — and with it the
 * persistent conversation, the run transport and the channel store — mounts
 * ONCE here, above every page Outlet. Sibling navigation unmounts only the
 * page content, so drafts, transcript position and the live connection
 * survive same-context navigation. Each child declares its destination via
 * staticData.nav; the layout reads the deepest match.
 */
const shellLayoutRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: '_shell',
	component: function ShellLayout() {
		const matches = useMatches();
		const meta = (matches[matches.length - 1]?.staticData ?? {}) as {
			nav?: WorkspaceNavId;
		};
		return (
			<OnboardingGate><WorkspaceChrome nav={meta.nav ?? 'none'}>
				<Outlet />
			</WorkspaceChrome></OnboardingGate>
		);
	},
});

// --- global destinations -------------------------------------------------------

const homeRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/',
	validateSearch,
	staticData: { nav: 'brief' },
	component: Shell,
});

const discoverRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/discover',
	validateSearch,
	staticData: { nav: 'discover' },
	component: DiscoverPage,
});

const projectsRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/projects',
	validateSearch,
	staticData: { nav: 'projects' },
	component: ProjectsPage,
});

// The project workspace: Overview is the landing; Plan/Build/Submission and
// their siblings are separate routes that all render nav='project' so the
// conversation binds to the selected project.
//
// R06: the canonical workspace also accepts ?view=overview|plan|preview — the
// consolidated Overview · Plan · Preview model. Unknown values fall back to
// overview. Details remains reachable via the existing project-local routes
// (runs/evidence/artifacts) during the migration.
function validateProjectView(search: Record<string, unknown>): {
	project?: string;
	pane?: 'channel' | 'brief' | 'runs';
	section?: string;
	view?: 'overview' | 'plan' | 'preview';
} {
	const base = validateSearch(search);
	const view = search.view;
	return {
		...base,
		...(view === 'overview' || view === 'plan' || view === 'preview' ? { view } : {}),
	};
}

const projectRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/project',
	validateSearch: validateProjectView,
	staticData: { nav: 'project' },
	component: ProjectOverviewPage,
});

// --- account surfaces ----------------------------------------------------------

/** /search accepts ?q=<query> — the results page is a real URL (v2 §4). */
function validateSearchQuery(search: Record<string, unknown>): { project?: string; pane?: 'channel' | 'brief' | 'runs'; q?: string } {
	const base = validateSearch(search);
	const q = search.q;
	return {
		...base,
		...(typeof q === 'string' && q.trim() !== '' ? { q: q.slice(0, 200) } : {}),
	};
}

const searchRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/search',
	validateSearch: validateSearchQuery,
	staticData: { nav: 'account' },
	component: SearchPage,
});

// v2 (HANDOFF §2): /automations became Settings › Routines.
const automationsRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/automations',
	validateSearch,
	staticData: { nav: 'account' },
	beforeLoad: () => {
		throw redirect({ to: '/settings', search: { tab: 'routines' }, replace: true });
	},
	component: () => null,
});

// v2 (HANDOFF §2): /usage became Settings › Spending.
const usageRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/usage',
	validateSearch,
	staticData: { nav: 'account' },
	beforeLoad: () => {
		throw redirect({ to: '/settings', search: { tab: 'spending' }, replace: true });
	},
	component: () => null,
});

/** /settings accepts ?tab=profile|interests|tools|knows|accounts|routines|spending|appearance. */
function validateSettingsSearch(search: Record<string, unknown>): { project?: string; pane?: 'channel' | 'brief' | 'runs'; tab?: string } {
	const base = validateSearch(search);
	const tab = search.tab;
	return {
		...base,
		...(typeof tab === 'string' &&
		['profile', 'interests', 'tools', 'knows', 'accounts', 'routines', 'spending', 'appearance'].includes(tab)
			? { tab }
			: {}),
	};
}

const settingsRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/settings',
	validateSearch: validateSettingsSearch,
	staticData: { nav: 'account' },
	component: function SettingsPage() {
		return <Settings />;
	},
});

// v2 (HANDOFF §2): Project settings — General / Code / Routines / What Caddie
// knows / Archive. The project header's gear navigates here (U03).
const projectSettingsRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/project/settings',
	validateSearch,
	staticData: { nav: 'project' },
	component: ProjectSettingsPage,
});

const onboardingRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/onboarding',
	validateSearch,
	staticData: { nav: 'account' },
	component: function OnboardingPage() {
		// v2 (§4 Welcome): Caddie introduces itself and asks what to call you,
		// then hands straight off to the app — "what to build" is a conversation
		// with Caddie in the shell, not a separate start screen.
		return <OnboardingGate><OnboardingFlow /></OnboardingGate>;
	},
});

// --- project-local surfaces (all render nav='project') --------------------------

const designReviewRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/design-review',
	validateSearch,
	staticData: { nav: 'project' },
	component: DesignReviewPage,
});

const runsRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/runs',
	validateSearch: validateRunsSearch,
	staticData: { nav: 'project' },
	component: RunsPage,
});

// v2 (HANDOFF §2): /artifacts was the standalone Files page; Build now owns
// it as a tab. Old links land on the right tab, keeping ?project=.
const artifactsRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/artifacts',
	validateSearch,
	staticData: { nav: 'project' },
	beforeLoad: ({ search }) => {
		throw redirect({
			to: '/runs',
			search: { ...carryProject(search as Record<string, unknown>), tab: 'files' },
			replace: true,
		});
	},
	component: () => null,
});

// v2 (HANDOFF §2): /schedules became Project settings › Routines.
const schedulesRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/schedules',
	validateSearch,
	staticData: { nav: 'project' },
	beforeLoad: ({ search }) => {
		throw redirect({ to: '/project/settings', search: carryProject(search as Record<string, unknown>), hash: 'routines', replace: true });
	},
	component: () => null,
});

// v2 (HANDOFF §2): /tasks moved onto the Overview's to-do list. Old links
// land there, keeping ?project= and the #todo anchor.
const tasksRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/tasks',
	validateSearch,
	staticData: { nav: 'project' },
	beforeLoad: ({ search }) => {
		throw redirect({
			to: '/project',
			search: carryProject(search as Record<string, unknown>),
			hash: 'todo',
			replace: true,
		});
	},
	component: () => null,
});

const evidenceRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/evidence',
	validateSearch: validateEvidenceSearch,
	staticData: { nav: 'project' },
	component: EvidencePage,
});

// v2 (HANDOFF §2): /judge was the standalone judge review page; Check owns
// scoring as the "Score it yourself" drawer. Old links land there.
const judgeRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/judge',
	validateSearch,
	staticData: { nav: 'project' },
	beforeLoad: ({ search }) => {
		throw redirect({
			to: '/evidence',
			search: { ...carryProject(search as Record<string, unknown>), open: 'score' },
			replace: true,
		});
	},
	component: () => null,
});

const submissionRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/submission',
	validateSearch,
	staticData: { nav: 'project' },
	component: SubmissionPage,
});

// v2 (HANDOFF §2): /repositories became Project settings › Code.
const repositoriesRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/repositories',
	validateSearch,
	staticData: { nav: 'project' },
	beforeLoad: ({ search }) => {
		throw redirect({ to: '/project/settings', search: carryProject(search as Record<string, unknown>), hash: 'code', replace: true });
	},
	component: () => null,
});

// --- legacy deep-link redirects --------------------------------------------------
//
// The old Discovery route (/discovery) is now the account-level /discover. A
// saved bookmark or an in-flight link must land somewhere real, carrying the
// selected project through so the user is not silently dropped into a different
// context. /discover ignores ?project= for its own data (it reads the account
// scope), but we keep the param so returning to a project is one click away.

function carryProject(search: Record<string, unknown>): Record<string, unknown> {
	const project = search.project;
	return typeof project === 'string' && project.trim() !== '' ? { project } : {};
}

const legacyDiscoveryRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/discovery',
	validateSearch,
	staticData: { nav: 'discover' },
	beforeLoad: ({ search }) => {
		throw redirect({ to: '/discover', search: carryProject(search as Record<string, unknown>), replace: true });
	},
	component: () => null,
});

export const routeTree = rootRoute.addChildren([
	onboardingRoute,
	shellLayoutRoute.addChildren([
		homeRoute,
	discoverRoute,
	projectsRoute,
	projectRoute,
	searchRoute,
	automationsRoute,
	usageRoute,
	settingsRoute,
	designReviewRoute,
	runsRoute,
artifactsRoute,
		schedulesRoute,
		tasksRoute,
		evidenceRoute,
	judgeRoute,
	submissionRoute,
	repositoriesRoute,
		projectSettingsRoute,
		legacyDiscoveryRoute,
	]),
]);

function detectBasepath(): string {
	return typeof window !== 'undefined' && window.location.pathname.startsWith('/app') ? '/app' : '/';
}

export const router = createRouter({
	routeTree,
	history: createBrowserHistory(),
	basepath: detectBasepath(),
	defaultPreload: 'intent',
	// Any route that throws without its own errorComponent falls back to the
	// designed FAULT page instead of the router's unstyled default box.
	defaultErrorComponent: WorkspaceError,
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
