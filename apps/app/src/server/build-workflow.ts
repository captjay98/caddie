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
import { createNotification } from "./notifications.ts";
import { admitJudgeBuildStart, admitJudgeMessage, judgeProjectCap, judgeProjectRefusal, judgeProjectRoom } from "./judge-limits.ts";
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
import { createD1ContentStore, D1_MAX_VALUE_BYTES } from "./artifacts.ts";
import { getLarge, putLarge } from "./large-content.ts";
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
    /** 'react-hono' (default) or 'flutter'; callers check FLUTTER_APPS_ENABLED (project-proposals.ts). */
    stackId?: "react-hono" | "flutter";
  },
  limits?: unknown,
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
  // S07 judge limits (review F03): only a NEW project is counted (a replay
  // above already returned the same project). For a judge, the project row is
  // inserted only while the allowance has room, in the same statement, and the
  // run and intake rows only if that project row exists, so a refused project
  // creates no project, run or intake, and racing creates cannot pass the cap.
  const cap = existing[0] ? null : await judgeProjectCap(db, scope.actorId, limits);
  const room = cap === null ? null : judgeProjectRoom(scope.actorId, cap);
  const projectExists = { sql: "exists (select 1 from projects where id = ?)", params: [projectId] };
  const insert = (head: string, values: unknown[], when: { sql: string; params: unknown[] } | null) =>
    when
      ? db.prepare(`${head} select ${values.map(() => "?").join(",")} where ${when.sql}`).bind(...values, ...when.params)
      : db.prepare(`${head} values (${values.map(() => "?").join(",")})`).bind(...values);
  const route = findModelRouteForRole("build");
  const stamp = now();
  const results = await db.batch([
    insert(
      "insert or ignore into projects (id,workspaceId,name,description,status,kind,createdAt,updatedAt)",
      [projectId, scope.workspaceId, input.name.trim(), input.description ?? input.brief, "active", "standard", stamp, stamp],
      room,
    ),
    insert(
      "insert or ignore into run_bindings (runId,projectId,conversationId,submissionId,planRevision,stackId,payerId,modelRouteId,pricingVersion,createdBy,createdAt)",
      [
        runId,
        projectId,
        conversationId,
        `sub_${digest.slice(0, 32)}`,
        "rev-0",
        input.stackId === "flutter" ? "flutter" : "react-hono",
        scope.actorId,
        route.id,
        route.pricingVersion,
        scope.actorId,
        stamp,
      ],
      room ? projectExists : null,
    ),
    insert(
      "insert or ignore into build_workflows (projectId,runId,conversationId,sourceConversationId,intakeKey,brief,phase,pendingKey,pendingBody,updatedAt)",
      [
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
      ],
      room ? projectExists : null,
    ),
  ]);
  if (cap !== null) {
    const inserted = Number((results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) > 0;
    // Nothing inserted: the allowance was full, unless a twin request with the
    // same intake key created this very project first.
    if (!inserted && !(await rows(db, "select 1 from projects where id = ?", projectId)).length)
      throw judgeProjectRefusal(cap);
  }
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
/** Whether this actor already recorded `decision` on this plan or design revision (a re-click). */
async function decidedBefore(db: D1Database, scope: Scope, revisionId: string, decision: "approved" | "changes") {
  const found = await rows(
    db,
    "select 1 from plan_decisions where projectId = ? and planRevisionId = ? and decidedBy = ? and decision = ? limit 1",
    scope.projectId,
    revisionId,
    scope.actorId,
    decision,
  );
  return found.length > 0;
}
export async function decideWorkflow(
  db: D1Database,
  scope: Scope,
  input: { planId: string; decision: "approved" | "rejected"; note?: string },
  limits?: unknown,
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
  // S07 judge limits. Approving the plan only starts the DESIGN step (one
  // model turn, no sandbox), so it is not a build start: the build starts when
  // the design is approved (decideDesign). A change request makes Caddie
  // rewrite the plan, so it counts as one Caddie message (review F02: these
  // turns used to count against nothing). Refused before any write; a
  // re-click that dispatches nothing is not counted again.
  if (
    input.decision === "rejected" &&
    (workflow!.phase === "review" || (workflow!.phase === "planning" && workflow!.pendingKey === null)) &&
    !(await decidedBefore(db, scope, plan.id, "changes"))
  )
    await admitJudgeMessage(db, scope.actorId, limits);
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
  limits?: unknown,
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
  // S07 judge limits: approving the design brief starts the actual build, and
  // is refused before any write. Only the transition from design-review counts.
  // A change request makes Caddie rewrite the brief: one Caddie message.
  if (input.decision === "approved" && workflow!.phase === "design-review")
    await admitJudgeBuildStart(db, scope.actorId, limits);
  if (
    input.decision === "rejected" &&
    workflow!.phase === "design-review" &&
    !(await decidedBefore(db, scope, design.id, "changes"))
  )
    await admitJudgeMessage(db, scope.actorId, limits);
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
  await notifyBuildPaused(db, scope.projectId, detail);
}

/**
 * Caddie paused this build and needs its owner (plan 5.4). Besides the Brief
 * card, the owner gets ONE notification per run, raised here where the pause
 * is recorded (the dedupe key arbitrates repeats). Only Caddie's own pauses
 * come here: the person's Stop (stopWorkflow) never does. A notification that
 * cannot be saved never undoes or hides the pause.
 */
async function notifyBuildPaused(db: D1Database, projectId: string, detail: string): Promise<void> {
  try {
    const found = await rows(
      db,
      'select w."runId", w."conversationId", p."name" from build_workflows w join "projects" p on p."id" = w."projectId" where w."projectId" = ?',
      projectId,
    );
    const workflow = found[0];
    if (!workflow) return;
    const run = await lookupRunByConversation(db, String(workflow.conversationId));
    if (!run?.createdBy) return;
    await createNotification(db, {
      userId: run.createdBy,
      projectId,
      kind: "build_paused",
      title: `Caddie paused the build of ${String(workflow.name)}`,
      body: detail.slice(0, 600),
      dedupeKey: `brief:${String(workflow.runId)}:blocked`,
    });
  } catch (error) {
    console.warn("build-paused notification not saved", error);
  }
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
  const paused = Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
  if (paused) await notifyBuildPaused(db, projectId, detail);
  return paused;
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

/**
 * Every Stop button (the chat card and the project page) ends here (plan 3.2):
 * the workflow is marked stopped FIRST, so nothing that runs after the abort
 * sees a building workflow, then the build's running turn is stopped. A
 * failed abort keeps the stop: the builder's next step finds the build stopped.
 */
export async function stopBuild(
  db: D1Database,
  scope: Scope,
  abort: ((conversationId: string) => Promise<boolean>) | null,
) {
  const snapshot = await stopWorkflow(db, scope);
  if (abort && snapshot.workflow) {
    try {
      await abort(snapshot.workflow.conversationId);
    } catch (error) {
      console.error("stop: the running turn could not be stopped:", error);
    }
  }
  return snapshot;
}
/** What a checked build carries besides its preview page (manifest v1, stored by content hash). */
export interface BuildBundleInput {
  /** dist/server.js — the app's server for Cloudflare Workers, or null for a client-only build. */
  server: string | null;
  /** migrations/NNNN_name.sql files, in name order. */
  migrations: { name: string; sql: string }[];
  /**
   * dist/main.js and dist/main.css as checked. The preview inlines them into
   * one document; publishing serves them as files, because a published page
   * may only run scripts from its own origin (the dispatch Worker's CSP).
   */
  client?: { js: string; css: string };
  /**
   * Android apps (Track 3): the whole browser preview page (flutter-preview.ts),
   * kept in the large-file store because it is bigger than one D1 value.
   */
  flutterWeb?: string;
  /** Validated native package, bound to this manifest and approval. */
  android?: { sha256: string; bytes: number; apiBase: string };
}

export interface BuildManifest {
  v: 1;
  server: { sha256: string; bytes: number } | null;
  migrations: { name: string; sha256: string }[];
  client?: { js: { sha256: string; bytes: number }; css: { sha256: string; bytes: number } };
  /** Android apps: the browser preview page in the large-file store (large-content.ts). */
  flutterWeb?: { sha256: string; bytes: number };
  android?: { sha256: string; bytes: number; apiBase: string };
}

// A build file is stored as one D1 BLOB, capped at 2 MB in production
// (D1_MAX_VALUE_BYTES). These per-file ceilings match that real limit, so an
// over-size file is refused at check time with a specific message rather than
// failing the content-store write later.
const MAX_SERVER_BUNDLE_BYTES = D1_MAX_VALUE_BYTES;
const MAX_MIGRATION_BYTES = 256 * 1024;
const MAX_CLIENT_FILE_BYTES = D1_MAX_VALUE_BYTES;

async function storeBundleManifest(db: D1Database, bundle: BuildBundleInput): Promise<string> {
  const store = createD1ContentStore(db);
  let server: BuildManifest["server"] = null;
  if (bundle.server !== null) {
    const bytes = new TextEncoder().encode(bundle.server);
    if (bytes.length > MAX_SERVER_BUNDLE_BYTES)
      throw new ScopeError(422, "SERVER_TOO_LARGE", "The app's server is larger than 2 MB, which is the most a saved app can hold in one file.");
    server = { sha256: (await store.put(bytes)).contentHash, bytes: bytes.length };
  }
  const migrations: BuildManifest["migrations"] = [];
  for (const file of [...bundle.migrations].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!/^\d{4}_[A-Za-z0-9_.-]+\.sql$/.test(file.name))
      throw new ScopeError(422, "INVALID_MIGRATION", `${file.name} is not a NNNN_name.sql migration.`);
    const bytes = new TextEncoder().encode(file.sql);
    if (bytes.length > MAX_MIGRATION_BYTES)
      throw new ScopeError(422, "INVALID_MIGRATION", `${file.name} is larger than 256 KB.`);
    migrations.push({ name: file.name, sha256: (await store.put(bytes)).contentHash });
  }
  let client: BuildManifest["client"];
  if (bundle.client) {
    const part = async (text: string, label: string) => {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > MAX_CLIENT_FILE_BYTES)
        throw new ScopeError(422, "CLIENT_TOO_LARGE", `The app's ${label} is larger than 2 MB, which is the most a saved app can hold in one file.`);
      return { sha256: (await store.put(bytes)).contentHash, bytes: bytes.length };
    };
    client = { js: await part(bundle.client.js, "script"), css: await part(bundle.client.css, "styles") };
  }
  let flutterWeb: BuildManifest["flutterWeb"];
  if (bundle.flutterWeb !== undefined) {
    const page = await putLarge(db, new TextEncoder().encode(bundle.flutterWeb));
    flutterWeb = { sha256: page.sha256, bytes: page.bytes };
  }
  const android = bundle.android;
  if (android) {
    const { androidApiBase } = await import('./android-app.ts');
    const head = await rows(db, 'select "bytes" from "large_content" where "sha256" = ?', android.sha256);
    if (!bundle.flutterWeb || !androidApiBase(android.apiBase, 'check') || !head[0] || Number(head[0].bytes) !== android.bytes) throw new ScopeError(422, 'INVALID_APK', 'The Android package has not been stored for this build.');
  }
  const manifest: BuildManifest = { v: 1, server, migrations, ...(android ? { android } : {}), ...(client ? { client } : {}), ...(flutterWeb ? { flutterWeb } : {}) };
  return (await store.put(new TextEncoder().encode(JSON.stringify(manifest)))).contentHash;
}

