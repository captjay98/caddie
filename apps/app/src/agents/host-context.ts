import type { CoordinatorHostContext } from "./coordinator.ts";
import {
  resolveCoordinatorContext,
  type CoordinatorEnvironment,
} from "../server/coordinator-host.ts";
import { dispatch } from "@flue/runtime";
import type { DispatchModuleBuilder } from "../server/modules.ts";
import { ModuleBuilder } from "./module-builder.ts";

/**
 * Big apps (plan part P step 2): start, or continue, one module's builder.
 * Flue's dispatch is at-least-once and keyed by the instance id
 * `<projectId>:<buildSeq>:<moduleId>`, so starting the same module twice
 * joins the one already running. The seed data names the build's conversation
 * (so the builder resolves the same run and scope as the coordinator), its
 * module, its build sequence and its features; it is recorded only when the
 * instance is created.
 */
export function moduleBuilderDispatcher(conversationId: string): DispatchModuleBuilder {
  return async (input) => {
    await dispatch(ModuleBuilder, {
      id: input.instanceId,
      message: input.message,
      initialData: { conversationId, moduleId: input.moduleId, buildSeq: input.buildSeq, features: [...input.features] },
    });
  };
}

/** Only serializable presentation data persists; env/secrets/functions never do. */
export interface CoordinatorSnapshot {
  conversationId: string;
  runId: string;
  sessionId: string;
  projectId: string;
  homeOverview: string | null;
  actorContext: string;
  planRevision: string;
}
export function coordinatorSnapshot(
  conversationId: string,
  context: CoordinatorHostContext,
): CoordinatorSnapshot {
  return {
    conversationId,
    runId: context.runId,
    sessionId: context.sessionId,
    projectId: context.projectId,
    homeOverview: context.homeOverview,
    actorContext: context.actorContext,
    planRevision: context.currentPlanRevision(),
  };
}
export function checkedCoordinatorSnapshot(
  value: unknown,
  conversationId: string,
): CoordinatorSnapshot | null {
  if (value === null) return null;
  if (!value || typeof value !== "object")
    throw new Error("Stored coordinator context is invalid.");
  const snapshot = value as CoordinatorSnapshot;
  if (
    snapshot.conversationId !== conversationId ||
    !snapshot.runId ||
    !snapshot.projectId ||
    !snapshot.sessionId ||
    typeof snapshot.actorContext !== "string" ||
    typeof snapshot.planRevision !== "string" ||
    (snapshot.homeOverview !== null &&
      typeof snapshot.homeOverview !== "string")
  ) {
    throw new Error(
      "Stored coordinator context does not belong to this conversation.",
    );
  }
  return snapshot;
}

/**
 * Every asynchronous effect resolves identity from its owning DO's env and
 * immutable conversation binding. Render snapshots are presentation only;
 * neither cached profile text nor browser-supplied initialData grants authority.
 */
export function scopedCoordinatorContext(
  env: CoordinatorEnvironment,
  conversationId: string,
  snapshot: CoordinatorSnapshot | null,
) {
  const resolve = () => resolveCoordinatorContext(env, conversationId, { dispatchModuleBuilder: moduleBuilderDispatcher(conversationId) });
  const context: CoordinatorHostContext = {
    runId: snapshot?.runId ?? `uninitialized:${conversationId}`,
    sessionId: snapshot?.sessionId ?? `uninitialized:${conversationId}`,
    projectId: snapshot?.projectId ?? "",
    homeOverview:
      snapshot?.homeOverview ?? "The authenticated context is initializing.",
    actorContext: snapshot?.actorContext || "Authenticated profile context is initializing. Use the coordinator context signal before personalizing replies.",
    currentPlanRevision: () => snapshot?.planRevision ?? "uninitialized",
    driver: {
      execute: async (input) => (await resolve()).driver.execute(input),
      readFile: async (input) => (await resolve()).driver.readFile(input),
      writeFile: async (input) => (await resolve()).driver.writeFile(input),
    },
    workflowState: async () => (await resolve()).workflowState(),
    continueProject: async (input) => (await resolve()).continueProject(input),
    continueNamedProject: async (input) => (await resolve()).continueNamedProject(input),
    projectStatus: async (input) => (await resolve()).projectStatus(input),
    startProject: async (input) => (await resolve()).startProject(input),
    proposeProject: async (input) => (await resolve()).proposeProject(input),
    listStacks: async () => (await resolve()).listStacks(),
    discover: async (input) => (await resolve()).discover(input),
    research: async (input) => (await resolve()).research(input),
    hackathonDetails: async (input) => (await resolve()).hackathonDetails(input),
    updateProfile: async (input) => (await resolve()).updateProfile(input),
    remember: async (input) => (await resolve()).remember(input),
    inspectRepository: async () => (await resolve()).inspectRepository(),
    verifyBuild: async (key, signal) => (await resolve()).verifyBuild(key, signal),
    buildNextFeature: async () => (await resolve()).buildNextFeature(),
    finishFeature: async (featureId, key, signal) => (await resolve()).finishFeature(featureId, key, signal),
    featureProgress: async () => (await resolve()).featureProgress(),
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
    blockBuild: async (reason) => (await resolve()).blockBuild(reason),
    requestApproval: async (input) => (await resolve()).requestApproval(input),
    readPlanNote: async (kind) => (await resolve()).readPlanNote(kind),
    writePlanNote: async (input) => (await resolve()).writePlanNote(input),
    delegateRepair: async (input) => (await resolve()).delegateRepair(input),
    recordVerification: async (input) =>
      (await resolve()).recordVerification(input),
  };
  // null is meaningful: it identifies a build project, rather than Home.
  if (snapshot) context.homeOverview = snapshot.homeOverview;
  return { context, resolve };
}
