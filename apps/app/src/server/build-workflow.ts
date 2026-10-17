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
  "planning" | "review" | "design" | "design-review" | "building" | "blocked" | "ready";
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
/** The DESIGN-BRIEF approval, distinct from the PRD's planIntent: approving the
 *  plan does not approve the design, and vice versa. Keyed to the design
 *  revision's own hash so the user's go-ahead binds to exactly what they saw. */
export const designIntent = (projectId: string, design: PlanDocRevision) => ({
  projectId,
  action: "design" as const,
  resourceId: design.id,
  revisionHash: design.bodyHash,
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
  // The latest design brief (if any) and its approval — surfaced so the card
  // can render the design-review state and the coordinator can read it.
  const design = (await listPlanDocRevisions(db, scope, "design"))[0] ?? null;
  // Auto-advance design -> design-review once a NOT-YET-DECIDED brief is saved:
  // the designer writes the 'design' revision and stops; an undecided revision
  // while the phase is still 'design' means the brief is ready for review.
  // (Mirrors the planning -> review advance a new PRD triggers above.) A
  // rejected brief stays in 'design' — it already has a decision — until the
  // re-authored NEW revision (no decision yet) supersedes it and advances.
  if (workflow && workflow.phase === "design" && design) {
    const decided = await rows(
      db,
      "select 1 from plan_decisions where projectId = ? and planRevisionId = ? limit 1",
      scope.projectId,
      design.id,
    );
    if (!decided.length) {
      await db
        .prepare(
          "update build_workflows set phase = ?, updatedAt = ? where projectId = ? and phase = 'design'",
        )
        .bind("design-review", now(), scope.projectId)
        .run();
      workflow = (await readWorkflow(db, scope))!;
    }
  }
  const approval = plan
    ? await getApprovalForIntent(
        db,
        scope.actorId,
        planIntent(scope.projectId, plan),
      )
    : null;
  const designApproval = design
    ? await getApprovalForIntent(
        db,
        scope.actorId,
        designIntent(scope.projectId, design),
      )
    : null;
  return { workflow, plan, approval, design, designApproval };
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
    const phase = input.decision === "approved" ? "design" : "planning";
    const message =
      input.decision === "approved"
        ? `The authenticated review controls approved plan ${plan.id}. Now DESIGN before building: delegate the designer to author ONE design brief (screen inventory; each key screen's layout; the token/component choices; the empty, loading and error state for anything that loads or saves), save it with write_plan_note kind:'design' and the same planRevision, then STOP for the authenticated design review. Do NOT build or scaffold yet — building is gated until the design brief is approved.`
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
/**
 * Approve or revise the DESIGN BRIEF — the gate between design-review and
 * building. Mirrors decideWorkflow but binds to the design revision's own
 * approval (designIntent): approving the plan never approves the design, so
 * building stays gated until the brief the user actually saw is approved.
 *   approved -> building (the feature loop may now run)
 *   rejected -> design   (re-author the brief with the feedback; no building)
 */
export async function decideDesign(
  db: D1Database,
  scope: Scope,
  input: { designId: string; decision: "approved" | "rejected"; note?: string },
) {
  await ensureWorkflow(db, scope);
  const { workflow, design } = await workflowSnapshot(db, scope);
  if (!design || design.id !== input.designId)
    throw new ScopeError(
      409,
      "STALE_DESIGN",
      "The design brief changed. Review the latest version.",
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
    intent: designIntent(scope.projectId, design),
    decision: input.decision,
  });
  const decisions = await rows(
    db,
    "select id from plan_decisions where projectId = ? and planRevisionId = ? and approvalId = ? and decidedBy = ?",
    scope.projectId,
    design.id,
    approval.id,
    scope.actorId,
  );
  if (!decisions.length)
    await recordPlanDecision(db, scope, {
      planRevisionId: design.id,
      decision: input.decision === "approved" ? "approved" : "changes",
      note,
      approvalId: approval.id,
    });
  // Only act from design-review (a retried click can't restart a running build
  // or re-queue a design pass).
  if (workflow!.phase === "design-review" && !decisions.length) {
    const phase = input.decision === "approved" ? "building" : "design";
    const message =
      input.decision === "approved"
        ? `The authenticated design review approved the design brief ${design.id}. Build the approved plan feature by feature, implementing it to match the design brief: call build_next_feature, delegate exactly that feature with its doneWhen checks, then finish_feature; when every feature has passed, run QA with verify_build. Stop honestly on blockers.`
        : `Revise the design brief ${design.id} using the user's feedback below. Write a NEW design revision (write_plan_note kind:'design'), then wait for the design review; no building.\n\n${note}`;
    await db
      .prepare(
        "update build_workflows set phase = ?, pendingKey = ?, pendingBody = ?, detail = null, updatedAt = ? where projectId = ?",
      )
      .bind(phase, `design-decision:${approval.id}`, message, now(), scope.projectId)
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
/**
 * A `building` run with no recorded progress for this long is stopped
 * honestly. Longer than the sandbox's 15-minute command cap
 * (coordinator-host.ts quotas), so one slow command never trips it.
 */
export const BUILD_STALL_MS = 20 * 60_000;

/** Newest evidence the build is moving: workflow write, sandbox action or repair round. */
async function lastBuildProgressAt(db: D1Database, workflow: BuildWorkflow): Promise<number> {
  const times = [Date.parse(workflow.updatedAt)];
  for (const sql of [
    'select max("finishedAt") as "t" from "build_activity" where "runId" = ?',
    'select max("createdAt") as "t" from "run_rounds" where "runId" = ?',
  ]) {
    try {
      const found = await rows(db, sql, workflow.runId);
      if (found[0]?.t) times.push(Date.parse(String(found[0].t)));
    } catch (error) {
      if (!String(error).includes("no such table")) throw error;
    }
  }
  return Math.max(...times.filter(Number.isFinite));
}

/**
 * The stall watchdog. A build that stops making progress — the coordinator's
 * request timed out or failed, a dispatch never arrived, a model stopped
 * calling tools — used to sit in `building` forever while the progress card
 * said "working" (FarmLog AI, 2026-10-15: 6 actions, then 80 silent minutes).
 * This turns that silence into the same honest, retryable stop the Stop
 * button produces. System-level (no scope) so the cron sweep can call it;
 * scoped readers verify membership first. Returns true when it stopped one.
 */
export async function reconcileStalledBuild(
  db: D1Database,
  projectId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const found = await rows(db, "select * from build_workflows where projectId = ?", projectId);
  const workflow = (found[0] ?? null) as unknown as BuildWorkflow | null;
  if (!workflow || workflow.phase !== "building") return false;
  const idleMs = nowMs - (await lastBuildProgressAt(db, workflow));
  if (idleMs < BUILD_STALL_MS) return false;
  const minutes = Math.floor(idleMs / 60_000);
  const detail = `Caddie stopped making progress on the build for ${minutes} minutes, so it was paused. Your plan and files are saved. Press Retry to continue from here.`;
  // Conditional on the row we read: a concurrent stop, retry or publish wins.
  const result = await db
    .prepare(
      "update build_workflows set phase='blocked',pendingKey=null,pendingBody=null,detail=?,updatedAt=? where projectId=? and phase='building' and updatedAt=?",
    )
    .bind(detail, new Date(nowMs).toISOString(), projectId, workflow.updatedAt)
    .run();
  return Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

/** Cron sweep: stop every stalled build. Returns how many were stopped. */
export async function sweepStalledBuilds(db: D1Database, nowMs: number = Date.now()): Promise<number> {
  let building: Record<string, unknown>[];
  try {
    building = await rows(db, "select projectId from build_workflows where phase = 'building'");
  } catch (error) {
    // A database without the workflow table (an old local DB) has nothing to sweep.
    if (String(error).includes("no such table")) return 0;
    throw error;
  }
  let stopped = 0;
  for (const row of building) {
    if (await reconcileStalledBuild(db, String(row.projectId), nowMs)) stopped += 1;
  }
  return stopped;
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
/**
 * True when the CURRENT plan revision was EVER approved — still approved, or
 * approved and since revoked/expired. Only a plan that was never approved is a
 * stuck PLAN; a revoked or expired approval must reach the build-retry path so
 * checkApprovalForEffect denies it with APPROVAL_REVOKED / APPROVAL_EXPIRED
 * instead of being quietly re-routed into planning.
 */
async function planWasApproved(db: D1Database, scope: Scope, planId: string | null): Promise<boolean> {
  if (!planId) return false;
  const approved = await rows(
    db,
    "select id from approvals where projectId = ? and resourceId = ? and action = 'design' and status in ('approved', 'revoked', 'expired') limit 1",
    scope.projectId,
    planId,
  );
  return approved.length > 0;
}

/**
 * Resume a plan that got stuck before approval: back to `planning` with the
 * request it needs — the user's latest "changes" feedback on the current
 * revision (or the original brief when no revision exists), plus any message
 * that was parked while the project was blocked. Idempotent on `key`.
 */
async function resumePlanning(
  db: D1Database,
  scope: Scope,
  workflow: BuildWorkflow,
  planId: string | null,
  key: string,
  request?: string,
) {
  const previous = await rows(db, "select id from workflow_resumes where projectId=? and id=?", scope.projectId, key);
  if (previous.length) return workflowSnapshot(db, scope);
  const feedback = planId
    ? await rows(
        db,
        "select note from plan_decisions where projectId = ? and planRevisionId = ? and decision = 'changes' order by createdAt desc limit 1",
        scope.projectId,
        planId,
      )
    : [];
  const note = typeof feedback[0]?.note === "string" ? (feedback[0].note as string) : "";
  const base =
    planId && note
      ? `Revise plan ${planId} using the user's feedback below. Write a NEW prd revision, then wait for review; no building.\n\n${note}`
      : `Prepare a clear plan for this request. Do not build until the plan is approved using the review controls.\n\n${workflow.brief}`;
  // A message parked while blocked (continueProjectFromChat) is carried, not dropped.
  const parked = workflow.pendingKey?.startsWith("continue:") && workflow.pendingBody ? workflow.pendingBody : null;
  const extras = [parked, request].filter((text): text is string => Boolean(text && text.trim()));
  const body = extras.length ? `${base}\n\nThe user also said:\n${extras.join("\n")}` : base;
  await db.batch([
    db
      .prepare(
        "insert or ignore into workflow_resumes (id,projectId,runId,actorId,afterRoundRowId,createdAt) values (?,?,?,?,coalesce((select max(rowid) from run_rounds where runId=?),0),?)",
      )
      .bind(key, scope.projectId, workflow.runId, scope.actorId, workflow.runId, now()),
    db
      .prepare(
        "update build_workflows set phase='planning',pendingKey=?,pendingBody=?,detail=null,updatedAt=? where projectId=? and phase='blocked'",
      )
      .bind(`replan:${key}`, body, now(), scope.projectId),
  ]);
  return workflowSnapshot(db, scope);
}

export async function retryWorkflow(db: D1Database, scope: Scope, key: string, request?: string) {
  if (typeof key !== "string" || !/^[a-zA-Z0-9:_-]{8,160}$/.test(key))
    throw new ScopeError(
      400,
      "invalid_retry_key",
      "An idempotent recovery key is required.",
    );
  const { workflow, plan } = await workflowSnapshot(db, scope);
  if (!workflow)
    throw new ScopeError(409, "NO_PLAN", "Prepare a plan before continuing.");
  // A project blocked BEFORE its plan was approved (e.g. a plan revision that
  // never got saved) resumes PLANNING — never building. Retrying used to
  // require an approved plan and resume the build, so a stuck plan had no way
  // back at all (FarmLog AI, 2026-10-15).
  if (workflow.phase === "blocked" && !(await planWasApproved(db, scope, plan?.id ?? null)))
    return resumePlanning(db, scope, workflow, plan?.id ?? null, key, request);
  if (!plan)
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
        `The authenticated user asked to retry approved plan ${plan.id}. Features that already passed are saved; call build_next_feature to continue from the first unfinished one, repair its blocker, then finish_feature. Do not discard prior work.${request ? "\n\nUser request: " + request : ""}`,
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
