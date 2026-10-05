import { createRootRoute, createRoute, createRouter, Outlet, createBrowserHistory } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Shell } from './workspace/Shell.tsx';

/**
 * TanStack Router setup (SPA mode, decision "Product UI: React SPA +
 * Router/Query on the Flue Hono worker").
 *
 * The Worker serves the SPA under /app with a client-routing fallback
 * (tests/routing.test.ts), so the browser history basepath is /app in the
 * composed build; `bun run dev` serves at the root. The selected project
 * lives in the ?project= search param — refresh (and deep links) retain it.
 */

const rootRoute = createRootRoute({
	component: () => <Outlet />,
	notFoundComponent: function WorkspaceNotFound() {
		return (
			<main className="shell-loading">
				<section className="state-panel card-surface">
					<p className="kicker">NOT FOUND</p>
					<h3 className="state-title">This workspace path does not exist</h3>
					<p className="state-detail">
						Everything lives under the workspace root: <a href="./">open the workspace</a>.
					</p>
				</section>
			</main>
		);
	},
});

/** ?project=<id> — the only client search param; refresh retains selection. */
function validateSearch(search: Record<string, unknown>): { project?: string } {
	const project = search.project;
	return typeof project === 'string' && project.trim() !== '' ? { project } : {};
}

const workspaceRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	validateSearch,
	component: Shell,
});

export const routeTree = rootRoute.addChildren([workspaceRoute]);

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
