import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './routes.tsx';
// Same self-hosted faces the landing uses (site/src/pages/index.astro) — the
// token stacks (--font-ui/--font-mono) name Inter and IBM Plex Mono first.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource/ibm-plex-mono/700.css';
import '@caddie/ui/tokens.css';
import '@caddie/ui/markdown.css';
import './workspace.css';

/**
 * Workspace SPA entry. P00 proved composition under /app; P06 replaces the
 * scaffold with the TanStack Router/Query shell over the halo tokens.
 *
 * Theme: the halo tokens default to dark; a persisted light preference is
 * applied to <html data-theme> before first paint. Fonts are the self-hosted
 * @fontsource imports above — nothing is fetched from a CDN at runtime.
 */

try {
	const saved = localStorage.getItem('caddie-theme');
	document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
} catch {
	document.documentElement.setAttribute('data-theme', 'dark');
}

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// The explicit state surfaces own failure rendering; a blind retry
			// storm would fight the honest denied/limit/offline grammar.
			retry: false,
			refetchOnWindowFocus: true,
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
