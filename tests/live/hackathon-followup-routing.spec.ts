import { describe, expect, test } from 'bun:test';
import {
	FIND_HACKATHONS_DESCRIPTION,
	HACKATHON_DETAILS_DESCRIPTION,
	HACKATHON_FOLLOWUPS_INSTRUCTION,
	HACKATHON_HONESTY_INSTRUCTION,
	RESEARCH_DESCRIPTION,
} from '../../apps/app/src/agents/hackathon-prompts.ts';
import { findModelRouteForRole } from '../../apps/app/src/agents/providers.ts';
import { buildHackathonReference } from '../../apps/app/src/server/hackathon-card.ts';

/**
 * LIVE routing probe (paid model call, ~$0.001 per trial).
 *
 * Replays the exact failure: a find_hackathons card is already in the chat,
 * then the user says "lets talk about the nebious x nvidia global ai hackathon".
 * Before the fix the model called `research` (a blind web search) and
 * contradicted the card. This sends the coordinator's REAL chat model, the
 * EXACT tool descriptions and hackathon instructions it uses (imported from
 * hackathon-prompts.ts), and asserts the first tool call is hackathon_details
 * for the right event — on every trial, not just once.
 *
 * Scope: a focused probe, not the full Flue coordinator (other tools and
 * instructions are omitted). The full round-trip is flue-lifecycle.spec.ts.
 */
const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
const TRIALS = 3;

const card = {
	candidates: [
		{ id: 'cand_amazon', title: 'Build, Ship, Shape: Amazon Developer Hackathon', url: 'https://amazon-hackathon.devpost.com', eligibility: 'eligible' as const },
		{ id: 'cand_nebius', title: 'Nebius x NVIDIA Global AI Hackathon', url: 'https://nebiusglobalaihackathon.devpost.com', eligibility: 'eligible' as const },
		{ id: 'cand_paypal', title: 'PayPal AI Hackathon', url: 'https://paypal-ai.devpost.com', eligibility: 'eligible' as const },
		{ id: 'cand_metavr', title: 'Meta VR Start Developer Competition 2026', url: 'https://metavr.devpost.com', eligibility: 'unknown' as const, eligibilityNeedsConfirm: true },
	],
	gaps: [],
	profileCountry: 'NG',
};

const findOutput = JSON.stringify({
	rendered: 'hackathon_results_card',
	count: card.candidates.length,
	gaps: [],
	shown: buildHackathonReference(card as never),
	instruction:
		'The hackathon card is shown to the user with every title, link and eligibility verdict. Do NOT list, tabulate or re-describe these hackathons in your reply. ' +
		'`shown` is for FOLLOW-UPS ONLY, never to be listed: when the user later asks about one of these events, use its id and its eligibility verdict here — it is the checked verdict on the card, so never contradict it.',
});

const tools = [
	{ name: 'find_hackathons', description: FIND_HACKATHONS_DESCRIPTION, parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, refresh: { type: 'boolean' } } } },
	{ name: 'research', description: RESEARCH_DESCRIPTION, parameters: { type: 'object', properties: { query: { type: 'string' }, url: { type: 'string' }, limit: { type: 'number' } } } },
	{ name: 'hackathon_details', description: HACKATHON_DETAILS_DESCRIPTION, parameters: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
].map((fn) => ({ type: 'function', function: fn }));

function messages(followUp: string) {
	return [
		{
			role: 'system',
			content: [
				'You are Caddie, a helpful assistant for solo builders. Speak in clear user-facing language, never raw internal tool names or opaque ids.',
				HACKATHON_HONESTY_INSTRUCTION,
				HACKATHON_FOLLOWUPS_INSTRUCTION,
			].join('\n\n'),
		},
		{ role: 'user', content: 'Help me find my first hackathon — something that fits what I like building.' },
		{ role: 'assistant', content: '', tool_calls: [{ id: 'call_find_1', type: 'function', function: { name: 'find_hackathons', arguments: '{"limit":8}' } }] },
		{ role: 'tool', tool_call_id: 'call_find_1', content: findOutput },
		{ role: 'assistant', content: 'Here are a few that fit your profile — open any that interest you.' },
		{ role: 'user', content: followUp },
	];
}

async function firstToolCall(apiKey: string, followUp: string): Promise<{ name: string; args: Record<string, unknown> } | null> {
	const route = findModelRouteForRole('chat');
	const res = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(90_000),
		body: JSON.stringify({ model: route.modelId, messages: messages(followUp), tools, tool_choice: 'auto', max_tokens: route.maxTokens }),
	});
	if (!res.ok) throw new Error(`model call failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	const body = (await res.json()) as { choices?: { message?: { tool_calls?: { function: { name: string; arguments: string } }[] } }[] };
	const call = body.choices?.[0]?.message?.tool_calls?.[0];
	if (!call) return null;
	let args: Record<string, unknown> = {};
	try {
		args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
	} catch {
		/* malformed args are asserted on below */
	}
	return { name: call.function.name, args };
}

describe('live: hackathon follow-up routes to hackathon_details, not research', () => {
	const apiKey = process.env.NEBIUS_API_KEY;
	const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1' && Boolean(apiKey);

	test(`the original failing follow-up calls hackathon_details for Nebius (${TRIALS}/${TRIALS} trials)`, async () => {
		if (!authorized) {
			throw new Error('BLOCKED: requires CADDIE_LIVE_AUTHORIZED=1 and NEBIUS_API_KEY. This test makes a paid model call; no mocked evidence is accepted.');
		}
		const outcomes: string[] = [];
		for (let i = 0; i < TRIALS; i++) {
			const call = await firstToolCall(apiKey!, 'lets talk about the nebious x nvidia global ai hackathon');
			outcomes.push(call ? `${call.name}(${JSON.stringify(call.args)})` : 'no tool call');
			expect(call?.name).toBe('hackathon_details');
			const id = String(call?.args['id'] ?? '');
			const title = String(call?.args['title'] ?? '').toLowerCase();
			expect(id === 'cand_nebius' || title.includes('nebi')).toBe(true);
		}
		console.log('trials:', outcomes.join(' | '));
	}, 300_000);
});
