import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Settings } from '../../../apps/app/src/client/settings/Settings.tsx';
import { Search } from '../../../apps/app/src/client/search/Search.tsx';
import { Search } from '../../../apps/app/src/client/search/Search.tsx';

// Settings now legitimately uses router context (useSearch for ?section=,
// Link in search results — audit F11), so the harness mounts it under a
// minimal router, exactly like the real shell does.
const rootRoute = createRootRoute({ component: () => <Outlet /> });
const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: () => <Settings />,
});
const searchRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/search',
	component: () => <Search />,
});
// The v2 settings tabs navigate to /settings?tab=… — give the harness the
// same path so tab clicks resolve.
const settingsPathRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/settings',
	component: () => <Settings />,
});
const routeTree = rootRoute.addChildren([settingsRoute, settingsPathRoute, searchRoute]);
const router = createRouter({ routeTree, basepath: '/' });

/**
 * Test-only harness page for tests/browser/settings.spec.ts: mounts the REAL
 * Settings/Memory/Search components with the same QueryClient defaults the
 * app uses. It is served by the spec's own local HTTP server and all /api
 * requests are stubbed at the network layer (Playwright route interception),
 * exactly like the P06 workspace.spec UI-state proofs — the real API
 * behavior is covered by the P14 integration suites against workerd+D1.
 */

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: false,
			refetchOnWindowFocus: false,
			staleTime: 10_000,
		},
	},
});

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</StrictMode>,
);
