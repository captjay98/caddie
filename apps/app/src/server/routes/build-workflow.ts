import { Hono } from "hono";
import type { AuthEnv } from "../auth.ts";
import { ScopeError, requireProjectScope } from "../scope.ts";
import { resolveAppSecrets } from "../app-secrets.ts";
import { SecretBoxError, keyringFromEnv } from "../secret-box.ts";
import { appAuthSecret, clearTestInbox, listTestInbox } from "../app-sign-in.ts";
import {
  workflowSnapshot,
  reconcileStalledBuild,
  decideWorkflow,
  decideDesign,
  acknowledgeDispatch,
  readBuildOutput,
  readBuildBundle,
  retryWorkflow,
  stopWorkflow,
} from "../build-workflow.ts";
import {
  PreviewRuntimeError,
  bridgeRequestToRequest,
  previewDatabaseFor,
  runPreviewApp,
  type PreviewDatabaseEnv,
  type WorkerLoaderLike,
} from "../preview-runtime.ts";
import { rollbackToFeature } from "../build-features.ts";
import {
  dispatchPendingWorkflow,
  recoverStalledDispatch,
  workerSelfDeliver,
  type CoordinatorDeliver,
} from "../workflow-dispatch.ts";
import { projectExperience, approvePlan } from "../project-experience.ts";
import { buildActivity } from "../build-activity.ts";
import { checkImportedApp, importPreviewDepsFromEnv, readImportPreview, type ImportPreviewEnv } from "../import-preview.ts";
import { acceptProposal, dismissProposal, getProposal } from "../project-proposals.ts";
import { projectHackathon } from "../project-hackathon.ts";
import { ApprovePlanCommandSchema } from "@caddie/contracts";
import * as v from "valibot";

/**
 * `selfFetch` is the in-process Worker fetch handler (passed as a thunk from
 * app.ts to avoid a circular import). When present, approval/retry deliver the
 * pending coordinator message SERVER-SIDE — the browser no longer has to. When
 * absent (unit tests, degraded config), the pending slot is left for a later
 * dispatch, exactly as before, so behaviour never silently regresses.
 */
