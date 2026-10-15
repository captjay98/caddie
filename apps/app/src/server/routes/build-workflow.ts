import { Hono } from "hono";
import type { AuthEnv } from "../auth.ts";
import { ScopeError, requireProjectScope } from "../scope.ts";
import {
  workflowSnapshot,
  decideWorkflow,
  acknowledgeDispatch,
  readBuildOutput,
  retryWorkflow,
  stopWorkflow,
} from "../build-workflow.ts";
import {
  dispatchPendingWorkflow,
  workerSelfDeliver,
  type CoordinatorDeliver,
} from "../workflow-dispatch.ts";
import { projectExperience, approvePlan } from "../project-experience.ts";
import { acceptProposal, dismissProposal, getProposal } from "../project-proposals.ts";
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
    return c.json(await workflowSnapshot(c.env.DB, scope));
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
    return c.json(await projectExperience(c.env.DB, scope));
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
    const result = await approvePlan(c.env.DB, scope, parsed.output);
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
    const snapshot = await decideWorkflow(c.env.DB, scope, input);
    // Server-owned dispatch (R02): deliver the pending coordinator message now,
    // from the server, so an approved build starts even if the browser closes.
    // The DO's own onStart drain owns re-delivery after a crash.
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
    const snapshot = await retryWorkflow(c.env.DB, scope, input.key);
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
    const result = await acceptProposal(c.env.DB, scope, c.req.param("proposalId"));
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
  return router;
}
