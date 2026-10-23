"use agent";
/**
 * ModuleBuilder (plan part P) — lane 12.
 *
 * A big app is split into modules, and several ModuleBuilders build them at
 * once, each in its OWN Durable Object on its OWN copy of the app. This is the
 * `'use agent'` export Flue registers; its durable identity is the function
 * name, so Flue generates the Durable Object class `FlueModuleBuilderAgent` and
 * the binding `FLUE_MODULE_BUILDER_AGENT`. The wrangler migration entry
 * (`{ "tag": "v4", "new_sqlite_classes": ["FlueModuleBuilderAgent"] }`) is lane
 * 1's to add — this file never touches wrangler.jsonc or app.ts.
 *
 * It runs the NORMAL feature loop, scoped to its module: the host
 * (coordinator-host's module-scoped context) hands out only this module's
 * features, in order, backend then frontend; its parts use this module's area
 * (part D); its contract checks cover this module's features (part E); it keeps
 * its own 3-try repair limit; and every model call it (or its delegates) makes
 * is charged to the build's SHARED spending limit (part A — resolveTurnPayer
 * reads the module's build_modules row). Its backend/frontend delegates are the
 * same `buildSpecialistDeclarations` the coordinator uses, scoped to the module
 * and bound to its session, on Super VL (the `build` model role).
 *
 * Dispatch is at-least-once (plan part P): the host starts a module with
 * `dispatch(ModuleBuilder, { id: "<projectId>:<buildSeq>:<moduleId>", message,
 * initialData })`. Starting the SAME instance id twice is harmless — the second
 * dispatch joins the running instance and its initialData is ignored (Flue), so
 * a module is never doubled. The instance id IS the module's identity, and
 * `resolveTurnPayer` keys the build's payer off it.
 *
 * Team mode only, big apps only: a ModuleBuilder is never dispatched unless
 * big-apps is on and the plan has more than one module (server/modules.ts gates
 * that). With it off, nothing here ever runs and the single-builder loop is
 * unchanged.
 */

import type { AgentProps } from "@flue/runtime";
import { getCloudflareContext } from "@flue/runtime/cloudflare";
import {
  dispatch,
  useAgentStart,
  useInitialData,
  useInstruction,
  useModel,
  useSubagent,
  useTool,
} from "@flue/runtime";
import * as v from "valibot";
import type { CoordinatorEnvironment, CoordinatorHostDeps } from "../server/coordinator-host.ts";
import type { CoordinatorHostContext } from "./coordinator.ts";
import { resolveModuleBuilderContext } from "../server/coordinator-host.ts";
import { registerBuildPayerForInstance } from "../server/spend-instrument.ts";
import { payerForInstance } from "../server/module-slots.ts";
import { findModelRouteForRole } from "./providers.ts";
import { FEATURE_DELEGATION_RULE } from "./delegation.ts";
import { buildSpecialistDeclarations, type SpecialistBuildContext } from "./specialists.ts";
import type { SandboxToolDeps } from "./tools.ts";

/**
 * The instance-creation data a dispatch carries (plan part P): which module
 * this builder owns, that module's feature ids, and the build's conversationId
 * (so the run/scope resolve exactly as the coordinator's). Validated by Flue
 * against this schema when the instance is first created, then readable for the
 * instance's life via `useInitialData()`.
 */
export const ModuleBuilderInitialData = v.object({
  /** The build's conversationId — the key the run binding is found under. */
  conversationId: v.pipe(v.string(), v.minLength(1)),
  /** The module this builder owns. */
  moduleId: v.pipe(v.string(), v.minLength(1)),
  /** The build sequence (for the instance-id / payer lineage). */
  buildSeq: v.number(),
  /** The feature ids this module owns; the feature loop is scoped to them. */
  features: v.array(v.string()),
});
export type ModuleBuilderInitialDataT = v.InferOutput<typeof ModuleBuilderInitialData>;

