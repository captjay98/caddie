import { describe, expect, test } from 'bun:test';
import { answerParts, finalAnswerParts } from '../apps/app/src/client/conversation/answer-parts.ts';

// Flue's message types, taken from the module under test (the root project
// does not resolve @flue/react itself).
type FlueConversationMessage = Parameters<typeof answerParts>[0][number];
type FlueConversationPart = ReturnType<typeof answerParts>[number];

/**
 * Live finding, 2026-10-20: replies showed their first word alone ("The", a
 * blank line, then "Nebius x NVIDIA Global AI Hackathon is open to you"). The
 * model streamed one answer in pieces with its thinking in between, and each
 * piece was drawn as its own paragraph.
 */

const message = (parts: FlueConversationPart[], id = 'm1'): FlueConversationMessage =>
	({ id, role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: '2026-10-20T00:00:00.000Z', parts }) as unknown as FlueConversationMessage;
const text = (value: string, state: 'streaming' | 'done' = 'done') => ({ type: 'text', text: value, state }) as unknown as FlueConversationPart;
const reasoning = (value: string) => ({ type: 'reasoning', text: value, state: 'done' }) as unknown as FlueConversationPart;
const tool = () => ({ type: 'dynamic-tool', toolName: 'find_hackathons', toolCallId: 't1', state: 'output-available', input: {}, output: {} }) as unknown as FlueConversationPart;
const card = () => ({ type: 'data-projectProposal', data: { proposalId: 'p1', homeProjectId: 'h1' } }) as unknown as FlueConversationPart;
const texts = (parts: FlueConversationPart[]) => parts.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`));

describe("one reply's answer", () => {
	test('pieces of one answer with thinking in between are one text, joined exactly as streamed', () => {
		const parts = answerParts([message([text('The'), reasoning('checking the rules'), text(' Nebius x NVIDIA Global AI Hackathon is open to you.')])]);
		expect(texts(parts)).toEqual(['The Nebius x NVIDIA Global AI Hackathon is open to you.']);
	});

	test('the joined text is still streaming while its last piece is', () => {
		const [joined] = answerParts([message([text('The'), reasoning('…'), text(' Nebius', 'streaming')])]);
		expect(joined).toMatchObject({ type: 'text', text: 'The Nebius', state: 'streaming' });
	});

	test('text on either side of a tool call, a card or a file stays its own block, in order', () => {
		const parts = answerParts([message([text('Let me look.'), tool(), text('Here is what I found.'), card(), text('Start it when you are ready.')])]);
		expect(texts(parts)).toEqual(['Let me look.', 'Here is what I found.', '[data-projectProposal]', 'Start it when you are ready.']);
	});

	test('two messages in one turn are never glued together', () => {
		const parts = answerParts([message([text('First.')], 'm1'), message([text('Second.')], 'm2')]);
		expect(texts(parts)).toEqual(['First.', 'Second.']);
	});

	test('reasoning and tool calls are never part of the answer', () => {
		expect(texts(answerParts([message([reasoning('…'), tool()])]))).toEqual([]);
	});
});

// Poultry Tracker, 2026-10-29: the reply showed every interim note the model
// wrote between tool calls ("I'll delegate the product specialist…").
describe('the reply a person reads after a turn that used tools', () => {
	test('only the words after the last tool call show; cards always show', () => {
		const parts = finalAnswerParts([message([text("I'll delegate the product specialist."), tool(), text('The specialist was refused by the host.'), card(), tool(), text('Your plan is ready to review.')])]);
		expect(texts(parts)).toEqual(['[data-projectProposal]', 'Your plan is ready to review.']);
	});
	test('a turn that ended on a tool call keeps its last sentence before it', () => {
		const parts = finalAnswerParts([message([text('Let me check.'), tool(), text('Searching now.'), tool()])]);
		expect(texts(parts)).toEqual(['Searching now.']);
	});
	test('a turn without tools is unchanged', () => {
		expect(texts(finalAnswerParts([message([text('Hello.'), reasoning('…'), text(' How can I help?')])]))).toEqual(['Hello. How can I help?']);
	});
});
