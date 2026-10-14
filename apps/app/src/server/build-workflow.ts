import { createHash } from "node:crypto";
import type { Scope, PlanDocRevision } from "@caddie/contracts";
import type { D1Database } from "./auth.ts";
import {
  assertProjectScope,
  assertWorkspaceScope,
  projectScopeForUser,
  ScopeError,
} from "./scope.ts";
import { createRun, isRunPaused, lookupRunByConversation } from "./runs.ts";
import {
  getProject,
  listPlanDocRevisions,
  listRunBindings,
} from "./projects.ts";
import {
  recordDecision,
  getApprovalForIntent,
  checkApprovalForEffect,
} from "./approvals.ts";
import { recordPlanDecision } from "./planning.ts";
import { createD1ContentStore } from "./artifacts.ts";
import { findModelRouteForRole } from "../agents/providers.ts";

export type WorkflowPhase =
  "planning" | "review" | "building" | "blocked" | "ready";
export interface BuildWorkflow {
  projectId: string;
  runId: string;
  conversationId: string;
  sourceConversationId: string | null;
  brief: string;
  phase: WorkflowPhase;
  planId: string | null;
  previewId: string | null;
  pendingKey: string | null;
  pendingBody: string | null;
  detail: string | null;
  updatedAt: string;
}
const now = () => new Date().toISOString();
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function rows(db: D1Database, sql: string, ...args: unknown[]) {
  return (
    await db
      .prepare(sql)
      .bind(...args)
      .all()
  ).results as Record<string, unknown>[];
}
export async function readWorkflow(
  db: D1Database,
  scope: Scope,
): Promise<BuildWorkflow | null> {
  await assertProjectScope(db, scope);
  const result = await rows(
    db,
    "select * from build_workflows where projectId = ?",
    scope.projectId,
  );
  return (result[0] ?? null) as unknown as BuildWorkflow | null;
}

/** One tool delivery creates one project, run and intake atomically. Replays reuse it. */
export async function startProjectFromChat(
  db: D1Database,
  scope: Scope,
  input: {
    name: string;
    description?: string;
    brief: string;
    operationKey: string;
    sourceConversationId: string;
  },
) {
  await assertProjectScope(db, scope);
  const source = await rows(
    db,
    "select projectId,createdBy from run_bindings where conversationId = ? order by createdAt desc limit 1",
    input.sourceConversationId,
  );
  if (
    source[0]?.projectId !== scope.projectId ||
    source[0]?.createdBy !== scope.actorId
  )
    throw new ScopeError(
      403,
      "invalid_source",
      "The source conversation must belong to this account and project.",
    );
  if (
    !input.name.trim() ||
    input.name.length > 100 ||
    !input.brief.trim() ||
    input.brief.length > 16000
  ) {
    throw new ScopeError(
      400,
      "invalid_intake",
      "A name and a brief of at most 16000 characters are required.",
    );
  }
  const digest = hash(
    `${scope.actorId}:${scope.workspaceId}:${input.sourceConversationId}:${input.operationKey}`,
  );
  const existing = await rows(
    db,
    "select w.*,p.name from build_workflows w join projects p on p.id=w.projectId where w.intakeKey=?",
    digest,
  );
  if (
    existing[0] &&
    (existing[0].brief !== input.brief ||
      existing[0].name !== input.name.trim())
  )
    throw new ScopeError(
      409,
      "INTAKE_KEY_CONFLICT",
      "This intake key was already used for another request.",
    );
  const projectId = `proj_${digest.slice(0, 32)}`,
    runId = `run_${digest.slice(0, 32)}`;
  const conversationId = `conv_${digest.slice(0, 32)}`;
  const route = findModelRouteForRole("build");
  const stamp = now();
  await db.batch([
    db
      .prepare(
        "insert or ignore into projects (id,workspaceId,name,description,status,kind,createdAt,updatedAt) values (?,?,?,?,?,?,?,?)",
      )
      .bind(
        projectId,
        scope.workspaceId,
        input.name.trim(),
        input.description ?? input.brief,
        "active",
        "standard",
        stamp,
        stamp,
      ),
    db
      .prepare(
        "insert or ignore into run_bindings (runId,projectId,conversationId,submissionId,planRevision,stackId,payerId,modelRouteId,pricingVersion,createdBy,createdAt) values (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        runId,
        projectId,
        conversationId,
        `sub_${digest.slice(0, 32)}`,
        "rev-0",
        "react-hono",
        scope.actorId,
        route.id,
        route.pricingVersion,
        scope.actorId,
        stamp,
      ),
    db
      .prepare(
        "insert or ignore into build_workflows (projectId,runId,conversationId,sourceConversationId,intakeKey,brief,phase,pendingKey,pendingBody,updatedAt) values (?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        projectId,
        runId,
        conversationId,
        input.sourceConversationId,
        digest,
        input.brief,
        "planning",
        `intake:${digest}`,
        `Prepare a clear plan for this request. Do not build until the plan is approved using the review controls.\n\n${input.brief}`,
        stamp,
      ),
  ]);
  const target = await projectScopeForUser(db, scope.actorId, projectId);
  return {
    project: await getProject(db, target),
    workflow: (await readWorkflow(db, target))!,
  };
}

