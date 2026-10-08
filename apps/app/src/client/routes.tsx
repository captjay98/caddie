import { Link, createRootRoute, createRoute, createRouter, Outlet, createBrowserHistory } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { WorkspaceChrome } from './workspace/Chrome.tsx';
import { Shell } from './workspace/Shell.tsx';
import { Settings } from './settings/Settings.tsx';
import { Start } from './onboarding/Start.tsx';
import {
	DiscoveryPage,
	JudgePage,
	SubmissionPage,
	SchedulesPage,
	EvidencePage,
	ArtifactsPage,
	RunsPage,
	DesignReviewPage,
	RepositoriesPage,
} from './surface.tsx';

/**
 * TanStack Router setup (SPA mode, decision "Product UI: React SPA +
 * Router/Query on the Flue Hono worker").
 *
 * The Worker serves the SPA under /app with a client-routing fallback
 * (tests/routing.test.ts), so the browser history basepath is /app in the
 * composed build; `bun run dev` serves at the root. The selected project
 * lives in the ?project= search param — refresh (and deep links) retain it.
 *
 * Shared chrome (UI review board screen 16): the workspace, settings,
 * onboarding, the four gate surfaces and the not-found all render inside
 * WorkspaceChrome, so no destination is a chrome-less `<main>` dead end.
 */

const rootRoute = createRootRoute({
	component: () => <Outlet />,
	notFoundComponent: function WorkspaceNotFound() {
		return (
			<WorkspaceChrome active="none">
				<div className="shell-loading">
					<section className="state-panel card-surface">
						<p className="kicker" data-tone="error">
							NOT FOUND
						</p>
						<h3 className="state-title">This workspace path does not exist</h3>
						<p className="state-detail">
							Everything lives under the workspace root: <a href="./">open the workspace</a>.
						</p>
						<p className="state-detail">
							Paths under <code>/app</code> are the SPA; anything else returns the landing page — two halves, one
							product.
						</p>
					</section>
				</div>
			</WorkspaceChrome>
		);
	},
});

/** ?project=<id> — the client search params; refresh retains selection.
 *  ?pane=<brief|runs|channel> is the mobile bottom nav's payload on the
 *  workspace route (which pane the home shows). */
function validateSearch(search: Record<string, unknown>): { project?: string; pane?: 'brief' | 'runs' | 'channel' } {
	const project = search.project;
	const pane = search.pane;
	return {
		...(typeof project === 'string' && project.trim() !== '' ? { project } : {}),
		...(pane === 'brief' || pane === 'runs' || pane === 'channel' ? { pane } : {}),
	};
}

const workspaceRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	validateSearch,
	component: Shell,
});

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
	validateSearch,
	component: function SettingsPage() {
		return (
			<WorkspaceChrome active="settings" crumbs={<><Link to="/" search={(prev: Record<string, unknown>) => ({ ...prev })}>← Workspace</Link><span>Settings</span></>}>
				<Settings />
			</WorkspaceChrome>
		);
	},
});

const onboardingRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/onboarding',
	validateSearch,
	component: function OnboardingPage() {
		return (
			<WorkspaceChrome
				active="none"
				crumbs={<span>Start a project · step 1 of 4 · start → connect → brief → first run</span>}
			>
				<Start />
			</WorkspaceChrome>
		);
	},
});

// P11/P13 surfaces — the slice-3 components mounted behind the shared
// fail-closed gate (surface.tsx): sign-in for unverified sessions, the
// ?project= param resolved against the actor's own project list.
const discoveryRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/discovery',
	validateSearch,
	component: DiscoveryPage,
});

const judgeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/judge',
	validateSearch,
	component: JudgePage,
});

const submissionRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/submission',
	validateSearch,
	component: SubmissionPage,
});

// P12 schedules — the same fail-closed gate, over the real P12 REST surface.
const schedulesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/schedules',
	validateSearch,
	component: SchedulesPage,
});

/** ?project=<id> + ?claim=<type> for the evidence inspector's focus mode. */
function validateEvidenceSearch(search: Record<string, unknown>): { project?: string; claim?: string } {
	const project = search.project;
	const claim = search.claim;
	return {
		...(typeof project === 'string' && project.trim() !== '' ? { project } : {}),
		...(typeof claim === 'string' && claim.trim() !== '' ? { claim } : {}),
	};
}

// Board phase 3: the P10 evidence inspector — reachable from decision-card
// evidence ids and run rows, behind the same fail-closed gate.
const evidenceRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/evidence',
	validateSearch: validateEvidenceSearch,
	component: EvidencePage,
});

// Board phase 3: the P07 artifact viewer — reachable from run rows and the
// brief's stale-artifact cards, behind the same fail-closed gate.
const artifactsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/artifacts',
	validateSearch,
	component: ArtifactsPage,
});

// The Build stage's Activity page — the nav's Build link finally has a real
// route behind it (the old nav pointed at /runs with no route: NOT FOUND).
const runsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/runs',
	validateSearch,
	component: RunsPage,
});

// Board phase 3: the design gate — reachable from the brief's approval cards,
// behind the same fail-closed gate.
const designReviewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/design-review',
	validateSearch,
	component: DesignReviewPage,
});

// Board phase 3: the P08 GitHub App surface — reachable from onboarding's
// "start from a repository" card, behind the same fail-closed gate.
const repositoriesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/repositories',
	validateSearch,
	component: RepositoriesPage,
});

export const routeTree = rootRoute.addChildren([
	workspaceRoute,
	settingsRoute,
	onboardingRoute,
	discoveryRoute,
	judgeRoute,
	submissionRoute,
	schedulesRoute,
	evidenceRoute,
	artifactsRoute,
	runsRoute,
	designReviewRoute,
	repositoriesRoute,
]);

function detectBasepath(): string {
	return typeof window !== 'undefined' && window.location.pathname.startsWith('/app') ? '/app' : '/';
}

export const router = createRouter({
	routeTree,
	history: createBrowserHistory(),
	basepath: detectBasepath(),
	defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
