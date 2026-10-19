import { describe, expect, test } from 'bun:test';
import {
	MODEL_ROUTES,
	MODEL_ROLES,
	findModelRoute,
	findModelRouteForRole,
	coordinatorModelRole,
	routeAcceptsImage,
	IDEATION_TURN_WINDOW,
	type ModelRole,
} from '../apps/app/src/agents/providers.ts';

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

	test('chat routes to the 3.5 mid tier; build/plan to GLM; helper stays on Nano', () => {
		expect(findModelRouteForRole('chat').id).toBe('nemotron-3.5-super-vl');
		expect(findModelRouteForRole('build').id).toBe('glm-5.3-flash');
		expect(findModelRouteForRole('plan').id).toBe('glm-5.3-flash');
		// The helper job is rules-reading: strict JSON out of a long page.
		// Lightning was moved here on 2026-10-18 and moved back on 2026-10-19
		// after the live probe (scripts/probe-lightning.ts): on the real prompt at
		// temperature 0 it spent every output token narrating its thinking INSIDE
		// `content` and never emitted JSON, at every excerpt size tried (671,
		// 3,772 and 5,998 chars). Nano keeps its reasoning in `reasoning_content`
		// and returned claims whose quotes were verbatim in the page.
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

	test('coordinatorModelRole: ideation only in Home with an open window; never in a project conversation', () => {
		expect(coordinatorModelRole({ isHome: true, ideationTurnsLeft: 3 })).toBe('ideation');
		expect(coordinatorModelRole({ isHome: true, ideationTurnsLeft: 0 })).toBe('chat');
		// project coordinators: specialists inherit this model — a brainstorm flag must not change a build
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 12 })).toBe('chat');
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 0 })).toBe('chat');
		expect(IDEATION_TURN_WINDOW).toBeGreaterThan(0);
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
