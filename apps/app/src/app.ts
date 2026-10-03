import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Hello } from './agents/hello.ts';

/**
 * The Worker's single fetch entry. Composition order:
 *
 *   /api/*      product API (auth router arrives in P01; JSON 404 fallback)
 *   /agents/*   Flue agent routers, one mount per agent identity
 *   /app/*      React SPA assets, deep links falling back to /app/index.html
 *   everything else: served straight from the composed assets tree (Astro
 *               landing at /) by the Workers asset layer — only /api,
 *               /agents and /app are run_worker_first.
 */

type AssetsBinding = {
	fetch(request: Request): Promise<Response>;
};

type Env = {
	ASSETS?: AssetsBinding;
};

const app = new Hono<{ Bindings: Env }>();

// --- product API -----------------------------------------------------------
// P01 replaces this stub with the real auth router; the mount point and the
// JSON 404 contract below are the frozen composition surface.
const api = new Hono<{ Bindings: Env }>();
api.get('/auth/status', (c) => c.json({ authenticated: false }));
app.route('/api', api);

// --- agents ----------------------------------------------------------------
// One mount per agent identity; specialist agents are added in P05 with
// their own DO migration tags.
app.route('/agents/hello', createAgentRouter(Hello));

// --- SPA under /app --------------------------------------------------------
app.get('/app', (c) => c.redirect('/app/', 307));
app.get('/app/*', async (c) => {
	const assets = c.env?.ASSETS;
	if (!assets) return c.json({ error: 'assets_not_configured' }, 500);
	const asset = await assets.fetch(c.req.raw);
	if (asset.status !== 404) return asset;
	// Client-side routing fallback: any /app/* path without a file serves
	// the SPA shell.
	return assets.fetch(new Request(new URL('/app/index.html', c.req.url)));
});

// --- fallbacks -------------------------------------------------------------
app.notFound((c) => {
	if (c.req.path.startsWith('/api') || c.req.path.startsWith('/agents')) {
		return c.json({ error: 'not_found' }, 404);
	}
	const assets = c.env?.ASSETS;
	if (!assets) return c.json({ error: 'assets_not_configured' }, 500);
	return assets.fetch(c.req.raw);
});

app.onError((err, c) => {
	console.error('unhandled worker error:', err);
	return c.json({ error: 'internal_error' }, 500);
});

export default app;
