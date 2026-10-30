"use agent";
import { refersToExistingWork } from '../shared/chat-intent.ts';
import { ownWordsOrNothing, rememberSaid } from '../shared/owner-words.ts';
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
import type { ProjectStatusReply } from "../server/project-experience.ts";
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
import { DEMO_CONTRACT_GUIDE, FEATURE_BLOCK_GUIDE, HackathonResultsCardSchema } from "@caddie/contracts";
import { buildHackathonReference, buildHackathonResultsCard, type DiscoveryResultForCard } from "../server/hackathon-card.ts";
import {
  FIND_HACKATHONS_DESCRIPTION,
  HACKATHON_DETAILS_DESCRIPTION,
  HACKATHON_FOLLOWUPS_INSTRUCTION,
  HACKATHON_HONESTY_INSTRUCTION,
  HACKATHON_IDEATION_INSTRUCTION,
  RESEARCH_DESCRIPTION,
} from "./hackathon-prompts.ts";
import { compactionFor, coordinatorModelSelection, findModelRouteForRole, IDEATION_TURN_WINDOW, ROLE_THINKING } from "./providers.ts";
import { guardPlanWrites } from "./plan-write-guard.ts";
import { COORDINATOR_DURABILITY } from "./permissions.ts";
import { makeListStacks, makeVerifyBuild, makeUpdateProfile, makeRememberFact, makeInspectRepository, makeWritePlanNote, makeReadProjectContext } from "./tools.ts";
import {
  PLATFORM_AI_RULE,
  FEATURE_DELEGATION_RULE,
  buildSpecialistDeclarations,
  architectDeclaration,
  TEAM_MODE_DESIGN_INSTRUCTION,
  TEAM_MODE_BIG_APPS_DESIGN_INSTRUCTION,
  type SpecialistBuildContext,
} from "./specialists.ts";

/**
 * Team mode (part B): the coordinator's review loop. Every design is reviewed
 * by the architect before it is shown for approval (the gate refuses an
 * unreviewed block), and when two reviews in a row still find safety problems
 * the plan changes instead of the design. Writing a new plan revision sends the
 * build back to plan review (workflowSnapshot). Team mode only.
 */
/**
 * The one sentence Caddie says beside a hackathon card, built from the real
 * result. It makes no claim about checking; the card's own footer states
 * how many events had their rules read.
 */
export function discoveryReply(count: number): string {
  if (count === 0) return "Nothing came back this time. Tell me a topic and I'll search again.";
  return "Tap any event to see what you'd build and how to enter, or tell me a topic and I'll narrow the search.";
}

/** The final word on how every reply sounds. */
/** During a build the build card is the status; chat text is for the owner only. */
export const BUILD_QUIET_RULE =
  "DURING A BUILD: write no text between tool calls — no plans, no 'Let me…', no feature numbers, no file, client/server or contract talk; the build card already shows which part is being built. Write chat text only when the build pauses, stops or finishes: one or two plain sentences naming the part by its title from the plan (\"Get a tip when a day looks unusual\") and what the owner can do (press Retry, or try the app).";
export const VOICE_RULE =
  "VOICE (applies to every reply, overrides any longer format above): the reader has never built software. Write at most three short sentences, under 60 words, like a friendly text message. Lead with what it means for them, then the one next step. No lists, headings or bold unless they asked for detail. Never describe how Caddie works inside (plans, reviews, saves, specialists, steps, retries, models, payloads, schemas) or repeat what a card already shows — point to the card instead. Never use technical words (PRD, API, PWA, schema, payload, scaffold, deploy, framework names, stack, endpoint) unless the user used them first. When something is ready: one sentence saying so and where to look. When something failed: one sentence saying it didn't work this time and that Try again on the project card will pick it up.";

/** Plan-note kinds only a specialist may author (never the coordinator). */
export const SPECIALIST_AUTHORED: Partial<Record<string, string>> = {
  prd: "the product specialist",
  looks: "the designer",
  design: "the designer",
};

export const TEAM_MODE_REVIEW_LOOP_INSTRUCTION =
  "TEAM MODE REVIEW: after a design revision is saved, delegate to the architect to review its caddie-architecture block before telling the user it is ready. Fix every security issue it reports in a NEW design revision, then ask for another review; advisory notes are shown to the user and never block. If the architect says the plan must change (two reviews in a row found safety problems), stop revising the design: write a new plan revision (write_plan_note kind 'prd') that removes the cause, and tell the user in one plain sentence why the plan changed. That sends the build back to plan review.";

