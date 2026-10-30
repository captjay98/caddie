import { describe, expect, test } from 'bun:test';
import {
	MODEL_ROUTES,
	MODEL_ROLES,
	findModelRoute,
	findModelRouteForRole,
	coordinatorModelRole,
	routeAcceptsImage,
	IDEATION_TURN_WINDOW,
	ROLE_THINKING,
	compactionFor,
	CONTEXT_BUDGET_TOKENS,
	type ModelRole,
} from '../apps/app/src/agents/providers.ts';
import { specialistModelRole } from '../apps/app/src/agents/specialists.ts';

/**
 * Stage 2 — the extended frozen model registry. The routes themselves are
 * live-verified against Nebius in Stage 1; here we lock the registry's
 * INVARIANTS so a future edit can't silently break the fail-closed pricing
 * contract or point a role at a non-existent model.
 */

describe('model registry (providers.ts)', () => {
	test('every route is fully priced and self-consistent (fail-closed inputs)', () => {
		for (const route of MODEL_ROUTES) {
			expect(route.id).toBeTruthy();
			expect(route.specifier).toContain(route.modelId);
			expect(route.pricingVersion).toBeTruthy();
			expect(route.currency).toBe('usd');
			// budget ceiling = output price (the conservative single rate).
			expect(route.unitPriceMinorUnits).toBe(route.outputPriceMinorUnits);
			expect(route.outputPriceMinorUnits).toBeGreaterThanOrEqual(route.inputPriceMinorUnits);
			expect(Number.isInteger(route.unitPriceMinorUnits)).toBe(true);
			expect(route.contextWindow).toBeGreaterThan(0);
			expect(route.maxTokens).toBeGreaterThan(0);
		}
	});

	test('the verified Nemotron ids are present with the exact (case-sensitive) spelling', () => {
		const byId = Object.fromEntries(MODEL_ROUTES.map((r) => [r.id, r]));
		expect(byId['nemotron-3-ultra']?.modelId).toBe('nvidia/Nemotron-3-Ultra-550b-a55b');
		expect(byId['nemotron-3-super']?.modelId).toBe('nvidia/nemotron-3-super-120b-a12b');
		expect(byId['nemotron-3-nano']?.modelId).toBe('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
		// The 3.5 tier (listing re-check 2026-10-18): Super VL carries a DOT in
		// `3.5`, Lightning an UNDERSCORE in `3_5`. A "tidied" id is a 404 at
		// request time, not a cosmetic difference.
		expect(byId['nemotron-3.5-super-vl']?.modelId).toBe('nvidia/Nemotron-3.5-Super-VL');
		expect(byId['nemotron-3.5-lightning']?.modelId).toBe('nvidia/Nemotron-3_5-Lightning');
	});

	test('findModelRoute throws on an unknown id (no silent fallback)', () => {
		expect(() => findModelRoute('does-not-exist')).toThrow(/unknown model route/);
	});

	test('every role maps to a route that exists', () => {
		for (const role of Object.keys(MODEL_ROLES) as ModelRole[]) {
			const route = findModelRouteForRole(role);
			expect(route.id).toBe(MODEL_ROLES[role]);
		}
	});

	test('chat uses the 3.5 mid tier; build runs on MiniMax; plan stays on GLM; helper stays on Nano', () => {
		expect(findModelRouteForRole('chat').id).toBe('nemotron-3.5-super-vl');
		// Owner 2026-10-29: the builder moves to MiniMax-M3.1-Flash (half Super
		// VL's input price, a quarter of its cached price).
		expect(findModelRouteForRole('build').id).toBe('minimax-m3.1-flash');
		expect(findModelRouteForRole('plan').id).toBe('glm-5.3-flash');
		expect(findModelRouteForRole('build').inputPriceMinorUnits)
			.toBeLessThan(findModelRouteForRole('chat').inputPriceMinorUnits);
		// The helper job is rules-reading: strict JSON out of a long page.
		// Lightning was tried again on 2026-10-20 at the route's real 4,096 cap:
		// 17,867 chars of narrated reasoning, `finish_reason: length`, no JSON.
		// At 512 (the G1 probe) it also failed. Nano keeps its reasoning in
		// `reasoning_content` and returns claims whose quotes are verbatim in the
		// page. Both routes cost $0.06/$0.24, so Nano gives up no saving.
		expect(findModelRouteForRole('helper').id).toBe('nemotron-3-nano');
		// the helper really is cheaper than the chat model (per-output rate).
		expect(findModelRouteForRole('helper').outputPriceMinorUnits)
			.toBeLessThan(findModelRouteForRole('chat').outputPriceMinorUnits);
	});

	test('the helper route has room to finish its reasoning', () => {
		// A cap that ends the answer mid-thought is worse than no cap: the model
		// bills for the tokens and returns nothing usable. At 2,048 the live probe
		// got 9,270 chars of `reasoning_content` and EMPTY content; at 8,192 the
		// same call finished in 1,382 output tokens with 4 verbatim claims.
		expect(findModelRouteForRole('helper').maxTokens).toBeGreaterThanOrEqual(4096);
	});

	test('AI inside apps: the cheap tier by default, the deeper tier on request', () => {
		expect(findModelRouteForRole('app').id).toBe('nemotron-3.5-lightning');
		expect(findModelRouteForRole('appSuper').id).toBe('nemotron-3.5-super-vl');
		// The deeper call is the chat route at exactly 3.75x the cheap tier's
		// output rate, so a project's monthly allowance runs out sooner by that
		// factor and nothing else changes (S04's contract).
		expect(findModelRouteForRole('appSuper').outputPriceMinorUnits)
			.toBe(findModelRouteForRole('app').outputPriceMinorUnits * 3.75);
	});

	test('ideation routes to Ultra; chat stays off it (the frontier model is for ideas only)', () => {
		expect(findModelRouteForRole('ideation').id).toBe('nemotron-3-ultra');
		expect(findModelRouteForRole('chat').id).toBe('nemotron-3.5-super-vl');
		// the point of the split: a chat turn is materially cheaper than one
		// ideation turn, so a drifted conversation falls back on its own.
		expect(findModelRouteForRole('chat').outputPriceMinorUnits)
			.toBeLessThan(findModelRouteForRole('ideation').outputPriceMinorUnits);
	});

	test('coordinatorModelRole: brainstorming follows the task in either conversation', () => {
		expect(coordinatorModelRole({ isHome: true, ideationTurnsLeft: 3 })).toBe('ideation');
		expect(coordinatorModelRole({ isHome: true, ideationTurnsLeft: 0 })).toBe('chat');
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 12 })).toBe('ideation');
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 0 })).toBe('chat');
		expect(IDEATION_TURN_WINDOW).toBeGreaterThan(0);
	});
	test('explicit brainstorming uses the deeper model immediately, routine status and execution do not', () => {
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 0, request: 'Can we brainstorm a simpler first version?' })).toBe('ideation');
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 8, request: 'Where did we stop?' })).toBe('chat');
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 8, execution: true })).toBe('chat');
		expect(coordinatorModelRole({ isHome: true, ideationTurnsLeft: 0, request: 'Thanks' })).toBe('chat');
	});

	test('coordinatorModelRole: an image turn routes to the vision model in any conversation', () => {
		expect(coordinatorModelRole({ isHome: true, ideationTurnsLeft: 0, hasImage: true })).toBe('vision');
		expect(coordinatorModelRole({ isHome: true, ideationTurnsLeft: 5, hasImage: true })).toBe('vision');
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 0, hasImage: true })).toBe('vision');
		expect(findModelRouteForRole('vision').id).toBe('nemotron-3.5-super-vl');
		expect(routeAcceptsImage(findModelRouteForRole('vision').id)).toBe(true);
		// GLM-5.3-Flash stays LISTED as vision-capable: it passed the same
		// image+tool probe on 2026-10-15. The vision role is a preference;
		// routeAcceptsImage is a fact about the model.
		expect(routeAcceptsImage('glm-5.3-flash')).toBe(true);
		// no image: unchanged
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 0, hasImage: false })).toBe('chat');
	});
});

