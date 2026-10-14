import type { AuthEnv } from "./auth.ts";
import type { RunBindingRecord } from "@caddie/contracts";
import type { CoordinatorHostContext } from "../agents/coordinator.ts";
import type { SandboxToolDeps } from "../agents/tools.ts";
import { D1SandboxPersistence } from "./adapters/sandbox-persistence.ts";
import { SandboxDriver, SandboxError } from "./adapters/sandbox.ts";
import { bytesToBase64, base64ToBytes } from "./adapters/contree.ts";
import {
  lookupRunByConversation,
  recordRepairRound,
  recordVerification,
} from "./runs.ts";
import { createPlanDocRevision, listProjectsForActor } from "./projects.ts";
import { requestApproval as requestApprovalOnServer } from "./approvals.ts";
import { actorContext, discoverForActor, hackathonDetailsForActor, researchForActor } from "./coordinator-context.ts";
import { upsertProfile } from "./profiles.ts";
import { proposeMemoryFact } from "./memory.ts";
import { listImports } from "./repositories.ts";
import { deriveEnrichment, describeEnrichment } from "./profile-enrichment.ts";
import { STACK_IDS } from "@caddie/contracts";
import {
  startProjectFromChat,
  ensureWorkflow,
  workflowSnapshot,
  requireBuildApproval,
  setWorkflowBlocker,
  storeBuildOutput,
  workflowRepairPause,
  continueProjectFromChat,
} from "./build-workflow.ts";
import { STACK_CATALOG } from "./stacks.ts";
import { SCAFFOLD_FILES, SCAFFOLD_COMMANDS } from "../../../../stacks/react-hono/scaffold.ts";
import { projectScopeForUser, ScopeError } from "./scope.ts";
export interface CoordinatorEnvironment {
  DB: AuthEnv["DB"];
  /** Tavily search key — the required PRIMARY discovery source + research tool (see AuthEnv). */
  TAVILY_API_KEY?: string;
  /** Nebius model key — powers AI fit inspection of discovery candidates (fail-soft when unset). */
  NEBIUS_API_KEY?: string;
  CONTREE_BASE_URL?: string;
  CONTREE_API_TOKEN?: string;
  CONTREE_PROJECT_ID?: string;
  CONTREE_IMAGE?: string;
}
/** Called inside the owning DO, including alarms/recovery; no HTTP module globals. */
export async function resolveCoordinatorContext(
  env: CoordinatorEnvironment,
  conversationId: string,
): Promise<CoordinatorHostContext> {
  if (!env?.DB) throw new Error("Coordinator D1 binding is unavailable.");
  const run = await lookupRunByConversation(env.DB, conversationId);
  if (!run?.createdBy)
    throw new ScopeError(
      404,
      "conversation_not_found",
      "No actor-bound conversation exists.",
    );
  const scope = await projectScopeForUser(env.DB, run.createdBy, run.projectId);
  return createCoordinatorContext(env, scope, run.runId, run);
}
export async function createCoordinatorContext(
  env: CoordinatorEnvironment,
  scope: { actorId: string; workspaceId: string; projectId: string },
  runId: string,
  run: RunBindingRecord,
): Promise<CoordinatorHostContext> {
  const projectRows = await env.DB.prepare(
    "select kind from projects where id = ?",
  )
    .bind(scope.projectId)
    .all();
  const isHome =
    (projectRows.results[0] as { kind: string } | undefined)?.kind === "home";
  const actor = await actorContext(env.DB, scope);
  const projects = isHome
    ? await listProjectsForActor(env.DB, scope.actorId)
    : [];
  const homeOverview = isHome
    ? "This is Home. Your project cards keep work inside this conversation. Existing projects: " +
      JSON.stringify(
        projects
          .filter((p) => p.kind !== "home")
          .map((p) => ({ id: p.id, name: p.name, description: p.description })),
      )
    : null;
  let planRevision = run.planRevision;
  const sessionId = `session:${runId}`;
  const root = `/workspace/${scope.projectId}`;
  // tt-base installs Bun outside the non-login shell's default PATH.
  // Only runtime locations enter the sandbox, never the Worker's environment.
  const runtimeEnv = { PATH: "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin" };
  let driver: SandboxDriver | null = null;
  let sessionReady: Promise<string> | null = null;
  const ensureSession = async () => {
    if (isHome)
      throw new SandboxError(409, "HOME_NO_SANDBOX", "Create a project first.");
    await requireBuildApproval(env.DB, scope);
    if (
      !env.CONTREE_BASE_URL ||
      !env.CONTREE_API_TOKEN ||
      !env.CONTREE_PROJECT_ID
    ) {
      await setWorkflowBlocker(
        env.DB,
        scope,
        "The build sandbox is not configured. Your plan is saved; connect the sandbox to continue.",
      );
      throw new SandboxError(
        503,
        "SANDBOX_NOT_CONFIGURED",
        "The build sandbox is not configured. Planning remains available.",
      );
    }
    driver ??= new SandboxDriver(
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
        workspaceRoot: "/workspace",
      },
      new D1SandboxPersistence(env.DB),
    );
    sessionReady ??= driver
      .ensureSession({
        sessionKey: sessionId,
        image: env.CONTREE_IMAGE ?? "tag:tt-base:1",
        projectId: scope.projectId,
        runId,
      })
      .then((s) => s.sessionId);
    const id = await sessionReady;
    return { driver, id };
  };
  // Empty generic scaffold only; the model must implement the requested app.
  // The files + commands come from the ONE shared stack source
  // (stacks/react-hono/scaffold.ts), identical to what the evaluation journey
  // uses — a green fixture journey and a real chat build now run the same setup.
  let scaffoldReady: Promise<void> | null = null;
  const scaffold = () =>
    (scaffoldReady ??= (async () => {
      const { driver, id } = await ensureSession();
      if (await driver.pathExists(id, `${root}/package.json`)) return;
      await driver.uploadFiles(
        id,
        Object.entries(SCAFFOLD_FILES).map(([path, text]) => ({
          path: `${root}/${path}`,
          contentBase64: bytesToBase64(new TextEncoder().encode(text)),
        })),
      );
    })());
  const deps: SandboxToolDeps = {
    execute: async (input) => {
      input.signal?.throwIfAborted();
      await scaffold();
      const { driver, id } = await ensureSession();
      const operationKey = `exec:${runId}:${input.operationKey}`;
      const result = await driver.execute({
        sessionId: id,
        command: input.command,
        operationKey,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        cwd: root,
        env: runtimeEnv,
      });
      // Specialists often test before QA. Those real failed attempts must share
      // the repair boundary, including replay after Durable Object recovery.
      if (/(?:^|[;&|\n])\s*bun\s+(?:test|run\s+test)\b/.test(input.command)) {
        const receipt = await driver.getOperationReceipt(operationKey);
        if (receipt?.projectId === scope.projectId && receipt.runId === runId &&
            receipt.command === input.command && receipt.exitCode !== null && receipt.exitCode !== 0) {
          await recordRepairRound(env.DB, scope, runId, {
            issue: "behavior-tests", round: "repair_attempt", outcome: "failed",
            operationKey, detail: JSON.stringify(receipt),
          });
          if ((await workflowRepairPause(env.DB, runId)).paused) {
            await setWorkflowBlocker(env.DB, scope,
              "Caddie could not get the app checks passing after three attempts. Your plan and files are saved. The app is not ready to try yet.");
          }
        }
      }
      return result;
    },
    readFile: async (input) => {
      await scaffold();
      const { driver, id } = await ensureSession();
      return new TextDecoder().decode(
        base64ToBytes((await driver.readFile(id, input.path)).contentBase64),
      );
    },
    writeFile: async (input) => {
      await scaffold();
      const { driver, id } = await ensureSession();
      await driver.writeFile(
        id,
        input.path,
        bytesToBase64(new TextEncoder().encode(input.content)),
      );
    },
  };
  const verifyBuild = async (attempt: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const { workflow, plan } = await requireBuildApproval(env.DB, scope);
    await scaffold();
    const { driver, id } = await ensureSession();
    const commands = [
      { check: "dependencies", command: SCAFFOLD_COMMANDS.install.join(" && ") },
      { check: "behavior-tests", command: SCAFFOLD_COMMANDS.test.join(" && ") },
      { check: "browser-bundle", command: SCAFFOLD_COMMANDS.build.join(" && ") },
    ];
    const receipts = [];
    for (const check of commands) {
      const operationKey = `verify:${runId}:${plan.id}:${attempt}:${check.check}`;
      await requireBuildApproval(env.DB, scope);
      const result = await driver.execute({
        sessionId: id,
        command: check.command,
        operationKey,
        signal,
        timeoutMs: 120_000,
        cwd: root,
        env: runtimeEnv,
      });
      const receipt = await driver.getOperationReceipt(operationKey);
      const passed = Boolean(
        receipt &&
        receipt.projectId === scope.projectId &&
        receipt.runId === runId &&
        receipt.command === check.command &&
        receipt.state === "succeeded" &&
        receipt.cwd === root &&
        receipt.exitCode === 0 &&
        !receipt.timedOut &&
        !receipt.outputTruncated &&
        (check.check !== "behavior-tests" ||
          /[1-9]\d* pass/.test(receipt.stdout + "\n" + receipt.stderr)),
      );
      await recordVerification(env.DB, scope, workflow.runId, {
        check: check.check,
        passed,
        evidence: JSON.stringify(receipt),
        planRevision: plan.id,
      });
      receipts.push({
        check: check.check,
        passed,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        operationKey,
      });
      if (!passed) {
        await recordRepairRound(env.DB, scope, workflow.runId, {
          issue: check.check,
          operationKey,
          round: "repair_attempt",
          outcome: "failed",
          detail: JSON.stringify(receipts.at(-1)),
        });
        const paused = (await workflowRepairPause(env.DB, workflow.runId))
          .paused;
        if (paused)
          await setWorkflowBlocker(
            env.DB,
            scope,
            "Caddie could not get the app checks passing after three attempts. Your plan and files are saved. The app is not ready to try yet.",
          );
        return {
          passed: false,
          paused,
          receipts,
          next: "Delegate a focused repair for the failing check, then run verify_build again.",
        };
      }
    }
    signal?.throwIfAborted();
    const final = await driver.getOperationReceipt(
      `verify:${runId}:${plan.id}:${attempt}:browser-bundle`,
    );
    if (!final?.resultImage)
      throw new Error("The verified build image is missing.");
    const before = await driver.checkpoint(id);
    if (before.checkpointRef !== final.resultImage)
      throw new ScopeError(
        409,
        "STALE_BUILD",
        "Files changed after the build. Run checks again.",
      );
    const js = new TextDecoder().decode(
      base64ToBytes(
        (await driver.readFile(id, `${root}/dist/main.js`)).contentBase64,
      ),
    );
    let css = "";
    if (await driver.pathExists(id, `${root}/dist/main.css`))
      css = new TextDecoder().decode(
        base64ToBytes(
          (await driver.readFile(id, `${root}/dist/main.css`)).contentBase64,
        ),
      );
    const after = await driver.checkpoint(id);
    if (after.checkpointRef !== final.resultImage)
      throw new ScopeError(
        409,
        "STALE_BUILD",
        "Files changed while preparing the preview. Run checks again.",
      );
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your app</title><style>' +
      css.replace(/<\/style/gi, "<\\/style") +
      '</style></head><body><div id="root"></div><script type="module">' +
      js.replace(/<\/script/gi, "<\\/script") +
      "</script></body></html>";
    signal?.throwIfAborted();
    const output = await storeBuildOutput(env.DB, scope, {
      html,
      image: final.resultImage,
      planId: plan.id,
      runId: workflow.runId,
    });
    return {
      passed: true,
      receipts,
      ...output,
      next: "The project card shows the working preview. Build checks passed; ask the user to try the behavior.",
    };
  };
  return {
    driver: deps,
    sessionId,
    runId,
    projectId: scope.projectId,
    homeOverview,
    actorContext: actor.text,
    currentPlanRevision: () => planRevision,
    listStacks: async () => STACK_CATALOG,
    discover: (input) => discoverForActor(env.DB, scope, input, { tavilyApiKey: env.TAVILY_API_KEY, nebiusApiKey: env.NEBIUS_API_KEY }),
    research: (input) => researchForActor(env.DB, scope, input, { tavilyApiKey: env.TAVILY_API_KEY }),
    hackathonDetails: (input) => hackathonDetailsForActor(env.DB, scope, input, { nebiusApiKey: env.NEBIUS_API_KEY }),
    updateProfile: async (input) => {
      // Only the fields the model may set from conversation; the service
      // re-verifies the actor and merges (undefined keeps the current value).
      // 'interests' maps to the profile's freeTextInterests. Budget is NOT
      // settable here by construction — the tool schema omits it.
      const patch: Record<string, unknown> = {};
      const applied: string[] = [];
      if (input.skills !== undefined) { patch.skills = input.skills.slice(0, 12); applied.push("skills"); }
      if (input.interests !== undefined) { patch.freeTextInterests = input.interests.slice(0, 12); applied.push("interests"); }
      if (input.experienceLevel !== undefined) { patch.experienceLevel = input.experienceLevel; applied.push("experience"); }
      if (input.formatPreference !== undefined) { patch.formatPreference = input.formatPreference; applied.push("format"); }
      if (input.weeklyHours !== undefined) { patch.weeklyHours = input.weeklyHours; applied.push("weekly hours"); }
      if (input.stackIds !== undefined) {
        // Keep only real stack ids; free text is never a stack.
        patch.stackIds = input.stackIds.filter((id) => STACK_IDS.includes(id as (typeof STACK_IDS)[number]));
        applied.push("preferred tools");
      }
      if (applied.length === 0) return { applied };
      await upsertProfile(env.DB, scope.actorId, patch);
      return { applied };
    },
    remember: async (input) => {
      // Everything the model proposes starts as a PROPOSAL (status 'proposed');
      // only user confirmation moves it into future context. sourceRunId stamps
      // provenance so a proposal is always traceable to this run.
      await proposeMemoryFact(env.DB, scope.actorId, {
        kind: input.kind,
        content: input.content,
        sourceRunId: runId,
      });
      return { proposed: true };
    },
    inspectRepository: async () => {
      // Read-only enrichment inference from the latest imported repo (CL3).
      // Home has no project imports; a project with no import returns found:false.
      if (isHome) return { found: false, summary: "", skills: [], stacks: [], notes: [] };
      const imports = await listImports(env.DB, scope);
      const latest = imports[0];
      if (!latest) return { found: false, summary: "", skills: [], stacks: [], notes: [] };
      // Pull dependency manifests out of the import's own manifest content where
      // present (package.json etc. are small, declared, non-secret files).
      const files = latest.manifest.map((entry) => ({ path: entry.path, size: entry.size }));
      const proposal = deriveEnrichment(files, {});
      return {
        found: true,
        summary: describeEnrichment(proposal),
        skills: proposal.skills.map((s) => ({ skill: s.skill, confidence: s.confidence })),
        stacks: proposal.stacks.map((s) => ({ stackId: s.stackId, confidence: s.confidence })),
        notes: proposal.notes.map((n) => ({ content: n.content, kind: n.kind })),
      };
    },
    continueProject: (input) => continueProjectFromChat(env.DB, scope, { ...input, resumeBlocked: false }),
    continueNamedProject: async (input) => {
      // A clear request to continue one owned named project is a routing fact,
      // not a capability decision the Home model needs to make.
      if (!isHome || !/^(?:please\s+)?(?:continue|resume|retry|finish|fix|repair)\b/i.test(input.request.trim())) return null;
      if (/\b(?:do not|don't)\s+(?:continue|resume|retry|build|repair)\b/i.test(input.request)) return null;
      const owned = await listProjectsForActor(env.DB, scope.actorId);
      const candidates = owned.filter(project => {
        if (project.kind === "home") return false;
        const escaped = project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, "iu").test(input.request);
      });
      if (candidates.length !== 1) return null;
      return continueProjectFromChat(env.DB, scope, {
        ...input, operationKey: `${input.operationKey}:${candidates[0]!.id}`, projectId: candidates[0]!.id, resumeBlocked: true,
      });
    },
    startProject: (input) =>
      startProjectFromChat(env.DB, scope, {
        ...input,
        sourceConversationId: run.conversationId,
      }),
    workflowState: async () => {
      await ensureWorkflow(env.DB, scope);
      const state = await workflowSnapshot(env.DB, scope);
      return {
        phase: state.workflow!.phase,
        brief: state.workflow!.brief,
        planId: state.workflow!.planId,
        detail: state.workflow!.detail,
      };
    },
    blockBuild: (reason) => setWorkflowBlocker(env.DB, scope, reason),
    requestApproval: async (input) => {
      // Agent-facing REQUEST bridge: create a PENDING server approval only.
      // There is no decision parameter here — the user decides through the
      // authenticated REST route, never through chat text or this agent path.
      // The project is pinned to the run's scope: the agent cannot request an
      // approval against another project by naming a different id.
      const record = await requestApprovalOnServer(env.DB, {
        intent: {
          projectId: scope.projectId,
          action: input.action,
          resourceId: input.resourceId,
          revisionHash: input.revisionHash,
          policyVersion: input.policyVersion,
        },
      });
      return { id: record.id, expiresAt: record.expiresAt };
    },
    verifyBuild,
    readPlanNote: async (kind) => {
      if (kind === "feedback" || kind === "profile")
        return (await actorContext(env.DB, scope)).text;
      if (kind === "brief") return (await ensureWorkflow(env.DB, scope)).brief;
      const res = await env.DB.prepare(
        "select body from plan_doc_revisions where projectId = ? and kind = ? order by revision desc limit 1",
      )
        .bind(scope.projectId, kind)
        .all();
      return (res.results[0] as { body: string } | undefined)?.body ?? null;
    },
    writePlanNote: async (input) => {
      if (isHome)
        throw new SandboxError(409, "HOME_NO_PLAN", "Create a project first.");
      await ensureWorkflow(env.DB, scope);
      const revision = await createPlanDocRevision(env.DB, scope, {
        kind: input.kind as "prd",
        body: input.body,
      });
      if (input.kind === "prd") {
        await env.DB.prepare(
          "update run_bindings set planRevision = ? where runId = ? and projectId = ?",
        )
          .bind(revision.id, runId, scope.projectId)
          .run();
        planRevision = revision.id;
        await workflowSnapshot(env.DB, scope);
      }
    },
    delegateRepair: async (input) => {
      await requireBuildApproval(env.DB, scope);
      await recordRepairRound(env.DB, scope, runId, {
        issue: input.issue,
        round: input.round as "diagnosis",
        outcome: "started",
        detail: `${input.toRole}: ${input.task}`,
      });
    },
    recordVerification: async () => {
      throw new Error(
        "Caller-supplied pass flags are not evidence. Use verify_build.",
      );
    },
  };
}
