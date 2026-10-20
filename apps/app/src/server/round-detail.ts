import { parseTestCounts } from './build-timeline.ts';

/**
 * Check history in words (plan 3.3). A failed repair round once stored the
 * check's raw result as JSON, and the build view showed it after "Tried a
 * fix —". New rows store the sentence written here; rows stored before are
 * worded when read. Raw JSON is never shown.
 */

/** Caddie's own checks, in plain words. */
const CHECK_WORDS: Readonly<Record<string, string>> = {
	'app-setup': "Preparing the app's folder",
	dependencies: "Installing the app's packages",
	'behavior-tests': "The app's own tests",
	'browser-bundle': 'Building the app',
	'server-starts': "Starting the app's server",
};

/** One check result as a sentence ("The app's own tests: 7 of 9 passed."). */
export function checkSentence(receipt: { check?: unknown; passed?: unknown; stdout?: unknown; stderr?: unknown }): string {
	if (receipt.check === 'behavior-tests') {
		const counts = parseTestCounts(`${String(receipt.stdout ?? '')}\n${String(receipt.stderr ?? '')}`);
		if (counts && counts.passed + counts.failed > 0) {
			return `The app's own tests: ${counts.passed} of ${counts.passed + counts.failed} passed.`;
		}
	}
	const name = typeof receipt.check === 'string' ? CHECK_WORDS[receipt.check] : undefined;
	const passed = receipt.passed === true;
	if (!name) return passed ? 'A check passed.' : 'A check failed.';
	return `${name} ${passed ? 'worked' : 'failed'}.`;
}

/** The rule that each feature adds a passing test, as a sentence. */
export function newTestsSentence(passing: number, baseline: number): string {
	return passing < baseline
		? `Fewer of the app's tests pass than before this feature (${passing}, was ${baseline}).`
		: `This feature has no new passing test yet (${passing} passing, the same as before).`;
}

/** A stored round detail as one plain line, or null when there is nothing worth showing. */
export function roundDetailText(detail: string | null): string | null {
	const text = detail?.trim() ?? '';
	if (!text) return null;
	if (!/^[{[]/.test(text)) return text.length > 300 ? `${text.slice(0, 299)}…` : text;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.check === 'string') return checkSentence(record);
	if (typeof record.passing === 'number' && typeof record.baseline === 'number') return newTestsSentence(record.passing, record.baseline);
	return null;
}
