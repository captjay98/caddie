import { setProvider } from '@flue/runtime';
import {
	createProvider,
	envApiKeyAuth,
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
 * The verified NVIDIA Nemotron tier on Nebius Token Factory (every id + that it
 * serves confirmed by a live probe 2026-10-12; the exact ids are case-sensitive
 * and differ from the marketing names). Pricing from Nebius/OpenRouter listings
 * for pricingVersion '2026-10-nemotron-tier'. Prices are minor units per Mtok.
 *
 * Role assignment is NOT encoded on the route (a route is a priced model, not a
 * role); {@link MODEL_ROLES} maps roles → route ids so one model can serve
 * several roles and a re-route is a one-line change.
 */
export const MODEL_ROUTES: readonly ModelRoute[] = [
	{
		// Frontier: strong agentic/tool-calling (agentic index 20.1 vs Super 1.7)
		// — the chat coordinator and heavy build/plan reasoning.
		id: 'nemotron-3-ultra',
		specifier: 'nebius/nvidia/Nemotron-3-Ultra-550b-a55b',
		providerId: 'nebius',
		modelId: 'nvidia/Nemotron-3-Ultra-550b-a55b',
		pricingVersion: '2026-10-nemotron-tier',
		unitPriceMinorUnits: 220, // output $2.20/Mtok (budget ceiling)
		inputPriceMinorUnits: 50, // $0.50/Mtok
		outputPriceMinorUnits: 220, // $2.20/Mtok
		currency: 'usd',
		contextWindow: 262144,
		maxTokens: 8192,
	},
	{
		// Balanced mid tier — retained as a fallback / cheaper coordinator option.
		id: 'nemotron-3-super',
		specifier: 'nebius/nvidia/nemotron-3-super-120b-a12b',
		providerId: 'nebius',
		modelId: 'nvidia/nemotron-3-super-120b-a12b',
		pricingVersion: '2026-10-nemotron-tier',
		unitPriceMinorUnits: 45, // output $0.45/Mtok (budget ceiling)
		inputPriceMinorUnits: 8, // $0.08/Mtok
		outputPriceMinorUnits: 45, // $0.45/Mtok
		currency: 'usd',
		contextWindow: 262144,
		maxTokens: 4096,
	},
	{
		// Small/fast/cheap reasoning model — bounded helper calls (discovery query
		// shaping, research summarization). Generous maxTokens: it is a reasoning
		// model and a tight cap returns empty output (LIVE VERIFIED Stage 1).
		id: 'nemotron-3-nano',
		specifier: 'nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
		providerId: 'nebius',
		modelId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
		pricingVersion: '2026-10-nemotron-tier',
		unitPriceMinorUnits: 20, // output $0.20/Mtok (budget ceiling)
		inputPriceMinorUnits: 5, // $0.05/Mtok
		outputPriceMinorUnits: 20, // $0.20/Mtok
		currency: 'usd',
		contextWindow: 262144,
		maxTokens: 2048,
	},
	{
		// VISION route — image input. LIVE VERIFIED 2026-10-15 on this account:
		// GET /v1/models + one chat completion per served model with a split
		// red/blue PNG and a `remember` tool. Nebius 400s image input on every
		// Nemotron route ("This model does not support image input"), Qwen3.5 and
		// GLM-5.3. GLM-5.3-Flash read both halves AND emitted the tool call
		// (7.0s). Kimi-K3 also passed (faster) but is $3/$15 per Mtok; Gemma 3
		// 27B claimed a save without calling the tool; MiniCPM-V rejects auto
		// tool choice; the original Qwen2.5-VL id is not served at all.
		// Pricing: Nebius cookbook listing $0.15 in / $0.50 out per Mtok
		// (Sept 2026) — re-verify against the Nebius price page.
		id: 'glm-5.3-flash',
		specifier: 'nebius/zai-org/GLM-5.3-Flash',
		providerId: 'nebius',
		modelId: 'zai-org/GLM-5.3-Flash',
		pricingVersion: '2026-10-nemotron-tier',
		unitPriceMinorUnits: 50, // output $0.50/Mtok (budget ceiling)
		inputPriceMinorUnits: 15, // $0.15/Mtok
		outputPriceMinorUnits: 50,
		currency: 'usd',
		contextWindow: 1048576,
		// A plan revision is ~3.5k reasoning tokens + the whole PRD inside the
		// write_plan_note call. LIVE VERIFIED 2026-10-15: at 4096 the FarmLog AI
		// revision stopped at finish=length before the tool call (nothing saved,
		// six attempts, "task completed with no text"); at 16384 the same request
		// finished with the call (8231 tokens, 18910-char PRD). 32768 leaves room
		// for longer plans. This is a cap, not a spend: billing is per token used.
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
	/** Caddie chat / coordinator. Super is fast + cheap and, with the strict
	 *  "present only tool results" instruction, does not hallucinate listings —
	 *  the frontier Ultra reasoned on every trivial turn (slow + ~5× cost) and
	 *  did NOT fix the hallucination, which was always a missing-instruction bug. */
	chat: 'nemotron-3-super',
	/** Brainstorming WHAT to build (Home chat only, a bounded window of turns —
	 *  see {@link coordinatorModelRole}). This is where judgment pays: asking
	 *  the right questions once, honest critique of ideas, grounding technical
	 *  claims in the rules, and NOT taking "1 and 3" as a chosen idea. Ultra ran
	 *  this same coordinator as the chat model before the switch to Super
	 *  (execution-ledger P05), so its tool-calling here is not new ground. */
	ideation: 'nemotron-3-ultra',
	/** Planning specialists (product, designer, tech-lead — the catalog's
	 *  `planning` skill): the PRD, design and plan of record. Kept as its own
	 *  role so planning can be re-routed in one line; it shares the build route
	 *  today (owner decision 2026-10-15), leaving Ultra for ideation only. */
	plan: 'glm-5.3-flash',
	/** Implementation + QA specialists (frontend, backend, mobile, qa). Moved off
	 *  Ultra ($0.50/$2.20 per Mtok) to GLM-5.3-Flash ($0.15/$0.50): tool calling
	 *  live-verified 2026-10-15, and Nebius's own agentic-coding cookbook
	 *  finished a coding task on it in 4 calls. The project RUN BINDING also
	 *  records this route. */
	build: 'glm-5.3-flash',
	/** Cheap bounded helper calls (query shaping, summarization). */
	helper: 'nemotron-3-nano',
	/** AI inside generated apps (env.CADDIE.ai, app-ai.ts): a visitor waits on
	 *  every reply, so the fast, cheap chat route — not a deep reasoning one.
	 *  Caddie pays; each project has a monthly allowance. */
	app: 'nemotron-3-super',
	/** Image understanding (Stage 3) — a vision-language model that accepts image input. */
	vision: 'glm-5.3-flash',
} as const satisfies Record<string, string>;

export type ModelRole = keyof typeof MODEL_ROLES;

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
 * durable state, so this is evaluated per turn. Ideation applies only in the
 * Home conversation: a project conversation's specialists inherit the
 * coordinator's model, and a brainstorm flag must never change what a build
 * runs on. An unknown home/project identity (first render, no snapshot yet)
 * is treated as NOT home — the default chat model, never a silent upgrade.
 *
 * Pricing note: the Home run binding still records the `chat` route; chat
 * turns reserve no budget today. When chat budgets are wired, ideation turns
 * must be priced at the ideation route, not the binding's.
 */
export function coordinatorModelRole(input: { isHome: boolean; ideationTurnsLeft: number; hasImage?: boolean }): ModelRole {
	// A turn that carries an image must reach a model that can see it — a
	// text-only route would drop or reject the image. Wins in any conversation:
	// project specialists declare their own model, so this never changes a build.
	if (input.hasImage) return 'vision';
	return input.isHome && input.ideationTurnsLeft > 0 ? 'ideation' : 'chat';
}

/** Route ids that accept image input (the vision-capable routes). The one place
 *  that marks a route as a VLM — the ModelCapability contract reads from here. */
export const VISION_ROUTE_IDS: readonly string[] = ['glm-5.3-flash'];

/** Whether a route accepts image input (used to pick a vision route for an
 *  image message, and to report the capability honestly). */
export function routeAcceptsImage(modelRouteId: string): boolean {
	return VISION_ROUTE_IDS.includes(modelRouteId);
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
					cacheRead: route.inputPriceMinorUnits / 100 / 10,
					cacheWrite: route.inputPriceMinorUnits / 100 / 10,
				},
				contextWindow: route.contextWindow,
				maxTokens: route.maxTokens,
				compat: {
					supportsDeveloperRole: false,
					supportsStore: false,
					maxTokensField: 'max_tokens',
				},
			})),
			api: openAICompletionsApi(),
		}),
	);
}
