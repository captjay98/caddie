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

	test('the three verified Nemotron tiers are present with the exact (case-sensitive) ids', () => {
		const byId = Object.fromEntries(MODEL_ROUTES.map((r) => [r.id, r]));
		expect(byId['nemotron-3-ultra']?.modelId).toBe('nvidia/Nemotron-3-Ultra-550b-a55b');
		expect(byId['nemotron-3-super']?.modelId).toBe('nvidia/nemotron-3-super-120b-a12b');
		expect(byId['nemotron-3-nano']?.modelId).toBe('nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
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

	test('chat routes to Super (fast/cheap); build to the frontier Ultra; helper to the cheap Nano', () => {
		expect(findModelRouteForRole('chat').id).toBe('nemotron-3-super');
		expect(findModelRouteForRole('build').id).toBe('nemotron-3-ultra');
		expect(findModelRouteForRole('helper').id).toBe('nemotron-3-nano');
		// the helper really is cheaper than the chat model (per-output rate).
		expect(findModelRouteForRole('helper').outputPriceMinorUnits)
			.toBeLessThan(findModelRouteForRole('chat').outputPriceMinorUnits);
	});

	test('ideation routes to Ultra; chat stays on Super', () => {
		expect(findModelRouteForRole('ideation').id).toBe('nemotron-3-ultra');
		expect(findModelRouteForRole('chat').id).toBe('nemotron-3-super');
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
		expect(findModelRouteForRole('vision').id).toBe('glm-5.3-flash-vision');
		expect(routeAcceptsImage(findModelRouteForRole('vision').id)).toBe(true);
		// no image: unchanged
		expect(coordinatorModelRole({ isHome: false, ideationTurnsLeft: 0, hasImage: false })).toBe('chat');
	});
});
