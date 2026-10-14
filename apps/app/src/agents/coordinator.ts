"use agent";
import type { AgentProps } from "@flue/runtime";
import {
  getCloudflareContext,
  getDurableObjectIdentity,
} from "@flue/runtime/cloudflare";
import {
  checkedCoordinatorSnapshot,
  coordinatorSnapshot,
  scopedCoordinatorContext,
  type CoordinatorSnapshot,
} from "./host-context.ts";
import type { CoordinatorEnvironment } from "../server/coordinator-host.ts";
import {
  useAgentFinish,
  useAgentStart,
  useDataWriter,
  useDelivery,
  useInstruction,
  useModel,
  usePersistentState,
  useSubagent,
  useTool,
} from "@flue/runtime";
import * as v from "valibot";
import { HackathonResultsCardSchema } from "@caddie/contracts";
import { buildHackathonReference, buildHackathonResultsCard, type DiscoveryResultForCard } from "../server/hackathon-card.ts";
import {
  FIND_HACKATHONS_DESCRIPTION,
  HACKATHON_DETAILS_DESCRIPTION,
  HACKATHON_FOLLOWUPS_INSTRUCTION,
  HACKATHON_HONESTY_INSTRUCTION,
  RESEARCH_DESCRIPTION,
} from "./hackathon-prompts.ts";
import { findModelRouteForRole } from "./providers.ts";
import { makeListStacks, makeVerifyBuild, makeUpdateProfile, makeRememberFact, makeInspectRepository } from "./tools.ts";
import {
  buildSpecialistDeclarations,
  type SpecialistBuildContext,
} from "./specialists.ts";