/** Render executes inside the ModuleBuilder's own Durable Object. */
export function ModuleBuilder({ id }: AgentProps) {
  // Every model call this builder makes runs on Super VL (the `build` role —
  // plan D1: "module builders run on Super VL"). Its delegates declare the same
  // model on their useSubagent definitions (buildSpecialistDeclarations).
  useModel(findModelRouteForRole("build").specifier);

  const seed = useInitialData<ModuleBuilderInitialDataT>();
  const env = getCloudflareContext().env as unknown as CoordinatorEnvironment;

  // Big apps (part P step 3): a part that joins can start the parts that were
  // waiting on it (a ModuleBuilder dispatch, like the coordinator's) and, when
  // every part is settled, tell the coordinator with one keyed message. The
  // coordinator is imported lazily: coordinator.ts reaches this file through
  // host-context.ts, so a static import would be a cycle.
  const hostDeps = (conversationId: string): CoordinatorHostDeps => ({
    dispatchModuleBuilder: async (input) => {
      await dispatch(ModuleBuilder, {
        id: input.instanceId,
        message: input.message,
        initialData: { conversationId, moduleId: input.moduleId, buildSeq: input.buildSeq, features: [...input.features] },
      });
    },
    notifyCoordinator: async ({ key, message }) => {
      const { Coordinator } = await import("./coordinator.ts");
      await dispatch(Coordinator, { id: conversationId, message: { kind: "user", body: message }, idempotencyKey: key });
    },
  });

  // Resolve the module-scoped host context lazily (same pattern as the
  // coordinator's host-context: identity comes from the owning DO's env and the
  // build's conversation binding, never from render-time data the caller could
  // forge). `id` is this instance's id, `<projectId>:<buildSeq>:<moduleId>`.
  const resolve = (): Promise<CoordinatorHostContext> => {
    if (!seed) throw new Error("ModuleBuilder started without its module scope (initialData).");
    return resolveModuleBuilderContext(env, {
      conversationId: seed.conversationId,
      moduleId: seed.moduleId,
      buildSeq: seed.buildSeq,
      features: seed.features,
    }, hostDeps(seed.conversationId));
  };

  // Register this instance's payer on the isolate fast path so the spend
  // interceptor attributes this module's model calls to the build's shared
  // payer without a D1 read each time. Best-effort: resolveTurnPayer's D1
  // fallback (reading build_modules.payerId by this instance id) is the
  // authority and REFUSES a module turn with no payer, so a miss here is safe.
  useAgentStart(async () => {
    if (!id) return;
    const payerId = await payerForInstance(env.DB, id).catch(() => null);
    if (payerId) registerBuildPayerForInstance(id, payerId);
  });

  // The module-scoped build tools. These are the SAME host tools the
  // coordinator mounts, but the host context behind them is scoped to this
  // module (createCoordinatorContext's moduleScope): build_next_feature and
  // finish_feature see only this module's features, and the parts/contract
  // checks use this module.
  useTool({
    name: "build_next_feature",
    description:
      "Get the ONE feature of THIS module to build next (its id, title and doneWhen checks) from the host. The module's features are built one at a time, in order; call this before delegating any implementation.",
    input: v.object({}),
    async run() {
      const host = await resolve();
      return { output: JSON.stringify(await host.buildNextFeature()) };
    },
  });
  useTool({
    name: "finish_feature",
    description:
      "Ask the host to finish the current feature of this module: it runs the project checks, requires new passing tests for this feature, checks the module's part boundary, and saves a checkpoint. Only the feature build_next_feature returned can be finished.",
    input: v.object({ featureId: v.pipe(v.string(), v.minLength(1), v.maxLength(48)) }),
    async run(ctx) {
      const host = await resolve();
      return { output: JSON.stringify(await host.finishFeature(ctx.data.featureId, ctx.toolCallId, ctx.signal)) };
    },
  });
  useTool({
    name: "run_checks",
    description:
      "Run the project's checks (install, tests, build, and this module's contract checks) exactly as the host verifies them, and get the failures. Shell test commands are refused; every failing run_checks counts toward the repair limit.",
    input: v.object({}),
    async run(ctx) {
      const host = await resolve();
      if (!host.runChecks) throw new Error("Host checks are not configured.");
      return { output: JSON.stringify(await host.runChecks(ctx.toolCallId, ctx.signal)) };
    },
  });
  useTool({
    name: "report_blocker",
    description: "Stop this module's build honestly and explain what is blocking it. A stopped module does not stop the other modules.",
    input: v.object({ reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)) }),
    async run(ctx) {
      const host = await resolve();
      await host.blockBuild(ctx.data.reason);
      return { output: "Blocker saved; this module stopped." };
    },
  });
  useTool({
    name: "finish_module",
    description:
      "When every feature of this part has passed, join the part into the app: the host copies this part's folders into the app, runs the full checks there, and answers joined, the failing checks to fix in this part's own folders (then call finish_module again), waiting for another part's join, or finished without this part.",
    input: v.object({}),
    async run(ctx) {
      const host = await resolve();
      if (!host.finishModuleBuild) throw new Error("This builder has no part to join.");
      return { output: JSON.stringify(await host.finishModuleBuild(ctx.toolCallId, ctx.signal)) };
    },
  });

  // The backend/frontend delegates, scoped to THIS module and bound to its
  // session, on Super VL. buildSpecialistDeclarations reads the context's
  // teamMode/bigApps and the module-scoped part guard; the module id flows
  // through the host context (createCoordinatorContext's moduleScope), so a
  // delegate's writes are checked against this module's area (part D).
  //
  // The declarations are built from a lightweight context that defers every
  // host call to `resolve()`, so no network work happens at render time. Only
  // the two build roles (backend, frontend) and QA matter for a module; the
  // planning roles never run here (the plan and design are already approved).
  //
  // Gap 3: this is a TYPED SpecialistBuildContext with NO `as unknown as` cast,
  // so a field the delegates need that we forgot would be a type error. Its
  // `runId` is this instance's id and its `sessionId` is the module's own
  // session `module:<runId>:<moduleId>` derived from that runId — NEVER built
  // from the conversationId. (The host's own driver resolves the real session
  // server-side and ignores this label, but the label must still be the
  // module's own session, not the project's.)
  const moduleRunId = id ?? "module";
  const driver: SandboxToolDeps = {
    execute: async (input) => (await resolve()).driver.execute(input),
    readFile: async (input) => (await resolve()).driver.readFile(input),
    writeFile: async (input) => (await resolve()).driver.writeFile(input),
  };
  const moduleContext: SpecialistBuildContext = {
    teamMode: true,
    bigApps: true,
    stackId: "react-hono",
    driver,
    sessionId: `module:${moduleRunId}:${seed?.moduleId ?? "pending"}`,
    runId: moduleRunId,
    readPlanNote: async (kind) => (await resolve()).readPlanNote(kind),
    writePlanNote: async (input) => (await resolve()).writePlanNote(input),
    delegateRepair: async (input) => (await resolve()).delegateRepair(input),
    recordVerification: async (input) => (await resolve()).recordVerification(input),
    runChecks: async (key, signal) => {
      const host = await resolve();
      if (!host.runChecks) throw new Error("Host checks are not configured.");
      return host.runChecks(key, signal);
    },
    requestAppKey: async (input) => {
      const host = await resolve();
      if (!host.requestAppKey) throw new Error("App keys are not available here.");
      return host.requestAppKey(input);
    },
    activePartForRole: async (role, mod) => {
      const host = await resolve();
      return host.activePartForRole ? host.activePartForRole(role, mod) : null;
    },
    restorePartFiles: async (paths, mod) => {
      const host = await resolve();
      if (!host.restorePartFiles) throw new Error("There is no part in progress, so there is nothing to restore.");
      return host.restorePartFiles(paths, mod);
    },
    ...(seed ? { currentRequest: `Build the "${seed.moduleId}" module's features only.` } : {}),
  };

  for (const declaration of buildSpecialistDeclarations(moduleContext)) useSubagent(declaration);

  useInstruction(
    `You are the builder for ONE module of a big app: ${seed?.moduleId ?? "a module"}. Build ONLY this module's features, in the order build_next_feature gives them, backend then frontend. For each feature: call build_next_feature, delegate exactly that feature with its doneWhen checks to the implementation specialist, get run_checks green, then call finish_feature. ${FEATURE_DELEGATION_RULE} Keep every change inside this module's own area (its server and screens folders) — the host refuses a feature that changed files outside it. When every feature of this module has passed, call finish_module to join the part into the app. If it answers with failing checks, fix them in this part's own folders, get run_checks green, and call finish_module again; if it answers joined, waiting, or finished without this part, end your turn. Do not build another module's features and do not run verify_build. If a real prerequisite is missing, call report_blocker and stop — a stopped module does not stop the others.`,
  );

  return `Caddie's builder for one module of a big app, running its feature loop on its own copy.`;
}

/** Pin the durable identity so a rename never silently migrates the DO class. */
ModuleBuilder.agentName = "ModuleBuilder";
/** Validate the dispatch's instance-creation data against the module scope. */
ModuleBuilder.initialData = ModuleBuilderInitialData;
