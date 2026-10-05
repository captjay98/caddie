import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Hello } from './agents/hello.ts';
import { createAuthRouter } from './server/routes/auth.ts';
import { createProjectsRouter } from './server/routes/projects.ts';
import { createApprovalsRouter } from './server/routes/approvals.ts';
import { createEvidenceRouter } from './server/routes/evidence.ts';
import type { AuthEnv } from './server/auth.ts';

/**
 * The Worker's single fetch entry. Composition order:
 *
 *   /api/*      product API (auth: Better Auth under /api/auth/*; projects:
 *               workspaces/projects/plan-docs/run-bindings/artifacts; JSON
 *               404 fallback for unknown paths)
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
	DB: AuthEnv['DB'];
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	INVITE_ALLOWLIST?: string;
};

const app = new Hono<{ Bindings: Env }>();

// --- product API -----------------------------------------------------------
const api = new Hono<{ Bindings: Env }>();
api.route('/', createAuthRouter());
api.route('/', createProjectsRouter());
api.route('/', createApprovalsRouter());
api.route('/', createEvidenceRouter());
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
