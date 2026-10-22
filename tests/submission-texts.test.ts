import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_ROLES, findModelRouteForRole, type ModelRole } from '../apps/app/src/agents/providers.ts';

/**
 * Lane 7, part H — the submission texts must never drift from the code.
 *
 * Two guards, both read-only over committed files:
 *   1. The devpost model table is PARSED and checked row-by-row against
 *      MODEL_ROLES in agents/providers.ts (the single source of truth). A
 *      role routed to a different model in the code than the table claims
 *      fails here, so the Devpost text can't quietly say "build runs on GLM"
 *      once the code moved build to Super VL.
 *   2. docs/submission/** must not contain the exact stale sentences that a
 *      prior draft carried (a hosted deployment / full agent build that isn't
 *      live, and the "planning and build share glm" claim that predates the
 *      2026-10-20 build re-route). These are pinned verbatim: if one comes
 *      back, this test names it.
 *
 * Classification: LOCAL VERIFIED (parses the real committed docs and the real
 * MODEL_ROLES export; no network, no stubs).
 */

const REPO_ROOT = join(import.meta.dir, '..');
const DEVPOST = readFileSync(join(REPO_ROOT, 'docs/submission/devpost.md'), 'utf8');
const VIDEO = readFileSync(join(REPO_ROOT, 'docs/submission/video-script.md'), 'utf8');

/** The role → (route id, model id) truth, resolved from the code. */
function expectedRoleRows(): Map<ModelRole, { routeId: string; modelId: string }> {
	const out = new Map<ModelRole, { routeId: string; modelId: string }>();
	for (const role of Object.keys(MODEL_ROLES) as ModelRole[]) {
		const route = findModelRouteForRole(role);
		out.set(role, { routeId: MODEL_ROLES[role], modelId: route.modelId });
	}
	return out;
}

/**
 * Parse every markdown table row in a doc that looks like
 * `| <role col> | <route id> | <model id> | <call site> |` where the role
 * column contains a backticked role name. Returns role name → {routeId,
 * modelId} taking the first backticked token of each of the first three cells.
 */
function parseModelTable(markdown: string): Map<string, { routeId: string; modelId: string }> {
	const rows = new Map<string, { routeId: string; modelId: string }>();
	const code = (cell: string): string | null => {
		const m = cell.match(/`([^`]+)`/);
		return m ? m[1] : null;
	};
	for (const line of markdown.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('|')) continue;
		const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
		if (cells.length < 3) continue;
		const roleCell = code(cells[0]!);
		const routeId = code(cells[1]!);
		const modelId = code(cells[2]!);
		if (!roleCell || !routeId || !modelId) continue;
		// Only accept a model id that looks like a provider model id, so header
		// and prose rows are skipped.
		if (!modelId.includes('/')) continue;
		rows.set(roleCell, { routeId, modelId });
	}
	return rows;
}

describe('submission texts: the devpost model table matches MODEL_ROLES', () => {
	const expected = expectedRoleRows();
	const parsed = parseModelTable(DEVPOST);

	test('the devpost table was found and parsed', () => {
		expect(parsed.size).toBeGreaterThanOrEqual(expected.size);
	});

	for (const [role, want] of expected) {
		test(`role \`${role}\` is listed as ${want.routeId} / ${want.modelId}`, () => {
			const got = parsed.get(role);
			expect(got, `role '${role}' is missing from the devpost model table`).toBeDefined();
			expect(got!.routeId).toBe(want.routeId);
			expect(got!.modelId).toBe(want.modelId);
		});
	}

	test('the table carries the build role on Super VL, not GLM (the 2026-10-20 re-route)', () => {
		const build = parsed.get('build');
		expect(build).toBeDefined();
		expect(build!.routeId).toBe('nemotron-3.5-super-vl');
		expect(build!.modelId).toBe('nvidia/Nemotron-3.5-Super-VL');
	});
});

describe('submission texts: stale sentences are gone from docs/submission/**', () => {
	// Each pinned phrase is one that a prior draft carried and that is now
	// false. If any reappears verbatim, the matching test fails and names it.
	const BANNED: { phrase: string; why: string }[] = [
		{
			phrase: 'planning and code emission',
			why: 'devpost said GLM does "planning and code emission"; build (code emission) is Super VL since 2026-10-20',
		},
		{
			phrase: 'Planning and build share `glm-5.3-flash`',
			why: 'video Beat 3 notes conflated plan and build on GLM; build is Super VL',
		},
		{
			phrase: 'plan and build both run on GLM-5.3-Flash',
			why: 'the original model-table defect: build runs on Super VL',
		},
	];

	for (const { phrase, why } of BANNED) {
		test(`devpost.md no longer contains: "${phrase}" (${why})`, () => {
			expect(DEVPOST.includes(phrase)).toBe(false);
		});
		test(`video-script.md no longer contains: "${phrase}" (${why})`, () => {
			expect(VIDEO.includes(phrase)).toBe(false);
		});
	}

	test('neither doc claims FarmLog finished a live 7-of-7 build (no repo receipt backs it)', () => {
		// The only assertion of this is the plan's own prose; no live receipt,
		// feature ledger or execution-ledger row records it, so it stays out of
		// the judge-facing texts.
		expect(DEVPOST).not.toMatch(/FarmLog/i);
		expect(VIDEO).not.toMatch(/FarmLog/i);
	});
});
