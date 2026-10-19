import type { AuthEnv } from "./auth.ts";
import type { RunBindingRecord } from "@caddie/contracts";
import type { CoordinatorHostContext } from "../agents/coordinator.ts";
import type { SandboxToolDeps } from "../agents/tools.ts";
import { buildSandboxFromEnv, stackRuntime } from "./build-sandbox.ts";
import { previewDocument, readBuiltApp, readBuiltServer } from "./built-app.ts";
import { flutterPreviewDocument, readFlutterWebBuild } from "./flutter-preview.ts";
import { type SandboxDriver, SandboxError } from "./adapters/sandbox.ts";
import { bytesToBase64, base64ToBytes } from "./adapters/contree.ts";
import {
  lookupRunByConversation,
  recordRepairRound,
  recordVerification,
} from "./runs.ts";
import { createPlanDocRevision, listProjectsForActor } from "./projects.ts";
import { requestApproval as requestApprovalOnServer } from "./approvals.ts";
import { proposeProject as proposeProjectOnServer } from "./project-proposals.ts";
import { actorContext } from "./coordinator-context.ts";
import { paidDiscoveryTools } from "./judge-paid-tools.ts";
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
import { stackCatalog } from "./stacks.ts";
import { recordBuildActivity } from "./build-activity.ts";
import { checkServerStarts, type WorkerLoaderLike } from "./preview-runtime.ts";
import { SCAFFOLD_FILES } from "../../../../stacks/react-hono/scaffold.ts";
import { FLUTTER_SCAFFOLD_FILES } from "../../../../stacks/flutter/scaffold.ts";
import { hostCheckCommands, testsPassed } from "./host-checks.ts";
import { projectScopeForUser, ScopeError } from "./scope.ts";
import { requestAppSecret } from "./app-secrets.ts";
import { BUILD_ACTION_BUDGET, REPEATED_ACTION_LIMIT, isShellTestCommand } from "../agents/permissions.ts";
import {
  currentFeature,
  ensureBuildFeatures,
  listBuildFeatures,
  markFeatureBuilding,
  recordFeatureAttempt,
  recordFeaturePassed,
  testsBaseline,
} from "./build-features.ts";
import { openWorkingCopy } from "./working-copy.ts";
import { runVerifiedInstall } from "./verified-install.ts";
import { parseTestCounts } from "./build-timeline.ts";
import { FEATURE_BLOCK_GUIDE, parsePlanFeatures } from "@caddie/contracts";
import { collectSourceSnapshot } from "./source-export.ts";
import { recordCodeVersion } from "./code-versions.ts";
import { codeStoreFor } from "./code-store-env.ts";
import { CODE_STORE_CAPS } from "./code-store.ts";
import type { ArtifactsBinding } from "./adapters/cloudflare-artifacts.ts";

/** A version snapshot must fit both the source walker's and the code store's limits. */
const VERSION_SOURCE_CAPS = {
  maxFiles: Math.min(300, CODE_STORE_CAPS.maxFiles),
  maxFileBytes: Math.min(512 * 1024, CODE_STORE_CAPS.maxFileBytes),
  maxTotalBytes: Math.min(8 * 1024 * 1024, CODE_STORE_CAPS.maxSnapshotBytes),
  maxDirectories: 400,
};

const NO_SUCH_TABLE = (error: unknown) => String(error).includes("no such table");

/** Sandbox actions spent in the current build window (since the last user retry). */
async function buildWindowActionCount(db: CoordinatorEnvironment["DB"], runId: string): Promise<number> {
  try {
    const result = await db
      .prepare(
        `select count(*) as "n" from "build_activity"
         where "runId" = ? and "kind" in ('command','file','check')
         and "startedAt" > coalesce((select max("createdAt") from "workflow_resumes" where "runId" = ?), '')`,
      )
      .bind(runId, runId)
      .all();
    return Number((result.results[0] as { n?: number } | undefined)?.n ?? 0);
  } catch (error) {
    if (NO_SUCH_TABLE(error)) return 0;
    throw error;
  }
}

