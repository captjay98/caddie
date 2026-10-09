import { Link, Outlet, createBrowserHistory, createRootRoute, createRoute, createRouter, redirect, useMatches } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { WorkspaceChrome, type WorkspaceNavId } from './workspace/Chrome.tsx';
import { Shell } from './workspace/Shell.tsx';
import { Settings } from './settings/Settings.tsx';
import { Start, IdeaForm } from './onboarding/Start.tsx';
import {
	DiscoverPage,
	ProjectsPage,
	ProjectOverviewPage,
	SearchPage,
	AutomationsPage,
	UsagePage,
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
 * TanStack Router setup (SPA mode) for the discovery-first shell.
 *
 * The Worker serves the SPA under /app with a client-routing fallback
 * (tests/routing.test.ts), so the browser history basepath is /app in the
 * composed build; `bun run dev` serves at the root. The selected project lives
 * in the ?project= search param — refresh and deep links retain it.
 *
 * THREE GLOBAL DESTINATIONS only (Home · Discover · Projects) plus account
 * surfaces (Search/Automations/Usage/Settings) and the project-local surfaces
 * (Overview/Plan/Build/Submission and their nested siblings). Every route renders
 * inside WorkspaceChrome, so no destination is a chrome-less dead end and the
 * persistent conversation is always present with an explicit context label.
 */

const rootRoute = createRootRoute({
	component: () => <Outlet />,
	notFoundComponent: function WorkspaceNotFound() {
		return (
			<WorkspaceChrome nav="none">
				<div className="shell-loading">
					<section className="state-panel card-surface">
						<p className="kicker" data-tone="error">
							NOT FOUND
						</p>
						<h3 className="state-title">This workspace path does not exist</h3>
						<p className="state-detail">
							Everything lives under the workspace root: <Link to="/">open the workspace</Link>.
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

/** ?project=<id> + ?claim=<type> for the evidence inspector's focus mode. */
function validateEvidenceSearch(search: Record<string, unknown>): { project?: string; claim?: string } {
	const project = search.project;
	const claim = search.claim;
	return {
		...(typeof project === 'string' && project.trim() !== '' ? { project } : {}),
		...(typeof claim === 'string' && claim.trim() !== '' ? { claim } : {}),
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
			<WorkspaceChrome nav={meta.nav ?? 'none'}>
				<Outlet />
			</WorkspaceChrome>
		);
	},
});

// --- global destinations -------------------------------------------------------

const homeRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/',
	validateSearch,
	staticData: { nav: 'home' },
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
const projectRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/project',
	validateSearch,
	staticData: { nav: 'project' },
	component: ProjectOverviewPage,
});

// --- account surfaces ----------------------------------------------------------

const searchRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/search',
	validateSearch,
	staticData: { nav: 'account' },
	component: SearchPage,
});

const automationsRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/automations',
	validateSearch,
	staticData: { nav: 'account' },
	component: AutomationsPage,
});

const usageRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/usage',
	validateSearch,
	staticData: { nav: 'account' },
	component: UsagePage,
});

const settingsRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/settings',
	validateSearch,
	staticData: { nav: 'account' },
	component: function SettingsPage() {
		return <Settings />;
	},
});

const onboardingRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/onboarding',
	validateSearch,
	staticData: { nav: 'account' },
	component: function OnboardingPage() {
		// The idea capture (audit S17) is the real primary path here: name +
		// plain-words idea -> one project -> straight into it.
		return (
			<div className="shell-loading shell-page">
				<div className="page-col">
					<Start ideaForm={<IdeaForm />} />
				</div>
			</div>
		);
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
	validateSearch,
	staticData: { nav: 'project' },
	component: RunsPage,
});

const artifactsRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/artifacts',
	validateSearch,
	staticData: { nav: 'project' },
	component: ArtifactsPage,
});

const schedulesRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/schedules',
	validateSearch,
	staticData: { nav: 'project' },
	component: SchedulesPage,
});

const evidenceRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/evidence',
	validateSearch: validateEvidenceSearch,
	staticData: { nav: 'project' },
	component: EvidencePage,
});

const judgeRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/judge',
	validateSearch,
	staticData: { nav: 'project' },
	component: JudgePage,
});

const submissionRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/submission',
	validateSearch,
	staticData: { nav: 'project' },
	component: SubmissionPage,
});

const repositoriesRoute = createRoute({
	getParentRoute: () => shellLayoutRoute,
	path: '/repositories',
	validateSearch,
	staticData: { nav: 'project' },
	component: RepositoriesPage,
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
	shellLayoutRoute.addChildren([
		homeRoute,
	discoverRoute,
	projectsRoute,
	projectRoute,
	searchRoute,
	automationsRoute,
	usageRoute,
	settingsRoute,
	onboardingRoute,
	designReviewRoute,
	runsRoute,
	artifactsRoute,
	schedulesRoute,
	evidenceRoute,
	judgeRoute,
	submissionRoute,
	repositoriesRoute,
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
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}
