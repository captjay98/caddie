import { Hono } from 'hono';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { createApprovalsRouter } from './approvals.ts';
import { ScopeError, requireProjectScope, requireWorkspaceScope, sessionUserId } from '../scope.ts';
import { GithubError, verifyWebhookSignature, type GithubEnv } from '../adapters/github.ts';
import {
	DeliveryGateError,
	bindInstallation,
	connectAndLinkRepo,
	createAndLinkRepo,
	deliverPatch,
	getProjectRepo,
	githubClientFromEnv,
	getInstallationForActor,
	importRepoSnapshot,
	listImports,
	listInstallations,
	listSelectedRepos,
	processGithubWebhook,
} from '../repositories.ts';

/**
 * P08 github router — the GitHub App surface.
 *
 *   POST /api/github/webhook                    GitHub -> Caddie. NO session:
 *                                               x-hub-signature-256 verified
 *                                               over the RAW bytes (fail-closed
 *                                               without a secret), delivery
 *                                               GUID deduped durably before any
 *                                               state changes.
 *   POST /api/github/installations/bind         explicit USER action binding an
 *                                               installation to a workspace
 *                                               (session + membership; metadata
 *                                               resolved live from the App API).
 *   GET  /api/github/installations              installations of the scoped workspace
 *   GET  /api/github/installations/:id/repos    selected repositories (owning-workspace members only)
 *
 * Project-scoped import/delivery routes are appended in slice 2.
 *
 * Exports:
 *   - createGithubRouter(): the /api-mounted github routes (app.ts composes
 *     this next to the auth/projects/approvals routers).
 *   - createGithubApp(): the full /api composition (auth + projects +
 *     approvals + github) — the same mount app.ts uses, wrapped for the local
 *     workerd fixture and tests.
 */

type Env = GithubEnv;

function errorJson(error: unknown): { status: number; body: { error: string; message?: string; operationKey?: string; revisionHash?: string } } {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	if (error instanceof DeliveryGateError) {
		// the approval gate refused: surface the EXACT intent so the user can
		// approve precisely this effect (the route never re-asks GitHub)
		return {
			status: error.gate.status,
			body: {
				error: error.gate.code,
				message: error.gate.message,
				operationKey: error.operationKey,
				revisionHash: error.revisionHash,
			},
		};
	}
	if (error instanceof GithubError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	console.error('unhandled github route error:', error);
	return { status: 500, body: { error: 'internal_error' } };
}

async function requireSessionActorId(env: Env, headers: Headers): Promise<string> {
	const userId = await sessionUserId(env, headers);
	if (!userId) {
		throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
	}
	return userId;
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ScopeError(400, 'invalid_input', 'body must be valid JSON');
	}
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new ScopeError(400, 'invalid_request', `${field} is required`);
	}
	return value.trim();
}

