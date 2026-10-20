import { Hono } from 'hono';
import { createAuthRouter } from './auth.ts';
import { createProjectsRouter } from './projects.ts';
import { createApprovalsRouter } from './approvals.ts';
import { ScopeError, requireProjectScope, requireWorkspaceScope, sessionUserId, workspaceScopeForUser } from '../scope.ts';
import {
	connectInstallUrl,
	connectState,
	readConnectState,
	returnLocation,
	safeReturnTo,
	setupOutcome,
} from '../github-connect.ts';
import {
	GithubError,
	githubInstallUrl,
	verifyWebhookSignature,
	type GithubEnv,
	type GithubRestClient,
} from '../adapters/github.ts';
import { SandboxError } from '../adapters/sandbox.ts';
import { startFromImport } from '../repo-start.ts';
import { codeStoreFor } from '../code-store-env.ts';
import type { ArtifactsBinding } from '../adapters/cloudflare-artifacts.ts';
import {
	DeliveryGateError,
	MergeGateError,
	bindInstallation,
	closeDeliveredPullRequest,
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
	mergeDeliveredPullRequest,
	processGithubWebhook,
} from '../repositories.ts';
import {
	readSourceSave,
	saveSourceAsPullRequest,
	sourceDriverFromEnv,
	type SourceSandboxEnv,
} from '../source-save.ts';

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
 *   GET  /api/github/app?workspaceId&returnTo   the App's install link; with a
 *                                               workspace it carries a signed
 *                                               state (members only, plan 6.1).
 *   GET  /api/github/setup                      the App's Setup URL: GitHub's
 *                                               return after install binds the
 *                                               installation, only for a state
 *                                               Caddie signed for this same
 *                                               person, then goes back to their
 *                                               page with ?github=<outcome>.
 *   GET  /api/github/installations              installations of the scoped workspace
 *   GET  /api/github/installations/:id/repos    selected repositories (owning-workspace members only)
 *
 * Project-scoped routes (scope derived server-side from the session):
 *   imports, repo create/connect/read, deliveries, and
 *   POST /api/projects/:id/github/source          save the checked build's
 *                                                 source as a pull request
 *   GET  /api/projects/:id/github/source          latest save + live PR state
 *                                                 + the exact merge approval
 *   POST /api/projects/:id/github/pulls/:n/close  close a Caddie PR
 *   POST /api/projects/:id/github/pulls/:n/merge  merge a Caddie PR (exact
 *                                                 approval for its head commit)
 *
 * Exports:
 *   - createGithubRouter(): the /api-mounted github routes (app.ts composes
 *     this next to the auth/projects/approvals routers).
 *   - createGithubApp(): the full /api composition (auth + projects +
 *     approvals + github) — the same mount app.ts uses, wrapped for the local
 *     workerd fixture and tests.
 */

type Env = GithubEnv & Omit<SourceSandboxEnv, 'DB'>;

