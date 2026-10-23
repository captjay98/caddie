import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';
import {
	CONTEXT_WINDOW_ESTIMATE_CAP,
	D4_LIMIT_MICROS,
	MICROS_PER_UNIT,
	buildPayerId,
	costliestRoute,
	createBuildPayer,
	estimateCallMicros,
	openBuildPayer,
	payerLimitMicros,
	release,
	reserve,
	resolveBuildLimitMicros,
	routeByModelId,
	settle,
	settleMicrosFromCost,
	spendCapMicros,
	spendSnapshot,
} from '../apps/app/src/server/build-spend.ts';
import { findModelRouteForRole, MODEL_ROUTES } from '../apps/app/src/agents/providers.ts';
import { readFileSync } from 'node:fs';

/**
 * Part A — the money logic of the spending limit (plan §A), against a REAL
 * migrated D1 (bun:sqlite with the migration-0040 trigger live), so the atomic
 * over-limit refusal is genuinely exercised, not mocked.
 *
 * LOCAL VERIFIED. Not evidence about production D1 itself — the same statement
 * surface, run over bun:sqlite.
 */

const CHAT = findModelRouteForRole('chat'); // Super VL, $0.30 in / $0.90 out per Mtok

/** Mark a user as an active judge account (what isJudgeAccount reads). */
function makeJudge(sqlite: Database, userId: string): void {
	const now = new Date().toISOString();
	sqlite
		.prepare('insert into "judge_accounts" ("judgeName","userId","state","createdAt","lastSignInAt") values (?,?,?,?,?)')
		.run(`judge-${userId}`, userId, 'active', now, null);
}