export function createGithubRouter(): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();

	router.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});

	// --- webhook (GitHub -> Caddie; signature IS the authentication) ---------------
	router.post('/github/webhook', async (c) => {
		const raw = await c.req.text();
		const bytes = new TextEncoder().encode(raw);
		const signature = c.req.header('x-hub-signature-256');
		// Fail-closed: without GITHUB_WEBHOOK_SECRET nothing is ever valid.
		const secret = (c.env.GITHUB_WEBHOOK_SECRET ?? '').trim() || null;
		if (!(await verifyWebhookSignature(secret, bytes, signature))) {
			throw new ScopeError(401, 'invalid_signature', 'webhook signature missing or invalid');
		}
		const deliveryId = c.req.header('x-github-delivery');
		const event = c.req.header('x-github-event');
		if (!deliveryId || !event) {
			throw new ScopeError(400, 'invalid_request', 'x-github-delivery and x-github-event are required');
		}
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			throw new ScopeError(400, 'invalid_input', 'webhook body must be valid JSON');
		}
		const result = await processGithubWebhook(c.env.DB, { event, deliveryId, payload });
		return c.json({ result }, 202);
	});

	// --- installation binding (explicit user action) ----------------------------------
	router.post('/github/installations/bind', async (c) => {
		await requireSessionActorId(c.env, c.req.raw.headers);
		const body = await readJson(c.req.raw);
		const installationId = requireNonEmptyString(
			(body as { installationId?: unknown })?.installationId,
			'installationId',
		);
		const workspaceId = requireNonEmptyString(
			(body as { workspaceId?: unknown })?.workspaceId,
			'workspaceId',
		);
		const scope = await requireWorkspaceScope(c.env.DB, c.env, c.req.raw.headers, workspaceId);
		// githubClientFromEnv -> readGithubConfig fails closed (typed 503) before any write.
		const client = githubClientFromEnv(c.env);
		const installation = await bindInstallation(c.env.DB, client, scope, installationId);
		return c.json({ installation }, 201);
	});

	router.get('/github/installations', async (c) => {
		await requireSessionActorId(c.env, c.req.raw.headers);
		const workspaceId = requireNonEmptyString(c.req.query('workspaceId'), 'workspaceId');
		const scope = await requireWorkspaceScope(c.env.DB, c.env, c.req.raw.headers, workspaceId);
		return c.json({ installations: await listInstallations(c.env.DB, scope) });
	});

	router.get('/github/installations/:installationId/repos', async (c) => {
		await requireSessionActorId(c.env, c.req.raw.headers);
		const repositories = await listSelectedRepos(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('installationId'),
		);
		return c.json({ repositories });
	});

	router.get('/github/installations/:installationId', async (c) => {
		await requireSessionActorId(c.env, c.req.raw.headers);
		const installation = await getInstallationForActor(
			c.env.DB,
			c.env,
			c.req.raw.headers,
			c.req.param('installationId'),
		);
		return c.json({ installation });
	});

	// --- project-scoped import / delivery (scope derived server-side) -----------------
	router.post('/projects/:projectId/github/imports', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		// githubClientFromEnv -> readGithubConfig fails closed (typed 503).
		const client = githubClientFromEnv(c.env);
		const imported = await importRepoSnapshot(c.env.DB, client, scope, await readJson(c.req.raw));
		return c.json({ import: imported }, 201);
	});

	router.get('/projects/:projectId/github/imports', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		return c.json({ imports: await listImports(c.env.DB, scope) });
	});

	// --- guided GitHub step: create a new repo / connect existing / read link ---------
	router.post('/projects/:projectId/github/repos', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		// Fails closed with a typed 503 when the App lacks administration:write.
		const client = githubClientFromEnv(c.env);
		const repo = await createAndLinkRepo(c.env.DB, client, scope, await readJson(c.req.raw));
		return c.json({ repo }, 201);
	});

	router.post('/projects/:projectId/github/repo/connect', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const client = githubClientFromEnv(c.env);
		const repo = await connectAndLinkRepo(c.env.DB, client, scope, await readJson(c.req.raw));
		return c.json({ repo }, 201);
	});

	router.get('/projects/:projectId/github/repo', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		return c.json({ repo: await getProjectRepo(c.env.DB, scope) });
	});

	router.post('/projects/:projectId/github/deliveries', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const client = githubClientFromEnv(c.env);
		const result = await deliverPatch(c.env.DB, client, scope, await readJson(c.req.raw));
		return c.json(result, result.reconciled ? 200 : 201);
	});

	return router;
}

/**
 * The full /api composition — the auth router, the P02 projects router, the
 * P03 approvals router and the P08 github router — exactly the mount app.ts
 * uses. The local workerd fixture wraps this to add its /__test routes.
 */
export function createGithubApp(): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route('/api', createAuthRouter());
	app.route('/api', createProjectsRouter());
	app.route('/api', createApprovalsRouter());
	app.route('/api', createGithubRouter());
	app.onError((error, c) => {
		const mapped = errorJson(error);
		return c.json(mapped.body, mapped.status as 500);
	});
	return app;
}
