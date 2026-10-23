import { describe, expect, test } from 'bun:test';
import {
	appendRun,
	emptyLedger,
	ledgerSpentMicros,
	memoryLedgerStore,
	type LedgerRunRecord,
} from '../scripts/brief-run/ledger.ts';

/** LANE 8 STEP 5 — the campaign ledger, driven with an in-memory store (no disk). */

const USD = 1_000_000;

function record(over: Partial<LedgerRunRecord> = {}): LedgerRunRecord {
	return {
		at: '2026-10-26T12:00:00.000Z',
		briefId: 'moodloop',
		size: 'small',
		mode: 'team',
		buildLimitMicros: 5 * USD,
		capMicros: 150 * USD,
		spentBeforeMicros: 0,
		capAllowed: true,
		capReason: 'allowed',
		buildSpentMicros: 3 * USD,
		complete: true,
		completeReason: 'every gate green',
		stopReason: 'ready',
		...over,
	};
}

describe('ledger append + read (step 5)', () => {
	test('appends a run and persists it, recording the mode', async () => {
		const store = memoryLedgerStore();
		const led = appendRun(store, 150 * USD, record({ mode: 'baseline' }));
		expect(led.runs.length).toBe(1);
		expect(led.runs[0].mode).toBe('baseline');
		expect(store.read()!.runs.length).toBe(1);
	});

	test('two runs accumulate; ledgerSpentMicros sums build spend', () => {
		const store = memoryLedgerStore();
		appendRun(store, 150 * USD, record({ briefId: 'a', buildSpentMicros: 3 * USD }));
		const led = appendRun(store, 150 * USD, record({ briefId: 'b', buildSpentMicros: 4 * USD }));
		expect(led.runs.length).toBe(2);
		expect(ledgerSpentMicros(led)).toBe(7 * USD);
	});

	test('a build that never started (null spend) counts as zero spend', () => {
		const store = memoryLedgerStore();
		const led = appendRun(store, 150 * USD, record({ buildSpentMicros: null }));
		expect(ledgerSpentMicros(led)).toBe(0);
	});

	test('a campaign keeps one cap: a mismatched cap on a later run is refused', () => {
		const store = memoryLedgerStore();
		appendRun(store, 150 * USD, record());
		expect(() => appendRun(store, 200 * USD, record())).toThrow(/cap mismatch/);
	});

	test('emptyLedger pins the cap and starts with no runs', () => {
		const led = emptyLedger(150 * USD);
		expect(led.cap_micros).toBe(150 * USD);
		expect(led.runs).toEqual([]);
	});

	test('a refused-by-cap run is recorded too (audit of what did NOT run)', () => {
		const store = memoryLedgerStore();
		const led = appendRun(
			store,
			150 * USD,
			record({ capAllowed: false, capReason: 'cap would be exceeded', buildSpentMicros: null, complete: false }),
		);
		expect(led.runs[0].capAllowed).toBe(false);
		expect(ledgerSpentMicros(led)).toBe(0);
	});
});