/** The most recent sandbox actions, newest first. */
async function recentActions(db: CoordinatorEnvironment["DB"], runId: string, limit: number) {
  try {
    const result = await db
      .prepare(
        `select "id","kind","subject","bytes" from "build_activity"
         where "runId" = ? and "kind" in ('command','file','check')
         order by "startedAt" desc, "id" desc limit ?`,
      )
      .bind(runId, limit)
      .all();
    return result.results as { id: string; kind: string; subject: string; bytes: number | null }[];
  } catch (error) {
    if (NO_SUCH_TABLE(error)) return [];
    throw error;
  }
}

const tail = (text: string | undefined, limit = 4000) =>
  !text ? "" : text.length > limit ? `…${text.slice(-limit)}` : text;
export interface CoordinatorEnvironment {
  DB: AuthEnv["DB"];
  /** Cloudflare Artifacts (owner input): app versions live there when bound, in D1 otherwise. */
  ARTIFACTS?: ArtifactsBinding;
  /** Tavily search key — the required PRIMARY discovery source + research tool (see AuthEnv). */
  TAVILY_API_KEY?: string;
  /** Nebius model key — powers AI fit inspection of discovery candidates (fail-soft when unset). */
  NEBIUS_API_KEY?: string;
  CONTREE_BASE_URL?: string;
  CONTREE_API_TOKEN?: string;
  CONTREE_PROJECT_ID?: string;
  CONTREE_IMAGE?: string;
  /** Flutter apps' image (Track 3); defaults to DEFAULT_FLUTTER_IMAGE in build-sandbox.ts. */
  CONTREE_FLUTTER_IMAGE?: string;
  /** Worker Loader (backend previews + the runs-on-Cloudflare check). Absent: the check is skipped honestly. */
  LOADER?: WorkerLoaderLike;
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
  // Track 3: an Android app (stackId 'flutter') builds in the Flutter image,
  // with its own scaffold, commands and builder instructions.
  const stack: "react-hono" | "flutter" = run.stackId === "flutter" ? "flutter" : "react-hono";
  const runtime = stackRuntime(stack, env);
  const runtimeEnv = runtime.env;
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
    driver ??= buildSandboxFromEnv(env)!;
    // A rollback or Restore points the build at another session; a working
    // copy the sandbox no longer keeps is started again from the saved code.
    // A failed open is not cached, so the next call in this context retries.
    sessionReady ??= openWorkingCopy({
      db: env.DB,
      store: codeStoreFor(env),
      driver,
      scope,
      runId,
      sessionKey: sessionId,
      baseImage: runtime.image,
      root,
      env: runtimeEnv,
    }).catch((error: unknown) => {
      sessionReady = null;
      throw error;
    });
    const id = await sessionReady;
    return { driver, id };
  };
  // Empty generic scaffold only; the model must implement the requested app.
  // The files + commands come from the ONE shared stack source
  // (stacks/react-hono/scaffold.ts), identical to what the evaluation journey
  // uses — a green fixture journey and a real chat build now run the same setup.
  let scaffoldReady: Promise<void> | null = null;
  const scaffoldFiles = stack === "flutter" ? FLUTTER_SCAFFOLD_FILES : SCAFFOLD_FILES;
  const scaffold = () =>
    (scaffoldReady ??= (async () => {
      const { driver, id } = await ensureSession();
      if (await driver.pathExists(id, `${root}/package.json`)) return;
      const setupStarted = new Date().toISOString();
      await driver.uploadFiles(
        id,
        Object.entries(scaffoldFiles).map(([path, text]) => ({
          path: `${root}/${path}`,
          contentBase64: bytesToBase64(new TextEncoder().encode(text)),
        })),
      );
      await recordBuildActivity(env.DB, {
        projectId: scope.projectId, runId, kind: "setup",
        subject: `${stack} scaffold (${Object.keys(scaffoldFiles).length} files)`,
        outcome: "ok", startedAt: setupStarted, finishedAt: new Date().toISOString(),
        key: "setup:scaffold",
      });
    })().catch((error: unknown) => {
      scaffoldReady = null;
      throw error;
    }));
  // Bounds on builder actions. The host context is rebuilt for every tool
  // call (host-context.ts resolve()), so both guards read the persisted
  // build_activity rows, never in-memory counters. They read row COUNTS and
  // subjects only; a dropped activity insert can only make a guard more
  // lenient, never refuse wrongly.
  const budgetMessage =
    `Caddie used this build's ${BUILD_ACTION_BUDGET}-step budget without getting the checks to pass, so the build was paused. Your plan and files are saved. Retry to continue with a fresh budget.`;
  const guardBudget = async () => {
    if ((await buildWindowActionCount(env.DB, runId)) < BUILD_ACTION_BUDGET) return;
    await setWorkflowBlocker(env.DB, scope, budgetMessage);
    throw new SandboxError(429, "BUILD_BUDGET_EXHAUSTED", budgetMessage);
  };
  const guardAction = async (action: { kind: "command" | "file"; subject: string; bytes?: number }) => {
    await guardBudget();
    const recent = await recentActions(env.DB, runId, REPEATED_ACTION_LIMIT);
    const subject = action.subject.slice(0, 500);
    const repeated =
      recent.length >= REPEATED_ACTION_LIMIT &&
      recent.every((row) =>
        row.kind === action.kind &&
        row.subject === subject &&
        (action.kind === "command" || row.bytes === (action.bytes ?? null)),
      );
    if (repeated)
      throw new SandboxError(
        409,
        "REPEATED_ACTION",
        action.kind === "command"
          ? `This exact command already ran ${REPEATED_ACTION_LIMIT} times in a row with nothing changed in between. Running it again will not change the result: change the code, try a different approach, or report the blocker.`
          : `${action.subject} was already written ${REPEATED_ACTION_LIMIT} times in a row with the same content. Writing it again changes nothing: try a different fix, or report the blocker.`,
      );
  };
  /** A recovered (replayed) command already has its activity row; never refuse a replay. */
  const isReplay = async (operationKey: string) => {
    try {
      const found = await env.DB.prepare('select 1 from "build_activity" where "id" = ?')
        .bind(`act:${runId}:${operationKey}`)
        .all();
      return found.results.length > 0;
    } catch (error) {
      if (NO_SUCH_TABLE(error)) return false;
      throw error;
    }
  };
  const deps: SandboxToolDeps = {
    execute: async (input) => {
      input.signal?.throwIfAborted();
      // Tests run ONLY through run_checks: a shell test run escaped the repair
      // counter (FarmLog AI: `bun test … | head -14` recorded head's exit 0).
      if (isShellTestCommand(input.command))
        throw new SandboxError(
          400,
          "TEST_COMMAND_REFUSED",
          "Shell test commands are not run here. Use run_checks: it runs the project's tests and build exactly as the host verifies them and returns the failures.",
        );
      await scaffold();
      const { driver, id } = await ensureSession();
      const operationKey = `exec:${runId}:${input.operationKey}`;
      if (!(await isReplay(operationKey)))
        await guardAction({ kind: "command", subject: input.command });
      const execStarted = new Date().toISOString();
      let result: Awaited<ReturnType<typeof driver.execute>>;
      try {
        result = await driver.execute({
          sessionId: id,
          command: input.command,
          operationKey,
          signal: input.signal,
          timeoutMs: input.timeoutMs,
          cwd: root,
          env: runtimeEnv,
        });
      } catch (error) {
        await recordBuildActivity(env.DB, {
          projectId: scope.projectId, runId, kind: "command", subject: input.command,
          outcome: input.signal?.aborted ? "cancelled" : "failed",
          startedAt: execStarted, finishedAt: new Date().toISOString(), key: operationKey,
        });
        throw error;
      }
      await recordBuildActivity(env.DB, {
        projectId: scope.projectId, runId, kind: "command", subject: input.command,
        outcome: result.exitCode === 0 ? "ok" : "failed", exitCode: result.exitCode,
        output: `${result.stdout}\n${result.stderr}`,
        startedAt: execStarted, finishedAt: new Date().toISOString(), key: operationKey,
      });
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
      const bytes = new TextEncoder().encode(input.content);
      await guardAction({ kind: "file", subject: input.path, bytes: bytes.length });
      const writeStarted = new Date().toISOString();
      await driver.writeFile(
        id,
        input.path,
        bytesToBase64(bytes),
      );
      // Path + size only — file contents never enter the activity ledger.
      await recordBuildActivity(env.DB, {
        projectId: scope.projectId, runId, kind: "file", subject: input.path,
        outcome: "ok", bytes: bytes.length,
        startedAt: writeStarted, finishedAt: new Date().toISOString(),
      });
    },
  };
  /**
   * The host-owned checks: install, behavior tests, browser bundle — fixed
   * recipe commands, real receipts, one repair_attempt per failed check.
   * `mode` keeps run_checks and verify_build receipts apart (distinct
   * operation keys) while sharing every rule; only verify_build publishes.
   */
  const runHostChecks = async (
    mode: "checks" | "verify" | "feature",
    attempt: string,
    signal?: AbortSignal,
    /** Feature id: failures count toward THAT feature's repair limit. */
    issuePrefix?: string,
  ) => {
    signal?.throwIfAborted();
    const { workflow, plan } = await requireBuildApproval(env.DB, scope);
    await scaffold();
    await guardBudget();
    const { driver, id } = await ensureSession();
    const commands = hostCheckCommands(stack);
    const receipts = [];
    for (const check of commands) {
      const operationKey = `${mode}:${runId}:${plan.id}:${attempt}:${check.check}`;
      await requireBuildApproval(env.DB, scope);
      const checkStarted = new Date().toISOString();
      // The dependencies check is the ONE verified install step: fetch every
      // pinned tarball, verify its sha512 against bun.lock, extract it, then
      // run the frozen install last (recorded under `operationKey`, so the
      // receipt below still names `bun install --frozen-lockfile`). Test and
      // build are the recipe's unchanged commands.
      const result =
        check.check === "dependencies"
          ? await runVerifiedInstall(driver, {
              sessionId: id,
              cwd: root,
              env: runtimeEnv,
              operationKey,
              signal,
            })
          : await driver.execute({
              sessionId: id,
              command: check.command,
              operationKey,
              signal,
              timeoutMs: check.timeoutMs,
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
        (check.check !== "behavior-tests" || testsPassed(receipt.stdout + "\n" + receipt.stderr)),
      );
      await recordVerification(env.DB, scope, workflow.runId, {
        check: check.check,
        passed,
        evidence: JSON.stringify(receipt),
        planRevision: plan.id,
      });
      await recordBuildActivity(env.DB, {
        projectId: scope.projectId, runId: workflow.runId, kind: "check", subject: check.check,
        outcome: passed ? "ok" : "failed", exitCode: result.exitCode,
        output: `${result.stdout}\n${result.stderr}`,
        startedAt: checkStarted, finishedAt: new Date().toISOString(), key: operationKey,
      });
      // The full receipt is the stored evidence; the model sees the tail of
      // the output, where test runners and bundlers print the failure.
      receipts.push({
        check: check.check,
        passed,
        exitCode: result.exitCode,
        stdout: tail(result.stdout),
        stderr: tail(result.stderr),
        operationKey,
      });
      if (!passed) {
        await recordRepairRound(env.DB, scope, workflow.runId, {
          issue: issuePrefix ? `${issuePrefix}:${check.check}` : check.check,
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
        return { passed: false as const, paused, receipts, workflow, plan, driver, id };
      }
    }
    return { passed: true as const, paused: false, receipts, workflow, plan, driver, id };
  };
  const runChecks = async (attempt: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const { plan } = await requireBuildApproval(env.DB, scope);
    // Failures count toward the feature being built, not one build-wide bucket.
    const current = currentFeature(await ensureBuildFeatures(env.DB, scope, runId, plan));
    const outcome = await runHostChecks("checks", attempt, signal, current?.featureId);
    if (!outcome.passed)
      return {
        passed: false,
        paused: outcome.paused,
        receipts: outcome.receipts,
        next: outcome.paused
          ? "The build is paused after repeated failures. Stop and report what is failing."
          : "Read the failing check's output above, fix its cause, then run run_checks again.",
      };
    return {
      passed: true,
      receipts: outcome.receipts,
      next: "All checks pass. Report back so the coordinator can finish this feature.",
    };
  };
  /** The host decides what is built next: the first feature that has not passed. */
  const buildNextFeature = async () => {
    const { plan } = await requireBuildApproval(env.DB, scope);
    const rows = await ensureBuildFeatures(env.DB, scope, runId, plan);
    const current = currentFeature(rows);
    if (!current)
      return { done: true, next: "Every feature passed. Ask QA to run verify_build to publish the preview." };
    await markFeatureBuilding(env.DB, current);
    return {
      done: false,
      feature: { id: current.featureId, title: current.title, doneWhen: current.doneWhen },
      position: current.position,
      total: rows.length,
      alreadyBuilt: rows.filter((row) => row.status === "passed").map((row) => row.title),
      next: `Delegate ONLY this feature to the implementation specialist, with its doneWhen checks: build it, add at least one test in src/*.test.tsx for each check, and get run_checks green. Then call finish_feature with featureId "${current.featureId}". Do not start another feature.`,
    };
  };
  /**
   * Finish the CURRENT feature: green host checks AND more passing tests than
   * the last green feature left, then a save point. Anything else is a failed
   * attempt on this feature (the 3-strike pause applies per feature).
   */
  const finishFeature = async (featureId: string, attempt: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const { plan } = await requireBuildApproval(env.DB, scope);
    const rows = await ensureBuildFeatures(env.DB, scope, runId, plan);
    const current = currentFeature(rows);
    if (!current)
      return { passed: true, done: true, next: "Every feature passed. Ask QA to run verify_build to publish the preview." };
    if (current.featureId !== featureId)
      throw new ScopeError(
        409,
        "NOT_CURRENT_FEATURE",
        `"${featureId}" is not the feature being built. Finish “${current.title}” (featureId "${current.featureId}") first; the host builds features in order.`,
      );
    const outcome = await runHostChecks("feature", `${featureId}:${attempt}`, signal, current.featureId);
    if (!outcome.passed) {
      await recordFeatureAttempt(env.DB, current, outcome.paused);
      return {
        passed: false,
        paused: outcome.paused,
        receipts: outcome.receipts,
        next: outcome.paused
          ? `“${current.title}” failed its checks three times, so the build is paused. Report what is failing.`
          : "Delegate a focused repair for the failing check, then call finish_feature again.",
      };
    }
    const tests = outcome.receipts.find((receipt) => receipt.check === "behavior-tests");
    const passing = parseTestCounts(`${tests?.stdout ?? ""}\n${tests?.stderr ?? ""}`)?.passed ?? 0;
    const baseline = testsBaseline(rows);
    if (passing <= baseline) {
      const round = await recordRepairRound(env.DB, scope, runId, {
        issue: `${current.featureId}:new-tests`,
        operationKey: `feature:${runId}:${plan.id}:${featureId}:${attempt}:new-tests`,
        round: "repair_attempt",
        outcome: "failed",
        detail: JSON.stringify({ passing, baseline }),
      });
      await recordFeatureAttempt(env.DB, current, round.paused);
      if (round.paused)
        await setWorkflowBlocker(
          env.DB,
          scope,
          `Caddie could not add working tests for “${current.title}” after three attempts. The features before it are saved. The app is not ready to try yet.`,
        );
      return {
        passed: false,
        paused: round.paused,
        next: `The checks pass, but this feature added no new passing tests (${passing} passing now, ${baseline} before it). Add tests in src/*.test.tsx for each doneWhen check, then call finish_feature again.`,
      };
    }
    const { checkpointRef } = await outcome.driver.checkpoint(outcome.id);
    await recordFeaturePassed(env.DB, current, { checkpointRef, testsPassed: passing });
    const after = currentFeature(await listBuildFeatures(env.DB, scope.projectId, plan.id));
    return {
      passed: true,
      feature: current.title,
      testsPassed: passing,
      next: after
        ? `Saved. Feature ${after.position} of ${rows.length}, “${after.title}”, is next: call build_next_feature.`
        : "Every feature passed. Ask QA to run verify_build to publish the preview.",
    };
  };
  /** Where the feature loop stands, for the coordinator's finish hook. */
  const featureProgress = async () => {
    const { workflow, plan } = await workflowSnapshot(env.DB, scope);
    if (!workflow || !plan) return null;
    const rows = await listBuildFeatures(env.DB, scope.projectId, plan.id);
    if (rows.length === 0) return null;
    const current = currentFeature(rows);
    return {
      total: rows.length,
      passed: rows.filter((row) => row.status === "passed").length,
      current: current ? { id: current.featureId, title: current.title, position: current.position } : null,
    };
  };
  const verifyBuild = async (attempt: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    {
      // The preview is published only after every planned feature has passed.
      const { plan } = await requireBuildApproval(env.DB, scope);
      const rows = await ensureBuildFeatures(env.DB, scope, runId, plan);
      const pending = currentFeature(rows);
      if (pending)
        return {
          passed: false,
          receipts: [],
          next: `Not every feature is built yet: feature ${pending.position} of ${rows.length}, “${pending.title}”, is next. Build the remaining features with build_next_feature and finish_feature; verify_build publishes the preview only after all of them pass.`,
        };
    }
    const outcome = await runHostChecks("verify", attempt, signal);
    if (!outcome.passed)
      return {
        passed: false,
        paused: outcome.paused,
        receipts: outcome.receipts,
        next: "Delegate a focused repair for the failing check, then run verify_build again.",
      };
    const { workflow, plan, driver, id, receipts } = outcome;
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
    // Backend apps: the server bundle and the migrations travel with the
    // checked output (previews and publishing read them from there). Android
    // apps (Track 3) have the same server and a Flutter web build for the
    // browser preview, carried as one page (flutter-preview.ts).
    const built =
      stack === "flutter"
        ? { kind: "flutter" as const, ...(await readBuiltServer(driver, id, root)), page: flutterPreviewDocument(await readFlutterWebBuild(driver, id, root)) }
        : { kind: "web" as const, ...(await readBuiltApp(driver, id, root)) };
    const { server, migrations } = built;
    // The version history: the app's source as checked (same skip rules as the
    // GitHub save — no dependencies, build output or secrets). Never fails the
    // build: a version that can't be saved is logged and the preview still lands.
    let source: Awaited<ReturnType<typeof collectSourceSnapshot>> | null = null;
    try {
      source = await collectSourceSnapshot(
        {
          list: (path) => driver.listEntries(id, path),
          read: async (path) => base64ToBytes((await driver.readFile(id, path)).contentBase64),
        },
        root,
        VERSION_SOURCE_CAPS,
      );
    } catch (error) {
      console.error("verify_build: version snapshot skipped:", error instanceof Error ? error.message : error);
    }
    const after = await driver.checkpoint(id);
    if (after.checkpointRef !== final.resultImage)
      throw new ScopeError(
        409,
        "STALE_BUILD",
        "Files changed while preparing the preview. Run checks again.",
      );
    // The runs-on-Cloudflare check: the server must start in the Workers
    // runtime, not just under Bun in the sandbox.
    if (server !== null && env.LOADER) {
      const started = new Date().toISOString();
      const startup = await checkServerStarts(env.LOADER, server);
      const operationKey = `verify:${runId}:${plan.id}:${attempt}:server-starts`;
      await recordVerification(env.DB, scope, workflow.runId, {
        check: "server-starts",
        passed: startup.ok,
        evidence: JSON.stringify(startup.ok ? { ok: true } : { ok: false, reason: startup.reason }),
        planRevision: plan.id,
      });
      await recordBuildActivity(env.DB, {
        projectId: scope.projectId, runId: workflow.runId, kind: "check", subject: "server-starts",
        outcome: startup.ok ? "ok" : "failed", exitCode: startup.ok ? 0 : 1,
        output: startup.ok ? "GET /api/health answered 200 on the Workers runtime" : startup.reason,
        startedAt: started, finishedAt: new Date().toISOString(), key: operationKey,
      });
      if (!startup.ok) {
        const receipt = { check: "server-starts", passed: false, exitCode: 1, stdout: "", stderr: startup.reason, operationKey };
        await recordRepairRound(env.DB, scope, workflow.runId, {
          issue: "server-starts",
          operationKey,
          round: "repair_attempt",
          outcome: "failed",
          detail: JSON.stringify(receipt),
        });
        const paused = (await workflowRepairPause(env.DB, workflow.runId)).paused;
        if (paused)
          await setWorkflowBlocker(
            env.DB,
            scope,
            "Caddie could not get the app's server starting on Cloudflare after three attempts. Your plan and files are saved. The app is not ready to try yet.",
          );
        return {
          passed: false,
          paused,
          receipts: [...receipts, receipt],
          next: `The app's server does not start on Cloudflare's runtime: ${startup.reason}. Fix src/server.ts so it uses only Web APIs and env.DB (GET /api/health must answer 200), then run verify_build again.`,
        };
      }
    }
    const html =
      built.kind === "flutter"
        ? "<!doctype html><html><body><p>An Android app built by Caddie. Open it in Caddie to try it in the browser.</p></body></html>"
        : previewDocument({ js: built.js, css: built.css });
    signal?.throwIfAborted();
    const output = await storeBuildOutput(env.DB, scope, {
      html,
      image: final.resultImage,
      planId: plan.id,
      runId: workflow.runId,
      bundle:
        built.kind === "flutter"
          ? { server, migrations, flutterWeb: built.page }
          : { server, migrations, client: { js: built.js, css: built.css } },
    });
    if (source) {
      try {
        const features = await listBuildFeatures(env.DB, scope.projectId, plan.id);
        const titles = features.filter((f) => f.status === "passed").map((f) => f.title);
        const title = titles.length > 0 ? titles.join(", ").slice(0, 160) : "Checked build";
        await recordCodeVersion(env.DB, codeStoreFor(env), scope, {
          kind: "build",
          title,
          files: source.files.map((file) => ({
            path: file.path,
            contentBase64: file.encoding === "base64" ? file.content : bytesToBase64(new TextEncoder().encode(file.content)),
          })),
          skipped: source.skipped,
          planId: plan.id,
          image: final.resultImage,
          outputId: output.outputId,
          actorId: scope.actorId,
        });
      } catch (error) {
        console.error("verify_build: version not saved:", error instanceof Error ? error.message : error);
      }
    }
    return {
      passed: true,
      receipts,
      ...output,
      next: "The project card shows the working preview. Build checks passed; ask the user to try the behavior.",
    };
  };
  const tools = paidDiscoveryTools(env, scope);
  return {
    driver: deps,
    sessionId,
    runId,
    stackId: stack,
    projectId: scope.projectId,
    homeOverview,
    actorContext: actor.text,
    currentPlanRevision: () => planRevision,
    listStacks: async () => stackCatalog(env),
    discover: tools.discover,
    research: tools.research,
    hackathonDetails: tools.hackathonDetails,
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
      }, env);
    },
    startProject: (input) =>
      startProjectFromChat(env.DB, scope, {
        ...input,
        sourceConversationId: run.conversationId,
      }, env),
    proposeProject: async (input) => {
      const proposal = await proposeProjectOnServer(env.DB, scope, {
        ...input,
        sourceConversationId: run.conversationId,
      }, env);
      return { id: proposal.id, homeProjectId: proposal.homeProjectId, status: proposal.status };
    },
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
    runChecks,
    requestAppKey: async (input) => {
      await requireBuildApproval(env.DB, scope);
      const key = await requestAppSecret(env.DB, scope, input);
      return { name: key.name, status: key.status };
    },
    buildNextFeature,
    finishFeature,
    featureProgress,
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
      if (input.kind === "prd") {
        // The approval binds to this revision's hash, so the feature list the
        // host will build must be inside it, valid, before it is saved.
        const features = parsePlanFeatures(input.body);
        if (!features.ok)
          throw new Error(`PLAN_FEATURES_INVALID: not saved — ${features.error}. ${FEATURE_BLOCK_GUIDE}`);
      }
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
      // A saved design brief advances design -> design-review (the snapshot
      // auto-advance picks up the new, not-yet-decided revision).
      if (input.kind === "design") {
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
