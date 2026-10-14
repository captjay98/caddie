import { Hono } from "hono";
import type { AuthEnv } from "../auth.ts";
import { ScopeError, projectScopeForUser, sessionUserId } from "../scope.ts";
import { lookupRunByConversation } from "../runs.ts";
import { readWorkflow } from "../build-workflow.ts";
import { createRun, recordRepairRound, runSnapshot } from "../runs.ts";

/**
 * P05 run routes + the conversation guard.
 *
 * The conversation guard is the "register project conversation behind
 * authenticated membership checks" requirement: every request to a
 * coordinator conversation stream must carry a session whose actor holds
 * membership in the project the conversation's run binding names. Unknown
 * conversations 404; non-member access 403; no session 401. The guard is a
 * Hono middleware mounted BEFORE the generated agent router in app.ts.
 */

type Env = AuthEnv;

export function createRunsRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();

  router.onError((error, c) => {
    if (error instanceof ScopeError) {
      return c.json(
        { error: error.code, message: error.message },
        error.status as 500,
      );
    }
    console.error("unhandled runs route error:", error);
    return c.json({ error: "internal_error" }, 500);
  });

  router.post("/projects/:projectId/runs", async (c) => {
    const userId = await sessionUserId(c.env, c.req.raw.headers);
    if (!userId)
      throw new ScopeError(
        401,
        "unauthenticated",
        "a verified session is required",
      );
    const scope = await projectScopeForUser(
      c.env.DB,
      userId,
      c.req.param("projectId"),
    );
    const workflow = await readWorkflow(c.env.DB, scope);
    if (workflow) {
      const binding = await lookupRunByConversation(
        c.env.DB,
        workflow.conversationId,
      );
      if (!binding || binding.createdBy !== userId)
        throw new ScopeError(
          403,
          "not_conversation_owner",
          "This build conversation belongs to another account.",
        );
      return c.json({ run: binding }, 200);
    }
    const body = (await c.req.json()) as {
      modelRouteId?: string;
      planRevision?: string;
      payerId?: string;
      conversationId?: string;
      submissionId?: string;
    };
    const run = await createRun(c.env.DB, scope, {
      modelRouteId: String(body.modelRouteId),
      planRevision: String(body.planRevision ?? ""),
      payerId: String(body.payerId ?? ""),
      conversationId: body.conversationId,
      submissionId: body.submissionId,
    });
    return c.json({ run }, 201);
  });

  router.get("/projects/:projectId/runs/:runId", async (c) => {
    const userId = await sessionUserId(c.env, c.req.raw.headers);
    if (!userId)
      throw new ScopeError(
        401,
        "unauthenticated",
        "a verified session is required",
      );
    const scope = await projectScopeForUser(
      c.env.DB,
      userId,
      c.req.param("projectId"),
    );
    return c.json({
      run: await runSnapshot(c.env.DB, scope, c.req.param("runId")),
    });
  });

  router.post("/projects/:projectId/runs/:runId/rounds", async (c) => {
    const userId = await sessionUserId(c.env, c.req.raw.headers);
    if (!userId)
      throw new ScopeError(
        401,
        "unauthenticated",
        "a verified session is required",
      );
    const scope = await projectScopeForUser(
      c.env.DB,
      userId,
      c.req.param("projectId"),
    );
    const body = (await c.req.json()) as {
      issue?: string;
      round?: string;
      outcome?: string;
      detail?: string;
    };
    const verdict = await recordRepairRound(
      c.env.DB,
      scope,
      c.req.param("runId"),
      {
        issue: String(body.issue ?? ""),
        round: String(body.round ?? "") as "diagnosis",
        outcome: (body.outcome ?? "started") as "started",
        detail: body.detail,
      },
    );
    return c.json({
      paused: verdict.paused,
      failedRepairAttempts: verdict.failedRepairAttempts,
    });
  });

  router.post("/projects/:projectId/runs/:runId/verifications", async (c) => {
    const userId = await sessionUserId(c.env, c.req.raw.headers);
    if (!userId)
      throw new ScopeError(
        401,
        "unauthenticated",
        "A verified session is required.",
      );
    await projectScopeForUser(c.env.DB, userId, c.req.param("projectId"));
    throw new ScopeError(
      409,
      "HOST_VERIFICATION_REQUIRED",
      "Verification is recorded only by host-executed checks, not caller pass flags.",
    );
  });

  return router;
}

/**
 * Membership guard for coordinator conversation streams. Mounted before the
 * generated agent router: request path shape /agents/coordinator/:conversationId/...
 */
export function conversationGuard(): Hono<{ Bindings: Env }> {
  const guard = new Hono<{ Bindings: Env }>();

  guard.all("/coordinator/:conversationId/*", async (c, next) => {
    const userId = await sessionUserId(c.env, c.req.raw.headers);
    if (!userId)
      throw new ScopeError(
        401,
        "unauthenticated",
        "a verified session is required",
      );
    const binding = await lookupRunByConversation(
      c.env.DB,
      c.req.param("conversationId"),
    );
    if (binding && binding.createdBy !== userId)
      throw new ScopeError(
        403,
        "not_conversation_owner",
        "This conversation belongs to another account.",
      );
    if (!binding) {
      throw new ScopeError(
        404,
        "conversation_not_found",
        "no run is bound to this conversation",
      );
    }
    try {
      await projectScopeForUser(c.env.DB, userId, binding.projectId);
    } catch {
      throw new ScopeError(
        403,
        "not_a_member",
        "actor has no membership in the conversation project",
      );
    }
    await next();
  });

  guard.onError((error, c) => {
    if (error instanceof ScopeError) {
      return c.json(
        { error: error.code, message: error.message },
        error.status as 500,
      );
    }
    console.error("unhandled conversation guard error:", error);
    return c.json({ error: "internal_error" }, 500);
  });

  return guard;
}