test('execution instructions do not inherit the brainstorming window', () => {
  for (const request of ['Build the approved plan', 'Fix the failed test', 'Please resume the build', 'Stop building', 'Let’s build the approved plan', 'Can you fix the failed test?', 'Yes, implement it']) {
    expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 8, request })).toBe('chat');
  }
  expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 8, request: 'Please build on that idea and explore options' })).toBe('ideation');
  expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 8, request: 'For small farms' })).toBe('ideation');
});

test('every role carries a thinking level: medium, and low for the design author and builder (owner 2026-10-29: context hygiene)', () => {
	// 'max' (2026-10-25) made the design author think for minutes and return
	// nothing, and every saved thinking token rode along into later turns. At
	// 'medium' the design author still spent its whole output on reasoning twice
	// on the merged looks task, and the builder thought for 437 s and 306 s in
	// single calls (Farm Ops, 2026-10-29), so both run on 'low'.
	const LOW = new Set<ModelRole>(['designAuthor', 'build']);
	for (const role of Object.keys(MODEL_ROLES) as ModelRole[]) {
		expect(ROLE_THINKING[role], `role ${role}`).toBe(LOW.has(role) ? 'low' : 'medium');
	}
});
test('the coordinator compacts past a bounded budget, not at the 1M window', () => {
	const settings = compactionFor({ contextWindow: 1_048_576 });
	// Owner 2026-10-29 bill: the conversation's size is the bill, so it stays small.
	expect(CONTEXT_BUDGET_TOKENS).toBe(60_000);
	expect(1_048_576 - settings.reserveTokens).toBe(CONTEXT_BUDGET_TOKENS);
	expect(settings.keepRecentTokens).toBeLessThan(CONTEXT_BUDGET_TOKENS);
	// A small window keeps Flue's floor instead of going negative.
	expect(compactionFor({ contextWindow: 70_000 }).reserveTokens).toBe(20_000);
});

