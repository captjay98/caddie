import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './routes.tsx';
import '@caddie/ui/tokens.css';
import '@caddie/ui/markdown.css';
import './workspace.css';

/**
 * Workspace SPA entry. P00 proved composition under /app; P06 replaces the
 * scaffold with the TanStack Router/Query shell over the halo tokens.
 *
 * Theme: the halo tokens default to dark; a persisted light preference is
 * applied to <html data-theme> before first paint. No runtime font/CDN
 * fetches — the token font stacks fall back to system faces here.
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
