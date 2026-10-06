import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { ScopeError, requireProjectScope } from '../scope.ts';
import {
	diffArtifactRevisions,
	getArtifact,
	listArtifacts,
	readArtifact,
	sandboxHeaders,
	storeArtifact,
	contentDisposition,
} from '../artifacts.ts';

/**
 * P07 artifacts router — content-addressed artifact revisions over the P02
 * scope patterns: every route derives its Scope server-side from the verified
 * session + membership (never the body) and the service layer re-verifies the
 * scope against D1 at entry. Typed ScopeErrors map to `{ error, message }`
 * with their status via the router-level onError; anything else is a 500
 * without internals.
 *
 * Content responses (inline + download) ALWAYS carry the sandbox class of
 * headers — `Content-Security-Policy: sandbox` (unique opaque origin for the
 * document: generated JS can never read Caddie cookies or storage) and
 * `X-Content-Type-Options: nosniff` (bytes are never re-sniffed into an
 * executable type). The download route adds a sanitized
 * `Content-Disposition: attachment` so a navigation always lands on disk,
 * never in the app origin.
 *
 * Exports:
 *   - createArtifactsRouter(): the /api-mounted artifact routes (app.ts
 *     composes this next to the auth/projects/previews routers — PROPOSED
 *     mount diff in docs/setup/previews.md).
 *   - createArtifactsApp(): the full /api composition (auth + projects +
 *     artifacts) for the local workerd fixture and tests.
 */

type Env = AuthEnv;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled artifacts route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
}

/**
 * Binary content response. The body is handed over as a standalone
 * ArrayBuffer (a copy, so the store's view is never detached); the cast keeps
 * this file free of DOM type names — the root typecheck program has no DOM
 * lib, only the app program does.
 */
function bytesResponse(bytes: Uint8Array, status: number, headers: Record<string, string>): Response {
	return new Response(bytes.slice().buffer as ArrayBuffer, { status, headers });
}

export function createArtifactsRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- store / list ------------------------------------------------------------
	router.post('/projects/:projectId/artifact-revisions', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const artifact = await storeArtifact(c.env.DB, scope, (await readJson(c.req.raw)) as never);
		return c.json({ artifact }, 201);
	});

	router.get('/projects/:projectId/artifact-revisions', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const kind = c.req.query('kind') || undefined;
		const artifacts = await listArtifacts(c.env.DB, scope, kind);
		return c.json({ artifacts, latest: artifacts[0] ?? null });
	});

	// --- diff (declared before :revisionId content routes? distinct paths — fine) ----
	router.get('/projects/:projectId/artifact-revisions/:toId/diff', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const fromId = c.req.query('from') ?? '';
		const diff = await diffArtifactRevisions(c.env.DB, scope, fromId, c.req.param('toId') ?? '');
		return c.json({ diff });
	});

	// --- single revision metadata ------------------------------------------------------
	router.get('/projects/:projectId/artifact-revisions/:revisionId', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		return c.json({ artifact: await getArtifact(c.env.DB, scope, c.req.param('revisionId') ?? '') });
	});

	// --- content: inline view (sandboxed, no download dance) -----------------------------
	router.get('/projects/:projectId/artifact-revisions/:revisionId/content', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const { revision, bytes } = await readArtifact(
			c.env.DB,
			scope,
			c.req.param('revisionId') ?? '',
		);
		return bytesResponse(bytes, 200, {
			...sandboxHeaders(revision.contentType, bytes),
			'content-disposition': contentDisposition('inline', revision.filename),
			'cache-control': 'private, no-store',
		});
	});

	// --- export: attachment download ------------------------------------------------------
	router.get('/projects/:projectId/artifact-revisions/:revisionId/download', async (c) => {
		const scope = await requireProjectScope(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('projectId'),
		);
		const { revision, bytes } = await readArtifact(
			c.env.DB,
			scope,
			c.req.param('revisionId') ?? '',
		);
		return bytesResponse(bytes, 200, {
			...sandboxHeaders(revision.contentType, bytes),
			'content-disposition': contentDisposition('attachment', revision.filename),
			'cache-control': 'private, no-store',
		});
	});

	return router;
}

/**
 * The full /api composition — the auth router, the P02 projects router and
 * the P07 artifacts router — the same mount shape app.ts uses. The local
 * workerd fixture wraps this to add its /__test control routes.
 */
export function createArtifactsApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.route('/api', createArtifactsRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
