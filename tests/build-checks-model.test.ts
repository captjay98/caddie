import { describe, expect, test } from 'bun:test';
import type { BuildFeatureView } from '@caddie/contracts';
import { attemptEntry, browserChecksInRun, failingChecks, partAttempts } from '../apps/app/src/client/project/build-checks-model.ts';

/**
 * The build activity dialog's Checks and Attempts views (owner 2026-10-30):
 * attempts grouped by part in plain words, identical runs folded, the failing
 * browser checks named. LOCAL VERIFIED: pure derivation over recorded rows.
 */

const feature = (id: string, title: string, position: number, status: BuildFeatureView['status'], doneWhen = 4): BuildFeatureView => ({
	id, title, position, status, doneWhen: Array.from({ length: doneWhen }, (_, i) => `${id} check ${i + 1}`), attempts: 0, testsPassed: null, passedAt: status === 'passed' ? '2026-10-30T10:05:00.000Z' : null, canRollBack: false,
});
const FEATURES = [
	feature('start-farm', 'Start your farm', 1, 'passed'),
	feature('log-eggs', 'Write down today’s eggs', 2, 'passed'),
	feature('see-days', 'See your days', 3, 'passed'),
	feature('odd-day-tip', 'Get a tip when a day looks unusual', 4, 'building'),
];
const BROWSER_DETAIL = `The host's independent checks failed (2). Each check starts on an empty app: a new person who has saved nothing yet. Route screens by location.hash.
1. “After a reload the same day shows its stored tip unchanged, and 'Look again' replaces it with a fresh answer” — the host did: open "#/farm" → press "Look again". It broke at: expected "205".
2. “When no tip can be produced, a plain message with a Try again button appears” — the host did: open "#/farm". It broke at: Try again not found.`;

describe('attempts read as plain rounds', () => {
	test('a builder’s own test run, a failed hand-in and a browser-check round each get their own words', () => {
		expect(attemptEntry({ issue: 'odd-day-tip:behavior-tests', round: 'diagnosis', outcome: 'failed', detail: "The app's own tests: 81 of 84 passed.", at: '2026-10-30T12:15:05.000Z' }))
			.toMatchObject({ kind: 'own-tests', title: 'Ran its own tests', summary: '81 of 84 passed', outcome: 'failed' });
		expect(attemptEntry({ issue: 'start-farm:behavior-tests', round: 'repair_attempt', outcome: 'failed', detail: "The app's own tests: 1 of 4 passed.", at: '2026-10-30T03:13:20.000Z' }))
			.toMatchObject({ title: 'Fix handed in: its own tests', summary: '1 of 4 passed' });
		const browser = attemptEntry({ issue: 'odd-day-tip:independent-criteria', round: 'repair_attempt', outcome: 'failed', detail: BROWSER_DETAIL, at: '2026-10-30T12:17:40.000Z' });
		expect(browser).toMatchObject({ kind: 'browser-checks', title: 'Caddie’s browser checks', summary: '2 failed' });
		expect(browser.failing).toEqual([
			"After a reload the same day shows its stored tip unchanged, and 'Look again' replaces it with a fresh answer",
			'When no tip can be produced, a plain message with a Try again button appears',
		]);
	});
	test('failing checks are found when the newlines were folded to spaces', () => {
		expect(failingChecks(BROWSER_DETAIL.replace(/\s+/g, ' '))).toHaveLength(2);
	});
	test('the rules preamble never becomes a failing check', () => {
		expect(failingChecks('The host\'s independent checks failed (1). Each check starts on an empty app.')).toEqual([]);
	});
	test('a raw recorded payload stays raw', () => {
		expect(attemptEntry({ issue: 'feature-2:browser-bundle', round: 'repair_attempt', outcome: 'failed', detail: '{"check":"browser-bundle","exitCode":1}', at: '2026-10-30T12:00:00.000Z' }))
			.toMatchObject({ title: 'Build for the browser', raw: true, summary: 'Failed' });
	});
});

describe('attempts are grouped by part, newest part first', () => {
	const rounds = [
		{ issue: 'see-days:behavior-tests', round: 'diagnosis', outcome: 'failed', detail: "The app's own tests: 49 of 51 passed.", at: '2026-10-30T11:03:54.000Z' },
		{ issue: 'odd-day-tip:behavior-tests', round: 'diagnosis', outcome: 'failed', detail: "The app's own tests: 58 of 59 passed.", at: '2026-10-30T12:15:37.000Z' },
		{ issue: 'odd-day-tip:behavior-tests', round: 'diagnosis', outcome: 'failed', detail: "The app's own tests: 58 of 59 passed.", at: '2026-10-30T12:16:28.000Z' },
		{ issue: 'odd-day-tip:behavior-tests', round: 'diagnosis', outcome: 'failed', detail: "The app's own tests: 58 of 59 passed.", at: '2026-10-30T12:17:56.000Z' },
		{ issue: 'odd-day-tip:independent-criteria', round: 'repair_attempt', outcome: 'failed', detail: BROWSER_DETAIL, at: '2026-10-30T12:20:00.000Z' },
		{ issue: 'odd-day-tip:behavior-tests', round: 'diagnosis', outcome: 'failed', detail: "The app's own tests: 86 of 87 passed.", at: '2026-10-30T12:24:05.000Z' },
	];
	const parts = partAttempts({ rounds, features: FEATURES });
	test('the part being built leads, with its real title, run counts and latest results', () => {
		expect(parts.map((part) => part.featureId)).toEqual(['odd-day-tip', 'see-days']);
		const tip = parts[0]!;
		expect(tip).toMatchObject({ title: 'Get a tip when a day looks unusual', status: 'building', ownRuns: 4, browserRuns: 1 });
		expect(tip.latestOwn).toEqual({ passed: 86, total: 87, at: '2026-10-30T12:24:05.000Z' });
		expect(tip.latestBrowser).toMatchObject({ failed: 2 });
		expect(tip.latestBrowser!.failing).toHaveLength(2);
	});
	test('identical runs in a row show once with a count', () => {
		const tip = parts[0]!;
		expect(tip.entries.map((entry) => [entry.summary, entry.repeats])).toEqual([
			['86 of 87 passed', 1],
			['2 failed', 1],
			['58 of 59 passed', 3],
		]);
	});
	test('a hand-in re-runs every finished part’s browser checks plus its own', () => {
		expect(browserChecksInRun(FEATURES, 'odd-day-tip')).toBe(16);
		expect(browserChecksInRun(FEATURES, 'start-farm')).toBe(4);
		expect(browserChecksInRun(FEATURES, 'nope')).toBeNull();
	});
});
