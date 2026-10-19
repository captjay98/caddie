import { Hono } from "hono";
import type { AuthEnv } from "../auth.ts";
import { ScopeError, projectScopeForUser, sessionUserId } from "../scope.ts";
import { lookupRunByConversation } from "../runs.ts";
import { readWorkflow } from "../build-workflow.ts";
import { createRun, recordRepairRound, runSnapshot } from "../runs.ts";
import { admitJudgeMessage } from "../judge-limits.ts";
import { isJudgeAccount } from "../judge-access.ts";
import { isInternalDispatch } from "../internal-dispatch.ts";

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
    // S07 judge limits: only the conversation ROOT's POST admits a user
    // message. /abort, GET history and GET ?view=updates are not messages and
    // cost nothing. The method/path test comes first, so non-message traffic
    // pays no judge lookup at all; a real judge pays exactly one. A message the
    // server dispatched itself carries an HMAC the browser cannot forge, so it
    // is admitted without consuming the judge's quota.
    const conversationId = c.req.param("conversationId");
    const isUserMessage =
      c.req.method === "POST" &&
      c.req.path.endsWith(`/coordinator/${conversationId}`);
    if (isUserMessage) {
      const fromServer = await isInternalDispatch(
        c.env,
        c.req.raw.headers,
        conversationId,
      );
      if (!fromServer) await admitJudgeMessage(c.env.DB, userId, c.env);
    }
    await next();
  });

  // The P00 scaffold agent (/agents/hello) proves the DO + router wiring. It
  // has no bound conversation to membership-check, but it must NOT be an
  // unauthenticated LLM endpoint — require a verified session before it is
  // reached. Any other non-coordinator agent path is likewise gated. It calls
  // the helper model outside every judge limit and no screen uses it, so
  // judge accounts are refused outright (review F02).
  guard.all("/hello/*", async (c, next) => {
    const userId = await sessionUserId(c.env, c.req.raw.headers);
    if (!userId)
      throw new ScopeError(401, "unauthenticated", "a verified session is required");
    if (await isJudgeAccount(c.env.DB, userId))
      throw new ScopeError(403, "JUDGE_ACCOUNT", "This isn't available to judge accounts.");
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