// --- Owner routing decision 2026-10-27 (model-role split) ------------------------
// product authors the PRD on deepseek, the designer authors looks/design on
// MiniMax, the independent plan reviewer is full GLM-5.3, and the legacy
// `plan` role keeps glm-5.3-flash for the tech-lead and historic bindings.
describe('2026-10-27 routing decision', () => {
	test('the new roles resolve to their decided routes', () => {
		expect(MODEL_ROLES.planAuthor).toBe('deepseek-v4.1-flash-1017');
		expect(MODEL_ROLES.planReviewer).toBe('glm-5.3');
		expect(MODEL_ROLES.designAuthor).toBe('minimax-m3.1-flash');
		// Legacy route is retained for historic run bindings.
		expect(MODEL_ROLES.plan).toBe('glm-5.3-flash');
		expect(findModelRouteForRole('planAuthor').modelId).toBe('deepseek-ai/DeepSeek-V4.1-Flash-1017');
		expect(findModelRouteForRole('planReviewer').modelId).toBe('zai-org/GLM-5.3');
		expect(findModelRouteForRole('designAuthor').modelId).toBe('MiniMaxAI/MiniMax-M3.1-Flash');
		// Every role — including the new ones — still resolves (fail closed).
		for (const role of Object.keys(MODEL_ROLES) as ModelRole[]) {
			expect(findModelRouteForRole(role).id).toBe(MODEL_ROLES[role]);
		}
	});

	test('the MiniMax route carries the live-checked catalog values', () => {
		const route = findModelRoute('minimax-m3.1-flash');
		expect(route.modelId).toBe('MiniMaxAI/MiniMax-M3.1-Flash');
		expect(route.specifier).toBe('nebius/MiniMaxAI/MiniMax-M3.1-Flash');
		// Catalog 2026-10-27: $0.15 in / $0.60 out per Mtok, context up to 1M.
		expect(route.inputPriceMinorUnits).toBe(15);
		expect(route.outputPriceMinorUnits).toBe(60);
		expect(route.contextWindow).toBe(1048576);
		expect(route.maxTokens).toBeGreaterThanOrEqual(16384);
		expect(route.pricingVersion).toBe('2026-10-27-nebius-catalog');
	});

	test('full GLM-5.3 can never take images, and MiniMax is not a vision route yet', () => {
		expect(routeAcceptsImage('glm-5.3')).toBe(false);
		expect(routeAcceptsImage('minimax-m3.1-flash')).toBe(false);
	});

	test('the specialist split routes product and tech-lead to the plan author, designer to the design author', () => {
		const roleOf = (role: string, skills: string[]) =>
			specialistModelRole({ role: role as never, skills });
		expect(roleOf('product', ['planning'])).toBe('planAuthor');
		expect(roleOf('designer', ['planning', 'design'])).toBe('designAuthor');
		expect(roleOf('tech-lead', ['planning', 'build-verify'])).toBe('planAuthor');
		expect(roleOf('frontend', ['build-verify'])).toBe('build');
	});
});
