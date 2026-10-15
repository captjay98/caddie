import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Guard for the hackathon follow-up routing in the coordinator prompt.
 *
 * Bug this protects against: after a find_hackathons card, "let's talk about
 * the Nebius one" went to `research` (a blind web search), which contradicted
 * the card's CHECKED eligibility verdict and cited LinkedIn/Reddit instead of
 * the event page. The coordinator's tools are declared inline with useTool, so
 * a model-free unit test can only pin the contract in the source: follow-ups
 * use hackathon_details first, research no longer claims rules/eligibility
 * questions, and the reply offers a project instead of internal agent talk.
 * (Live model behaviour is tests/live, BLOCKED without credentials.)
 */
// Registration lives in coordinator.ts; the prompt text it sends lives in
// hackathon-prompts.ts (imported verbatim by the coordinator). Pin both.
const source =
	readFileSync(new URL('../apps/app/src/agents/coordinator.ts', import.meta.url), 'utf8') +
	readFileSync(new URL('../apps/app/src/agents/hackathon-prompts.ts', import.meta.url), 'utf8');

describe('coordinator hackathon follow-up routing', () => {
	test('hackathon_details is registered and described as the first stop for a found event', () => {
		expect(source).toContain('name: "hackathon_details"');
		expect(source).toContain('Use this BEFORE research for any question about a found event');
		expect(source).toContain('context.hackathonDetails(ctx.data)');
	});

	test('the follow-up instruction routes to hackathon_details and forbids contradicting the verdict', () => {
		expect(source).toContain('HACKATHON FOLLOW-UPS');
		expect(source).toContain('call hackathon_details FIRST');
		expect(source).toContain('never soften or contradict the verdict, and never re-check it with research');
		expect(source).toContain('Never mention agents, specialists, handoffs or tool names.');
		// The follow-up now hands brainstorming to the IDEATION rule rather than
		// jumping to propose_project; the "nothing created until Start" promise
		// lives in the ideation + propose instructions, pinned by their own guards.
		expect(source).toContain('Follow the IDEATION rule for how to brainstorm — do NOT jump straight to propose_project');
	});

	test('a new project is only ever PROPOSED: no create_project tool, and the propose tool says it creates nothing', () => {
		expect(source).not.toContain('name: "create_project"');
		expect(source).toContain('name: "propose_project"');
		expect(source).toContain('This creates NOTHING');
		expect(source).toContain('created: false');
		expect(source).not.toMatch(/call create_project/);
	});

	test('research no longer claims rules/eligibility questions about stored events', () => {
		expect(source).not.toContain("a contest's rules/eligibility ('what are the rules for X')");
		expect(source).not.toContain("For one event's rules or an open question, use `research` instead.");
		expect(source).toContain('Never use it to re-check eligibility of an event that hackathon_details already returned');
	});

	test('the honesty rule allows naming events returned by hackathon_details', () => {
		expect(source).toContain("THIS turn's find_hackathons / hackathon_details / research tool results");
	});
});

/**
 * Guard for the IDEATION rule (Stage 2 of the end-to-end polish).
 *
 * Bug this protects against — replayed from tonight's chat: the user steered
 * "keep the focus on livestock" (a direction to explore, NOT a chosen idea)
 * and the coordinator went straight to proposing/creating a project, and
 * earlier ideation replies dumped options as a catalogue. The rule now makes
 * Caddie ask first, offer at most three plain-prose ideas checked honestly,
 * narrow to one, and only THEN propose — and forbids tables/HTML/product-name
 * lists in ideation replies. The coordinator registers the instruction inline
 * via useInstruction, so a model-free unit test pins the contract in source;
 * live model behaviour is tests/live (BLOCKED without credentials).
 */
describe('coordinator ideation rule', () => {
	test('the ideation instruction is registered in the coordinator', () => {
		expect(source).toContain('HACKATHON_IDEATION_INSTRUCTION');
		expect(source).toContain('useInstruction(HACKATHON_IDEATION_INSTRUCTION)');
	});

	test('ideation thinks before it proposes: ask first, offer <=3 ideas, narrow, propose only when settled', () => {
		expect(source).toContain('IDEATION');
		expect(source).toContain('NEVER call propose_project until the user has clearly settled on one specific idea');
		// a vague steer is a direction to explore, not an idea to commit — the
		// exact "keep the focus on livestock" case from tonight's chat.
		expect(source).toContain('keep the focus on livestock');
		expect(source).toContain('is a direction to explore, not an idea to commit');
		expect(source).toContain('ask 2–3 short questions');
		expect(source).toContain('at MOST three distinct ideas');
		expect(source).toContain('NARROW to a single idea');
	});

	test('ideation replies forbid tables, HTML and product-name lists', () => {
		expect(source).toContain('NO markdown tables, NO HTML, NO numbered or bulleted lists of product names');
	});
});