describe('Part A — build-spend money logic (trigger-enforced D1)', () => {
	let sqlite: Database;
	let db: D1Database;

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
	});
	afterEach(() => sqlite.close());

	// --- payer per build start, incl. judge and big-app limits ----------------

	test('a payer is created per build start with the D4 limit; judge and big-app differ', async () => {
		addUser(sqlite, 'u-owner', 'owner@example.com');
		addUser(sqlite, 'u-judge', 'judge@example.com');
		makeJudge(sqlite, 'u-judge');

		// Owner / invited: $5.
		const owner = await openBuildPayer(db, { runId: 'run-owner', actorId: 'u-owner', bigApps: false });
		expect(owner.limitMicros).toBe(D4_LIMIT_MICROS.standard);
		expect(owner.limitMicros).toBe(5 * MICROS_PER_UNIT);
		expect(await payerLimitMicros(db, owner.payerId)).toBe(5 * MICROS_PER_UNIT);

		// Judge: $2.
		const judge = await openBuildPayer(db, { runId: 'run-judge', actorId: 'u-judge', bigApps: false });
		expect(judge.limitMicros).toBe(D4_LIMIT_MICROS.judge);
		expect(judge.limitMicros).toBe(2 * MICROS_PER_UNIT);

		// Big app (owner): $40 — overrides the judge rate too.
		const big = await openBuildPayer(db, { runId: 'run-big', actorId: 'u-owner', bigApps: true });
		expect(big.limitMicros).toBe(D4_LIMIT_MICROS.bigApp);
		expect(big.limitMicros).toBe(40 * MICROS_PER_UNIT);
		const bigJudge = await resolveBuildLimitMicros(db, 'u-judge', { bigApps: true });
		expect(bigJudge).toBe(40 * MICROS_PER_UNIT); // big-app wins over judge

		// The payer id ties to the run and is time-stamped (a retry is a new payer).
		expect(buildPayerId('run-x', new Date(1000))).toBe('build:run-x:1000');
		expect(owner.payerId.startsWith('build:run-owner:')).toBe(true);
	});

	test('an operator cap (SPEND_LIMIT_CAP_USD) only ever LOWERS a build limit', async () => {
		addUser(sqlite, 'u-cap', 'cap@example.com');
		expect(spendCapMicros({ SPEND_LIMIT_CAP_USD: '0.75' })).toBe(750_000);
		expect(spendCapMicros({ SPEND_LIMIT_CAP_USD: ' 2 ' })).toBe(2 * MICROS_PER_UNIT);
		// Unset, malformed, zero or negative: no cap at all.
		for (const bad of [undefined, '', 'abc', '-1', '0', '0.0', '1e3', '0.5x', 3]) {
			expect(spendCapMicros({ SPEND_LIMIT_CAP_USD: bad })).toBeNull();
		}
		expect(spendCapMicros(null)).toBeNull();
		expect(spendCapMicros(undefined)).toBeNull();

		const capped = await openBuildPayer(db, { runId: 'run-cap', actorId: 'u-cap', bigApps: false, capMicros: 750_000 });
		expect(capped.limitMicros).toBe(750_000);
		expect(await payerLimitMicros(db, capped.payerId)).toBe(750_000);
		// MUTATION PROOF: use the cap as the limit (not the smaller of the two)
		// and a cap above the D4 limit would RAISE it.
		const high = await openBuildPayer(db, { runId: 'run-high', actorId: 'u-cap', bigApps: false, capMicros: 99 * MICROS_PER_UNIT });
		expect(high.limitMicros).toBe(D4_LIMIT_MICROS.standard);
		const none = await openBuildPayer(db, { runId: 'run-none', actorId: 'u-cap', bigApps: false, capMicros: null });
		expect(none.limitMicros).toBe(D4_LIMIT_MICROS.standard);
	});

	test('createBuildPayer is idempotent — a replay never resets the limit', async () => {
		await createBuildPayer(db, 'build:p:1', 5 * MICROS_PER_UNIT);
		await createBuildPayer(db, 'build:p:1', 999 * MICROS_PER_UNIT); // ignored
		expect(await payerLimitMicros(db, 'build:p:1')).toBe(5 * MICROS_PER_UNIT);
	});

	// --- the estimate ---------------------------------------------------------

	test('estimateCallMicros: request size at 1 token/2 chars + route maxTokens, at route rates', () => {
		// 2000 request chars -> 1000 input tokens. Super VL $0.30/Mtok in -> each
		// token 0.30/100 = 0.003 micros; 1000 * 0.003 = 3 micros input.
		// output = maxTokens (8192) * 0.90/100 = 8192 * 0.009 = 73.728 -> ceil.
		const withReq = estimateCallMicros(CHAT, 2000);
		const expectedInput = 1000 * (CHAT.inputPriceMinorUnits / 100);
		const expectedOutput = CHAT.maxTokens * (CHAT.outputPriceMinorUnits / 100);
		expect(withReq).toBe(Math.ceil(expectedInput + expectedOutput));

		// No request yet -> input falls back to the context window capped at 200k.
		const fallback = estimateCallMicros(CHAT, undefined);
		const cappedInput = Math.min(CHAT.contextWindow, CONTEXT_WINDOW_ESTIMATE_CAP);
		expect(fallback).toBe(Math.ceil(cappedInput * (CHAT.inputPriceMinorUnits / 100) + expectedOutput));
		expect(fallback).toBeGreaterThan(withReq); // the fallback is the worst case
	});

	test('settleMicrosFromCost: currency-unit cost -> micros, rounded up', () => {
		expect(settleMicrosFromCost(1.2)).toBe(1_200_000);
		expect(settleMicrosFromCost(0.0000011)).toBe(2); // 1.1 micros -> ceil 2
		expect(settleMicrosFromCost(0)).toBe(0);
		expect(settleMicrosFromCost(undefined)).toBe(0);
	});

	test('routeByModelId resolves a frozen route and rejects an unknown id', () => {
		expect(routeByModelId(CHAT.modelId)?.id).toBe(CHAT.id);
		expect(routeByModelId('nope/not-a-model')).toBeNull();
		expect(routeByModelId(undefined)).toBeNull();
	});

	// --- reserve / settle / release -------------------------------------------

	test('reserve then settle then a payer snapshot adds up; release hands the estimate back', async () => {
		await createBuildPayer(db, 'build:p:1', 5 * MICROS_PER_UNIT);

		expect((await reserve(db, { payerId: 'build:p:1', turnId: 't1', conversationId: 'c', estimateMicros: 1_000_000 })).outcome).toBe('reserved');
		let snap = await spendSnapshot(db, 'build:p:1');
		expect(snap.reservedMicros).toBe(1_000_000);
		expect(snap.settledMicros).toBe(0);

		await settle(db, 't1', 300_000); // the call actually cost $0.30
		snap = await spendSnapshot(db, 'build:p:1');
		expect(snap.settledMicros).toBe(300_000);
		// Settled rows no longer count as open reservation.
		expect(snap.reservedMicros).toBe(0);

		// A second reservation that is then released frees its estimate.
		expect((await reserve(db, { payerId: 'build:p:1', turnId: 't2', conversationId: 'c', estimateMicros: 2_000_000 })).outcome).toBe('reserved');
		expect((await spendSnapshot(db, 'build:p:1')).reservedMicros).toBe(2_000_000);
		await release(db, 't2');
		expect((await spendSnapshot(db, 'build:p:1')).reservedMicros).toBe(0);
	});

	test('a duplicate turnId never double-counts (idempotent reserve)', async () => {
		await createBuildPayer(db, 'build:p:1', 5 * MICROS_PER_UNIT);
		expect((await reserve(db, { payerId: 'build:p:1', turnId: 'dup', conversationId: 'c', estimateMicros: 1_000_000 })).outcome).toBe('reserved');
		// The interceptor fires again for the SAME turnId (S1: ~8× per turn).
		for (let i = 0; i < 7; i++) {
			const r = await reserve(db, { payerId: 'build:p:1', turnId: 'dup', conversationId: 'c', estimateMicros: 1_000_000 });
			expect(r.outcome).toBe('duplicate'); // NOT refused, NOT a second reserve
		}
		// Only ONE reservation's worth of micros is held.
		expect((await spendSnapshot(db, 'build:p:1')).reservedMicros).toBe(1_000_000);
	});

	// --- the hard limit (the migration-0040 trigger) --------------------------

	test('a reservation is refused at the limit; settled + reserved + estimate > limit', async () => {
		await createBuildPayer(db, 'build:p:1', 5 * MICROS_PER_UNIT); // $5

		// Spend $4 (settled) + reserve $0.90 open = $4.90. Another $0.90 -> $5.80 > $5: refused.
		expect((await reserve(db, { payerId: 'build:p:1', turnId: 'a', conversationId: 'c', estimateMicros: 4_000_000 })).outcome).toBe('reserved');
		await settle(db, 'a', 4_000_000);
		expect((await reserve(db, { payerId: 'build:p:1', turnId: 'b', conversationId: 'c', estimateMicros: 900_000 })).outcome).toBe('reserved');
		const refused = await reserve(db, { payerId: 'build:p:1', turnId: 'c', conversationId: 'c', estimateMicros: 900_000 });
		expect(refused.outcome).toBe('refused');
		// Nothing was written for the refused turn.
		expect((await spendSnapshot(db, 'build:p:1')).settledMicros).toBe(4_000_000);
	});

	test('a payer with NO limit row fails closed — the trigger refuses the reserve', async () => {
		// Part A always creates the limit row first; a missing one is a bug, and
		// the trigger (limit reads as -1) refuses rather than letting a call through.
		const r = await reserve(db, { payerId: 'build:missing', turnId: 't', conversationId: 'c', estimateMicros: 1 });
		expect(r.outcome).toBe('refused');
	});

	test('two simultaneous reservations never exceed the limit (the trigger serializes)', async () => {
		await createBuildPayer(db, 'build:p:1', 5 * MICROS_PER_UNIT); // $5
		// Each reserve is $3. Two fit $6 > $5, so exactly ONE may succeed. The
		// trigger evaluates settled+reserved+estimate inside each INSERT, and
		// bun:sqlite serializes writes, so the second sees the first's row.
		const first = await reserve(db, { payerId: 'build:p:1', turnId: 'x1', conversationId: 'c', estimateMicros: 3_000_000 });
		const second = await reserve(db, { payerId: 'build:p:1', turnId: 'x2', conversationId: 'c', estimateMicros: 3_000_000 });
		const outcomes = [first.outcome, second.outcome].sort();
		expect(outcomes).toEqual(['refused', 'reserved']);
		// The held reservation never exceeds the limit.
		const snap = await spendSnapshot(db, 'build:p:1');
		expect(snap.reservedMicros + snap.settledMicros).toBeLessThanOrEqual(snap.limitMicros!);
		expect(snap.reservedMicros).toBe(3_000_000);
	});
});

describe('Part A — a call on an unknown model route is never unpriced (lead fix)', () => {
	test('costliestRoute is the route with the highest worst-case estimate', () => {
		const top = costliestRoute();
		for (const route of MODEL_ROUTES) {
			expect(estimateCallMicros(top, undefined)).toBeGreaterThanOrEqual(estimateCallMicros(route, undefined));
		}
		// MUTATION PROOF: pick the cheapest instead and this fails.
		const cheapest = Math.min(...MODEL_ROUTES.map((r) => estimateCallMicros(r, undefined)));
		expect(estimateCallMicros(top, undefined)).toBeGreaterThan(cheapest);
	});

	test('the interceptor prices an unresolved route at the costliest route instead of passing it through', () => {
		const source = readFileSync(new URL('../apps/app/src/server/spend-instrument.ts', import.meta.url), 'utf8');
		// MUTATION PROOF: restore the unpriced pass-through and this fails.
		expect(source).not.toContain('if (!resolvedRoute) return next();');
		expect(source).toContain('resolvedRoute ?? costliestRoute()');
	});
});