/** Existing projects keep their actual latest conversation; no reset or duplicate app. */
export async function ensureWorkflow(
  db: D1Database,
  scope: Scope,
): Promise<BuildWorkflow> {
  const existing = await readWorkflow(db, scope);
  if (existing) return existing;
  const project = await getProject(db, scope);
  if (project.kind === "home")
    throw new ScopeError(409, "home_not_build", "Home is not a build project.");
  const binding =
    (await listRunBindings(db, scope))[0] ??
    (await createRun(db, scope, {
      modelRouteId: findModelRouteForRole("build").id,
      payerId: scope.actorId,
    }));
  await db
    .prepare(
      "insert or ignore into build_workflows (projectId,runId,conversationId,intakeKey,brief,phase,updatedAt) values (?,?,?,?,?,?,?)",
    )
    .bind(
      scope.projectId,
      binding.runId,
      binding.conversationId,
      `existing:${scope.projectId}`,
      project.description ?? project.name,
      "planning",
      now(),
    )
    .run();
  return (await readWorkflow(db, scope))!;
}
export const planIntent = (projectId: string, plan: PlanDocRevision) => ({
  projectId,
  action: "design" as const,
  resourceId: plan.id,
  revisionHash: plan.bodyHash,
  policyVersion: "v1",
});
export async function workflowSnapshot(db: D1Database, scope: Scope) {
  let workflow = await readWorkflow(db, scope);
  const plan = (await listPlanDocRevisions(db, scope, "prd"))[0] ?? null;
  if (workflow && plan && workflow.planId !== plan.id) {
    await db
      .prepare(
        "update build_workflows set phase = ?, planId = ?, previewId = null, pendingKey = null, pendingBody = null, detail = null, updatedAt = ? where projectId = ?",
      )
      .bind("review", plan.id, now(), scope.projectId)
      .run();
    workflow = (await readWorkflow(db, scope))!;
  }
  const approval = plan
    ? await getApprovalForIntent(
        db,
        scope.actorId,
        planIntent(scope.projectId, plan),
      )
    : null;
  return { workflow, plan, approval };
}
export async function decideWorkflow(
  db: D1Database,
  scope: Scope,
  input: { planId: string; decision: "approved" | "rejected"; note?: string },
) {
  await ensureWorkflow(db, scope);
  const { workflow, plan } = await workflowSnapshot(db, scope);
  if (!plan || plan.id !== input.planId)
    throw new ScopeError(
      409,
      "STALE_PLAN",
      "The plan changed. Review the latest version.",
    );
  if (input.decision !== "approved" && input.decision !== "rejected")
    throw new ScopeError(
      400,
      "invalid_decision",
      "Choose approve or request changes.",
    );
  const note = input.note?.trim() ?? "";
  if (input.decision === "rejected" && (!note || note.length > 2000))
    throw new ScopeError(
      400,
      "feedback_required",
      "Describe the change in 2000 characters or fewer.",
    );
  const approval = await recordDecision(db, scope.actorId, {
    intent: planIntent(scope.projectId, plan),
    decision: input.decision,
  });
  const decisions = await rows(
    db,
    "select id from plan_decisions where projectId = ? and planRevisionId = ? and approvalId = ? and decidedBy = ?",
    scope.projectId,
    plan.id,
    approval.id,
    scope.actorId,
  );
  if (!decisions.length)
    await recordPlanDecision(db, scope, {
      planRevisionId: plan.id,
      decision: input.decision === "approved" ? "approved" : "changes",
      note,
      approvalId: approval.id,
    });
  // A retried click cannot restart a settled build or queue a second repair.
  if (
    workflow!.phase === "review" ||
    (workflow!.phase === "planning" &&
      workflow!.pendingKey === null &&
      input.decision === "rejected" &&
      !decisions.length)
  ) {
    const phase = input.decision === "approved" ? "building" : "planning";
    const message =
      input.decision === "approved"
        ? `The authenticated review controls approved plan ${plan.id}. Re-read the latest plan and durable approval. Delegate implementation and QA, then call verify_build. Stop honestly on blockers.`
        : `Revise plan ${plan.id} using the user's feedback below. Write a NEW prd revision, then wait for review; no building.\n\n${note}`;
    await db
      .prepare(
        "update build_workflows set phase = ?, pendingKey = ?, pendingBody = ?, detail = null, updatedAt = ? where projectId = ? and planId = ?",
      )
      .bind(
        phase,
        `decision:${approval.id}`,
        message,
        now(),
        scope.projectId,
        plan.id,
      )
      .run();
  }
  return workflowSnapshot(db, scope);
}
export async function acknowledgeDispatch(
  db: D1Database,
  scope: Scope,
  key: string,
) {
  await assertProjectScope(db, scope);
  await db
    .prepare(
      "update build_workflows set pendingKey = null,pendingBody = null,detail = case when phase='blocked' then detail else null end,updatedAt = ? where projectId = ? and pendingKey = ?",
    )
    .bind(now(), scope.projectId, key)
    .run();
}
export async function requireBuildApproval(db: D1Database, scope: Scope) {
  const { workflow, plan } = await workflowSnapshot(db, scope);
  if (!workflow || !plan || workflow.phase !== "building")
    throw new ScopeError(
      409,
      "BUILD_NOT_APPROVED",
      "Show the plan and wait for the review controls before building.",
    );
  const pause = await workflowRepairPause(db, workflow.runId);
  if (pause.paused)
    throw new ScopeError(
      409,
      "RUN_PAUSED",
      "Three repair attempts failed. Ask the user to review the blocker.",
    );
  await checkApprovalForEffect(db, {
    actorId: scope.actorId,
    ...planIntent(scope.projectId, plan),
  });
  return { workflow, plan };
}
export async function setWorkflowBlocker(
  db: D1Database,
  scope: Scope,
  detail: string,
) {
  await assertProjectScope(db, scope);
  await db
    .prepare(
      "update build_workflows set phase = ?,detail = ?,updatedAt = ? where projectId = ?",
    )
    .bind("blocked", detail.slice(0, 2000), now(), scope.projectId)
    .run();
}
/** Stop effects immediately; Flue's abort acknowledgment is separate from settlement. */
export async function stopWorkflow(db: D1Database, scope: Scope) {
  const { workflow } = await workflowSnapshot(db, scope);
  if (!workflow) throw new ScopeError(404, "workflow_not_found", "No build exists.");
  const run = await lookupRunByConversation(db, workflow.conversationId);
  if (run?.createdBy !== scope.actorId) throw new ScopeError(403, "not_run_owner", "Only the build owner can stop it.");
  await db.prepare("update build_workflows set phase='blocked',pendingKey=null,pendingBody=null,detail=?,updatedAt=? where projectId=? and phase='building'")
    .bind("Stop requested. Your plan and files are retained. Wait for Caddie to stop before retrying.", now(), scope.projectId).run();
  return workflowSnapshot(db, scope);
}
export async function storeBuildOutput(
  db: D1Database,
  scope: Scope,
  input: { html: string; image: string; planId: string; runId: string },
) {
  const { workflow, plan } = await requireBuildApproval(db, scope);
  if (plan.id !== input.planId || workflow.runId !== input.runId)
    throw new ScopeError(
      409,
      "STALE_CHECK",
      "Checks no longer match the current plan.",
    );
  const bytes = new TextEncoder().encode(input.html);
  if (!input.html.toLowerCase().includes("<html") || bytes.length > 500_000)
    throw new ScopeError(
      422,
      "INVALID_PREVIEW",
      "A complete HTML preview of at most 500 KB is required.",
    );
  const content = await createD1ContentStore(db).put(bytes);
  const id = `out_${hash(`${scope.projectId}:${plan.id}:${input.image}:${content.contentHash}`).slice(0, 32)}`;
  await db.batch([
    db
      .prepare(
        "insert or ignore into workflow_outputs (id,projectId,runId,planId,image,sha256,createdAt) values (?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        scope.projectId,
        workflow.runId,
        plan.id,
        input.image,
        content.contentHash,
        now(),
      ),
    db
      .prepare(
        `update build_workflows set phase = ?,previewId = ?,detail = null,updatedAt = ?
   where projectId = ? and planId = ? and phase = 'building'
   and planId = (select id from plan_doc_revisions where projectId = ? and kind = 'prd' order by revision desc limit 1)
   and exists(select 1 from approvals where projectId = ? and action = 'design' and resourceId = ? and revisionHash = ? and policyVersion = 'v1' and status = 'approved' and decidedBy = ? and expiresAt >= ?)
   and exists(select 1 from workspace_memberships where workspaceId = ? and userId = ?)`,
      )
      .bind(
        "ready",
        id,
        now(),
        scope.projectId,
        plan.id,
        scope.projectId,
        scope.projectId,
        plan.id,
        plan.bodyHash,
        scope.actorId,
        now(),
        scope.workspaceId,
        scope.actorId,
      ),
  ]);
  const published = await readWorkflow(db, scope);
  if (
    published?.phase !== "ready" ||
    published.previewId !== id ||
    published.planId !== plan.id
  )
    throw new ScopeError(
      409,
      "STALE_CHECK",
      "The plan or approval changed before publication. Run checks against the latest approved plan.",
    );
  return { outputId: id, sha256: content.contentHash };
}
export async function readBuildOutput(
  db: D1Database,
  scope: Scope,
  id: string,
) {
  await assertProjectScope(db, scope);
  const found = await rows(
    db,
    "select sha256 from workflow_outputs where id = ? and projectId = ?",
    id,
    scope.projectId,
  );
  if (!found[0])
    throw new ScopeError(
      404,
      "preview_not_found",
      "No such preview in this project.",
    );
  const bytes = await createD1ContentStore(db).get(String(found[0].sha256));
  if (!bytes)
    throw new ScopeError(
      404,
      "preview_missing",
      "Preview content is unavailable.",
    );
  return bytes;
}

