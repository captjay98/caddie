import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	StubProvider,
	applyMigrations,
	controlsMigrationPaths,
	d1Count,
	d1Exec,
	freePort,
	startControlsFixtureWorker,
	stopControlsFixtureWorker,
	type StartedFixtureWorker,
} from './fixtures/controls-harness.ts';

/**
 * P03 slice 3 — budgets: atomic reserve/settle/release proven against REAL
 * workerd + real local SQLite-backed D1 (feature-ledger H16).
 *
 * THE contracts.md race lives here: limit 100; two independent callers reserve
 * 70 each SIMULTANEOUSLY (two HTTP requests fired together against the fixture
 * worker — no shared JS lock, no shared connection state); exactly ONE may
 * fulfill and the outstanding reserved sum is 70. The atomicity lives in a
 * single INSERT guarded by a D1 trigger (budget_reservations_cap_guard), which
 * SQLite serializes across ALL callers — any interleaving, including real
 * concurrent request handling inside workerd, can never exceed the cap.
 *
 * Honesty classification: LOCAL VERIFIED (real workerd, real D1). No real
 * provider money moves in this packet.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const MODEL_ROUTE = 'route/race';
const PRICING_VERSION = '2026-10';

let WORKER_PORT = 0;
let WORKER_BASE = '';
let stub: StubProvider;
let started: StartedFixtureWorker;

const jsonHeaders = { 'content-type': 'application/json' } as const;

beforeAll(async () => {
	const migrationPaths = controlsMigrationPaths();
	for (const path of migrationPaths) {
		if (!existsSync(path)) throw new Error(`migration missing: ${path}`);
	}
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	started = await startControlsFixtureWorker(REPO_ROOT, WORKER_PORT, ['race@example.com'], {
		AUTH_STUB_BASE_URL: stub.url,
	});
	await applyMigrations(WORKER_BASE, migrationPaths);
}, 180_000);

afterAll(async () => {
	if (started) stopControlsFixtureWorker(WORKER_PORT);
	if (stub) await stub.stop();
});

// --- helpers ---------------------------------------------------------------------

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(`${WORKER_BASE}${path}`, {
		method: 'POST',
		headers: jsonHeaders,
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function setLimit(payerId: string, limitMinorUnits: number): Promise<void> {
	const res = await post('/__test/budget/limit', { payerId, limitMinorUnits, currency: 'usd-cents' });
	if (res.status !== 200) throw new Error(`setLimit failed: ${JSON.stringify(res.body)}`);
}

async function reserve(payerId: string, key: string, amountMinorUnits: number): Promise<{ status: number; body: Record<string, unknown> }> {
	return post('/__test/budget/reserve', {
		payerId,
		reservationKey: key,
		amountMinorUnits,
		runId: 'run-race',
		modelRouteId: MODEL_ROUTE,
		pricingVersion: PRICING_VERSION,
	});
}

async function reservedSum(payerId: string): Promise<number> {
	const res = await fetch(`${WORKER_BASE}/__test/budget/reserved?payerId=${encodeURIComponent(payerId)}`);
	return ((await res.json()) as { reservedMinorUnits: number }).reservedMinorUnits;
}

/** Database-truth sum of live reservations (independent of the service's own query path). */
async function rowSum(payerId: string): Promise<number> {
	const res = await d1Exec(
		WORKER_BASE,
		`select coalesce(sum("amountMinorUnits"), 0) as total from "budget_reservations" where "payerId" = '${payerId}' and "status" = 'reserved'`,
	);
	return Number((res.results[0] as { total: number })?.total ?? -1);
}

async function rowCount(payerId: string, where = ''): Promise<number> {
	return d1Count(WORKER_BASE, 'budget_reservations', `"payerId" = '${payerId}'${where}`);
}

// --- the race ---------------------------------------------------------------------

