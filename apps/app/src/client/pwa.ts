/**
 * Service worker registration for the installed app (apps/app/public/sw.js).
 *
 * Only the built app registers it, and only under /app: `bun run dev` serves
 * the SPA at / with no worker file (its /app fallback would answer with the
 * HTML shell, which a browser refuses as a script). The worker lives at /sw.js
 * because Vite puts public files at the asset root; the scope keeps it to /app/,
 * so the landing page and the report page are never controlled by it.
 */

export const SERVICE_WORKER_URL = '/sw.js';
export const SERVICE_WORKER_SCOPE = '/app/';

export function shouldRegisterServiceWorker(env: { production: boolean; pathname: string; supported: boolean }): boolean {
	return env.production && env.supported && (env.pathname === '/app' || env.pathname.startsWith('/app/'));
}

export function registerServiceWorker(): void {
	if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
	const ok = shouldRegisterServiceWorker({
		production: import.meta.env.PROD,
		pathname: window.location.pathname,
		supported: 'serviceWorker' in navigator,
	});
	if (!ok) return;
	const register = () => {
		// A refusal (private mode, a blocked worker) leaves the app working online.
		navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE }).catch(() => {});
	};
	// After load, so the worker's install fetches never compete with first paint.
	if (document.readyState === 'complete') register();
	else window.addEventListener('load', register, { once: true });
}
