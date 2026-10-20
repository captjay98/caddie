import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Hello } from './agents/hello.ts';
import { registerNebiusProvider } from './agents/providers.ts';
import { Coordinator } from './agents/coordinator.ts';
import { createBuildWorkflowRouter } from './server/routes/build-workflow.ts';
import { createAuthRouter } from './server/routes/auth.ts';
import { createProjectsRouter } from './server/routes/projects.ts';
import { createApprovalsRouter } from './server/routes/approvals.ts';
import { createEvidenceRouter } from './server/routes/evidence.ts';
import { createBriefRouter } from './server/routes/brief.ts';
import { createRunsRouter, conversationGuard } from './server/routes/runs.ts';
import { createTasksRouter } from './server/routes/tasks.ts';
import { createGithubRouter } from './server/routes/github.ts';
import { createDiscoveryRouter } from './server/routes/discovery.ts';
import { createJudgeRouter } from './server/routes/judge.ts';
import { createJudgeAccessRouter } from './server/routes/judge-access.ts';
import { createProfileRouter } from './server/routes/profile.ts';
import { createArtifactsRouter } from './server/routes/artifacts.ts';
import { createPreviewsRouter } from './server/routes/previews.ts';
import { createAppKeysRouter } from './server/routes/app-keys.ts';
import { createPublishRouter } from './server/routes/publish.ts';
import { createVersionsRouter } from './server/routes/versions.ts';
import { createAppAiRouter } from './server/routes/app-ai.ts';
import { createReportRouter } from './server/routes/report.ts';
import { createOperatorRouter } from './server/routes/operator.ts';
import { createAndroidAppRouter } from './server/android-app.ts';
import { SandboxError } from './server/adapters/sandbox.ts';
import { ScopeError } from './server/scope.ts';
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
	/** Base image reference sessions bootstrap from (default: the adjudication-proven `tag:tt-base:1`). */
	CONTREE_IMAGE?: string;
	GITHUB_APP_ID?: string;
	GITHUB_APP_PRIVATE_KEY?: string;
	GITHUB_WEBHOOK_SECRET?: string;
	GITHUB_API_BASE_URL?: string;
	/** Outbound email (Resend; LIVE VERIFIED for the owner's address). Both
	 *  absent → the noop mailer's honest BLOCKED receipt, never a faked send. */
	RESEND_API_KEY?: string;
	RESEND_FROM?: string;
	/** Keyring sealing app keys at rest: "kid:base64-32-bytes[,kid:...]", first seals (owner input). */
	APP_SECRETS_KEYS?: string;
	/** Publishing (owner inputs; all of them, or publishing reports "not set up"). */
	APPS_DOMAIN?: string;
	CLOUDFLARE_API_BASE?: string;
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_DISPATCH_NAMESPACE?: string;
	CLOUDFLARE_ROUTES_KV_ID?: string;
	CLOUDFLARE_APPS_ZONE_ID?: string;
	/** Safety (owner inputs): the monitored abuse inbox, who may review reports and take apps down, Web Risk. */
	ABUSE_INBOX?: string;
	OPERATOR_EMAILS?: string;
	WEB_RISK_API_KEY?: string;
	/** AI inside apps: each project's monthly allowance in US cents (default 100). Uses NEBIUS_API_KEY. */
	APP_AI_MONTHLY_LIMIT_CENTS?: string;
};

registerNebiusProvider();

const app = new Hono<{ Bindings: Env }>();

// --- product API -----------------------------------------------------------
const api = new Hono<{ Bindings: Env }>();
api.route('/', createAuthRouter());
api.route('/', createProjectsRouter());
api.route('/', createApprovalsRouter());
api.route('/', createEvidenceRouter());
api.route('/', createRunsRouter());
api.route('/', createBuildWorkflowRouter(() => app));
api.route('/', createProfileRouter());
api.route('/', createArtifactsRouter());
api.route('/', createPreviewsRouter());
api.route('/', createTasksRouter());
api.route('/', createGithubRouter());
api.route('/', createDiscoveryRouter());
api.route('/', createJudgeRouter());
// S06: judge sign-in by access code. Distinct from createJudgeRouter() above
// (that is the P13 scoring surface at /projects/:projectId/judge/...); this one
// owns /judge/access, /judge/start and /judge/sign-in.
api.route('/', createJudgeAccessRouter());
api.route('/', createBriefRouter());
api.route('/', createAppKeysRouter());
api.route('/', createPublishRouter());
api.route('/', createVersionsRouter());
api.route('/', createAppAiRouter());
app.route('/api', api);

// --- agents ----------------------------------------------------------------
// The coordinator conversation: guard (auth + membership of the bound
// project) first, then host-context provisioning, then the generated agent
// router. Hello remains as the P00 scaffold agent.
app.route('/agents', conversationGuard());
app.route('/agents/coordinator', createAgentRouter(Coordinator));
app.route('/agents/hello', createAgentRouter(Hello));

// --- SPA under /app --------------------------------------------------------
// The public "Report an app" page every published app links to, and the
// operator's page for answering reports (OPERATOR_EMAILS only).
app.route('/', createReportRouter());
app.route('/', createOperatorRouter());
// Android apps (Track 3): an APK's server address and its download, public
// by design (a phone has no Caddie session). /a/<project>/api/* forwards only
// to that project's own published app; app.apk needs a signed link or a
// live publication (server/android-app.ts).
app.route('/', createAndroidAppRouter());

app.get('/app', (c) => c.redirect('/app/', 307));
app.get('/app/*', async (c) => {
	const assets = c.env?.ASSETS;
	if (!assets) return c.json({ error: 'assets_not_configured' }, 500);
	const asset = await assets.fetch(c.req.raw);
	if (asset.status !== 404) return asset;
	// Client-side routing fallback: any /app/* path without a file serves
	// the SPA shell. The composed build emits the shell at /app/index.html;
	// the dev assets tree has no /app prefix — its SPA entry is / — so fall
	// through to that when the shell path misses.
	const shell = await assets.fetch(new Request(new URL('/app/index.html', c.req.url)));
	if (shell.status !== 404) return shell;
	return assets.fetch(new Request(new URL('/', c.req.url)));
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
	if (err instanceof SandboxError || err instanceof ScopeError) {
		return c.json({ error: err.code, message: err.message }, err.status as 500);
	}
	console.error('unhandled worker error:', err);
	return c.json({ error: 'internal_error' }, 500);
});

export default app;