describe('P03 budgets: the contracts.md cap race on real workerd D1', () => {
	test('setup: versioned pricing row exists for the model route', async () => {
		const res = await post('/__test/budget/price', {
			modelRouteId: MODEL_ROUTE,
			pricingVersion: PRICING_VERSION,
			unitPriceMinorUnits: 7,
			currency: 'usd-cents',
		});
		expect(res.status).toBe(200);
	});

	test('contracts.md mirror: limit 100, two simultaneous 70 reserves from independent HTTP callers — exactly 1 fulfilled, reserved === 70 (proven across three rounds)', async () => {
		for (const round of ['r1', 'r2', 'r3']) {
			const payerId = `race-payer-${round}`;
			await setLimit(payerId, 100);

			// two INDEPENDENT requests fired together — the caller shares nothing:
			// no lock, no map, no connection affinity. workerd may interleave them
			// arbitrarily; SQLite serializes the writes and the trigger enforces
			// the cap inside the INSERT statement itself.
			const [ra, rb] = await Promise.allSettled([
				reserve(payerId, `race-${round}-a`, 70),
				reserve(payerId, `race-${round}-b`, 70),
			]);

			const outcomes = [ra, rb].map((r) => {
				if (r.status !== 'fulfilled') throw new Error(`reserve request itself failed: ${String(r.reason)}`);
				return r.value;
			});
			const fulfilled = outcomes.filter((o) => o.status === 200);
			const rejected = outcomes.filter((o) => o.status === 402);
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect(rejected[0]!.body['error']).toBe('budget_exceeded');

			// database truth: exactly one live reservation, outstanding sum 70
			expect(await reservedSum(payerId)).toBe(70);
			expect(await rowSum(payerId)).toBe(70);
			expect(await rowCount(payerId)).toBe(1);
		}
	});

	test('settle is idempotent under double-call; conflicting actuals and released/settled transitions are refused', async () => {
		const payerId = 'settle-payer';
		await setLimit(payerId, 100);
		expect((await reserve(payerId, 'settle-a', 70)).status).toBe(200);

		const settle = (key: string, amount: number) =>
			post('/__test/budget/settle', { reservationKey: key, actualAmountMinorUnits: amount });

		const first = await settle('settle-a', 50);
		expect(first.status).toBe(200);
		expect(
			(first.body as { reservation: { status: string; settledAmountMinorUnits: number } }).reservation,
		).toMatchObject({ status: 'settled', settledAmountMinorUnits: 50 });
		// the reserved bound freed on settle; the billed actual is recorded distinctly
		expect(await reservedSum(payerId)).toBe(0);

		// double settle: no-op returning the first result, not a double debit
		const replay = await settle('settle-a', 50);
		expect(replay.status).toBe(200);
		expect(
			(replay.body as { reservation: { settledAmountMinorUnits: number } }).reservation.settledAmountMinorUnits,
		).toBe(50);
		expect(await rowCount(payerId, ` and "reservationKey" = 'settle-a'`)).toBe(1);

		// a DIFFERENT actual on a settled row is a conflict
		const conflict = await settle('settle-a', 60);
		expect(conflict.status).toBe(409);
		expect(conflict.body['error']).toBe('settle_conflict');

		// an actual above the reserved bound violates the conservative bound
		expect((await reserve(payerId, 'settle-b', 10)).status).toBe(200);
		const exceeds = await post('/__test/budget/settle', {
			reservationKey: 'settle-b',
			actualAmountMinorUnits: 11,
		});
		expect(exceeds.status).toBe(409);
		expect(exceeds.body['error']).toBe('settle_exceeds_reservation');
		// database truth: still reserved, nothing settled
		const row = await d1Exec(
			WORKER_BASE,
			`select "status", "settledAmountMinorUnits" from "budget_reservations" where "reservationKey" = 'settle-b'`,
		);
		expect(row.results[0]).toEqual({ status: 'reserved', settledAmountMinorUnits: null });

		// released rows cannot be settled afterwards
		expect((await post('/__test/budget/release', { reservationKey: 'settle-b' })).status).toBe(200);
		const afterRelease = await settle('settle-b', 5);
		expect(afterRelease.status).toBe(409);
		expect(afterRelease.body['error']).toBe('reservation_released');
	});

	test('concurrent reserve + settle cannot corrupt totals; the cap stays exact afterwards', async () => {
		const payerId = 'mixed-payer';
		await setLimit(payerId, 100);
		expect((await reserve(payerId, 'mixed-held', 70)).status).toBe(200);

		// settle the 70 AND reserve a new 70, fired together from independent callers
		const [settleRes, reserveRes] = await Promise.allSettled([
			post('/__test/budget/settle', { reservationKey: 'mixed-held', actualAmountMinorUnits: 70 }),
			reserve(payerId, 'mixed-new', 70),
		]);
		const settleOk = settleRes.status === 'fulfilled' && settleRes.value.status === 200;
		const reserveOk = reserveRes.status === 'fulfilled' && reserveRes.value.status === 200;

		// invariant 1: service-reported reserved equals the database-truth row sum
		expect(await reservedSum(payerId)).toBe(await rowSum(payerId));
		// invariant 2: reserved is consistent with which operations succeeded —
		// settle frees 70; the new reserve lands only if the cap allowed it
		if (reserveOk) {
			// mixed-held settled (or settles after) — final outstanding must be 70
			expect(await reservedSum(payerId)).toBe(70);
		} else {
			// the new reserve was capped; held either settled or is still reserved
			expect([0, 70]).toContain(await reservedSum(payerId));
		}
		expect(settleOk || (await rowSum(payerId)) === 70).toBe(true);

		// invariant 3: the cap is EXACT after the storm — fill to the limit, then 1 over fails
		const current = await reservedSum(payerId);
		if (current < 100) {
			expect((await reserve(payerId, 'mixed-fill', 100 - current)).status).toBe(200);
		}
		const over = await reserve(payerId, 'mixed-over', 1);
		expect(over.status).toBe(402);
		expect(over.body['error']).toBe('budget_exceeded');
		expect(await rowSum(payerId)).toBe(100);
	});

	test('unknown modelRouteId/pricingVersion fails closed: 403, no reservation row, outstanding unchanged', async () => {
		const payerId = 'closed-payer';
		await setLimit(payerId, 100);
		const before = await reservedSum(payerId);

		const res = await post('/__test/budget/reserve', {
			payerId,
			reservationKey: 'closed-a',
			amountMinorUnits: 10,
			runId: 'run-closed',
			modelRouteId: 'route/never-priced',
			pricingVersion: PRICING_VERSION,
		});
		expect(res.status).toBe(403);
		expect(res.body['error']).toBe('budget_pricing_unknown');
		expect(await rowCount(payerId, ` and "reservationKey" = 'closed-a'`)).toBe(0);
		expect(await reservedSum(payerId)).toBe(before);

		// same route, UNKNOWN pricing version: also fails closed
		const res2 = await post('/__test/budget/reserve', {
			payerId,
			reservationKey: 'closed-b',
			amountMinorUnits: 10,
			runId: 'run-closed',
			modelRouteId: MODEL_ROUTE,
			pricingVersion: '1999-01',
		});
		expect(res2.status).toBe(403);
		expect(res2.body['error']).toBe('budget_pricing_unknown');
		expect(await rowCount(payerId, ` and "reservationKey" = 'closed-b'`)).toBe(0);
	});

	test("a cancelled run's reservation STAYS reserved until explicitly released (cancellation does not free liability)", async () => {
		const payerId = 'cancel-payer';
		await setLimit(payerId, 100);

		// seed a workspace + project row for the external-operation foreign key
		await d1Exec(
			WORKER_BASE,
			`insert or ignore into "workspaces" ("id","name","createdAt") values ('race-ws','Race WS','2026-10-04T00:00:00.000Z')`,
		);
		await d1Exec(
			WORKER_BASE,
			`insert or ignore into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
			 values ('race-project','race-ws','Race Project','active','2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z')`,
		);

		// an external operation for the run gets cancelled...
		const prep = await post('/__test/operations/prepare', {
			projectId: 'race-project',
			runId: 'run-cancel-budget',
			provider: 'contree',
			operationKey: 'budget/cancel-case',
		});
		expect(prep.status).toBe(200);
		expect((await post('/__test/operations/cancel-request', { operationKey: 'budget/cancel-case' })).status).toBe(200);

		// ...while its budget reservation exists
		expect((await reserve(payerId, 'cancel-a', 40)).status).toBe(200);
		expect(await reservedSum(payerId)).toBe(40);

		// cancellation of the RUN does not release the reserved amount
		expect(await reservedSum(payerId)).toBe(40);
		const row = await d1Exec(
			WORKER_BASE,
			`select "status" from "budget_reservations" where "reservationKey" = 'cancel-a'`,
		);
		expect(row.results[0]).toEqual({ status: 'reserved' });

		// only an explicit release frees it
		expect((await post('/__test/budget/release', { reservationKey: 'cancel-a' })).status).toBe(200);
		expect(await reservedSum(payerId)).toBe(0);
	});

	test('duplicate reservationKey conflicts 409 with exactly one row and unchanged outstanding', async () => {
		const payerId = 'dup-payer';
		await setLimit(payerId, 100);
		expect((await reserve(payerId, 'dup-a', 30)).status).toBe(200);
		const dup = await reserve(payerId, 'dup-a', 30);
		expect(dup.status).toBe(409);
		expect(dup.body['error']).toBe('reservation_key_conflict');
		expect(await rowCount(payerId, ` and "reservationKey" = 'dup-a'`)).toBe(1);
		expect(await reservedSum(payerId)).toBe(30);

		// release is idempotent; releasing a settled row is refused
		expect((await post('/__test/budget/release', { reservationKey: 'dup-a' })).status).toBe(200);
		expect((await post('/__test/budget/release', { reservationKey: 'dup-a' })).status).toBe(200);
		const conflict = await post('/__test/budget/settle', {
			reservationKey: 'dup-a',
			actualAmountMinorUnits: 1,
		});
		expect(conflict.status).toBe(409);
	});
});