export async function storeBuildOutput(
  db: D1Database,
  scope: Scope,
  input: { html: string; image: string; planId: string; runId: string; bundle?: BuildBundleInput },
) {
  const { workflow, plan } = await requireBuildApproval(db, scope);
  if (plan.id !== input.planId || workflow.runId !== input.runId)
    throw new ScopeError(
      409,
      "STALE_CHECK",
      "Checks no longer match the current plan.",
    );
  const { id, contentHash, manifestSha256 } = await prepareOutput(db, scope.projectId, plan.id, input);
  const android = input.bundle?.android ?? null;
  await db.batch([
    db
      .prepare(
        "insert or ignore into workflow_outputs (id,projectId,runId,planId,image,sha256,manifestSha256,createdAt,apkSha256,apkBytes) values (?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        id,
        scope.projectId,
        workflow.runId,
        plan.id,
        input.image,
        contentHash,
        manifestSha256,
        now(),
        android?.sha256 ?? null,
        android?.bytes ?? null,
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
  return { outputId: id, sha256: contentHash };
}

/** Validate and store a preview document (and its bundle); the output id follows from the content. */
async function prepareOutput(
  db: D1Database,
  projectId: string,
  planId: string,
  input: { html: string; image: string; bundle?: BuildBundleInput },
) {
  const bytes = new TextEncoder().encode(input.html);
  if (!input.html.toLowerCase().includes("<html"))
    throw new ScopeError(
      422,
      "INVALID_PREVIEW",
      "A complete HTML preview of at most 2 MB is required.",
    );
  // The page carries the whole app (its code and styles inlined), so its
  // limit is storage's own, not a smaller guess: a finished build with
  // sql.js once got no preview at 500 KB (live finding, 2026-10-20).
  if (bytes.length > D1_MAX_VALUE_BYTES)
    throw new ScopeError(
      422,
      "INVALID_PREVIEW",
      `This app's preview page is ${(bytes.length / 1_000_000).toFixed(1)} MB, and a preview can be at most ${D1_MAX_VALUE_BYTES / 1_000_000} MB. Make the app's code smaller (load big files only when needed) and check again.`,
    );
  const content = await createD1ContentStore(db).put(bytes);
  const manifestSha256 = input.bundle ? await storeBundleManifest(db, input.bundle) : null;
  const id = `out_${hash(`${projectId}:${planId}:${input.image}:${content.contentHash}${manifestSha256 ? `:${manifestSha256}` : ""}`).slice(0, 32)}`;
  return { id, contentHash: content.contentHash, manifestSha256 };
}

/**
 * The copied app's preview ("Start from my GitHub repo", import-preview.ts):
 * the same output record a checked build makes, tied to the imported version
 * instead of a plan. It never moves the build workflow — the card shows it
 * until the first build has a preview of its own.
 */
export async function storeImportedOutput(
  db: D1Database,
  scope: Scope,
  input: { html: string; image: string; commitId: string; bundle: BuildBundleInput },
) {
  await assertProjectScope(db, scope);
  const source = `import:${input.commitId}`;
  const { id, contentHash, manifestSha256 } = await prepareOutput(db, scope.projectId, source, input);
  await db
    .prepare(
      "insert or ignore into workflow_outputs (id,projectId,runId,planId,image,sha256,manifestSha256,createdAt) values (?,?,?,?,?,?,?,?)",
    )
    .bind(id, scope.projectId, source, source, input.image, contentHash, manifestSha256, now())
    .run();
  return { outputId: id, sha256: contentHash };
}
/** The checked build's server bundle and migrations, or null when it has no server. */
export async function readBuildBundle(
  db: D1Database,
  scope: Scope,
  id: string,
): Promise<{ server: string; migrations: { name: string; sql: string }[] } | null> {
  await assertProjectScope(db, scope);
  const found = await rows(
    db,
    'select "manifestSha256" from workflow_outputs where id = ? and projectId = ?',
    id,
    scope.projectId,
  );
  if (!found[0]) throw new ScopeError(404, "preview_not_found", "No such preview in this project.");
  const manifestHash = found[0].manifestSha256;
  if (manifestHash === null || manifestHash === undefined) return null;
  const store = createD1ContentStore(db);
  const text = async (sha: string) => {
    const bytes = await store.get(sha);
    if (!bytes) throw new ScopeError(404, "preview_missing", "Part of this build is no longer available.");
    return new TextDecoder().decode(bytes);
  };
  const manifest = JSON.parse(await text(String(manifestHash))) as BuildManifest;
  if (manifest.v !== 1 || !manifest.server) return null;
  const migrations = [];
  for (const file of manifest.migrations) migrations.push({ name: file.name, sql: await text(file.sha256) });
  return { server: await text(manifest.server.sha256), migrations };
}

export interface OutputManifestView {
  manifestSha256: string;
  publishable: boolean;
  hasServer: boolean;
  /** "flutter": an Android app's browser preview (Track 3). */
  kind: "web" | "flutter";
  migrations: { name: string; sha256: string }[];
}

/** A checked output's manifest only (no file bodies): what status screens need. */
export async function readOutputManifest(db: D1Database, scope: Scope, id: string): Promise<OutputManifestView | null> {
  await assertProjectScope(db, scope);
  const found = await rows(db, 'select "manifestSha256" from workflow_outputs where id = ? and projectId = ?', id, scope.projectId);
  if (!found[0]) return null;
  const manifestHash = found[0].manifestSha256;
  if (manifestHash === null || manifestHash === undefined) return { manifestSha256: "", publishable: false, hasServer: false, kind: "web", migrations: [] };
  const bytes = await createD1ContentStore(db).get(String(manifestHash));
  if (!bytes) return null;
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as BuildManifest;
  return {
    manifestSha256: String(manifestHash),
    publishable: manifest.v === 1 && Boolean(manifest.client || (manifest.flutterWeb && manifest.android && manifest.server)),
    hasServer: manifest.server !== null,
    kind: manifest.flutterWeb ? "flutter" : "web",
    migrations: manifest.migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
  };
}

export interface PublishBundle {
  /** The bundle manifest's hash: what this exact version is. */
  manifestSha256: string;
  js: string;
  css: string;
  android?: { sha256: string; bytes: number; apiBase: string };
  server: string | null;
  migrations: { name: string; sha256: string; sql: string }[];
}

/**
 * Everything publishing needs from a checked build output, scoped to the
 * project. A build checked before client files were kept has no `client`
 * part; publishing it needs the checks to run again (REBUILD_TO_PUBLISH).
 */
export async function readPublishBundle(db: D1Database, scope: Scope, id: string): Promise<PublishBundle> {
  await assertProjectScope(db, scope);
  const found = await rows(db, 'select "manifestSha256", "apkSha256", "apkBytes" from workflow_outputs where id = ? and projectId = ?', id, scope.projectId);
  if (!found[0]) throw new ScopeError(404, "preview_not_found", "No such version in this project.");
  const manifestHash = found[0].manifestSha256;
  const rebuild = () =>
    new ScopeError(409, "REBUILD_TO_PUBLISH", "This version was checked before publishing was possible. Run the checks again, then publish.");
  if (manifestHash === null || manifestHash === undefined) throw rebuild();
  const store = createD1ContentStore(db);
  const text = async (sha: string) => {
    const bytes = await store.get(sha);
    if (!bytes) throw new ScopeError(404, "preview_missing", "Part of this build is no longer available.");
    return new TextDecoder().decode(bytes);
  };
  const manifest = JSON.parse(await text(String(manifestHash))) as BuildManifest;
  if (manifest.v !== 1 || (!manifest.client && !(manifest.flutterWeb && manifest.android && manifest.server))) throw rebuild();
  if (manifest.android && (manifest.android.sha256 !== found[0].apkSha256 || manifest.android.bytes !== found[0].apkBytes)) throw new ScopeError(409, 'APK_MISMATCH', 'The Android package does not match the approved build. Build a new version.');
  const migrations = [];
  for (const file of manifest.migrations) migrations.push({ name: file.name, sha256: file.sha256, sql: await text(file.sha256) });
  return {
    manifestSha256: String(manifestHash),
    js: manifest.client ? await text(manifest.client.js.sha256) : "",
    css: manifest.client ? await text(manifest.client.css.sha256) : "",
    ...(manifest.android ? { android: manifest.android } : {}),
    server: manifest.server ? await text(manifest.server.sha256) : null,
    migrations,
  };
}

export async function readBuildOutput(
  db: D1Database,
  scope: Scope,
  id: string,
) {
  await assertProjectScope(db, scope);
  const found = await rows(
    db,
    "select sha256, manifestSha256 from workflow_outputs where id = ? and projectId = ?",
    id,
    scope.projectId,
  );
  if (!found[0])
    throw new ScopeError(
      404,
      "preview_not_found",
      "No such preview in this project.",
    );
  const store = createD1ContentStore(db);
  // Android apps (Track 3): the stored HTML is a small stand-in; the real page
  // is in the large-file store, named by the build manifest.
  if (found[0].manifestSha256) {
    const manifestBytes = await store.get(String(found[0].manifestSha256));
    const manifest = manifestBytes ? (JSON.parse(new TextDecoder().decode(manifestBytes)) as BuildManifest) : null;
    if (manifest?.flutterWeb) {
      const page = await getLarge(db, manifest.flutterWeb.sha256);
      if (!page) throw new ScopeError(404, "preview_missing", "Preview content is unavailable.");
      return page;
    }
  }
  const bytes = await store.get(String(found[0].sha256));
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
  limits?: unknown,
) {
  const previous = await rows(db, "select id from workflow_resumes where projectId=? and id=?", scope.projectId, key);
  if (previous.length) return workflowSnapshot(db, scope);
  // S07 judge limits (review F02): resuming makes Caddie plan again, one
  // Caddie message, refused before the resume row and the phase change.
  await admitJudgeMessage(db, scope.actorId, limits);
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

export async function retryWorkflow(db: D1Database, scope: Scope, key: string, request?: string, limits?: unknown) {
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
    return resumePlanning(db, scope, workflow, plan?.id ?? null, key, request, limits);
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
  // S07 judge limits: a real retry is one build start, refused BEFORE the
  // resume row and the phase change. Replays (the `previous` check above) and a
  // blocked plan that resumes planning never reach here.
  await admitJudgeBuildStart(db, scope.actorId, limits);
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
  limits?: unknown,
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
    const resumed = await retryWorkflow(db, target, recoveryKey, input.request, limits);
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
