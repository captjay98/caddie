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
import { FEATURE_BLOCK_GUIDE, HackathonResultsCardSchema } from "@caddie/contracts";
import { buildHackathonReference, buildHackathonResultsCard, type DiscoveryResultForCard } from "../server/hackathon-card.ts";
import {
  FIND_HACKATHONS_DESCRIPTION,
  HACKATHON_DETAILS_DESCRIPTION,
  HACKATHON_FOLLOWUPS_INSTRUCTION,
  HACKATHON_HONESTY_INSTRUCTION,
  HACKATHON_IDEATION_INSTRUCTION,
  RESEARCH_DESCRIPTION,
} from "./hackathon-prompts.ts";
import { coordinatorModelRole, findModelRouteForRole, IDEATION_TURN_WINDOW } from "./providers.ts";
import { COORDINATOR_DURABILITY } from "./permissions.ts";
import { makeListStacks, makeVerifyBuild, makeUpdateProfile, makeRememberFact, makeInspectRepository, makeWritePlanNote, makeReadProjectContext } from "./tools.ts";
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
  /** Store a project PROPOSAL for a card in this chat. Creates no project — the user's click does. */
  proposeProject: (input: {
    name: string;
    idea: string;
    brief: string;
    hackathonTitle?: string;
    hackathonUrl?: string;
    track?: string;
    firstStep?: string;
    /** 'flutter' = an Android app (Track 3); omitted = a web app. */
    stackId?: "react-hono" | "flutter";
  }) => Promise<{ id: string; homeProjectId: string; status: string }>;
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
  /** The host's next feature to build (marks it building). */
  buildNextFeature: () => Promise<unknown>;
  /** Finish the current feature: host checks + new tests + save point. */
  finishFeature: (featureId: string, operationKey: string, signal?: AbortSignal) => Promise<unknown>;
  /** Feature-loop position for the finish hook; null before a build has features. */
  featureProgress: () => Promise<{
    total: number;
    passed: number;
    current: { id: string; title: string; position: number } | null;
  } | null>;
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
  // Brainstorming window: entered when the user picks an event to dig into
  // (hackathon_details) or asks to work out what to build (start_brainstorm),
  // counted down per user turn, cleared by propose_project. While it is open
  // the HOME coordinator runs on the deeper ideation model; Flue reads the
  // model when a submission starts, so the switch lands on the next turn.
  // Project conversations never switch: their specialists inherit this model.
  const [ideationTurnsLeft, setIdeationTurnsLeft] = usePersistentState("ideation-turns-left", 0);
  const isHome = snapshot !== null && snapshot.homeOverview !== null;
  const delivery = useDelivery();
  // An attached image routes THIS submission to the vision model (Flue reads
  // the model when the submission starts, so the image turn itself switches).
  const hasImage =
    delivery.kind === "user" && (delivery.attachments ?? []).some((part) => part.type === "image");
  useModel(findModelRouteForRole(coordinatorModelRole({ isHome, ideationTurnsLeft, hasImage })).specifier);
  const { context, resolve } = scopedCoordinatorContext(env, id, snapshot);
  const [lastUserRequest, setLastUserRequest] = usePersistentState(
    "last-user-request",
    "",
  );
  const [homeDeliverySequence, setHomeDeliverySequence] = usePersistentState("home-delivery-sequence", 0);
  const [continuations, setContinuations] = usePersistentState(
    "build-continuations",
    0,
  );
  // Which feature the continuation budget is being spent on (per-feature reset).
  const [continuationFocus, setContinuationFocus] = usePersistentState("build-continuation-focus", "");
  const writeProject = useDataWriter("projectWorkflow", {
    schema: v.object({ projectId: v.string(), name: v.string() }),
  });
  // The project PROPOSAL card: carries only the server proposal id; the card
  // reads its content and state from the server, and only the user's click on
  // "Start this project" creates anything.
  const writeProposal = useDataWriter("projectProposal", {
    schema: v.object({ proposalId: v.string(), homeProjectId: v.string() }),
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
    // The coordinator can read the current plan and SAVE a PRD revision
    // itself. The product/designer delegates remain the normal authoring path,
    // but a delegate that returns "(task completed with no text)" leaves
    // NOTHING saved — and the host then nudges forever while the model
    // (falsely) tells the user the plan was saved (FarmLog AI, 2026-10-15: six
    // empty delegations in one turn, three "saved / in review" claims, zero new
    // revisions). Mounting write_plan_note here lets the coordinator write the
    // revision directly when a delegate stalls, so the save actually lands in
    // ONE round instead of burning the turn budget on empty hand-offs.
    useTool(makeReadProjectContext({ readPlanNote: context.readPlanNote }));
    useTool(makeWritePlanNote({ writePlanNote: context.writePlanNote }));
    useTool(makeVerifyBuild({ verify: context.verifyBuild }));
    // The host-driven feature loop: the host says which feature is next and
    // decides when it is done (green checks + new passing tests + save point).
    useTool({
      name: "build_next_feature",
      description:
        "During an approved build, get the ONE feature to build next (its id, title and doneWhen checks) from the host. Features are built one at a time in plan order; call this before delegating any implementation.",
      input: v.object({}),
      async run() {
        return { output: JSON.stringify(await context.buildNextFeature()) };
      },
    });
    useTool({
      name: "finish_feature",
      description:
        "Ask the host to finish the current feature: it runs the project checks, requires new passing tests for this feature, and saves a checkpoint the user can roll back to. Only the feature build_next_feature returned can be finished.",
      input: v.object({ featureId: v.pipe(v.string(), v.minLength(1), v.maxLength(48)) }),
      async run(ctx) {
        return { output: JSON.stringify(await context.finishFeature(ctx.data.featureId, ctx.toolCallId, ctx.signal)) };
      },
    });
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
      const details = await context.hackathonDetails(ctx.data);
      // Digging into ONE event is where brainstorming starts (the follow-up
      // rule offers it next), so the following turns get the ideation model.
      if (isHome && (details as { found?: unknown } | null)?.found !== false)
        setIdeationTurnsLeft(IDEATION_TURN_WINDOW);
      return { output: JSON.stringify(details) };
    },
  });
  useTool({
    name: "start_brainstorm",
    description:
      "Call when the user wants to work out WHAT to build — they ask for project ideas, say \"let's brainstorm\", pick a track, or describe a problem they want to solve — and no project idea has been settled yet. It gives the next replies more careful thinking; it creates nothing and shows nothing. Call it once per brainstorm, then follow the IDEATION rule in the same reply. Do not call it for questions about an existing project.",
    input: v.object({}),
    async run() {
      if (!isHome) return { output: "Brainstorming already happens in this conversation." };
      setIdeationTurnsLeft(IDEATION_TURN_WINDOW);
      return { output: JSON.stringify({ brainstorming: true, next: "Follow the IDEATION rule now. Never mention this tool or a mode change to the user." }) };
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
    name: "propose_project",
    description:
      "Propose ONE new project as a card in this chat, once the user has agreed on a specific idea. This creates NOTHING: the card shows the name, the idea, the hackathon and track and what to build first, and the project is created only if the user presses its \"Start this project\" button (\"Keep refining\" creates nothing). Never call it while you are still brainstorming or narrowing down, never call it twice for the same idea, and never say a project was created or started.",
    input: v.object({
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      idea: v.pipe(v.string(), v.minLength(1), v.maxLength(600)),
      brief: v.pipe(v.string(), v.minLength(1), v.maxLength(16000)),
      hackathonTitle: v.optional(v.string()),
      hackathonUrl: v.optional(v.string()),
      track: v.optional(v.string()),
      firstStep: v.optional(v.string()),
      app: v.optional(
        v.pipe(
          v.picklist(["web", "android"]),
          v.description(
            "Leave out for a web app (the default; web apps also install on phones from the browser). Use \"android\" only when the user asked for an Android app they install on their phone: Caddie then builds it with Flutter and offers the app as a download. Check list_stacks first: if flutter is not enabled, do not offer an Android app.",
          ),
        ),
      ),
    }),
    async run(ctx) {
      const authority = await resolve();
      const original =
        delivery.kind === "user" ? delivery.body : lastUserRequest;
      // Mid-brainstorm, the latest message is a reaction ("1 and 3 are the
      // most realistic"), not the request — prefixing it made it the first
      // line of the saved brief. Only a direct request is kept verbatim.
      const brainstorming = ideationTurnsLeft > 0;
      const { app, ...proposalInput } = ctx.data;
      const proposal = await authority.proposeProject({
        ...proposalInput,
        ...(app === "android" ? { stackId: "flutter" as const } : {}),
        brief: original && !brainstorming
          ? `${original}\n\nProject brief: ${ctx.data.brief}`
          : ctx.data.brief,
      });
      setIdeationTurnsLeft(0);
      writeProposal({ proposalId: proposal.id, homeProjectId: proposal.homeProjectId });
      return {
        output: JSON.stringify({
          proposalId: proposal.id,
          shown: "project_proposal_card",
          created: false,
          next: "The proposal card is shown. NOTHING has been created: the user decides with the card's \"Start this project\" or \"Keep refining\" button. Do not say the project was created, started or queued. Write at most one short sentence (e.g. they can start it from the card, or tell you what to change).",
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
      // One user turn spent from the brainstorm window (this turn's model was
      // already chosen at submission start, so this only affects later turns).
      setIdeationTurnsLeft((left) => (left > 0 ? left - 1 : 0));
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
      ctx.append({ kind: "signal", type: "plan_incomplete", body: "Planning is unfinished: the host has NOT received a new PRD revision — nothing was saved, and the workflow phase is still 'planning', NOT 'review'. Do NOT tell the user a plan or revision was saved, written, updated or is awaiting review; that is FALSE right now and must not be said. A delegate result of \"(task completed with no text)\" means the specialist stopped WITHOUT saving — it is not a save, so never re-delegate the same empty hand-off expecting a different result. Instead, call write_plan_note yourself with kind:'prd' and the full revised PRD body (incorporate the user's feedback and the current brief), then STOP. write_plan_note returns a line beginning 'SAVED:' only when the host actually recorded the revision; only after you see that, and the next coordinator_context shows phase 'review', may you tell the user the plan is ready. If a real prerequisite is missing, call report_blocker. Until you have the 'SAVED:' confirmation, say Caddie is still working on the plan — never that it is saved or ready." });
      return;
    }
    // Review, ready and blocked may settle; readiness comes only from the host.
    if (state.phase !== "building") return;
    // The host owns the feature order. The nudge budget is PER FEATURE: a
    // feature that passed is progress, so the next one starts a fresh budget.
    const progress = await authority.featureProgress();
    const focus = progress?.current ? `feature:${progress.current.id}` : "verify";
    const used = focus === continuationFocus ? continuations : 0;
    if (used >= 2) {
      await authority.blockBuild(
        progress?.current
          ? `Caddie could not finish “${progress.current.title}” (feature ${progress.current.position} of ${progress.total}). The features before it are saved; retry to continue from this one.`
          : "The build did not produce passing checks and a preview. Continue with Caddie to diagnose it.",
      );
      return;
    }
    setContinuationFocus(focus);
    setContinuations(used + 1);
    ctx.append({
      kind: "signal",
      type: "build_incomplete",
      body: progress?.current
        ? `The build is not finished: feature ${progress.current.position} of ${progress.total}, “${progress.current.title}”, is next. Call build_next_feature, delegate exactly that feature with its doneWhen checks, then call finish_feature. If a prerequisite is unavailable call report_blocker; never claim completion.`
        : "Work is not verified. Call build_next_feature to see what remains; when every feature has passed, run QA with verify_build. If a prerequisite is unavailable call report_blocker; never claim completion.",
    });
  });
  useInstruction(context.actorContext);
  if (context.homeOverview) {
    useInstruction(context.homeOverview);
    useInstruction("This is Home coordination. Existing project requests are handed to their project coordinator through continue_project and its in-chat card. A NEW project is only ever proposed with propose_project, as a card the user starts themselves. After handoff acknowledge it briefly and settle; project specialists and verification run in the project conversation. Their absence from Home is intentional, not a blocker. Do not expose internal ids/tool names or contradict the server-backed project card with speculative progress or capability claims.");
  }
  useInstruction(
    `You are Caddie, a helpful assistant for solo builders. Priorities: find suitable hackathons, plan and build new projects, then continue existing projects. Speak in clear user-facing language, never raw internal tool names or opaque ids. The supported proving stack is React + Bun + Hono; the other stacks remain planned. When the user refers to an existing project call continue_project with its actual id from context; never create a duplicate or tell them to navigate first. For a new app, first make sure the user has agreed on a specific idea, then call propose_project with a faithful full brief and a sensible name; the card lets them start it. Nothing is created until they press Start this project. Never ask the user to open another page or repeat the request. Profile facts supplied by the host are known; never pretend this is anonymous. Use find_hackathons for actual hackathon results — call it directly for any "find/suggest a hackathon" request, without first asking the user what they like (their saved profile already drives the ranking); explicitly acknowledge when fresh official rules/listings are unavailable. A planning step or greeting is not a completed build. Plan approval does not authorize deployment, purchases, merge, or destructive data changes. If blocked explain the specific prerequisite and stop. A ready workflow means build checks passed, not proof of every real-world outcome.`,
  );
  useInstruction("Caddie serves nontechnical people and technical people short on time. Own setup, task handoffs, tests and repairs. The user describes the outcome, reviews a readable plan, and tries the app. Ask only for product choices or missing information that changes the result; choose sensible defaults for implementation details. Keep tool names, run ids, revision hashes and debugging steps out of normal replies. Explain progress briefly in terms of the app, and show technical evidence only when requested. Never ask the user to configure the test environment, move between workspaces or pass instructions to specialists. A genuine blocker needs a plain explanation of what is saved, what is incomplete and the specific decision needed. Do not imply the user must repair Caddie. Never describe a generated app as ready until the host-backed workflow publishes its preview.");
  useInstruction("Be smart, proactive and personal, but never presumptuous. Lead with what you already know from the host-supplied profile and confirmed memory — default the stack from a stated preference, greet by what you know, and ask only for facts that are genuinely missing and matter to the current choice. When the user tells you something durable about themselves (a skill, a tool preference, how they work), call update_profile or remember so you keep it — but a memory is a PROPOSAL: tell them you noted it and that it sticks once they confirm; never present a proposed or inferred fact as already saved. You may call inspect_repository to see what the user has already built and offer an observation (\"looks like you work in TypeScript + React — want me to remember that?\"); it records nothing on its own. Never record anything resembling spending or deployment permission as a preference or memory — those remain separate explicit approvals.");
  useInstruction(HACKATHON_HONESTY_INSTRUCTION);
  useInstruction(HACKATHON_FOLLOWUPS_INSTRUCTION);
  useInstruction(HACKATHON_IDEATION_INSTRUCTION);
  if (context.homeOverview) {
    useInstruction("Your final role is Home intake and handoff. You MUST use continue_project for requested work on a named existing project, passing the full request to its actual id in Home context. That project's coordinator has frontend, QA and the sandbox. You do not execute specialist work here and MUST NOT report those tools as unavailable. If the user asks for technical repairs, forward those requirements intact to the project coordinator; do not evaluate local Home tools as project capabilities.");
  } else {
    useInstruction("For project work: read project context, delegate product and designer work, write one cohesive PRD with user-facing scope, concrete visual direction and behavior checks, then stop for authenticated review. A PRD uses the React/Hono recipe; no arbitrary unsupported stacks or IE11 requirement. After approval, build feature by feature: call build_next_feature, delegate exactly that feature with its doneWhen checks to the implementation specialist, then call finish_feature; repeat until the host says every feature passed, then run QA with verify_build to publish a usable preview. There is no native shell environment: use the specialists' scoped tools. If a product/designer delegate returns \"(task completed with no text)\" or otherwise does not save, do NOT re-delegate the same empty hand-off: call write_plan_note yourself with kind:'prd' and the full PRD body to save the revision directly.");
    useInstruction("SAVED MEANS SAVED: a plan, revision or file exists only when the host CONFIRMS it — write_plan_note returning a line that begins 'SAVED:', AND the workflow phase in coordinator_context being 'review' (not 'planning'). A specialist describing what it saved, a PRD you printed in chat, or a task result of \"(task completed with no text)\", is NOT proof; never tell the user something was saved, written, updated or is ready for review on that basis. While the phase is still 'planning' the plan is NOT saved — say Caddie is still working on it, never that it is ready. Only after you have the 'SAVED:' confirmation and the phase has moved to 'review' may you say the plan is ready to review.");
    useInstruction(`FEATURE LIST: every PRD you save must list what will be built, so the user approves exactly that list and the host builds it one feature at a time. ${FEATURE_BLOCK_GUIDE} Order features so each builds on the last; keep each one small enough to finish and test on its own; write doneWhen checks as behaviors a person could see. write_plan_note refuses a PRD without a valid list.`);
    useInstruction("COMPREHENSIVE PRD, FIRST PASS: write the whole thing before saving — the user must never have to ask for the schema, then say 'not comprehensive', then 'still ambiguous'. Every PRD covers, as explicit sections: overview + goals/non-goals; user stories/flows; a DATA MODEL with every entity's fields, types, keys and relations (money as integer minor units, never a float); the API surface (Hono routes in/out) or an explicit 'local-only, no server API'; the frontend screens + key components with each loading/empty/error state; offline/sync (what's stored locally, what syncs, the conflict rule) when it is a PWA/offline app; the SPECIFIC AI model/service with its call path and fail-soft behavior, never 'an AI model'; and observable success metrics. Where the brief lacks a detail, choose a sensible default and label it 'assumption:' so the user corrects one line — do NOT leave a section blank, do NOT drip-feed depth across turns, and do NOT stop to ask one question at a time.");
    useInstruction("DESIGN STEP: after the PRD is approved the project enters the 'design' phase — the user has NOT approved a build yet. Do NOT scaffold or build. Delegate the designer (or author it yourself with write_plan_note kind:'design', same planRevision) to produce ONE design brief: the screen inventory; each key screen's layout and components; the token/component choices and the interaction pattern for each input; and the empty, loading and error state for anything that loads or saves; plus one titled ```html-mock block per key screen and state (static markup styled only with design-system tokens) so the user can see it. Save it and STOP for the authenticated design review. Only after the design review approves does the phase become 'building' and the feature loop begins. The design brief is NOT the PRD and carries no caddie-features block.");
  }
  return "Caddie helps solo builders discover, plan, build, verify and share software through one continuous conversation.";
}
// Explicit submission bound (see COORDINATOR_DURABILITY): Flue aborts and
// settles a submission past timeoutMs; the app's stall watchdog reports it.
Coordinator.durability = { ...COORDINATOR_DURABILITY };
