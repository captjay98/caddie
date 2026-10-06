import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { createArtifactsRouter } from './artifacts.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';
import {
	createPreview,
	extendPreview,
	listPreviews,
	logPreviewAccess,
	revokePreview,
	resolvePreview,
	unknownTokenMarker,
} from '../previews.ts';
import { sandboxHeaders } from '../artifacts.ts';

/**
 * P07 previews router. Two surfaces with deliberately different authority:
 *
 *   /api/projects/:projectId/previews       authenticated USER surface
 *     POST   /                              mint a token (secret returned ONCE)
 *     GET    /                              list (metadata only, no secrets)
 *     POST   /:previewId/revoke             share-off (membership required)
 *     POST   /:previewId/extend             new window from now (membership)
 *
 *   /api/previews/resolve/:token            PUBLIC resolution — TOKEN-ONLY
 *     The token in the path IS the credential. No session, no cookie, no
 *     header is read, so a separate isolated origin can serve previews.
 *       valid + unexpired + not revoked -> 200 bytes with the sandbox class
 *           of headers (CSP sandbox + nosniff + no-store): previewed content
 *           runs in an opaque origin and can never read Caddie cookies
 *       unknown or malformed token      -> 404 { error: 'not_found' }
 *           (existence is never confirmed; no 401/403 distinction)
 *       expired or revoked              -> 410 { error: 'preview_gone', reason }
 *     Every attempt appends a preview_access_log row (served | denied | gone).
 *
 * Typed ScopeErrors map to `{ error, message }` via the router-level onError.
 *
 * Exports:
 *   - createPreviewsRouter(): the /api-mounted preview routes (PROPOSED app.ts
 *     mount diff in docs/setup/previews.md).
 *   - createPreviewsApp(): the full P07 /api composition (auth + projects +
 *     artifacts + previews) — the mount shape app.ts will use, wrapped for
 *     the local workerd fixture and tests.
 */

type Env = AuthEnv;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled previews route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
}

export function createPreviewsRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- management (authenticated, project-scoped) --------------------------------
	router.post('/projects/:projectId/previews', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const created = await createPreview(c.env.DB, scope, (await readJson(c.req.raw)) as never);
		return c.json({ preview: created.preview, token: created.token }, 201);
	});

	router.get('/projects/:projectId/previews', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ previews: await listPreviews(c.env.DB, scope) });
	});

	router.post('/projects/:projectId/previews/:previewId/revoke', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const preview = await revokePreview(c.env.DB, scope, c.req.param('previewId') ?? '');
		return c.json({ preview });
	});

	router.post('/projects/:projectId/previews/:previewId/extend', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const body = (await readJson(c.req.raw)) as { ttlSeconds?: unknown };
		const preview = await extendPreview(c.env.DB, scope, c.req.param('previewId') ?? '', body.ttlSeconds);
		return c.json({ preview });
	});

	// --- resolution (PUBLIC, token-only) ---------------------------------------------
	router.get('/previews/resolve/:token', async (c) => {
		const token = c.req.param('token');
		const resolution = await resolvePreview(c.env.DB, token);
		if (resolution.outcome === 'served') {
			await logPreviewAccess(c.env.DB, {
				tokenId: resolution.preview.id,
				projectId: resolution.preview.projectId,
				path: c.req.path,
				outcome: 'served',
			});
			return new Response(resolution.bytes.slice().buffer as ArrayBuffer, {
				status: 200,
				headers: {
					...sandboxHeaders(resolution.revision.contentType, resolution.bytes),
					// previews are shared links: never cached anywhere
					'cache-control': 'no-store',
				},
			});
		}
		if (resolution.outcome === 'gone') {
			await logPreviewAccess(c.env.DB, {
				tokenId: await unknownTokenMarker(token),
				path: c.req.path,
				outcome: 'gone',
			});
			return c.json({ error: 'preview_gone', reason: resolution.reason }, 410);
		}
		await logPreviewAccess(c.env.DB, {
			tokenId: await unknownTokenMarker(token),
			path: c.req.path,
			outcome: 'denied',
		});
		return c.json({ error: 'not_found' }, 404);
	});

	return router;
}

/**
 * The full P07 /api composition — auth, P02 projects, P07 artifacts and P07
 * previews — exactly the mount app.ts will use. The local workerd fixture
 * wraps this to add its /__test control routes.
 */
export function createPreviewsApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.route('/api', createArtifactsRouter());
	app.route('/api', createPreviewsRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
