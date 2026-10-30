import { expect, test } from 'bun:test';
import { cleanAssistantText } from '../apps/app/src/client/conversation/response-hygiene.ts';

// Live Poultry Farm Monitor reply, 2026-10-29: the last two sentences narrated
// Caddie's internal team to a non-technical owner.
test('hand-off narration is removed and the real answer stays', () => {
	const reply = 'Nothing is built yet. Please review and approve the plan first.\nI\'m in the looks phase now. Let me delegate the designer to author the look proposals.';
	expect(cleanAssistantText(reply)).toBe('Nothing is built yet. Please review and approve the plan first.');
});
test('a reply that is only narration is kept rather than emptied', () => {
	const reply = 'Let me hand this to the product specialist.';
	expect(cleanAssistantText(reply)).toBe(reply);
});
test('ordinary first-person answers are untouched', () => {
	const reply = 'I\'ll check the entry rules for you. The design looks calm and clear.';
	expect(cleanAssistantText(reply)).toBe(reply);
});
test('document and tool names are said in plain words', () => {
	expect(cleanAssistantText('The PRD is approved. I tried write_plan_note and the host-side allowance step.'))
		.toBe('The plan is approved. I tried saving and the allowance step.');
});
test('a proposal first step reads without stack names', async () => {
	const { plainWordsForOwner } = await import('../apps/app/src/client/conversation/response-hygiene.ts');
	expect(plainWordsForOwner('Scaffold the React + Bun + Hono web app with a daily entry page and a stubbed anomaly check'))
		.toBe('set up the web app with a daily entry page and a first check for unusual days');
});
