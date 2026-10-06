import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Settings } from '../../../apps/app/src/client/settings/Settings.tsx';

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
			<Settings />
		</QueryClientProvider>
	</StrictMode>,
);
