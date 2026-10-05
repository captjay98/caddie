import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Hello } from './agents/hello.ts';
import { Coordinator, provideCoordinatorContext } from './agents/coordinator.ts';
import type { SandboxToolDeps } from './agents/tools.ts';
import type { SpecialistBuildContext } from './agents/specialists.ts';
import { createAuthRouter } from './server/routes/auth.ts';
import { createProjectsRouter } from './server/routes/projects.ts';
import { createApprovalsRouter } from './server/routes/approvals.ts';
import { createEvidenceRouter } from './server/routes/evidence.ts';
import { createRunsRouter, conversationGuard } from './server/routes/runs.ts';
import { lookupRunByConversation, recordRepairRound, recordVerification } from './server/runs.ts';
import { createPlanDocRevision } from './server/projects.ts';
import { SandboxDriver, SandboxError, InMemorySandboxPersistence, type SandboxExecuteInput } from './server/adapters/sandbox.ts';
import { sessionUserId, projectScopeForUser } from './server/scope.ts';
import type { AuthEnv } from './server/auth.ts';

/**
 * The Worker's single fetch entry. Composition order:
 *
 *   /api/*      product API (auth: Better Auth under /api/auth/*; projects,
 *               approvals, evidence, runs; JSON 404 fallback for unknowns)
 *   /agents/*   Flue agent routers. The coordinator conversation is guarded:
 *               authenticated session + project membership required, host
 *               context provisioned per request.
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
	/** Sandbox service (owner inputs; agent runs fail closed without them). */
	CONTREE_BASE_URL?: string;
	CONTREE_API_TOKEN?: string;
	CONTREE_PROJECT_ID?: string;
};

const app = new Hono<{ Bindings: Env }>();

// --- product API -----------------------------------------------------------
const api = new Hono<{ Bindings: Env }>();
api.route('/', createAuthRouter());
api.route('/', createProjectsRouter());
api.route('/', createApprovalsRouter());
api.route('/', createEvidenceRouter());
api.route('/', createRunsRouter());
app.route('/api', api);

// --- agents ----------------------------------------------------------------
// The coordinator conversation: guard (auth + membership of the bound
// project) first, then host-context provisioning, then the generated agent
// router. Hello remains as the P00 scaffold agent.
app.route('/agents', conversationGuard());
app.use('/agents/coordinator/*', async (c, next) => {
	const userId = await sessionUserId(c.env, c.req.raw.headers);
	if (!userId) return c.json({ error: 'unauthenticated' }, 401);
	const conversationId = c.req.param('conversationId');
	const run = conversationId ? await lookupRunByConversation(c.env.DB, conversationId) : null;
	if (!run) return c.json({ error: 'conversation_not_found' }, 404);
	const scope = await projectScopeForUser(c.env.DB, userId, run.projectId);
	provideCoordinatorContext(coordinatorContext(c.env, scope, run.runId));
	await next();
});
app.route('/agents/coordinator', createAgentRouter(Coordinator));
app.route('/agents/hello', createAgentRouter(Hello));

/**
 * Build the coordinator's runtime context for one request: the sandbox driver
 * bound to the run's session, durable hooks over the P02/P05 services, and
 * the run's current plan revision. Requires configured CONTREE credentials —
 * without them the context fails honestly on first use; there is no silent
 * local fallback for agent execution.
 */
function coordinatorContext(
	env: Env,
	scope: { actorId: string; workspaceId: string; projectId: string },
	runId: string,
): SpecialistBuildContext & { currentPlanRevision: () => string } {
	if (!env.CONTREE_BASE_URL || !env.CONTREE_API_TOKEN || !env.CONTREE_PROJECT_ID) {
		throw new SandboxError(
			503,
			'SANDBOX_NOT_CONFIGURED',
			'CONTREE_BASE_URL/CONTREE_API_TOKEN/CONTREE_PROJECT_ID are required for agent runs',
		);
	}
	const driver = new SandboxDriver(
		{
			contree: {
				baseUrl: env.CONTREE_BASE_URL,
				apiToken: env.CONTREE_API_TOKEN,
				platformProjectId: env.CONTREE_PROJECT_ID,
			},
			quotas: {
				maxCommandTimeoutMs: 15 * 60_000,
				maxOutputBytes: 5 * 1024 * 1024,
				maxUploadBytes: 20 * 1024 * 1024,
			},
			workspaceRoot: `/workspace/${scope.projectId}`,
		},
		// Per-isolate persistence: crash recovery across restarts requires the
		// D1-backed port (P09 wiring); this is the honest minimum for now.
		new InMemorySandboxPersistence(),
	);
	const sessionId = `session:${runId}`;
	const deps: SandboxToolDeps = {
		execute: async (input) => {
			const execInput: SandboxExecuteInput = {
				sessionId: input.sessionId,
				command: input.command,
				operationKey: input.operationKey,
				timeoutMs: input.timeoutMs,
			};
			return driver.execute(execInput);
		},
		readFile: async (input) => {
			const result = await driver.execute({
				sessionId: input.sessionId,
				command: `cat -- '${input.path}'`,
				operationKey: `read:${runId}:${Math.random().toString(36).slice(2, 10)}`,
				timeoutMs: 30_000,
			});
			if (result.exitCode !== 0) throw new SandboxError(404, 'FILE_NOT_FOUND', `cannot read ${input.path}`);
			return result.stdout;
		},
		writeFile: async (input) => {
			await driver.uploadFiles(input.sessionId, [{ path: input.path, contentBase64: btoa(input.content) }]);
		},
	};
	return {
		driver: deps,
		sessionId,
		runId,
		readPlanNote: async (kind) => {
			const rows = await env.DB.prepare(
				`select "body" from "plan_doc_revisions" where "projectId" = ? and "kind" = ? order by "revision" desc limit 1`,
			)
				.bind(scope.projectId, kind)
				.all();
			const row = (rows.results ?? [])[0] as { body?: string } | undefined;
			return row?.body ?? null;
		},
		writePlanNote: async (input) => {
			await createPlanDocRevision(env.DB, scope, { kind: input.kind as 'note', body: input.body });
		},
		delegateRepair: async (input) => {
			// Repair delegation is recorded as a round start; the outcome is
			// reported back by the specialist's report path (P09 wiring).
			await recordRepairRound(env.DB, scope, runId, {
				issue: input.issue,
				round: input.round as 'diagnosis',
				outcome: 'started',
			});
		},
		recordVerification: async (input) => {
			await recordVerification(env.DB, scope, runId, input);
		},
		currentPlanRevision: () => currentRevisionCache.get(runId) ?? '',
	};
}

const currentRevisionCache = new Map<string, string>();

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
	if (err instanceof SandboxError) {
		return c.json({ error: err.code, message: err.message }, err.status as 500);
	}
	console.error('unhandled worker error:', err);
	return c.json({ error: 'internal_error' }, 500);
});

export default app;