export function createBuildWorkflowRouter(
  selfFetch?: () => {
    fetch(request: Request, env?: unknown, executionCtx?: unknown): Promise<Response> | Response;
  },
) {
  const router = new Hono<{ Bindings: AuthEnv }>();

  /** Build the deliver boundary for this request, or null when self-fetch is unavailable.
   *  Forwards THIS request's Worker bindings — the self-request needs them for auth + the DO. */
  function deliverFor(c: {
    req: { raw: Request; url: string };
    env: AuthEnv;
    executionCtx?: unknown;
  }): CoordinatorDeliver | null {
    const app = selfFetch?.();
    if (!app) return null;
    const origin = new URL(c.req.url).origin;
    let executionCtx: unknown;
    try {
      executionCtx = c.executionCtx;
    } catch {
      // Hono throws when no ExecutionContext exists (tests); the self-fetch works without it.
      executionCtx = undefined;
    }
    return workerSelfDeliver(app, origin, c.req.raw.headers.get("cookie"), c.env, executionCtx);
  }

  router.onError((error, c) => {
    if (error instanceof ScopeError)
      return c.json(
        { error: error.code, message: error.message },
        error.status as 500,
      );
    console.error("workflow route error", error);
    return c.json({ error: "internal_error" }, 500);
  });
  router.get("/projects/:projectId/workflow", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    await reconcileStalledBuild(c.env.DB, scope.projectId);
    const snapshot = await workflowSnapshot(c.env.DB, scope);
    const previewId = snapshot.workflow?.previewId ?? null;
    const previewHasServer = previewId ? (await readBuildBundle(c.env.DB, scope, previewId).catch(() => null)) !== null : false;
    // "Start from my GitHub repo": the copied app, shown until the first build has a preview of its own.
    const importPreview = await readImportPreview(c.env.DB, scope);
    return c.json({ ...snapshot, previewHasServer, importPreview });
  });

  // Carry the copied app's build forward (import-preview.ts). The card calls
  // this while it shows "checking"; it may run for minutes (install + build)
  // or answer "checking" at once when the sandbox is busy with the same work.
  router.post("/projects/:projectId/import-preview/check", async (c) => {
    const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param("projectId"));
    const env = c.env as typeof c.env & ImportPreviewEnv;
    const importPreview = await checkImportedApp(importPreviewDepsFromEnv(env), scope);
    if (!importPreview) throw new ScopeError(404, "no_import_preview", "This project didn't start from GitHub.");
    return c.json({ importPreview });
  });

  // Build activity: the honest "what is Caddie doing right now?" read while a
  // project is building/checking — ordered steps + the real run_rounds history.
  // Derived, read-only; the preview still only appears via the workflow phase.
  router.get("/projects/:projectId/activity", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    return c.json(await buildActivity(c.env.DB, scope));
  });

  // R01/R06: the shared ProjectExperience projection — the ONE source chat
  // cards, Brief, Projects and the workspace read (never a per-UI guess).
  router.get("/projects/:projectId/experience", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    // Review F01: a handoff that was written but never accepted (a Worker
    // that stopped mid-send, or a delivery with no 2xx) is re-sent here, with
    // the same key, once its lease has passed. This route is polled every 3 s
    // while the project is open, so a lost handoff recovers while someone
    // looks. It never blocks the answer: a failed recovery is logged.
    const deliver = deliverFor(c);
    if (deliver) {
      await recoverStalledDispatch(c.env.DB, scope, deliver).catch((error: unknown) => {
        console.error("[dispatch] recovery failed", error instanceof Error ? error.message : error);
      });
    }
    return c.json(await projectExperience(c.env.DB, scope));
  });

  // The hackathon this project is for (header chips): derived read-only from
  // the started proposal / contest link + the stored event. null = none.
  router.get("/projects/:projectId/hackathon", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    return c.json({ hackathon: await projectHackathon(c.env.DB, scope) });
  });

  // R01/R06: the approve-plan command — buttons AND an unambiguous
  // conversational "approve this plan" invoke the SAME versioned/idempotent
  // command. Returns the uniform outcome + the refreshed projection.
  router.post("/projects/:projectId/experience/approve", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    let input;
    try {
      input = await c.req.json();
    } catch {
      throw new ScopeError(400, "invalid_input", "Expected JSON.");
    }
    const parsed = v.safeParse(ApprovePlanCommandSchema, input);
    if (!parsed.success) {
      throw new ScopeError(400, "invalid_input", "Invalid approve-plan command.");
    }
    const result = await approvePlan(c.env.DB, scope, parsed.output, c.env);
    // The command delivered the pending message if it transitioned to building;
    // dispatch it server-side exactly as the decision route does.
    if (result.outcome === "applied") {
      const deliver = deliverFor(c);
      if (deliver) await dispatchPendingWorkflow(c.env.DB, scope, deliver);
    }
    return c.json(result);
  });
  router.post("/projects/:projectId/workflow/decision", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    let input;
    try {
      input = await c.req.json();
    } catch {
      throw new ScopeError(400, "invalid_input", "Expected JSON.");
    }
    const snapshot = await decideWorkflow(c.env.DB, scope, input, c.env);
    // Server-owned dispatch (R02): deliver the pending coordinator message now,
    // from the server, so an approved build starts even if the browser closes.
    // The DO's own onStart drain owns re-delivery after a crash.
    const deliver = deliverFor(c);
    if (deliver) await dispatchPendingWorkflow(c.env.DB, scope, deliver);
    return c.json(snapshot);
  });
  router.post("/projects/:projectId/workflow/design-decision", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    let input;
    try {
      input = await c.req.json();
    } catch {
      throw new ScopeError(400, "invalid_input", "Expected JSON.");
    }
    // The DESIGN-brief gate: approve -> building (feature loop), reject ->
    // design (re-author). Same server-owned dispatch as the plan decision so an
    // approved build starts even if the browser closes.
    const snapshot = await decideDesign(c.env.DB, scope, input, c.env);
    const deliver = deliverFor(c);
    if (deliver) await dispatchPendingWorkflow(c.env.DB, scope, deliver);
    return c.json(snapshot);
  });
  router.post("/projects/:projectId/workflow/retry", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    const input = await c.req.json<{ key: string }>();
    const snapshot = await retryWorkflow(c.env.DB, scope, input.key, undefined, c.env);
    const deliver = deliverFor(c);
    if (deliver) await dispatchPendingWorkflow(c.env.DB, scope, deliver);
    return c.json(snapshot);
  });
  // Project proposals (Home chat card): Caddie proposes, the USER creates.
  // GET reads the card state; accept creates the project + planning intake
  // and dispatches it server-side; dismiss ("Keep refining") creates nothing.
  router.get("/projects/:projectId/proposals/:proposalId", async (c) => {
    const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param("projectId"));
    return c.json({ proposal: await getProposal(c.env.DB, scope, c.req.param("proposalId")) });
  });
  router.post("/projects/:projectId/proposals/:proposalId/accept", async (c) => {
    const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param("projectId"));
    const result = await acceptProposal(c.env.DB, scope, c.req.param("proposalId"), c.env);
    // Deliver the new project's planning intake now, from the server, exactly
    // like a plan approval does (the DO dedupes on the same key).
    const deliver = deliverFor(c);
    if (deliver) {
      const target = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, result.project.id);
      await dispatchPendingWorkflow(c.env.DB, target, deliver);
    }
    return c.json(result);
  });
  router.post("/projects/:projectId/proposals/:proposalId/dismiss", async (c) => {
    const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param("projectId"));
    return c.json({ proposal: await dismissProposal(c.env.DB, scope, c.req.param("proposalId")) });
  });
  router.post("/projects/:projectId/workflow/stop", async (c) => {
    const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param("projectId"));
    return c.json(await stopWorkflow(c.env.DB, scope));
  });
  // Roll a settled build back to a feature's save point (owner-only, idempotent
  // on key). Nothing runs here: the next build step starts from that image.
  router.post("/projects/:projectId/workflow/rollback", async (c) => {
    const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param("projectId"));
    let input: { featureId?: unknown; key?: unknown };
    try {
      input = await c.req.json();
    } catch {
      throw new ScopeError(400, "invalid_input", "Expected JSON.");
    }
    if (typeof input.featureId !== "string" || typeof input.key !== "string")
      throw new ScopeError(400, "invalid_input", "A featureId and an idempotency key are required.");
    return c.json(await rollbackToFeature(c.env.DB, scope, { featureId: input.featureId, key: input.key }));
  });
  router.post("/projects/:projectId/workflow/ack", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    const input = await c.req.json<{ key: string }>();
    if (typeof input.key !== "string")
      throw new ScopeError(400, "invalid_input", "A dispatch key is required.");
    await acknowledgeDispatch(c.env.DB, scope, input.key);
    return c.json({ acknowledged: true });
  });
  router.get("/projects/:projectId/workflow/preview/:outputId", async (c) => {
    const scope = await requireProjectScope(
      c.env.DB,
      c.env,
      c.req.raw.headers,
      c.req.param("projectId"),
    );
    const bytes = await readBuildOutput(
      c.env.DB,
      scope,
      c.req.param("outputId"),
    );
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "sandbox",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(c.req.query("download") === "1" ? { "content-disposition": 'attachment; filename="caddie-app.html"' } : {}),
      },
    });
  });

  // Backend previews: the preview frame relays its fetch('/api/…') calls here
  // (it has no network of its own). The app's server bundle runs in a Worker
  // Loader isolate with this project's preview database, the app's own keys,
  // Caddie's platform (env.CADDIE: AI) for this project, and outside requests
  // only through Caddie's egress gate.
  router.post("/projects/:projectId/workflow/preview/:outputId/app", async (c) => {
    const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param("projectId"));
    const env = c.env as AuthEnv & PreviewRuntimeBindings;
    const exportsOf = previewExports(c);
    if (!env.LOADER || !env.PREVIEW_DB || !exportsOf?.PreviewDatabaseGateway)
      throw new ScopeError(
        503,
        "PREVIEW_RUNTIME_UNAVAILABLE",
        "Trying apps with a server needs Cloudflare's Worker Loader, which isn't available here.",
      );
    const outputId = c.req.param("outputId");
    const bundle = await readBuildBundle(c.env.DB, scope, outputId);
    if (!bundle) throw new ScopeError(409, "PREVIEW_HAS_NO_SERVER", "This version of the app has no server.");
    let request: Request;
    try {
      request = bridgeRequestToRequest(await c.req.json());
    } catch (error) {
      if (error instanceof PreviewRuntimeError) throw new ScopeError(error.status, error.code, error.message);
      throw new ScopeError(400, "invalid_request", "The preview sent a request Caddie could not read.");
    }
    try {
      await previewDatabaseFor(env, scope.projectId).applyMigrations(bundle.migrations);
      const relayed = await runPreviewApp({
        loader: env.LOADER,
        projectId: scope.projectId,
        outputId,
        serverSource: bundle.server,
        vars: await previewVars(env, scope.projectId),
        database: exportsOf.PreviewDatabaseGateway({ props: { projectId: scope.projectId } }),
        platform: exportsOf.AppPlatform ? exportsOf.AppPlatform({ props: { projectId: scope.projectId } }) : undefined,
        globalOutbound: exportsOf.PreviewOutbound ? exportsOf.PreviewOutbound({ props: { projectId: scope.projectId } }) : null,
        request,
      });
      return c.json(relayed);
    } catch (error) {
      if (error instanceof PreviewRuntimeError) throw new ScopeError(error.status, error.code, error.message);
      const message = error instanceof Error ? error.message : String(error);
      // The app's own failure (a thrown error in its server) is the app's answer, not Caddie's.
      return c.json({
        status: 500,
        headers: [["content-type", "text/plain; charset=utf-8"]],
        body: btoa(unescape(encodeURIComponent(`The app's server failed: ${message.slice(0, 500)}`))),
      });
    }
  });

  // "Reset test data": empty this project's preview database (and its test inbox).
  router.post("/projects/:projectId/workflow/preview-data/reset", async (c) => {
    const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param("projectId"));
    const env = c.env as AuthEnv & PreviewRuntimeBindings;
    if (!env.PREVIEW_DB) throw new ScopeError(503, "PREVIEW_RUNTIME_UNAVAILABLE", "The preview database isn't available here.");
    await previewDatabaseFor(env, scope.projectId).reset();
    await clearTestInbox(c.env.DB, scope.projectId);
    return c.json({ reset: true });
  });

  // The preview's test inbox: sign-in codes the app sent while you tried it.
  router.get("/projects/:projectId/workflow/test-inbox", async (c) => {
    const scope = await requireProjectScope(c.env.DB, c.env, c.req.raw.headers, c.req.param("projectId"));
    return c.json({ messages: await listTestInbox(c.env.DB, scope) }, 200, { "cache-control": "no-store" });
  });
  return router;
}

