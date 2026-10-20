import { describe, expect, test } from 'bun:test';
import {
	assertNoBannedLocalModel,
	bannedLocalModelMention,
} from '../apps/app/src/server/generated-app-policy.ts';

/**
 * The platform rule bans local models in prompt text; this guard makes the
 * ban deterministic at the plan-save boundary (FarmLog AI's PRD planned an
 * Ollama insight engine that could never run in the preview).
 */
describe('generated-app policy: local model runtimes are refused', () => {
	test('the exact failure from FarmLog is caught', () => {
		const prd =
			'## AI insight engine\nRun Llama 3.2 1B via Ollama on the client, with a rule-based fallback.';
		expect(bannedLocalModelMention(prd)).toBe('Ollama');
		expect(() => assertNoBannedLocalModel(prd)).toThrow(/LOCAL_MODEL_BANNED/);
		expect(() => assertNoBannedLocalModel(prd)).toThrow(/CADDIE\.ai/);
	});

	test('local and self-hosted model wording is caught, any case', () => {
		expect(bannedLocalModelMention('Use a LOCAL MODEL in the browser.')).toBe('LOCAL MODEL');
		expect(bannedLocalModelMention('A self-hosted LLM answers questions.')).toBe('self-hosted LLM');
		expect(() => assertNoBannedLocalModel('a locally-hosted model')).toThrow(/LOCAL_MODEL_BANNED/);
	});

	test('ordinary local wording and the supported route are allowed', () => {
		const allowed = [
			'Data lives in localStorage.',
			'Show times in the local time zone.',
			'Call c.env.CADDIE.ai from src/server.ts (NVIDIA Nemotron on Nebius).',
			'Store the draft locally before saving.',
		];
		for (const body of allowed) {
			expect(bannedLocalModelMention(body)).toBeNull();
			expect(() => assertNoBannedLocalModel(body)).not.toThrow();
		}
	});

	test('the guard reports the first mention only, not an unbounded match', () => {
		expect(bannedLocalModelMention('Ollama here, another local model there')).toBe('Ollama');
	});
});
