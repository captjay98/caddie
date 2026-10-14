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
		expect(source).toContain('Do not create the project before they agree.');
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
