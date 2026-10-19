// FIRST, before routes.tsx creates the router: a link shared into Caddie
// leaves the address and waits in sessionStorage (share-target.ts).
import './share-capture.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './routes.tsx';
import { registerServiceWorker } from './pwa.ts';
import { applyTheme, browserStorage, readStoredTheme } from './theme.ts';
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
import '@caddie/ui/mascot.css';
import './workspace.css';

/**
 * Workspace SPA entry. P00 proved composition under /app; P06 replaces the
 * scaffold with the TanStack Router/Query shell over the halo tokens.
 *
 * Theme: the pre-paint script in index.html puts the saved palette + mode on
 * <html data-palette data-theme> before the stylesheet paints. Re-applying it
 * here covers entries that load this module without that HTML (harnesses).
 * Fonts are the self-hosted @fontsource imports above — nothing is fetched
 * from a CDN at runtime.
 */

applyTheme(readStoredTheme(browserStorage()));

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

// Installed-app support (pwa.ts): the built app under /app only.
registerServiceWorker();