type PreviewRuntimeBindings = { LOADER?: WorkerLoaderLike; APP_SECRETS_KEYS?: string } & PreviewDatabaseEnv;
type PreviewExports = {
  PreviewDatabaseGateway?(options: { props: { projectId: string } }): unknown;
  PreviewOutbound?(options: { props: { projectId: string } }): unknown;
  AppPlatform?(options: { props: { projectId: string } }): unknown;
};

/** The Worker's own entrypoints (ctx.exports). Hono's executionCtx getter throws when there is none (tests, Bun). */
function previewExports(c: { executionCtx: unknown }): PreviewExports | undefined {
  try {
    return (c.executionCtx as { exports?: PreviewExports } | undefined)?.exports;
  } catch {
    return undefined;
  }
}

/**
 * The app's own keys for its preview, opened server-side. A server without a
 * keyring has no keys to give (the preview still runs); a key that can no
 * longer be opened is left out, and the Keys card says to paste it again.
 */
async function previewKeys(env: PreviewRuntimeBindings & { DB: AuthEnv["DB"] }, projectId: string): Promise<Record<string, string>> {
  if (!(env.APP_SECRETS_KEYS ?? "").trim()) return {};
  try {
    return (await resolveAppSecrets(env.DB, await keyringFromEnv(env), projectId)).values;
  } catch (error) {
    if (error instanceof SecretBoxError) {
      console.error("preview: app keys unavailable:", error.code);
      return {};
    }
    throw error;
  }
}

/** Everything the preview's env carries as text: the app's keys and its sign-in secret. */
async function previewVars(env: PreviewRuntimeBindings & { DB: AuthEnv["DB"]; BETTER_AUTH_SECRET?: string }, projectId: string): Promise<Record<string, string>> {
  const vars = await previewKeys(env, projectId);
  const authSecret = await appAuthSecret(env.BETTER_AUTH_SECRET, projectId, "preview");
  return authSecret ? { ...vars, CADDIE_AUTH_SECRET: authSecret } : vars;
}