function errorJson(error: unknown): {
	status: number;
	body: { error: string; message?: string; operationKey?: string; revisionHash?: string; intent?: unknown };
} {
	if (error instanceof ScopeError) {
		return { status: error.status, body: { error: error.code, message: error.message } };
	}
	if (error instanceof MergeGateError) {
		// the merge gate refused: hand back the EXACT intent (PR + head commit)
		// the user must approve; the browser never builds one itself
		return {
			status: error.gate.status,
			body: { error: error.gate.code, message: error.gate.message, intent: error.intent },
		};
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
	if (error instanceof SandboxError) {
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

/** Caddie's own server secret, which signs the connect state (plan 6.1). */
function authSecret(env: unknown): string | null {
	const secret = (env as { BETTER_AUTH_SECRET?: unknown } | undefined)?.BETTER_AUTH_SECRET;
	return typeof secret === 'string' && secret.length > 0 ? secret : null;
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

function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new ScopeError(400, 'invalid_input', 'body must be a JSON object');
	}
	return value as Record<string, unknown>;
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

	// --- app metadata (public, non-credential): where to install the App -------------
	router.get('/github/app', async (c) => {
		await requireSessionActorId(c.env, c.req.raw.headers);
		const workspaceId = c.req.query('workspaceId');
		// The slug is public; the install URL is null when unconfigured (never guessed).
		if (!workspaceId) return c.json({ installUrl: githubInstallUrl(c.env) });
		// The one-click link (plan 6.1): GitHub hands its state back on the
		// Setup URL, so the return can connect. Members of the workspace only.
		const scope = await requireWorkspaceScope(c.env.DB, c.env, c.req.raw.headers, workspaceId);
		const secret = authSecret(c.env);
		if (!secret) return c.json({ installUrl: null });
		const state = await connectState(secret, {
			actorId: scope.actorId,
			workspaceId: scope.workspaceId,
			returnTo: safeReturnTo(c.req.query('returnTo')),
		});
		return c.json({ installUrl: connectInstallUrl(c.env, state) });
	});

	// --- the App's Setup URL: GitHub's return after install (plan 6.1) ---------------
	// GitHub warns installation_id can be spoofed, so nothing connects unless the
	// state is one Caddie signed for this same signed-in person in the last 30
	// minutes; the installation is then checked as the by-id bind checks it.
	router.get('/github/setup', async (c) => {
		const userId = await sessionUserId(c.env, c.req.raw.headers);
		if (!userId) return c.redirect(returnLocation('/app/', 'not_signed_in'), 302);
		const secret = authSecret(c.env);
		const request = secret ? await readConnectState(secret, c.req.query('state')) : null;
		if (!request || request.actorId !== userId) return c.redirect(returnLocation('/app/', 'expired'), 302);
		// An organisation member asked its owner to approve the App: nothing to bind yet.
		if (c.req.query('setup_action') === 'request') return c.redirect(returnLocation(request.returnTo, 'requested'), 302);
		const installationId = c.req.query('installation_id') ?? '';
		if (!/^\d{1,20}$/.test(installationId)) return c.redirect(returnLocation(request.returnTo, 'not_found'), 302);
		try {
			const scope = await workspaceScopeForUser(c.env.DB, userId, request.workspaceId);
			// githubClientFromEnv -> readGithubConfig fails closed (typed 503) before any write.
			await bindInstallation(c.env.DB, githubClientFromEnv(c.env), scope, installationId);
			return c.redirect(returnLocation(request.returnTo, 'connected'), 302);
		} catch (error) {
			const outcome = setupOutcome(error);
			if (outcome === 'failed') console.error('github setup return failed:', error);
			return c.redirect(returnLocation(request.returnTo, outcome), 302);
		}
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
		const body = await readJson(c.req.raw);
		const imported = await importRepoSnapshot(c.env.DB, client, scope, body);
		// "Start from my GitHub repo": when Caddie can build the copied app, its
		// files become the project's first version and the first build starts there.
		const start =
			(body as { start?: unknown } | null)?.start === true
				? await startFromImport(c.env.DB, codeStoreFor(c.env as typeof c.env & { ARTIFACTS?: ArtifactsBinding }), scope, { importId: imported.id })
				: undefined;
		return c.json({ import: imported, ...(start ? { start } : {}) }, 201);
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

	// Close a PR Caddie opened for this project (reversible; read-before-write).
	router.post('/projects/:projectId/github/pulls/:number/close', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const client = githubClientFromEnv(c.env);
		const body = asObject(await readJson(c.req.raw));
		const result = await closeDeliveredPullRequest(c.env.DB, client, scope, {
			repoFullName: body['repoFullName'],
			pullRequestNumber: Number(c.req.param('number')),
		});
		return c.json(result, 200);
	});

	// Save the checked build's SOURCE as a pull request on its own branch.
	// Never writes the default branch, so it needs no approval; merging does.
	router.post('/projects/:projectId/github/source', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const client = githubClientFromEnv(c.env);
		const driver = sourceDriverFromEnv(c.env);
		const result = await saveSourceAsPullRequest(c.env.DB, client, driver, scope, await readJson(c.req.raw));
		return c.json(result, result.reconciled ? 200 : 201);
	});

	// The latest save, its PR's live state, and the exact merge approval it needs.
	router.get('/projects/:projectId/github/source', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		let client: GithubRestClient | null = null;
		try {
			client = githubClientFromEnv(c.env);
		} catch (error) {
			if (!(error instanceof GithubError)) throw error;
		}
		return c.json(await readSourceSave(c.env.DB, client, scope));
	});

	// Merge a PR Caddie opened for this project: exact approval for its head commit.
	router.post('/projects/:projectId/github/pulls/:number/merge', async (c) => {
		const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param('projectId'));
		const client = githubClientFromEnv(c.env);
		const body = asObject(await readJson(c.req.raw));
		const result = await mergeDeliveredPullRequest(c.env.DB, client, scope, {
			repoFullName: body['repoFullName'],
			pullRequestNumber: Number(c.req.param('number')),
			headSha: body['headSha'],
		});
		return c.json(result, 200);
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
