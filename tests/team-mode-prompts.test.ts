import { describe, expect, test } from 'bun:test';
import {
	ARCHITECT_INSTRUCTION,
	SPECIALIST_INSTRUCTIONS,
	TEAM_MODE_BIG_APPS_DESIGN_INSTRUCTION,
	TEAM_MODE_DESIGN_INSTRUCTION,
	TEAM_MODE_PRODUCT_INSTRUCTION,
	TEAM_MODE_TECH_LEAD_INSTRUCTION,
	architectDeclaration,
	specialistInstruction,
} from '../apps/app/src/agents/specialists.ts';
import { findModelRouteForRole, MODEL_ROLES } from '../apps/app/src/agents/providers.ts';

/**
 * Part C prompts in team mode, and part B's architect role and design block
 * instruction. The wording changes with team mode ON and is unchanged with it
 * OFF. LOCAL VERIFIED (string/role assertions, no model calls).
 */

describe('part C: product and tech-lead wording changes in team mode, not out of it', () => {
	test('team mode OFF: product and tech-lead keep today\'s wording', () => {
		expect(specialistInstruction('product', false)).toBe(SPECIALIST_INSTRUCTIONS.product);
		expect(specialistInstruction('tech-lead', false)).toBe(SPECIALIST_INSTRUCTIONS['tech-lead']);
		// The old wording aims at a demo, not a complete app.
		expect(specialistInstruction('product', false)).toContain('Aim at a demo that wins, not a complete CRUD app');
	});

	test('team mode ON: product aims at a complete app and keeps the demo contract', () => {
		const on = specialistInstruction('product', true);
		expect(on).toBe(TEAM_MODE_PRODUCT_INSTRUCTION);
		expect(on).toContain('Plan a complete app');
		expect(on).toContain('create, show, change and delete');
		// The demo contract is KEPT, as the three-minute tour of the complete app.
		expect(on).toContain('demo contract is the three-minute tour');
		expect(on).not.toContain('Aim at a demo that wins, not a complete CRUD app');
	});

	test('team mode ON: the tech-lead checks completeness (tables used, privacy, restart)', () => {
		const on = specialistInstruction('tech-lead', true);
		expect(on).toBe(TEAM_MODE_TECH_LEAD_INSTRUCTION);
		expect(on).toContain('every declared table is used by a screen');
		expect(on).toContain('still works after a restart');
	});

	test('team mode does not change the implementation or QA roles', () => {
		for (const role of ['frontend', 'backend', 'mobile', 'qa'] as const) {
			expect(specialistInstruction(role, true)).toBe(SPECIALIST_INSTRUCTIONS[role]);
		}
	});
});

describe('part B/C: the design carries the architecture block v2; big apps plan modules core-first', () => {
	test('the team-mode design instruction names the one block, one approval, one hash', () => {
		expect(TEAM_MODE_DESIGN_INSTRUCTION).toContain('caddie-architecture');
		expect(TEAM_MODE_DESIGN_INSTRUCTION).toContain('version 2');
		expect(TEAM_MODE_DESIGN_INSTRUCTION).toContain('one approval and one revision hash');
		// Each screen declares what it shows.
		expect(TEAM_MODE_DESIGN_INSTRUCTION).toContain('every screen declares what it shows');
	});

	test('the big-apps design instruction plans independent modules, core first', () => {
		expect(TEAM_MODE_BIG_APPS_DESIGN_INSTRUCTION).toContain('core module first');
		expect(TEAM_MODE_BIG_APPS_DESIGN_INSTRUCTION).toContain('independent modules');
		expect(TEAM_MODE_BIG_APPS_DESIGN_INSTRUCTION).toContain('in parallel');
	});
});

describe('part B: the architect delegate on the Ultra role', () => {
	test('the architect role is cleared and routes to nemotron-3-ultra', () => {
		expect(MODEL_ROLES.architect).toBe('nemotron-3-ultra');
		expect(findModelRouteForRole('architect').modelId).toContain('Nemotron-3-Ultra');
	});

	test('the architect declaration is read-only: it mounts the review tool on the Ultra route', () => {
		const declaration = architectDeclaration({
			readPlanNote: async () => null,
			recordArchitectureReview: async () => ({ round: 1, security: 0, advisory: 0 }),
		});
		expect(declaration.name).toBe('architect');
		expect(declaration.model).toBe(findModelRouteForRole('architect').specifier);
		expect(ARCHITECT_INSTRUCTION).toContain('record_architecture_review');
		expect(ARCHITECT_INSTRUCTION).toContain('READ-ONLY');
	});
});

describe('part B: the coordinator review loop (lead fix)', () => {
	test('every design is reviewed by the architect, and the plan changes when the architect says so', async () => {
		const { TEAM_MODE_REVIEW_LOOP_INSTRUCTION } = await import('../apps/app/src/agents/coordinator.ts');
		expect(TEAM_MODE_REVIEW_LOOP_INSTRUCTION).toContain('delegate to the architect');
		expect(TEAM_MODE_REVIEW_LOOP_INSTRUCTION).toContain('NEW design revision');
		expect(TEAM_MODE_REVIEW_LOOP_INSTRUCTION).toContain('plan must change');
		expect(TEAM_MODE_REVIEW_LOOP_INSTRUCTION).toContain("write_plan_note kind 'prd'");
	});
});