/** Explicit user recovery starts a fresh repair window; previous failures remain evidence. */
export async function workflowRepairPause(db: D1Database, runId: string) {
  const result = await rows(
    db,
    `select issue,count(*) failed from run_rounds where runId=? and round='repair_attempt' and outcome='failed'
  and rowid > coalesce((select afterRoundRowId from workflow_resumes where runId=? order by rowid desc limit 1),0)
  group by issue having count(*) >= 3`,
    runId,
    runId,
  );
  return {
    paused: result.length > 0,
    issue: result[0] ? String(result[0].issue) : null,
  };
}
export async function retryWorkflow(db: D1Database, scope: Scope, key: string, request?: string) {
  if (typeof key !== "string" || !/^[a-zA-Z0-9:_-]{8,160}$/.test(key))
    throw new ScopeError(
      400,
      "invalid_retry_key",
      "An idempotent recovery key is required.",
    );
  const { workflow, plan } = await workflowSnapshot(db, scope);
  if (!workflow || !plan)
    throw new ScopeError(409, "NO_PLAN", "Prepare a plan before continuing.");
  await checkApprovalForEffect(db, {
    actorId: scope.actorId,
    ...planIntent(scope.projectId, plan),
  });
  const previous = await rows(
    db,
    "select id from workflow_resumes where projectId=? and id=?",
    scope.projectId,
    key,
  );
  if (previous.length) return workflowSnapshot(db, scope);
  if (workflow.phase !== "blocked")
    throw new ScopeError(
      409,
      "NOT_BLOCKED",
      "Only a stopped build can be retried.",
    );
  await db.batch([
    db
      .prepare(
        "insert or ignore into workflow_resumes (id,projectId,runId,actorId,afterRoundRowId,createdAt) values (?,?,?,?,coalesce((select max(rowid) from run_rounds where runId=?),0),?)",
      )
      .bind(
        key,
        scope.projectId,
        workflow.runId,
        scope.actorId,
        workflow.runId,
        now(),
      ),
    db
      .prepare(
        "update build_workflows set phase='building',pendingKey=?,pendingBody=?,detail=null,updatedAt=? where projectId=? and phase='blocked' and planId=?",
      )
      .bind(
        `retry:${key}`,
        `The authenticated user asked to retry approved plan ${plan.id}. Inspect the saved files and previous failing checks; repair the blocker, then verify_build. Do not discard prior work.${request ? "\n\nUser request: " + request : ""}`,
        now(),
        scope.projectId,
        plan.id,
      ),
  ]);
  return workflowSnapshot(db, scope);
}
export async function continueProjectFromChat(
  db: D1Database,
  sourceScope: Scope,
  input: { projectId: string; request: string; operationKey: string; resumeBlocked?: boolean },
) {
  await assertProjectScope(db, sourceScope);
  const target = await projectScopeForUser(
    db,
    sourceScope.actorId,
    input.projectId,
  );
  const workflow = await ensureWorkflow(db, target);
  const project = await getProject(db, target);
  if (!input.request.trim() || input.request.length > 16000)
    throw new ScopeError(
      400,
      "invalid_request",
      "A request of up to 16000 characters is required.",
    );
  // Only a fresh user delivery can open another bounded repair window.
  // Framework signals may hand off work but cannot reset the failure boundary.
  const recoveryKey = `continue:${hash(sourceScope.actorId + target.projectId + input.operationKey)}`;
  const delivered = await rows(db, "select id from workflow_resumes where projectId=? and id=?", target.projectId, recoveryKey);
  if (delivered.length) return { project, workflow: (await workflowSnapshot(db, target)).workflow };
  if (workflow.phase === "blocked" && input.resumeBlocked) {
    const resumed = await retryWorkflow(db, target, recoveryKey, input.request);
    return { project, workflow: resumed.workflow };
  }
  if (!workflow.pendingKey)
    await db
      .prepare(
        "update build_workflows set pendingKey=?,pendingBody=?,updatedAt=? where projectId=? and pendingKey is null",
      )
      .bind(
        `continue:${hash(sourceScope.actorId + input.operationKey)}`,
        input.request,
        now(),
        target.projectId,
      )
      .run();
  return { project, workflow: (await workflowSnapshot(db, target)).workflow };
}