export interface CoordinatorHostContext extends SpecialistBuildContext {
  currentPlanRevision: () => string;
  homeOverview: string | null;
  actorContext: string;
  projectId: string;
  workflowState: () => Promise<{
    phase: string;
    brief: string;
    planId: string | null;
    detail: string | null;
  }>;
  continueProject: (input: {
    projectId: string;
    request: string;
    operationKey: string;
    resumeBlocked?: boolean;
  }) => Promise<{ project: { id: string; name: string }; workflow: unknown }>;
  continueNamedProject: (input: { request: string; operationKey: string }) => Promise<{ project: { id: string; name: string }; workflow: unknown } | null>;
  startProject: (input: {
    name: string;
    description?: string;
    brief: string;
    operationKey: string;
  }) => Promise<{ project: { id: string; name: string }; workflow: unknown }>;
  listStacks: () => Promise<
    readonly { id: string; status: string; note?: string }[]
  >;
  discover: (input: {
    query?: string;
    limit?: number;
    refresh?: boolean;
  }) => Promise<unknown>;
  research: (input: {
    query?: string;
    url?: string;
    limit?: number;
  }) => Promise<unknown>;
  /** Stored detail for ONE hackathon already found (id or loose title). */
  hackathonDetails: (input: { id?: string; title?: string }) => Promise<unknown>;
  updateProfile: (input: {
    skills?: string[];
    interests?: string[];
    experienceLevel?: "beginner" | "intermediate" | "senior";
    formatPreference?: "online" | "in_person" | "either";
    weeklyHours?: number;
    stackIds?: string[];
  }) => Promise<{ applied: string[] }>;
  remember: (input: { content: string; kind: "preference" | "fact" }) => Promise<{ proposed: boolean }>;
  inspectRepository: () => Promise<{
    found: boolean;
    summary: string;
    skills: { skill: string; confidence: string }[];
    stacks: { stackId: string; confidence: string }[];
    notes: { content: string; kind: string }[];
  }>;
  verifyBuild: (operationKey: string, signal?: AbortSignal) => Promise<unknown>;
  blockBuild: (reason: string) => Promise<void>;
  /**
   * B06: create a PENDING approval on the server (the agent-facing request
   * bridge). Returns the server approval id; the user's Allow / Not now
   * decision goes through the authenticated REST route — never chat text.
   */
  requestApproval: (input: {
    projectId: string;
    action: string;
    resourceId: string;
    revisionHash: string;
    policyVersion: string;
  }) => Promise<{ id: string; expiresAt: string }>;
}
/** Render executes in the owning Durable Object, including alarm recovery. */
export function Coordinator({ id }: AgentProps) {
  useModel(findModelRouteForRole("chat").specifier);
  const identity = getDurableObjectIdentity();
  if (!id || identity.name !== id)
    throw new Error(
      "Coordinator conversation identity is unavailable or inconsistent.",
    );
  const env = getCloudflareContext().env as unknown as CoordinatorEnvironment;
  const [storedContext, setStoredContext] =
    usePersistentState<CoordinatorSnapshot | null>(
      "coordinator-context-v1",
      null,
    );
  const snapshot = checkedCoordinatorSnapshot(storedContext, id);
  const { context, resolve } = scopedCoordinatorContext(env, id, snapshot);
  const [lastUserRequest, setLastUserRequest] = usePersistentState(
    "last-user-request",
    "",
  );
  const delivery = useDelivery();
  const [homeDeliverySequence, setHomeDeliverySequence] = usePersistentState("home-delivery-sequence", 0);
  const [continuations, setContinuations] = usePersistentState(
    "build-continuations",
    0,
  );
  const writeProject = useDataWriter("projectWorkflow", {
    schema: v.object({ projectId: v.string(), name: v.string() }),
  });
  // Hackathon results render as a structured card (not model-authored markdown)
  // so the ranked candidates can't be invented or overflow. Emitted from the
  // REAL discovery result in the find_hackathons tool below.
  const writeHackathons = useDataWriter("hackathonResults", {
    schema: HackathonResultsCardSchema,
  });
  // B06 — the in-chat "OK to spend?" card. The coordinator writes a typed
  // data part carrying the SERVER approval id and the plan's spend cap; the
  // card's Allow / Not now buttons call the authenticated approvals REST
  // route, and the card state reloads from the server. Chat text can never
  // approve anything: only a card backed by a server approval id acts.
  const writeApprovalCard = useDataWriter('approvalCard', {
    schema: v.object({
      approvalId: v.string(),
      projectId: v.string(),
      what: v.string(),
      capMinorUnits: v.nullable(v.number()),
      currency: v.nullable(v.string()),
      status: v.picklist(['pending', 'approved', 'rejected', 'expired']),
    }),
  });
  // No useSandbox: native tools would be inherited by QA and bypass role
  // boundaries. All filesystem and execution effects use scoped host tools.
  if (!snapshot || context.homeOverview === null) {
    for (const declaration of buildSpecialistDeclarations({ ...context, currentRequest: delivery.kind === "user" ? delivery.body : lastUserRequest }))
      useSubagent(declaration);
    useTool(makeVerifyBuild({ verify: context.verifyBuild }));
    useTool({
      name: "report_blocker",
      description:
        "Stop a blocked build honestly and explain what the user needs to resolve.",
      input: v.object({
        reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
      }),
      async run(ctx) {
        await context.blockBuild(ctx.data.reason);
        return { output: "Blocker saved; work stopped." };
      },
    });
  }
  useTool(makeListStacks({ listStacks: context.listStacks }));
  // "Caddie learns you": capture preferences and memory the user states in
  // conversation. Available in every conversation (user-scoped, not a build
  // effect). Memory proposals await confirmation; budget/authorization is not
  // settable here by construction.
  useTool(makeUpdateProfile({ updateProfile: context.updateProfile }));
  useTool(makeRememberFact({ remember: context.remember }));
  useTool(makeInspectRepository({ inspectRepository: context.inspectRepository }));
  useTool({
    name: "find_hackathons",
    description:
      FIND_HACKATHONS_DESCRIPTION,
    input: v.object({
      query: v.optional(v.string()),
      limit: v.optional(v.number()),
      refresh: v.optional(v.boolean()),
    }),
    async run(ctx) {
      const result = await context.discover(ctx.data);
      // Emit the structured card from the REAL result (buildHackathonResultsCard
      // documents the honesty rules of the mapping) — never model-authored text.
      const card = buildHackathonResultsCard(result as DiscoveryResultForCard);
      writeHackathons(card);
      const candidates = card.candidates;
      // The ranked card is ALREADY rendered in the chat from this structured
      // result. Return a terse signal — NOT the full result JSON — so the model
      // does not transcribe the same list into a markdown table or prose beside
      // the card (that duplication is the one thing to avoid here). `shown` is
      // a compact reference (id/title/url/verdict) taken from the SAME card, so
      // a later follow-up can name the right event and agree with the card
      // instead of searching the web blind.
      return {
        output: JSON.stringify({
          rendered: 'hackathon_results_card',
          count: candidates.length,
          gaps: card.gaps,
          shown: buildHackathonReference(card),
          instruction:
            'The hackathon card is shown to the user with every title, link and eligibility verdict. Do NOT list, tabulate or re-describe these hackathons in your reply — that would duplicate the card. Write at most one short sentence of framing (e.g. invite the user to open one or refine the search), or nothing. Never output a markdown table of these results. ' +
            '`shown` is for FOLLOW-UPS ONLY, never to be listed: when the user later asks about one of these events, use its id and its eligibility verdict here — it is the checked verdict on the card, so never contradict it.',
        }),
      };
    },
  });
  useTool({
    name: "research",
    description:
      RESEARCH_DESCRIPTION,
    input: v.object({
      query: v.optional(v.string()),
      url: v.optional(v.string()),
      limit: v.optional(v.number()),
    }),
    async run(ctx) {
      return { output: JSON.stringify(await context.research(ctx.data)) };
    },
  });
  useTool({
    name: "hackathon_details",
    description:
      HACKATHON_DETAILS_DESCRIPTION,
    input: v.object({
      id: v.optional(v.string()),
      title: v.optional(v.string()),
    }),
    // A digest cache miss runs one bounded model call (~30s); keep the call
    // bounded so a stalled request settles as a tool error, not a hung turn.
    timeoutMs: 90_000,
    async run(ctx) {
      return { output: JSON.stringify(await context.hackathonDetails(ctx.data)) };
    },
  });
  useTool({
    name: "request_approval",
    description:
      "Ask the user to approve a spend or a plan action. Creates a PENDING approval on the server and shows an approval card in the chat. Call this BEFORE any work that needs user authorization; never claim the user approved something without this card being approved on the server.",
    input: v.object({
      projectId: v.string(),
      action: v.string(),
      resourceId: v.string(),
      revisionHash: v.string(),
      policyVersion: v.string(),
      what: v.string(),
      capMinorUnits: v.optional(v.nullable(v.number())),
      currency: v.optional(v.nullable(v.string())),
    }),
    async run({ data }) {
      const bridge = context.requestApproval;
      if (!bridge) return 'approvals are not available in this run';
      const approval = await bridge({
        projectId: data.projectId,
        action: data.action,
        resourceId: data.resourceId,
        revisionHash: data.revisionHash,
        policyVersion: data.policyVersion,
      });
      writeApprovalCard({
        approvalId: approval.id,
        projectId: data.projectId,
        what: data.what,
        capMinorUnits: data.capMinorUnits ?? null,
        currency: data.currency ?? null,
        status: 'pending',
      });
      return `Approval requested (id ${approval.id}). The user decides with the card in the chat; do not proceed until the server records the decision.`;
    },
  });
  useTool({
    name: "create_project",
    description:
      "Create a project with the full user request and start planning in Caddie. The chat shows its plan, review controls, build status and preview; no manual handoff.",
    input: v.object({
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      description: v.optional(v.string()),
      brief: v.pipe(v.string(), v.minLength(1), v.maxLength(16000)),
    }),
    async run(ctx) {
      const authority = await resolve();
      const original =
        delivery.kind === "user" ? delivery.body : lastUserRequest;
      const created = await authority.startProject({
        ...ctx.data,
        brief: original
          ? `${original}\n\nProject brief: ${ctx.data.brief}`
          : ctx.data.brief,
        operationKey: `${authority.runId}:${ctx.toolCallId}`,
      });
      writeProject({
        projectId: created.project.id,
        name: created.project.name,
      });
      return {
        output: JSON.stringify({
          projectId: created.project.id,
          name: created.project.name,
          status: "planning",
          next: "Planning is queued for the separate project coordinator. The project card continues that work and shows the plan here. Your Home role is to acknowledge the handoff briefly; do not attempt project planning here, claim missing specialist tools, or ask the user to navigate or resend their request.",
        }),
      };
    },
  });
  useTool({
    name: "continue_project",
    description:
      "Continue an existing project inside this chat. Shows its current plan/build/preview and carries your request to its existing conversation without creating another project.",
    input: v.object({
      projectId: v.string(),
      request: v.pipe(v.string(), v.minLength(1), v.maxLength(16000)),
    }),
    async run(ctx) {
      const authority = await resolve();
      const result = await authority.continueProject({
        ...ctx.data,
        request: delivery.kind === "user" ? delivery.body : ctx.data.request,
        operationKey: authority.homeOverview !== null && delivery.kind === "user" && homeDeliverySequence > 0
          ? `home-delivery:${authority.runId}:${homeDeliverySequence}:${ctx.data.projectId}`
          : `${authority.runId}:${ctx.toolCallId}`,
      });
      writeProject({ projectId: result.project.id, name: result.project.name });
      return {
        output:
          "The existing project is shown here; its original plan, files and conversation are retained.",
      };
    },
  });
  useAgentStart(async (ctx) => {
    const authority = await resolve();
    setStoredContext(coordinatorSnapshot(id, authority));
    setContinuations(0);
    if (delivery.kind === "user") {
      setLastUserRequest(delivery.body);
      if (authority.homeOverview !== null) {
        let sequence = 0;
        setHomeDeliverySequence(previous => { sequence = previous + 1; return sequence; });
        const routed = await authority.continueNamedProject({
          request: delivery.body, operationKey: `home-delivery:${authority.runId}:${sequence}`,
        });
        if (routed) {
          writeProject({ projectId: routed.project.id, name: routed.project.name });
          ctx.append({ kind: "signal", type: "project_handoff", body:
            `The host has already forwarded this full user request to ${routed.project.name}, preserving its plan and files. The project card shows its actual state. Acknowledge the handoff briefly. Do not claim specialist tools are missing or ask the user to move to another page. Do not create another project or hand it off again.` });
        }
      }
    }
    const state =
      authority.homeOverview === null ? await authority.workflowState() : null;
    ctx.append({
      kind: "signal",
      type: "coordinator_context",
      body: JSON.stringify({
        actorContext: authority.actorContext,
        homeOverview: authority.homeOverview,
        projectState: state,
      }),
    });
  });
  useAgentFinish(async (ctx) => {
    const authority = await resolve();
    if (authority.homeOverview !== null) return;
    const state = await authority.workflowState();
    // A plan in prose is not a saved reviewable revision. Both planning and
    // building must advance their durable state or stop with a real blocker.
    if (state.phase === "planning") {
      if (continuations >= 2) {
        await authority.blockBuild("The plan revision was not saved. Ask Caddie to continue planning; your request and feedback are retained.");
        return;
      }
      setContinuations((n) => n + 1);
      ctx.append({ kind: "signal", type: "plan_incomplete", body: "Planning is unfinished: no new PRD has been saved. Use the task tool to delegate product to read the full brief and feedback and WRITE a new prd revision using write_plan_note. A PRD printed in chat does not count. The server-backed review controls appear only after the revision is saved. Do not ask for a conversational Approved or claim a plan is ready until the workflow phase is review. If a real prerequisite is missing, report_blocker." });
      return;
    }
    // Review, ready and blocked may settle; readiness comes only from the host.
    if (state.phase !== "building") return;
    if (continuations >= 2) {
      await authority.blockBuild(
        "The build did not produce passing checks and a preview. Continue with Caddie to diagnose it.",
      );
      return;
    }
    setContinuations((n) => n + 1);
    ctx.append({
      kind: "signal",
      type: "build_incomplete",
      body: "Work is not verified. Delegate implementation/repair, then call verify_build. If a prerequisite is unavailable call report_blocker; never claim completion.",
    });
  });
  useInstruction(context.actorContext);
  if (context.homeOverview) {
    useInstruction(context.homeOverview);
    useInstruction("This is Home coordination. New and existing project requests are handed to their project coordinator through create_project or continue_project and their in-chat card. After handoff acknowledge it briefly and settle; project specialists and verification run in the project conversation. Their absence from Home is intentional, not a blocker. Do not expose internal ids/tool names or contradict the server-backed project card with speculative progress or capability claims.");
  }
  useInstruction(
    `You are Caddie, a helpful assistant for solo builders. Priorities: find suitable hackathons, plan and build new projects, then continue existing projects. Speak in clear user-facing language, never raw internal tool names or opaque ids. The supported proving stack is React + Bun + Hono; the other stacks remain planned. When the user refers to an existing project call continue_project with its actual id from context; never create a duplicate or tell them to navigate first. For a new app call create_project with a faithful full brief, choose a sensible name when none is provided, and let its card continue the work here. Never ask the user to open another page or repeat the request. Profile facts supplied by the host are known; never pretend this is anonymous. Use find_hackathons for actual hackathon results — call it directly for any "find/suggest a hackathon" request, without first asking the user what they like (their saved profile already drives the ranking); explicitly acknowledge when fresh official rules/listings are unavailable. A planning step or greeting is not a completed build. Plan approval does not authorize deployment, purchases, merge, or destructive data changes. If blocked explain the specific prerequisite and stop. A ready workflow means build checks passed, not proof of every real-world outcome.`,
  );
  useInstruction("Caddie serves nontechnical people and technical people short on time. Own setup, task handoffs, tests and repairs. The user describes the outcome, reviews a readable plan, and tries the app. Ask only for product choices or missing information that changes the result; choose sensible defaults for implementation details. Keep tool names, run ids, revision hashes and debugging steps out of normal replies. Explain progress briefly in terms of the app, and show technical evidence only when requested. Never ask the user to configure the test environment, move between workspaces or pass instructions to specialists. A genuine blocker needs a plain explanation of what is saved, what is incomplete and the specific decision needed. Do not imply the user must repair Caddie. Never describe a generated app as ready until the host-backed workflow publishes its preview.");
  useInstruction("Be smart, proactive and personal, but never presumptuous. Lead with what you already know from the host-supplied profile and confirmed memory — default the stack from a stated preference, greet by what you know, and ask only for facts that are genuinely missing and matter to the current choice. When the user tells you something durable about themselves (a skill, a tool preference, how they work), call update_profile or remember so you keep it — but a memory is a PROPOSAL: tell them you noted it and that it sticks once they confirm; never present a proposed or inferred fact as already saved. You may call inspect_repository to see what the user has already built and offer an observation (\"looks like you work in TypeScript + React — want me to remember that?\"); it records nothing on its own. Never record anything resembling spending or deployment permission as a preference or memory — those remain separate explicit approvals.");
  useInstruction(HACKATHON_HONESTY_INSTRUCTION);
  useInstruction(HACKATHON_FOLLOWUPS_INSTRUCTION);
  if (context.homeOverview) {
    useInstruction("Your final role is Home intake and handoff. You MUST use continue_project for requested work on a named existing project, passing the full request to its actual id in Home context. That project's coordinator has frontend, QA and the sandbox. You do not execute specialist work here and MUST NOT report those tools as unavailable. If the user asks for technical repairs, forward those requirements intact to the project coordinator; do not evaluate local Home tools as project capabilities.");
  } else {
    useInstruction("For project work: read project context, delegate product and designer work, write one cohesive PRD with user-facing scope, concrete visual direction and behavior checks, then stop for authenticated review. A PRD uses the React/Hono recipe; no arbitrary unsupported stacks or IE11 requirement. After approval, delegate frontend/backend only as needed; include meaningful behavioral tests, run QA with verify_build, and surface a usable preview. There is no native shell environment: use the specialists' scoped tools.");
  }
  return "Caddie helps solo builders discover, plan, build, verify and share software through one continuous conversation.";
}