export interface CoordinatorHostContext extends SpecialistBuildContext {
  currentPlanRevision: () => string;
  homeOverview: string | null;
  existingProjectCount?: number;
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
  /** Read-only: how one of the person's own projects is going, in words (plan 3.7). */
  projectStatus: (input: { projectId: string }) => Promise<ProjectStatusReply>;
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
    requiredTech?: string;
    audience?: string;
    problem?: string;
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
  }, hooks?: {
    /** The person asked for a first / beginner hackathon in their own words. */
    firstTimer?: boolean;
    /** Called as each real stage of the search starts (drives the live progress line). */
    onProgress?: (progress: { stage: "sources" | "rules" | "ranking"; text: string }) => void;
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
  remember: (input: { content: string; kind: "preference" | "fact"; about?: "you" | "project" }) => Promise<{ proposed: boolean }>;
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
    /** Big apps: the foundation is done and its parts are still being built by their own builders. */
    waitingOnParts?: boolean;
  } | null>;
  /**
   * Big apps (part P step 3): join this finished part into the app. Present
   * only on a part builder's (module-scoped) host.
   */
  finishModuleBuild?: (operationKey: string, signal?: AbortSignal) => Promise<unknown>;
  blockBuild: (reason: string, source?: 'nonprogress') => Promise<void>;
  /**
   * Team mode (part B): record one architecture-review round. The host closure
   * performs the project-scoped insert into architecture_reviews. Absent when
   * the run is not team-mode, so the architect delegate is not mounted.
   */
  recordArchitectureReview?: (input: {
    blockHash: string;
    /** Ignored by the host, which numbers rounds itself. */
    round?: number;
    issues: { severity: "security" | "advisory"; path: string; message: string }[];
  }) => Promise<{ round: number; security: number; advisory: number; mustChangePlan?: boolean }>;
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
  // either conversation can use deeper ideation; execution specialists keep
  // explicit model declarations. Explicit brainstorm requests route immediately.
  const [ideationTurnsLeft, setIdeationTurnsLeft] = usePersistentState("ideation-turns-left", 0);
  const isHome = snapshot !== null && snapshot.homeOverview !== null;
  const delivery = useDelivery();
  // An attached image routes THIS submission to the vision model (Flue reads
  // the model when the submission starts, so the image turn itself switches).
  const hasImage =
    delivery.kind === "user" && (delivery.attachments ?? []).some((part) => part.type === "image");
  const selection = coordinatorModelSelection({ isHome, ideationTurnsLeft, hasImage,
    ...(delivery.kind === "user" ? { request: delivery.body } : { execution: true }),
  });
  const selectedRole = selection.role;
  const modelRoute = findModelRouteForRole(selectedRole);
  // Context hygiene: compact past a bounded budget, not at the 1M window.
  useModel(modelRoute.specifier, { thinkingLevel: ROLE_THINKING[selectedRole], compaction: compactionFor(modelRoute) });
  const { context, resolve } = scopedCoordinatorContext(env, id, snapshot);
  const [lastUserRequest, setLastUserRequest] = usePersistentState(
    "last-user-request",
    "",
  );
  const [homeDeliverySequence, setHomeDeliverySequence] = usePersistentState("home-delivery-sequence", 0);
  // The person's own recent messages, so the project card only quotes what
  // they actually wrote (shared/owner-words.ts).
  const [saidByOwner, setSaidByOwner] = usePersistentState<string[]>("said-by-owner", []);
  const [continuations, setContinuations] = usePersistentState(
    "build-continuations",
    0,
  );
  // Which feature the continuation budget is being spent on (per-feature reset).
  const [continuationFocus, setContinuationFocus] = usePersistentState("build-continuation-focus", "");
  // The design brief has the same save-or-stop contract as the PRD; keep its
  // retry budget separate so a design miss cannot consume the build's budget.
  const [designContinuations, setDesignContinuations] = usePersistentState(
    "design-continuations",
    0,
  );
  const [designContinuationFocus, setDesignContinuationFocus] = usePersistentState(
    "design-continuation-focus",
    "",
  );
  const [looksContinuations, setLooksContinuations] = usePersistentState(
    "looks-continuations",
    0,
  );
  const [looksValidationFailures, setLooksValidationFailures] = usePersistentState("looks-validation-failures", 0);
  let observedLookFailures = looksValidationFailures;
  const savePlanNote = guardPlanWrites({
    failures: () => observedLookFailures,
    remember: count => { observedLookFailures = count; setLooksValidationFailures(count); },
    write: context.writePlanNote,
    block: context.blockBuild,
  });
  const [looksContinuationFocus, setLooksContinuationFocus] = usePersistentState(
    "looks-continuation-focus",
    "",
  );
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
  // Live progress while find_hackathons runs (review 2026-10-28): one write
  // per REAL stage the server reaches, so the person sees what is happening
  // instead of a minute of "Searching…". The client shows only the latest.
  const writeDiscoveryProgress = useDataWriter("discoveryProgress", {
    schema: v.object({
      stage: v.picklist(["sources", "rules", "ranking"]),
      text: v.pipe(v.string(), v.maxLength(200)),
    }),
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
      status: v.picklist(['pending', 'approved', 'rejected', 'expired']),
    }),
  });
  // No useSandbox: native tools would be inherited by QA and bypass role
  // boundaries. All filesystem and execution effects use scoped host tools.
  if (!snapshot || context.homeOverview === null) {
    for (const declaration of buildSpecialistDeclarations({ ...context, writePlanNote: savePlanNote, currentRequest: delivery.kind === "user" ? delivery.body : lastUserRequest }))
      useSubagent(declaration);
    // Team mode (part B): the read-only architecture reviewer, on the Ultra
    // `architect` model role. Mounted only when the workflow is team-mode and
    // the host provides the record hook; with team mode off it is absent.
    if (context.teamMode === true && context.recordArchitectureReview)
      useSubagent(architectDeclaration({ readPlanNote: context.readPlanNote, recordArchitectureReview: context.recordArchitectureReview }));
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
    // Owner 2026-10-29: the coordinator's chat model is not the author of the
    // plan, the looks or the design — the specialists run on the routes chosen
    // for that work (product → planAuthor, designer → designAuthor). A model
    // check found the coordinator writing the PRD itself on the chat route, so
    // its own write_plan_note now refuses those kinds and says who writes them.
    useTool(makeWritePlanNote({ writePlanNote: async (input) => {
      const author = SPECIALIST_AUTHORED[input.kind];
      if (author) throw new Error(`SPECIALIST_REQUIRED: not saved — ${author} writes the ${input.kind === "prd" ? "plan" : input.kind}. Delegate it with a complete task (the full brief, the user's feedback, and every refusal or reviewer finding from the last attempt) and let the specialist save it with write_plan_note.`);
      return savePlanNote(input);
    }, authorRouteId: modelRoute.id }));
    useTool(makeVerifyBuild({ verify: context.verifyBuild }));
    // The host-driven feature loop: the host says which feature is next and
    // decides when it is done (green checks + new passing tests + save point).
    useTool({
      name: "build_next_feature",
      description:
        "During an approved build, get the ONE feature to build next (its id, title and doneWhen checks) from the host. Features are built one at a time in plan order; call this before delegating any implementation.",
      input: v.object({}),
      async run() {
        const result = await context.buildNextFeature();
        setStoredContext(coordinatorSnapshot(id, await resolve()));
        return { output: JSON.stringify(result) };
      },
    });
    useTool({
      name: "finish_feature",
      description:
        "Ask the host to finish the current feature: it runs the project checks, requires new passing tests for this feature, and saves a checkpoint the user can roll back to. Only the feature build_next_feature returned can be finished.",
      input: v.object({ featureId: v.pipe(v.string(), v.minLength(1), v.maxLength(48)) }),
      async run(ctx) {
        const result = await context.finishFeature(ctx.data.featureId, ctx.toolCallId, ctx.signal);
        setStoredContext(coordinatorSnapshot(id, await resolve()));
        return { output: JSON.stringify(result) };
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
    // A fresh search measured ~55–65s (2026-10-28). Bound the whole call so a
    // stall settles as a visible tool error instead of an open-ended turn.
    timeoutMs: 120_000,
    async run(ctx) {
      const steps: string[] = [];
      // "My first hackathon" is in the PERSON's words; the model rightly drops
      // it from the narrowing query, so read it from the message itself.
      const request = delivery.kind === "user" ? delivery.body : lastUserRequest;
      const result = await context.discover(ctx.data, {
        firstTimer: /\b(?:first|beginner|new to (?:this|hackathons|coding|building))\b/i.test(request),
        onProgress: (progress) => {
          steps.push(progress.text);
          writeDiscoveryProgress(progress);
        },
      });
      // Emit the structured card from the REAL result (buildHackathonResultsCard
      // documents the honesty rules of the mapping) — never model-authored text.
      const card = buildHackathonResultsCard(result as DiscoveryResultForCard);
      writeHackathons(card);
      const candidates = card.candidates;
      // The closing sentence is written HERE from the real counts, and the
      // model must use it word for word (review 2026-10-28: it once told the
      // user "all eight" had eligibility checks when only three did).
      const reply = discoveryReply(candidates.length);
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
          reply,
          // What the search did, in plain words — shown in the chat's work
          // summary (this output is saved with the message).
          steps: [...steps, `Found ${candidates.length} open ${candidates.length === 1 ? 'hackathon' : 'hackathons'}`],
          instruction:
            `The hackathon card is already shown to the user. Your whole reply must be exactly this sentence, word for word, with nothing before or after it: "${reply}" Do not describe, count, list or summarise the events, and do not say anything about how many were checked; the card says that. ` +
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
      if ((details as { found?: unknown } | null)?.found !== false)
        setIdeationTurnsLeft(IDEATION_TURN_WINDOW);
      return { output: JSON.stringify(details) };
    },
  });
  useTool({
    name: "start_brainstorm",
    description:
      "Call when the user wants to work out WHAT to build — they ask for project ideas, say \"let's brainstorm\", pick a track, or describe a problem they want to solve — and no project idea has been settled yet. It gives the next replies more careful thinking; it creates nothing and shows nothing. Call it once per brainstorm, then follow the IDEATION rule in the same reply. For an existing project, call it only to explore product ideas or scope tradeoffs, never for routine status or implementation. Exploring alternatives does not approve a scope change.",
    input: v.object({}),
    async run() {
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
      // Part A step 6: the card carries NO model-chosen number. The spending
      // limit the user sees is the build's own D4 limit, shown on the build
      // card (ApprovalCard shows the server-backed approval, not a cap the
      // model invented).
      writeApprovalCard({
        approvalId: approval.id,
        projectId: data.projectId,
        what: data.what,
        status: 'pending',
      });
      return `Approval requested (id ${approval.id}). The user decides with the card in the chat; do not proceed until the server records the decision.`;
    },
  });
  useTool({
    name: "propose_project",
    description:
      "Propose ONE new project as a card in this chat, once the user has agreed on a specific idea. This creates NOTHING: the card shows the name, the idea, the hackathon and track and what to build first, and the project is created only if the user presses its \"Start this project\" button (\"Keep refining\" creates nothing). Never call it while you are still brainstorming or narrowing down, never call it twice for the same idea, and never say a project was created or started. When the hackathon's rules name what entries must use, pass that rule word for word as requiredTech. Fill audience (who it's for) and problem (what goes wrong for them today) ONLY with a phrase copied exactly from the person's own messages — never reworded, never with details they did not say; leave a field out when they did not say it (the card shows these in quotation marks, and a reworded quote is dropped). The idea and firstStep are for the person: plain words on what the app does for them and what they will be able to do first (e.g. 'Log today's feed, eggs and dead birds from your phone'), never a framework, language, database, storage, hosting, API or AI-model name and never words like scaffold, stub or endpoint; those go in the brief.",
    input: v.object({
      name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
      idea: v.pipe(v.string(), v.minLength(1), v.maxLength(600)),
      brief: v.pipe(v.string(), v.minLength(1), v.maxLength(16000)),
      hackathonTitle: v.optional(v.string()),
      hackathonUrl: v.optional(v.string()),
      track: v.optional(v.string()),
      firstStep: v.optional(v.string()),
      // The hackathon's own rule naming what entries must use, quoted word for
      // word from its rules (plan 4.2); left out when it has none.
      requiredTech: v.optional(v.pipe(v.string(), v.maxLength(600))),
      // Who it's for and the problem it solves, in the person's own words from
      // this conversation, as they said them, not rewritten (plan 4.3).
      audience: v.optional(v.pipe(v.string(), v.maxLength(400))),
      problem: v.optional(v.pipe(v.string(), v.maxLength(400))),
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
      if (authority.homeOverview !== null && (authority.existingProjectCount ?? 0) > 0 && original && refersToExistingWork(original)) {
        return {output:'The owner is referring to existing work. Do not propose another project. Ask which project they mean if it is ambiguous, then use continue_project with their original request.'};
      }
      // Mid-brainstorm, the latest message is a reaction ("1 and 3 are the
      // most realistic"), not the request — prefixing it made it the first
      // line of the saved brief. Only a direct request is kept verbatim.
      const brainstorming = ideationTurnsLeft > 0;
      const { app, audience, problem, ...proposalInput } = ctx.data;
      // Quoted on the card as the person's words: only when they wrote them.
      const said = original ? [...saidByOwner, original] : saidByOwner;
      const ownAudience = ownWordsOrNothing(audience, said);
      const ownProblem = ownWordsOrNothing(problem, said);
      const proposal = await authority.proposeProject({
        ...proposalInput,
        ...(ownAudience ? { audience: ownAudience } : {}),
        ...(ownProblem ? { problem: ownProblem } : {}),
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
    name: "project_status",
    description:
      "Read how one of the person's own projects is going (its stage, the latest from its build, how many features are done) without changing anything. Call it whenever they ask about a project's progress, before you answer; never guess. Takes an id from the list of existing projects.",
    input: v.object({ projectId: v.string() }),
    async run(ctx) {
      const authority = await resolve();
      return { output: JSON.stringify(await authority.projectStatus({ projectId: ctx.data.projectId })) };
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
    ctx.log.info("caddie.model_selection", { role: selection.role, reason: selection.reason, routeId: findModelRouteForRole(selection.role).id });
    const authority = await resolve();
    setStoredContext(coordinatorSnapshot(id, authority));
    setContinuations(0);
    setDesignContinuations(0);
    setLooksContinuations(0);
    // Every new submission (the owner's Try again, an approval hand-off, a
    // message) opens a fresh looks repair window; the 3-strike limit still
    // bounds one turn. Reset only on user messages used to strand the step:
    // an owner Try again is a host hand-off, so after one failed attempt
    // every later save was refused unread with LOOKS_REPAIR_LIMIT
    // (EggOps Nigeria, 2026-10-30: three retries, each wasted).
    observedLookFailures = 0;
    setLooksValidationFailures(0);
    if (delivery.kind === "user") {
      setLastUserRequest(delivery.body);
      setSaidByOwner(rememberSaid(saidByOwner, delivery.body));
      // One user turn spent from the brainstorm window (this turn's model was
      // already chosen at submission start, so this only affects later turns).
      setIdeationTurnsLeft((left) => selection.reason === "execution_request" ? 0 : (selectedRole === "ideation" && left === 0 ? IDEATION_TURN_WINDOW - 1 : Math.max(0, left - 1)));
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
    setStoredContext(coordinatorSnapshot(id, authority));
    if (authority.homeOverview !== null) return;
    const state = await authority.workflowState();
    // A plan in prose is not a saved reviewable revision. Both planning and
    // building must advance their durable state or stop with a real blocker.
    if (state.phase === "planning") {
      if (continuations >= 2) {
        await authority.blockBuild("Caddie couldn’t finish your plan this time. Nothing is lost — tap Try again.");
        return;
      }
      setContinuations((n) => n + 1);
      ctx.append({ kind: "signal", type: "plan_incomplete", body: "Planning is unfinished: the host has NOT received a new PRD revision — nothing was saved, and the workflow phase is still 'planning', NOT 'review'. Do NOT tell the user a plan or revision was saved, written, updated or is awaiting review; that is FALSE right now and must not be said. A delegate result of \"(task completed with no text)\" does not prove whether its tools saved work. The host still reports no new published PRD here, so never re-delegate the identical hand-off. Instead, delegate the product specialist again with a COMPLETE task — the full brief, the user's feedback, and the exact refusal or reviewer findings from the last attempt — and tell it to save the full PRD with write_plan_note kind:'prd', then STOP. You cannot save a PRD yourself. write_plan_note returns a line beginning 'SAVED:' only when the host actually recorded the revision; only after you see that, and the next coordinator_context shows phase 'review', may you tell the user the plan is ready. If a real prerequisite is missing, call report_blocker. Until you have the 'SAVED:' confirmation, say Caddie is still working on the plan — never that it is saved or ready." });
      return;
    }
    // A looks proposal in prose is not a saved, reviewable set. The phase only
    // advances to looks-review when a valid caddie-looks note is saved; a turn
    // that settles with no looks would otherwise park the project in 'looks'
    // forever, exactly like the design case below.
    if (state.phase === "looks") {
      const focus = `looks:${state.planId ?? "none"}`;
      const used = focus === looksContinuationFocus ? looksContinuations : 0;
      const continuationLimit=authority.repairModelRouteId?8:2;
    if (used >= continuationLimit) {
        await authority.blockBuild(
          "Caddie couldn’t finish the look options this time. Your plan is safe — tap Try again.",
        );
        return;
      }
      setLooksContinuationFocus(focus);
      setLooksContinuations(used + 1);
      ctx.append({
        kind: "signal",
        type: "looks_incomplete",
        body: "The look options are unfinished: the host has NOT received a looks note — nothing was saved, and the workflow phase is still 'looks', NOT 'looks-review'. Do NOT tell the user the looks are ready. A delegate result of \"(task completed with no text)\" or prose without a SAVED: confirmation means nothing was saved — never re-delegate the same empty hand-off expecting a different result. Instead, delegate the designer again with a COMPLETE task (the exact refusal or reviewer findings from the last attempt included) and tell it to save with write_plan_note kind:'looks' — you cannot save looks yourself. The task asks for the same planRevision and exactly 3 looks, each drawn as the real first screen, with the inventory and the caddie-checks block. Only after write_plan_note returns a line beginning 'SAVED:' and the next coordinator_context shows phase 'looks-review' may you tell the user the looks are ready to choose from.",
      });
      return;
    }
    // A design brief in prose is not a saved, reviewable revision. The phase
    // only advances to design-review when a new undecided brief is saved; a
    // turn that settles with no brief would otherwise park the project forever
    // (HerdVoice, 2026-10-20: the designer returned prose, the turn ended, and
    // nothing moved until a person sent a follow-up).
    if (state.phase === "design") {
      const focus = `design:${state.planId ?? "none"}`;
      const used = focus === designContinuationFocus ? designContinuations : 0;
      const continuationLimit=authority.repairModelRouteId?8:2;
    if (used >= continuationLimit) {
        await authority.blockBuild(
          "Caddie couldn’t finish the screen designs this time. Your plan and look are safe — tap Try again.",
        );
        return;
      }
      setDesignContinuationFocus(focus);
      setDesignContinuations(used + 1);
      ctx.append({
        kind: "signal",
        type: "design_incomplete",
        body: "Design is unfinished: the host has NOT received a design brief — nothing was saved, and the workflow phase is still 'design', NOT 'design-review'. Do NOT tell the user the design brief is saved, written or ready. A delegate result of \"(task completed with no text)\" or prose without a SAVED: confirmation means the designer stopped WITHOUT saving — never re-delegate the same empty hand-off expecting a different result. Instead, delegate the designer again with a COMPLETE task (the exact refusal or reviewer findings from the last attempt included) and tell it to save with write_plan_note kind:'design' — you cannot save a design yourself. The task must ask for the same planRevision and the full brief (screen inventory; each key screen's layout and components; tokens and interaction patterns; empty, loading and error states; one titled ```html-mock block per key screen and state). Save ONE complete reviewable design revision, never separate part-numbered revisions: review and build use only the latest revision. If the content is too large, reduce repetition while retaining the complete screen inventory and key screens; do not describe a partial save as ready. The brief MUST carry the chosen look's caddie-theme block unchanged — the host refuses a design with no valid theme, so copy the theme from the chosen look (it is in the coordinator_context for this planRevision) into a ```caddie-theme block in the brief. Only after write_plan_note returns a line beginning 'SAVED:' and the next coordinator_context shows phase 'design-review' may you tell the user it is ready.",
      });
      return;
    }
    // Review, ready and blocked may settle; readiness comes only from the host.
    if (state.phase !== "building") return;
    // The host owns the feature order. The nudge budget is PER FEATURE: a
    // feature that passed is progress, so the next one starts a fresh budget.
    const progress = await authority.featureProgress();
    // Big apps (part P): the parts are being built by their own builders and
    // Caddie messages this conversation when they are joined. Nothing is
    // unfinished here, so settle without a nudge (a nudge would spend the
    // budget and then block a build that is progressing).
    if (progress?.waitingOnParts) return;
    const focus = progress?.current ? `feature:${progress.current.id}` : "verify";
    const used = focus === continuationFocus ? continuations : 0;
    const continuationLimit=authority.repairModelRouteId?8:2;
    if (used >= continuationLimit) {
      await authority.blockBuild(
        progress?.current
          ? `Caddie could not finish “${progress.current.title}” (feature ${progress.current.position} of ${progress.total}). The features before it are saved; retry to continue from this one.`
          : "The build did not produce passing checks and a preview. Your plan and saved work are retained.",
        "nonprogress",
      );
      return;
    }
    setContinuationFocus(focus);
    setContinuations(used + 1);
    ctx.append({
      kind: "signal",
      type: "build_incomplete",
      body: progress?.current
        ? `The build is not finished: feature ${progress.current.position} of ${progress.total}, “${progress.current.title}”, is next. Call build_next_feature, delegate exactly that feature with its doneWhen checks, and have it built to match the approved design brief. Then call finish_feature. ${FEATURE_DELEGATION_RULE} If a prerequisite is unavailable call report_blocker; never claim completion.`
        : "Work is not verified. Call build_next_feature to see what remains; when every feature has passed, run QA with verify_build. If a prerequisite is unavailable call report_blocker; never claim completion.",
    });
  });
  useInstruction(context.actorContext);
  if (context.resumeContext) useInstruction(`Host recovery context (read-only; current host tools remain authoritative): ${context.resumeContext}`);
  if (context.homeOverview) {
    useInstruction(context.homeOverview);
    useInstruction("This is Home coordination. Existing project requests are handed to their project coordinator through continue_project and its in-chat card. A NEW project is only ever proposed with propose_project, as a card the user starts themselves. After handoff acknowledge it briefly and settle; project specialists and verification run in the project conversation. Their absence from Home is intentional, not a blocker. Do not expose internal ids/tool names or contradict the server-backed project card with speculative progress or capability claims.");
  }
  useInstruction(
    `You are Caddie, a helpful assistant for solo builders. Priorities: find suitable hackathons, plan and build new projects, then continue existing projects. Speak in clear user-facing language, never raw internal tool names or opaque ids. The supported proving stack is React + Bun + Hono; the other stacks remain planned. When the user refers to an existing project call continue_project with its actual id from context; never create a duplicate or tell them to navigate first. For a new app, first make sure the user has agreed on a specific idea, then call propose_project with a faithful full brief and a sensible name; the card lets them start it. Nothing is created until they press Start this project. Make a proposal ONLY by calling propose_project, and never write its fields into your reply (not as JSON, a list or a code block): the person sees nothing until propose_project returns. Mention the card only after propose_project has returned in this turn, in one short sentence that does not name a button ("Here's the idea — start it whenever you're ready."): the card changes to "Project started" once they press it, and a line telling them to press Start would then be wrong. If it did not, say the proposal did not go through and offer to try again. Never ask the user to open another page or repeat the request. Profile facts supplied by the host are known; never pretend this is anonymous. Use find_hackathons for actual hackathon results — call it directly for any "find/suggest a hackathon" request, without first asking the user what they like (their saved profile already drives the ranking); explicitly acknowledge when fresh official rules/listings are unavailable. A planning step or greeting is not a completed build. Plan approval does not authorize deployment, purchases, merge, or destructive data changes. If blocked explain the specific prerequisite and stop. A ready workflow means build checks passed, not proof of every real-world outcome.`,
  );
  useInstruction("Caddie serves nontechnical people and technical people short on time. Own setup, task handoffs, tests and repairs. The user describes the outcome, reviews a readable plan, and tries the app. Ask only for product choices or missing information that changes the result; choose sensible defaults for implementation details. Keep tool names, run ids, revision hashes and debugging steps out of normal replies. Keep every reply short: two or three plain sentences, like a friendly text message. When something failed or was refused, never explain the internals (saves, allowances, reviewers, tools, retries, specialists): say in one sentence that it didn't work this time and that the Try again button on the project card will pick it up, then stop. When a plan, looks, design or build is ready, say so in one sentence and point to the card; never list its features, decisions or technical details in the chat, because the card shows them. Keep technical words out too, even when summarizing a plan: say 'installs on your phone like an app' not PWA, 'sample entries' not seeded data, 'spots unusual days' not anomaly detection, and never name frameworks, PRDs, specialists or coordinators unless the user used those words first. Explain progress briefly in terms of the app, and show technical evidence only when requested. Never ask the user to configure the test environment, move between workspaces or pass instructions to specialists. A genuine blocker needs a plain explanation of what is saved, what is incomplete and the specific decision needed. Do not imply the user must repair Caddie. Never describe a generated app as ready until the host-backed workflow publishes its preview.");
  useInstruction("PROJECT IDEATION: you may explore product ideas and scope tradeoffs inside this project without creating another project. Keep its agreed purpose and decisions in context. Any proposed change to approved scope remains a proposal; save a new revision for review before executing it. Do not restart the intake or ask questions already answered in the project context.");
  useInstruction("RESPONSE STYLE: be concise throughout the conversation, not just at the end. For routine progress and completed actions, use one to three short sentences: the result first, then the next useful action if there is one. Do not narrate tool calls, specialist handoffs, schema corrections or recovered retries, and do not restate a card's contents or instructions. Save complete plans, designs and evidence in their proper artifacts rather than pasting them into chat. Acknowledge a saved result only after host confirmation. Keep material limitations, unresolved failures and decisions visible; brevity must never conceal them. Give a fuller explanation when the user asks for one or needs it to make an informed choice. Avoid repeated reassurance, status recaps and unnecessary follow-up questions.");
  useInstruction("Be smart, proactive and personal, but never presumptuous. Lead with what you already know from the host-supplied profile and confirmed memory — default the stack from a stated preference, greet by what you know, and ask only for facts that are genuinely missing and matter to the current choice. When the user tells you something durable about themselves (a skill, a tool preference, how they work), call update_profile or remember so you keep it. When they tell you something lasting about this project (who it is for, what it must do, a decision), call remember with about 'project' so it stays with the project. A memory is a PROPOSAL: tell them you noted it and that it sticks once they confirm; never present a proposed or inferred fact as already saved. You may call inspect_repository to see what the user has already built and offer an observation (\"looks like you work in TypeScript + React — want me to remember that?\"); it records nothing on its own. Never record anything resembling spending or deployment permission as a preference or memory — those remain separate explicit approvals.");
  useInstruction(HACKATHON_HONESTY_INSTRUCTION);
  useInstruction(HACKATHON_FOLLOWUPS_INSTRUCTION);
  useInstruction(HACKATHON_IDEATION_INSTRUCTION);
  useInstruction(PLATFORM_AI_RULE);
  if (context.homeOverview) {
    useInstruction("Your final role is Home intake and handoff. You MUST use continue_project for requested work on a named existing project, passing the full request to its actual id in Home context. That project's coordinator has frontend, QA and the sandbox. You do not execute specialist work here and MUST NOT report those tools as unavailable. If the user asks for technical repairs, forward those requirements intact to the project coordinator; do not evaluate local Home tools as project capabilities.");
  } else {
    useInstruction("HACKATHON RULES IN THE PLAN: when the brief has a 'Required by the hackathon' line, copy it word for word into the PRD under 'Hackathon requirements' and build the plan on it; never drop, soften or swap what it requires. Lines marked 'in their words' (who it's for, the problem) open the PRD's overview exactly as written.");
    useInstruction("For project work: read project context, then DELEGATE the PRD to the product specialist and let it save it (write_plan_note kind:'prd') — do not write the PRD yourself on the first pass: the product specialist runs on the purpose-built plan model, the owner is billed for that route and the independent review is bound to it. The PRD is one cohesive document with user-facing scope, a plain line on who the app is for and where they use it (this drives the look), a demo contract that names the 3-minute judge path and the real integration, and behavior checks, then stop for authenticated review. The PRD does NOT fix colours or fonts — the looks step owns the app's look. A PRD uses the React/Hono recipe; no arbitrary unsupported stacks or IE11 requirement. After approval, build feature by feature: call build_next_feature, delegate exactly that feature with its doneWhen checks to the implementation specialist, then call finish_feature; repeat until the host says every feature passed, then run QA with verify_build to publish a usable preview. " + FEATURE_DELEGATION_RULE + " There is no native shell environment: use the specialists' scoped tools. If a product/designer delegate returns \"(task completed with no text)\", first call project_status for this project and read_project_context to check whether its tools saved a new revision. Empty text alone is not failure. If the host still reports no saved revision, do NOT re-delegate the same empty hand-off: delegate the product specialist again with a complete task that includes the refusal or reviewer findings; only the specialist can save the PRD.");
    useInstruction("SAVED MEANS SAVED: a plan, revision or file exists only when the host CONFIRMS it — write_plan_note returning a line that begins 'SAVED:', AND the workflow phase in coordinator_context being 'review' (not 'planning'). A specialist describing what it saved, a PRD you printed in chat, or a task result of \"(task completed with no text)\", is NOT proof; never tell the user something was saved, written, updated or is ready for review on that basis. While the phase is still 'planning' the plan is NOT saved — say Caddie is still working on it, never that it is ready. Only after you have the 'SAVED:' confirmation and the phase has moved to 'review' may you say the plan is ready to review.");
    useInstruction(`DEMO CONTRACT: completeness is not the bar — a judge watching for three minutes is. Every PRD must carry this section before the feature list, and the host refuses a PRD without one. ${DEMO_CONTRACT_GUIDE} The real integration must carry the core value, not decorate it: no Ollama, local model or third-party AI key, and a mock (price feed, seed data, rule table) may support the demo but never be the reason it is impressive. Order the features so the demo path is buildable end to end, and cut any feature that would not appear in the demo.`);
    useInstruction(`FEATURE LIST: every PRD you save must list what will be built, so the user approves exactly that list and the host builds it one feature at a time. ${FEATURE_BLOCK_GUIDE} Order features so each builds on the last; keep each one small enough to finish and test on its own; write doneWhen checks as behaviors a person could see. write_plan_note refuses a PRD without a valid list.`);
    useInstruction("COMPREHENSIVE PRD, FIRST PASS: write the whole thing before saving — the user must never have to ask for the schema, then say 'not comprehensive', then 'still ambiguous'. Every PRD covers, as explicit sections: overview + goals/non-goals; user stories/flows; a DATA MODEL with every entity's fields, types, keys and relations (money as integer minor units, never a float); the API surface (Hono routes in/out) or an explicit 'local-only, no server API'; the frontend screens + key components with each loading/empty/error state; offline/sync (what's stored locally, what syncs, the conflict rule) when it is a PWA/offline app; the AI the app relies on with its call path and fail-soft behavior, in the owner's words (\"Caddie's AI\", \"(a deep answer)\") — never a model, provider or tier name; and observable success metrics. Where the brief lacks a detail, choose a sensible default and label it 'assumption:' so the user corrects one line — do NOT leave a section blank, do NOT drip-feed depth across turns, and do NOT stop to ask one question at a time.");
    // Owner 2026-10-29: the looks ARE the design (one step, machine-checked).
    // The full guide and example live with the designer, not here.
    useInstruction("LOOKS STEP: after the PRD is approved the phase is 'looks' and nothing is approved to build. DELEGATE the designer to save ONE looks proposal (write_plan_note kind:'looks'): exactly 3 looks, each drawn as the app's real first screen, with the screen inventory and the caddie-checks block. The host checks it in code and refuses a save with the exact fixes; if the designer comes back without SAVED:, delegate it again with those fixes, never write the looks yourself. Then STOP: the owner picks a look, and that pick starts the build — there is no separate design brief or design review. Never paste HTML or a mockup into a reply; the project page shows the looks.");
    useInstruction('If a specialist returns REPAIR_ROUTE_CHANGED or a technical task fails/returns empty during a build, call build_next_feature and delegate the current feature again with the refreshed host-selected model. Never treat that internal hand-off as a user blocker. If a specialist task times out, call build_next_feature to refresh the host recovery context and model route. Continue the same feature only while the host allows it. Never open another admission or ask the owner to debug a timeout. Pending writes must be reconciled by their original operation keys before another writer.');
    useInstruction("LEGACY DESIGN STEP: a project already in the 'design' phase (chosen before looks became the design) still needs ONE design brief from the designer (write_plan_note kind:'design') carrying the chosen look's caddie-theme block unchanged; then STOP for the owner's design review.");
    // Team mode (part B/C): the design document also carries the
    // caddie-architecture block v2, so there is one approval and one revision
    // hash for the brief and the architecture. Caddie's deterministic rules and
    // the architecture review gate the design, so the block must be correct and
    // safe before it can be approved. With team mode off this is never added.
    if (context.teamMode === true) {
      useInstruction(TEAM_MODE_DESIGN_INSTRUCTION);
      if (context.bigApps === true) useInstruction(TEAM_MODE_BIG_APPS_DESIGN_INSTRUCTION);
      useInstruction(TEAM_MODE_REVIEW_LOOP_INSTRUCTION);
    }
  }
  // Owner 2026-10-30: mid-build chat read "Feature 4 is the AI tip feature —
  // the core demo value. Let me start with the frontend, defining the server
  // contract." The build card already shows which part is being built.
  if (!context.homeOverview) useInstruction(BUILD_QUIET_RULE);
  // Last on purpose: every reply is read by a non-technical person first
  // (owner 2026-10-29, "too technical/verbose for the target audience").
  useInstruction(VOICE_RULE);
  return "Caddie helps solo builders discover, plan, build, verify and share software through one continuous conversation.";
}
// Explicit submission bound (see COORDINATOR_DURABILITY): Flue aborts and
// settles a submission past timeoutMs; the app's stall watchdog reports it.
Coordinator.durability = { ...COORDINATOR_DURABILITY };
