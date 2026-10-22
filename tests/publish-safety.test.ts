// Part G — publish safety for the exact output. Unit tests of the pure core
// (apps/app/src/server/publish-safety.ts): the bundle key scan, the team-mode
// receipt binding, and the kill switch. Each check has a mutation proof noted
// in docs/plans/2026-10-22-software-team-mode.md part G.
//
// Classification: LOCAL VERIFIED.
import { describe, expect, test } from 'bun:test';
import { checkPublishSafety, isAppKeyName, type OutputVerifyReceipts } from '../apps/app/src/server/publish-safety.ts';

const greenReceipts = (outputId: string): OutputVerifyReceipts => ({
	outputId,
	checks: { 'sign-in': true, 'second-person': true, restart: true },
});

const cleanBundle = { js: 'console.log("hi")', css: 'body{}', server: 'export default {}' };

describe('part G: publish safety — key scan', () => {
	test('a clean bundle (no team mode) is allowed', () => {
		const result = checkPublishSafety({
			outputId: 'out-1',
			...cleanBundle,
			savedKeyNames: ['WEATHER_API_KEY'],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(false);
		expect(result.findings).toHaveLength(0);
	});

	test('a bundle with a saved key VALUE in the browser code is refused', () => {
		// MUTATION: the real value "s3cr3t-weather-key-value" is shipped in dist/main.js.
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'const K = "s3cr3t-weather-key-value"; fetch("/x?key=" + K)',
			css: 'body{}',
			server: null,
			savedKeyNames: ['WEATHER_API_KEY'],
			savedKeyValues: ['s3cr3t-weather-key-value'],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'saved-key')).toBe(true);
	});

	test('a key-shaped string (sk-…) in the bundle is refused even if not a saved key', () => {
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'const token = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; void token;',
			css: 'body{}',
			server: null,
			savedKeyNames: [],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'key-shaped')).toBe(true);
	});

	test('a key-shaped string in the SERVER code is also refused', () => {
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'console.log(1)',
			css: 'body{}',
			server: 'const k = "AKIAIOSFODNN7EXAMPLE";',
			savedKeyNames: [],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.where.includes('server'))).toBe(true);
	});

	test('a short saved value (< 8 chars) is not treated as a key (no false refusal)', () => {
		// MUTATION PROOF of the length guard: a 3-char "value" must not refuse.
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'const mode = "dev";',
			css: 'body{}',
			server: null,
			savedKeyNames: ['MODE'],
			savedKeyValues: ['dev'],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(false);
	});
});

describe('part G: publish safety — team-mode receipt binding', () => {
	test('team mode with green receipts for THIS output is allowed', () => {
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: true,
			publishSafety: 'on',
			receipts: greenReceipts('out-42'),
		});
		expect(result.refused).toBe(false);
		expect(result.findings).toHaveLength(0);
	});

	test('team mode with no receipts at all is refused (missing-receipt)', () => {
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: true,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'missing-receipt')).toBe(true);
	});

	test('a GREEN receipt for ANOTHER output does not count (wrong-output)', () => {
		// MUTATION: receipts are green, but they belong to out-7, not out-42.
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: true,
			publishSafety: 'on',
			receipts: greenReceipts('out-7'),
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'wrong-output')).toBe(true);
	});

	test('a RED check (restart not green) on this output is refused', () => {
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: true,
			publishSafety: 'on',
			receipts: { outputId: 'out-42', checks: { 'sign-in': true, 'second-person': true, restart: false } },
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'red-receipt' && f.where === 'restart')).toBe(true);
	});

	test('a NON-team-mode app does not need receipts', () => {
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(false);
	});
});

describe('part G: publish safety — kill switch', () => {
	test('publish_safety=off logs the findings but does not refuse', () => {
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'const token = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";',
			css: 'body{}',
			server: null,
			savedKeyNames: [],
			teamMode: true, // even in team mode with no receipts
			publishSafety: 'off',
			receipts: null,
		});
		expect(result.refused).toBe(false);
		expect(result.findings.length).toBeGreaterThan(0); // still computed for logging
		expect(result.message).toContain('Publish safety is off');
	});
});

describe('part G: app key name shape', () => {
	test('WEATHER_API_KEY is a valid app-key name; a lowercase one is not', () => {
		expect(isAppKeyName('WEATHER_API_KEY')).toBe(true);
		expect(isAppKeyName('weatherApiKey')).toBe(false);
	});
});
