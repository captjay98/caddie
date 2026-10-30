import { boundedProvider } from './bounded-provider.ts';
import { setProvider } from '@flue/runtime';
import {
	createProvider,
	envApiKeyAuth,
	type ThinkingLevel,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

/**
 * P05 providers — Nebius Token Factory registration with the EVALUATED
 * compatibility options (adjudication carry-in; see docs/flue-contracts.md):
 * supportsDeveloperRole:false / supportsStore:false / maxTokensField:"max_tokens"
 * — TF 422s the OpenAI `developer` role without the block.
 *
 * Registration happens once per isolate via `registerNebiusProvider()`; the
 * app entry (app.ts) calls it so `flue.config providers` stays built-in-IDs
 * only (custom registration belongs in app.ts — the runtime's documented
 * precedence point). No credential is read here at import time; the env name
 * is declared and resolved lazily by the provider.
 */

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

/** Model routes are FROZEN per run (contracts.md: payer/model/pricing binding). */
export interface ModelRoute {
	id: string;
	/** Full specifier the Flue runtime resolves: provider-prefixed model id. */
	specifier: string;
	providerId: 'nebius';
	modelId: string;
	/** The pricingVersion rows P03 budgets resolve against. */
	pricingVersion: string;
	/**
	 * The single per-Mtok rate the P03 budget ledger reserves against. Nebius
	 * prices input and output ASYMMETRICALLY; the budget schema holds ONE rate
	 * per (route, pricingVersion), so this is set to the OUTPUT (higher) price —
	 * the conservative, fail-closed choice (a reservation can never under-price).
	 * The true input/output split lives in {@link inputPriceMinorUnits} /
	 * {@link outputPriceMinorUnits} and feeds the provider cost registration.
	 */
	unitPriceMinorUnits: number;
	/** True input price per Mtok, minor units (provider cost accounting). */
	inputPriceMinorUnits: number;
	/** True output price per Mtok, minor units (provider cost accounting). */
	outputPriceMinorUnits: number;
	/**
	 * Cached-input price per Mtok, minor units (may be fractional). Taken from
	 * the Token Factory bill (owner, 2026-10-29: cost ÷ usage per cached line).
	 * The old flat "input ÷ 10" under-counted Super VL's cached tokens by half,
	 * and cached tokens were its biggest line ($13.47 of $58.84). Absent = the
	 * full input price, which can only over-count.
	 */
	cacheReadPriceMinorUnits?: number;
	currency: string;
	/** Max input context the model accepts (tokens). */
	contextWindow: number;
	/**
	 * Default completion cap. Nemotron Nano/Ultra are REASONING models that
	 * spend tokens thinking before any output — a tight cap returns empty, so
	 * routes used for real replies carry a generous cap (LIVE VERIFIED Stage 1).
	 */
	maxTokens: number;
}

/**
 * The price list every route below is priced against. Bump this whenever a
 * price changes: it travels onto each run binding at creation (P03 keys budget
 * rows per (route, pricingVersion)), so a binding keeps the version it was
 * created under and a re-price never silently rewrites history.
 *
 * '2026-10-nemotron-tier' was the first Nemotron tier, priced from
 * cookbook/aggregator figures. '2026-10-nemotron-listing' is every value
 * re-read from `GET /v1/models?verbose=true` on 2026-10-18 (execution-ledger
 * G1) and applied on 2026-10-19. The OLD string still lives in bindings created
 * before that date — deliberately, and that is all it is: the old *prices* are
 * no longer in this registry, so a settlement that resolves prices by route id
 * today charges today's prices. Nothing reserves budget yet (see
 * `reserveBudget`'s missing callers), so no stored run is mis-settled by it.
 */
export const PRICING_VERSION = '2026-10-nemotron-listing';

/**
 * The verified NVIDIA Nemotron tier on Nebius Token Factory (every id + that it
 * serves confirmed by a live probe 2026-10-12; the exact ids are case-sensitive
 * and differ from the marketing names). Prices are minor units per Mtok and
 * carry {@link PRICING_VERSION}.
 *
 * Role assignment is NOT encoded on the route (a route is a priced model, not a
 * role); {@link MODEL_ROLES} maps roles → route ids so one model can serve
 * several roles and a re-route is a one-line change.
 */
export const MODEL_ROUTES: readonly ModelRoute[] = [
	{
		id: 'deepseek-v4.1-flash-1017', specifier: 'nebius/deepseek-ai/DeepSeek-V4.1-Flash-1017', providerId: 'nebius',
		modelId: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', pricingVersion: '2026-10-25-repair-catalog',
		unitPriceMinorUnits: 120, inputPriceMinorUnits: 30, outputPriceMinorUnits: 120,
		cacheReadPriceMinorUnits: 0.64, // bill 2026-10-29: $0.08 / 12.56M cached
		currency: 'usd', contextWindow: 1048576, maxTokens: 32768,
	},
	{
		id: 'glm-5.3', specifier: 'nebius/zai-org/GLM-5.3', providerId: 'nebius',
		modelId: 'zai-org/GLM-5.3', pricingVersion: '2026-10-25-repair-catalog',
		unitPriceMinorUnits: 440, inputPriceMinorUnits: 140, outputPriceMinorUnits: 440,
		cacheReadPriceMinorUnits: 26, // bill 2026-10-29: $0.59 / 2.27M cached
		currency: 'usd', contextWindow: 1024000, maxTokens: 32768,
	},
	{
		// Frontier judgment for ideation only (the 30-turn Home brainstorm
		// window; chat and vision moved to Super VL on 2026-10-18). The G1
		// listing raised its context to 1,048,576 — the code carried the 3.x
		// 262,144 — and priced it $1.00/$3.00 per Mtok, which this entry now
		// carries too (re-priced under '2026-10-nemotron-listing' on
		// 2026-10-19; the old '2026-10-nemotron-tier' string survives only in
		// run bindings created before that date, which is what the field is for).
		id: 'nemotron-3-ultra',
		specifier: 'nebius/nvidia/Nemotron-3-Ultra-550b-a55b',
		providerId: 'nebius',
		modelId: 'nvidia/Nemotron-3-Ultra-550b-a55b',
		pricingVersion: PRICING_VERSION,
		unitPriceMinorUnits: 300, // output $3.00/Mtok (budget ceiling)
		inputPriceMinorUnits: 100, // $1.00/Mtok
		outputPriceMinorUnits: 300, // $3.00/Mtok
		cacheReadPriceMinorUnits: 12, // bill 2026-10-29: $0.84 / 7.03M cached
		currency: 'usd',
		contextWindow: 1048576,
		// Owner 2026-10-25: max reasoning effort (ROLE_THINKING) needs output
		// headroom — at 8192 the model spent the WHOLE cap on reasoning and
		// returned empty (model_call_usage shows delegate calls cut at exactly
		// 8192). A cap is a ceiling, not a spend.
		maxTokens: 32768,
	},
	{
		// Balanced 3.x mid tier — superseded as the chat route by Super VL
		// (2026-10-18) but RETAINED: stored run bindings and older tests refer to
		// this id, and a removed route would fail closed on lookup. Re-priced
		// $0.08/$0.45 → $0.30/$0.90 on 2026-10-19 from the G1 listing (its
		// 262,144 context the listing confirms unchanged).
		id: 'nemotron-3-super',
		specifier: 'nebius/nvidia/nemotron-3-super-120b-a12b',
		providerId: 'nebius',
		modelId: 'nvidia/nemotron-3-super-120b-a12b',
		pricingVersion: PRICING_VERSION,
		unitPriceMinorUnits: 90, // output $0.90/Mtok (budget ceiling)
		inputPriceMinorUnits: 30, // $0.30/Mtok
		outputPriceMinorUnits: 90, // $0.90/Mtok
		currency: 'usd',
		contextWindow: 262144,
		maxTokens: 4096,
	},
	{
		// Nemotron 3.5 Super VL — the 3.5-tier generalist, and the first Nebius
		// route this project has seen that genuinely accepts IMAGE input. G1
		// probe 2026-10-18: a split red/blue PNG plus a `remember` tool returned
		// HTTP 200, both colours named, and the tool call (711 in / 260 out,
		// 1267 ms). That supersedes the 2026-10-15 note on the GLM entry below
		// that every Nemotron route 400s images — true of the 3.x ids, not this
		// one. Id spelling is the listing's (`3.5`, a dot); prices and context
		// are the listing's too (GET /v1/models?verbose=true, 2026-10-18).
		id: 'nemotron-3.5-super-vl',
		specifier: 'nebius/nvidia/Nemotron-3.5-Super-VL',
		providerId: 'nebius',
		modelId: 'nvidia/Nemotron-3.5-Super-VL',
		pricingVersion: PRICING_VERSION,
		unitPriceMinorUnits: 90, // output $0.90/Mtok (budget ceiling)
		inputPriceMinorUnits: 30, // $0.30/Mtok
		outputPriceMinorUnits: 90, // $0.90/Mtok
		cacheReadPriceMinorUnits: 6, // bill 2026-10-29: $13.47 / 224.48M cached
		currency: 'usd',
		contextWindow: 1048576,
		// Chat, vision and appSuper all share this route, so the cap has to
		// cover a coordinator turn with tool calls AND a vision reply. It is a
		// 3.5-tier reasoning model: the cap is not spend, and a tight one
		// returns a truncated or empty reply (the Nano note, re-observed on
		// Lightning in the same probe). Raised 8192 → 32768 with max reasoning
		// effort: five build-delegate calls hit the 8192 cap mid-reasoning and
		// returned "(task completed with no text)" — the Farmhand feature-1
		// blocker (model_call_usage, 2026-10-25).
		maxTokens: 32768,
	},
	{
		// Nemotron 3.5 Lightning — the cheap 3.5-tier model (helper calls, and
		// AI inside generated apps). G1 probe 2026-10-18: the rules-reading
		// system prompt on a short excerpt at temperature 0 answered HTTP 200
		// but hit the probe's 512-token cap (323 in / 512 out) and returned no
		// parseable `{"claims":[...]}` — the same failure mode the Nano entry
		// documents, so the cap stays generous. Id spelling is the listing's
		// (`3_5`, an underscore — it differs from Super VL's dot).
		id: 'nemotron-3.5-lightning',
		specifier: 'nebius/nvidia/Nemotron-3_5-Lightning',
		providerId: 'nebius',
		modelId: 'nvidia/Nemotron-3_5-Lightning',
		pricingVersion: PRICING_VERSION,
		unitPriceMinorUnits: 24, // output $0.24/Mtok (budget ceiling)
		inputPriceMinorUnits: 6, // $0.06/Mtok
		outputPriceMinorUnits: 24, // $0.24/Mtok
		currency: 'usd',
		contextWindow: 1048576,
		// Raised 4096 → 8192: the app role runs at max reasoning effort now; a
		// tight cap on a reasoning model returns empty (same failure class).
		maxTokens: 8192,
	},
	{
		// Small/fast/cheap reasoning model — bounded helper calls (discovery query
		// shaping, research summarization). Generous maxTokens: it is a reasoning
		// model and a tight cap returns empty output (LIVE VERIFIED Stage 1).
		// Retained because stored run bindings name this id, and it is the
		// `helper` route again as of 2026-10-19 (see that role's note: Lightning
		// failed the rules-reading probe). Re-priced $0.05/$0.20 → $0.06/$0.24 on
		// 2026-10-19 from the G1 listing. maxTokens raised 2,048 → 8,192 the same
		// day: at 2,048 the probe's own run hit the cap mid-reasoning and
		// returned EMPTY content (9,270 chars of `reasoning_content`, no answer)
		// on a 3,772-char excerpt, which is the failure this comment always
		// warned about. The cap is a ceiling, not a spend: it costs nothing
		// unless the model actually needs the tokens, and needing them is the
		// point. Nano's output rate is $0.24/Mtok, so even a full 8,192-token
		// answer is ~$0.002.
		id: 'nemotron-3-nano',
		specifier: 'nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
		providerId: 'nebius',
		modelId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
		pricingVersion: PRICING_VERSION,
		unitPriceMinorUnits: 24, // output $0.24/Mtok (budget ceiling)
		inputPriceMinorUnits: 6, // $0.06/Mtok
		outputPriceMinorUnits: 24, // $0.24/Mtok
		currency: 'usd',
		contextWindow: 262144,
		maxTokens: 8192,
	},
	{
		// VISION route — image input. LIVE VERIFIED 2026-10-15 on this account:
		// GET /v1/models + one chat completion per served model with a split
		// red/blue PNG and a `remember` tool. Nebius 400s image input on every
		// 3.x Nemotron route ("This model does not support image input"), Qwen3.5
		// and GLM-5.3. GLM-5.3-Flash read both halves AND emitted the tool call
		// (7.0s). Kimi-K3 also passed (faster) but is $3/$15 per Mtok; Gemma 3
		// 27B claimed a save without calling the tool; MiniCPM-V rejects auto
		// tool choice; the original Qwen2.5-VL id is not served at all.
		// 2026-10-18 correction: the 3.5 generation changed the Nemotron half of
		// that negative — `nvidia/Nemotron-3.5-Super-VL` read the same split PNG
		// and returned the tool call (1267ms). The 3.x ids still 400. Super VL
		// now drives the `vision` role; this route stays in VISION_ROUTE_IDS
		// because it demonstrably accepts images too.
		// Pricing: Nebius cookbook listing $0.15 in / $0.50 out per Mtok
		// (Sept 2026) — re-verify against the Nebius price page. Re-checked
		// 2026-10-18 against GET /v1/models?verbose=true: $0.15/$0.50 ✓ and
		// unchanged by the 2026-10-19 re-price. The listing reports its context
		// as 1,024,000 — not 1,048,576 (a round 1000×1024 rather than a power of
		// two) — and the code now carries the listing's figure: a context window
		// that overstates the truth is the one direction that silently sends a
		// prompt the model cannot hold.
		id: 'glm-5.3-flash',
		specifier: 'nebius/zai-org/GLM-5.3-Flash',
		providerId: 'nebius',
		modelId: 'zai-org/GLM-5.3-Flash',
		pricingVersion: PRICING_VERSION,
		unitPriceMinorUnits: 50, // output $0.50/Mtok (budget ceiling)
		inputPriceMinorUnits: 15, // $0.15/Mtok
		outputPriceMinorUnits: 50,
		cacheReadPriceMinorUnits: 3, // bill 2026-10-29: $0.63 / 20.99M cached
		currency: 'usd',
		contextWindow: 1024000,
		// A plan revision is ~3.5k reasoning tokens + the whole PRD inside the
		// write_plan_note call. LIVE VERIFIED 2026-10-15: at 4096 the FarmLog AI
		// revision stopped at finish=length before the tool call (nothing saved,
		// six attempts, "task completed with no text"); at 16384 the same request
		// finished with the call (8231 tokens, 18910-char PRD). 32768 leaves room
		// for longer plans. This is a cap, not a spend: billing is per token used.
		maxTokens: 32768,
	},
	{
		// Owner routing decision 2026-10-27 (after the model-role comparison in
		// docs/evidence/2026-10-27-model-role-comparison/): the design/look
		// AUTHOR route. Catalog checked live 2026-10-27 (tokenfactory
		// models_info): image2text (text+image in), function calling + reasoning,
		// context up to 1M. Priced $0.15 in / $0.60 out per Mtok; the catalog's
		// cached rate stays in the plan until a receipt shows cache accounting.
		// The vendor's video claim is NOT carried: the provider listing checked
		// here does not advertise video. Not in VISION_ROUTE_IDS — no Caddie
		// flow sends it images today; widening that is a separate decision.
		id: 'minimax-m3.1-flash',
		specifier: 'nebius/MiniMaxAI/MiniMax-M3.1-Flash',
		providerId: 'nebius',
		modelId: 'MiniMaxAI/MiniMax-M3.1-Flash',
		pricingVersion: '2026-10-27-nebius-catalog',
		unitPriceMinorUnits: 60, inputPriceMinorUnits: 15, outputPriceMinorUnits: 60,
		cacheReadPriceMinorUnits: 1.5, // bill 2026-10-29: $0.17 / 11.31M cached
		currency: 'usd',
		contextWindow: 1048576,
		// Cap headroom rule (owner 2026-10-25): max reasoning effort needs a
		// generous ceiling; the calibration probes ran 16384 cleanly.
		maxTokens: 32768,
	},
];

/**
 * Role → route id. The one place that assigns models to jobs; call sites resolve
 * their role here rather than hard-coding a route id, so re-routing a role is a
 * one-line change. Every value MUST be a route id present in {@link MODEL_ROUTES}
 * ({@link findModelRouteForRole} throws otherwise — fail closed).
 */
export const MODEL_ROLES = {
	/** Caddie chat / coordinator. Super VL is the 3.5-tier generalist: one price
	 *  step above the cheap tier and two below Ultra's $1.00/$3.00, and it is
	 *  also the one Nebius route that takes image input, so a text turn and a
	 *  screenshot turn share it. The strict "present only tool results"
	 *  instruction is what stops hallucinated listings — the frontier model
	 *  reasoned on every trivial turn (slow, ~5× cost) and did NOT fix that,
	 *  because it was always a missing-instruction bug. */
	chat: 'nemotron-3.5-super-vl',
	/** Brainstorming WHAT to build (Home chat only, a bounded window of turns —
	 *  see {@link coordinatorModelRole}). This is where judgment pays: asking
	 *  the right questions once, honest critique of ideas, grounding technical
	 *  claims in the rules, and NOT taking "1 and 3" as a chosen idea. Ultra ran
	 *  this same coordinator as the chat model before the switch to the mid tier
	 *  (execution-ledger P05), so its tool-calling here is not new ground. */
	ideation: 'nemotron-3-ultra',
	/** Planning specialists (product, designer, tech-lead — the catalog's
	 *  `planning` skill): the PRD, design and plan of record. Kept as its own
	 *  role so planning can be re-routed in one line. Still GLM-5.3-Flash after
	 *  the 2026-10-20 build re-route: that decision covered implementation, not
	 *  the PRD/design, so planning keeps its 2026-10-15 owner route until a
	 *  separate decision moves it.
	 *
	 *  LEGACY as of the owner routing decision 2026-10-27: the product/PRD and
	 *  design/look authors moved to the dedicated {@link planAuthor} and
	 *  {@link designAuthor} roles below; `plan` remains for historic run
	 *  bindings. Never delete this role. */
	plan: 'glm-5.3-flash',
	/** Owner routing decision 2026-10-27: the PLAN AUTHOR (product / PRD). The
	 *  model-role comparison probes put DeepSeek-V4.1-Flash-1017 ahead on repo/
	 *  terminal tasks at $0.30/$1.20; the author route is recorded per run via
	 *  authorRouteId, and the independent plan reviewer ({@link planReviewer}
	 *  via the quality gate) can never be the same route. */
	planAuthor: 'deepseek-v4.1-flash-1017',
	/** Owner routing decision 2026-10-27: the independent PLAN REVIEWER — full
	 *  GLM-5.3 (text-only), used by artifact-quality for PRD reviews. Never
	 *  route images here, and never let it review a plan it authored (the
	 *  quality gate filters by authorRouteId). */
	planReviewer: 'glm-5.3',
	/** Owner routing decision 2026-10-27: the DESIGN / LOOK AUTHOR — MiniMax
	 *  M3.1-Flash, registered above after the live catalog check. Its
	 *  screenshot-review probe is not proof of design-authoring quality; the
	 *  end-to-end quality gate decides. The independent DESIGN reviewer is
	 *  deepseek-v4.1-flash-1017 with nemotron-3.5-super-vl as the eligible
	 *  fallback (artifact-quality design ladder) — never MiniMax itself. */
	designAuthor: 'minimax-m3.1-flash',
	/** Implementation + QA specialists (frontend, backend, mobile, qa). Moved
	 *  off GLM-5.3-Flash to Nemotron-3.5-Super-VL on 2026-10-20 (owner
	 *  direction): the cheap Flash route produced small, fixture-shaped apps,
	 *  so the coding/QA loop now runs on the 3.5-tier generalist. Super VL is
	 *  $0.30/$0.90 per Mtok vs Flash's $0.15/$0.50 — roughly 2x/1.8x, paid only
	 *  on build turns. Tool calling is live-verified on this route (G1 probe,
	 *  2026-10-18) and the project RUN BINDING records this route.
	 *  Owner 2026-10-29: the builder moves to MiniMax-M3.1-Flash on 'low' —
	 *  half Super VL's input price, a quarter of its cached price (cached
	 *  context was Super VL's biggest bill line), and Super VL thought for
	 *  7 and 5 minutes in single Farm Ops build calls. Earlier run bindings
	 *  keep the route they recorded. */
	build: 'minimax-m3.1-flash',
	/** Cheap bounded helper calls (query shaping, summarization). LIBERATED AS
	 *  AN EXPERIMENT ON 2026-10-20 (owner asked to try Nemotron-3.5-Lightning)
	 *  and REVERTED AGAIN the same day: on the real rules prompt at temperature
	 *  0 the model returned `finish_reason: length` with no parseable JSON at
	 *  the route's 4,096 cap (1,482 in / 4,096 out), its narration inside
	 *  `content` rather than `reasoning_content` (execution-ledger
	 *  probe-lightning receipt, 2026-10-20); the G1 probe at 512 also failed.
	 *  Nano keeps its reasoning in `reasoning_content` and returns
	 *  claims whose quotes are verbatim in the page — provided the output cap is
	 *  generous, see its entry. Both routes cost the same ($0.06/$0.24), so
	 *  staying on Nano gives up no saving. */
	helper: 'nemotron-3-nano',
	/** Independently evaluable helper tasks. Keep the proven route until a
	 * representative comparison supports changing that particular job. */
	helperRules: 'nemotron-3-nano',
	helperRanking: 'nemotron-3-nano',
	helperSummary: 'nemotron-3-nano',
	/** AI inside generated apps (env.CADDIE.ai, app-ai.ts): a visitor waits on
	 *  every reply, so the fast cheap tier — not a deep reasoning one. Caddie
	 *  pays; each project has a monthly allowance. */
	app: 'nemotron-3.5-lightning',
	/** The deeper tier a generated app may opt into for one call (S04): the
	 *  chat route, at ~3.75× {@link app}'s per-token price ($0.30/$0.90 vs
	 *  $0.06/$0.24), so a project's allowance simply runs out sooner. */
	appSuper: 'nemotron-3.5-super-vl',
	/** Image understanding — Super VL is the only route that passed the
	 *  2026-10-18 G1 image+tool probe (split red/blue PNG: HTTP 200, both
	 *  colours named, `remember` call returned), which is what moved vision off
	 *  GLM. Keep {@link VISION_ROUTE_IDS} in step with this value. */
	vision: 'nemotron-3.5-super-vl',
	/** Software-team mode's architecture review (plan part B): a read-only
	 *  `architect` delegate reads the design's caddie-architecture block and
	 *  records security/advisory findings. This is where judgment on safety
	 *  pays — sign-in, ownership and privacy, key exposure, data loss — so it
	 *  runs on Ultra, the frontier model, like ideation. It has one write tool
	 *  (record_architecture_review) and no sandbox or build tools. Team mode
	 *  only; nothing routes here with teamMode=0. */
	architect: 'nemotron-3-ultra',
} as const satisfies Record<string, string>;

export type ModelRole = keyof typeof MODEL_ROLES;

/**
 * Reasoning effort per role (owner 2026-10-25: "use the maximum reasoning
 * effort available to each model"). This is the single registry; agents pass
 * it to `useModel(specifier, { thinkingLevel })` and specialist declarations
 * carry it on `SubagentDefinition.thinkingLevel`, so the effort follows the
 * ROLE, not the call site. Levels are the pi-ai union
 * (off|minimal|low|medium|high|xhigh|max).
 *
 * LIVE VERIFIED 2026-10-25 (scripts/probe-thinking.ts): all five Nebius
 * routes accept `reasoning_effort` up to `max` with HTTP 200 (Super-VL,
 * Ultra, GLM-5.3-Flash, Lightning, Nano) — so `max` is the maximum
 * AVAILABLE to every model today. The map stays per-role so any future
 * cost/latency tuning is a one-line change here, not a call-site hunt.
 */
export const ROLE_THINKING: Record<ModelRole, ThinkingLevel> = {
	// Owner 2026-10-29 (context hygiene): medium everywhere. 'max' was the
	// 2026-10-25 default; the LIVE probe that day showed MiniMax-M3.1-Flash at
	// 'max' spending all 6,000 tokens thinking (75 s) and returning nothing,
	// while 'medium' returned the full screen in 23 s. Every saved thinking
	// token is also carried in the conversation into the next turn, so the
	// lower level shrinks every later request too.
	chat: 'medium',
	ideation: 'medium',
	plan: 'medium',
	planAuthor: 'medium',
	planReviewer: 'medium',
	// The one exception, on live evidence: MiniMax-M3.1-Flash on the merged
	// looks task (three screens + inventory + browser checks) spent its whole
	// 32,768-token output on reasoning twice in a row at 'medium' and was cut
	// off before writing a byte (Farm Ops, 2026-10-29 17:38Z and 17:53Z).
	designAuthor: 'low',
	// Same evidence for the builder: Nemotron-3.5-Super at 'medium' thought
	// for 437 s and 306 s in single calls (32,768 and 31,602 output tokens,
	// one cut off with nothing written) while its normal calls take 2-20 s
	// (Farm Ops, 2026-10-29 18:22Z and 19:31Z).
	build: 'low',
	helper: 'medium',
	helperRules: 'medium',
	helperRanking: 'medium',
	helperSummary: 'medium',
	app: 'medium',
	appSuper: 'medium',
	vision: 'medium',
	architect: 'medium',
};

/**
 * Context hygiene (owner 2026-10-29: "collapse old tool output"). The routes
 * advertise ~1M-token windows, so Flue's default threshold (window minus 20k)
 * never fired and every coordinator turn carried its whole history — 265k-400k
 * tokens per request (2026-10-28 spend rows). Compact once a conversation
 * passes CONTEXT_BUDGET_TOKENS: older turns, including old tool output, are
 * folded into a summary and the most recent KEEP_RECENT_TOKENS stay verbatim.
 */
// Owner 2026-10-29 bill: 280M Super VL input tokens (cached and not) were
// $30 of $58.84 — every step of a turn re-sends the whole conversation, so the
// conversation's size is the bill. Halved from 120k/30k.
export const CONTEXT_BUDGET_TOKENS = 60_000;
export const KEEP_RECENT_TOKENS = 20_000;
export function compactionFor(route: { contextWindow: number }): { reserveTokens: number; keepRecentTokens: number } {
	return { reserveTokens: Math.max(20_000, route.contextWindow - CONTEXT_BUDGET_TOKENS), keepRecentTokens: KEEP_RECENT_TOKENS };
}

/**
 * How many user turns a brainstorm keeps the deeper `ideation` model after it
 * is entered. A bound, so a conversation that drifts off ideas without a
 * proposal falls back to the fast chat model on its own. Sized to outlast a
 * real brainstorm (who-it's-for → problem → three ideas → narrow → confirm →
 * propose is comfortably 15+ user turns): a window that expires MID-brainstorm
 * drops the deeper model and the fast chat model is markedly worse at not
 * re-asking answered questions — the "lost track" symptom. Any new brainstorm
 * trigger re-arms it to the full window, so it only lapses once a conversation
 * has genuinely moved off ideas.
 */
export const IDEATION_TURN_WINDOW = 30;

/**
 * Which role drives THIS coordinator turn. Flue reads `useModel` when a
 * submission starts and allows the argument to vary render to render from
 * durable state. Ideation follows the task in either conversation; specialists
 * declare their own models. Background execution and routine status questions
 * never inherit a lingering brainstorm window.
 *
 * The immutable run binding records its initial route only. The spending
 * instrument prices each paying build turn from its own requested model, and
 * per-call telemetry records the actual request/response model separately.
 */
export interface CoordinatorModelInput {
	isHome: boolean;
	ideationTurnsLeft: number;
	hasImage?: boolean;
	request?: string;
	execution?: boolean;
}

/** Content-free selection reason; safe to record without logging the request. */
export type CoordinatorSelectionReason = 'image_attachment' | 'background_execution' | 'routine_status' | 'execution_request' | 'explicit_ideation' | 'active_ideation' | 'default_chat';

export function coordinatorModelSelection(input: CoordinatorModelInput): { role: ModelRole; reason: CoordinatorSelectionReason } {
	if (input.hasImage) return { role: 'vision', reason: 'image_attachment' };
	if (input.execution) return { role: 'chat', reason: 'background_execution' };
	const request = input.request?.trim() ?? '';
	if (/^(?:(?:hi|hey)[,! ]+)?(?:where (?:did we stop|are we)|(?:what(?:'s| is)|any) (?:the )?(?:status|progress|update)|(?:is|are) (?:it|we|you|the app|the build) (?:done|ready)|thanks|thank you)[?!. ]*$/i.test(request)) return { role: 'chat', reason: 'routine_status' };
	const explicitIdeation = /\b(?:brainstorm|(?:rethink|explore|compare) (?:the |our |this )?(?:idea|scope|approach|options)|(?:project|app) ideas|what (?:could|should|can) (?:we|I) build)\b/i.test(request);
	if (!explicitIdeation && /^(?:(?:please|yes[,!]?|ok(?:ay)?[,!]?|let['’]s|can you|could you|would you)\s+)*(?:build|implement|fix|repair|resume|continue|start|run|approve|stop|cancel)\b/i.test(request)) return { role: 'chat', reason: 'execution_request' };
	if (explicitIdeation) return { role: 'ideation', reason: 'explicit_ideation' };
	return input.ideationTurnsLeft > 0 ? { role: 'ideation', reason: 'active_ideation' } : { role: 'chat', reason: 'default_chat' };
}

/** Backwards-compatible role-only API used by existing consumers. */
export function coordinatorModelRole(input: CoordinatorModelInput): ModelRole {
	return coordinatorModelSelection(input).role;
}

/** Route ids that accept image input (the vision-capable routes). The one place
 *  that marks a route as a VLM — the ModelCapability contract reads from here.
 *  Two entries, deliberately: the `vision` ROLE is a preference, but both of
 *  these demonstrably read a split red/blue PNG and returned a tool call
 *  (GLM-5.3-Flash 2026-10-15, Super VL 2026-10-18), and dropping GLM here would
 *  assert it cannot see images when it was verified that it can. */
export const VISION_ROUTE_IDS: readonly string[] = ['nemotron-3.5-super-vl', 'glm-5.3-flash'];

/** Whether a route accepts image input (used to pick a vision route for an
 *  image message, and to report the capability honestly). */
export function routeAcceptsImage(modelRouteId: string): boolean {
	return modelRouteId === 'deepseek-v4.1-flash-1017' || VISION_ROUTE_IDS.includes(modelRouteId);
}

/** Resolve a role to its route, fail-closed (unknown role id is a bug, throws). */
export function findModelRouteForRole(role: ModelRole): ModelRoute {
	return findModelRoute(MODEL_ROLES[role]);
}

export function findModelRoute(modelRouteId: string): ModelRoute {
	const route = MODEL_ROUTES.find((route) => route.id === modelRouteId);
	if (!route) {
		throw new Error(
			`unknown model route ${modelRouteId} — routes are frozen; a run may never silently fall back to a different provider or price`,
		);
	}
	return route;
}

let registered = false;

/** Idempotent isolate-level registration of the custom Nebius provider. */
export function registerNebiusProvider(): void {
	if (registered) return;
	registered = true;
	setProvider(
		createProvider({
			id: 'nebius',
			name: 'Nebius Token Factory',
			baseUrl: NEBIUS_BASE_URL,
			auth: { apiKey: envApiKeyAuth('Nebius API key', ['NEBIUS_API_KEY']) },
			models: MODEL_ROUTES.map((route) => ({
				id: route.modelId,
				name: route.modelId,
				api: 'openai-completions',
				provider: 'nebius',
				baseUrl: NEBIUS_BASE_URL,
				reasoning: true,
				input: routeAcceptsImage(route.id) ? ['text', 'image'] : ['text'],
				// pi-ai rates are dollars-per-Mtok; convert each route's true
				// asymmetric minor-unit prices (P03 budget ledger holds the single
				// output ceiling separately in route.unitPriceMinorUnits).
				cost: {
					input: route.inputPriceMinorUnits / 100,
					output: route.outputPriceMinorUnits / 100,
					cacheRead: (route.cacheReadPriceMinorUnits ?? route.inputPriceMinorUnits) / 100,
					// Token Factory bills no separate cache-write line: written
					// tokens are ordinary input.
					cacheWrite: route.inputPriceMinorUnits / 100,
				},
				contextWindow: route.contextWindow,
				maxTokens: route.maxTokens,
				compat: {
					supportsDeveloperRole: false,
					supportsStore: false,
					maxTokensField: 'max_tokens',
				},
			})),
			api: boundedProvider(openAICompletionsApi()),
		}),
	);
}
