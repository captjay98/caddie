import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
	type BootedRaw,
	type FlueEvent,
	type FlueExecutionContext,
	type FlueExecutionOperation,
	type FlueInstrumentation,
	AgentRunError,
	bootRaw,
	init,
	Coordinator,
	Worker,
} from '../apps/app/test-support/spend-harness.ts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { migratedDatabase } from './fixtures/sqlite-d1.ts';
import { createBuildPayer, MICROS_PER_UNIT, spendSnapshot } from '../apps/app/src/server/build-spend.ts';
import {
	_resetPayerRegistry,
	makeSpendInstrumentation,
	registerBuildPayer,
	registerBuildPayerForInstance,
	resolveTurnPayer,
} from '../apps/app/src/server/spend-instrument.ts';

/**
 * Part A — the instrument() wiring, against REAL Flue agents and a REAL
 * migrated D1 (the migration-0040 trigger live). Proves the reserve-before /
 * settle-after / release-on-error behaviour end to end, the pass-through with
 * no payer, the duplicate-turnId dedupe, the delegate-charges-coordinator
 * lineage, and the kill switch. The money logic itself is unit-tested in
 * build-spend.test.ts; this proves the runtime seam calls it correctly.
 *
 * LOCAL VERIFIED. Not evidence about the live Cloudflare getCloudflareContext
 * D1 path (needs workerd) — that is deferred per the plan; here the DB handle
 * comes through the install closure, which S1 proved is how the interceptor
 * reaches D1.
 */

const PAYER = 'build:run-itest:1';

/**
 * Wrap part A's instrumentation so the FIRST model call registers the turn's
 * conversationId AND instanceId against the payer — exactly what
 * coordinator-host does when it opens the payer. (It cannot be pre-registered:
 * Flue assigns its own conversationId at runtime.) After registration the real
 * resolveTurnPayer finds the payer for every turn of the build, including a
 * delegate's (same instanceId, different conversationId).
 */
function registeringInstrumentation(base: FlueInstrumentation, payerId: string): FlueInstrumentation {
	let registered = false;
	return {
		observe: base.observe,
		interceptor: async <T>(op: FlueExecutionOperation, ctx: FlueExecutionContext, next: () => Promise<T>): Promise<T> => {
			if (op.type === 'model' && !registered) {
				registered = true;
				if (ctx.instanceId) registerBuildPayerForInstance(ctx.instanceId, payerId);
				if (ctx.conversationId) registerBuildPayer(ctx.conversationId, payerId);
			}
			return base.interceptor(op, ctx, next);
		},
		dispose: base.dispose,
	};
}

describe('Part A — spend instrument wiring (real agents, real D1)', () => {
	let sqlite: Database;
	let db: D1Database;
	let booted: BootedRaw | null = null;

	beforeEach(() => {
		_resetPayerRegistry();
		({ sqlite, db } = migratedDatabase());
	});
	afterEach(async () => {
		if (booted) {
			await booted.stop();
			booted = null;
		}
		sqlite.close();
	});

	test('no payer: the call passes straight through and nothing is reserved', async () => {
		// No registration, no build_workflows row -> resolveTurnPayer returns null.
		const inst = makeSpendInstrumentation({ db });
		booted = await bootRaw({ instrumentation: inst, script: [{ text: 'done', input: 10, output: 5 }] });
		const c = init(Coordinator, { id: 'conv-nopayer' });
		await c.read(await c.dispatch('go'));
		// The call ran; no reservation rows exist for any payer.
		const rows = (await db.prepare('select count(*) as n from "build_spend_reservations"').all<{ n: number }>()).results[0];
		expect(rows.n).toBe(0);
		expect(booted.sp.callCount()).toBe(1);
	});

	test('with a payer: a call reserves before, then settles from the turn usage', async () => {
		await createBuildPayer(db, PAYER, 5 * MICROS_PER_UNIT);
		const inst = registeringInstrumentation(makeSpendInstrumentation({ db }), PAYER);
		booted = await bootRaw({ instrumentation: inst, script: [{ text: 'done', input: 200_000, output: 100_000 }] });

		const c = init(Coordinator, { id: 'conv-withpayer' });
		await c.read(await c.dispatch('go'));

		// Exactly ONE reservation despite the interceptor firing many times per turn.
		const reservations = (await db.prepare('select "turnId","status","settledMicros" from "build_spend_reservations"').all<{ turnId: string; status: string; settledMicros: number }>()).results;
		expect(reservations.length).toBe(1);
		expect(reservations[0].status).toBe('settled');
		// Super VL: 0.2 Mtok in ($0.06) + 0.1 Mtok out ($0.09) = $0.15. pi-ai
		// computes the cost in floating point, so turn.usage.cost.total can be a
		// hair above $0.15; Math.ceil(total * 1e6) is the fail-closed rounding, so
		// the settled micros is 150000 or (with float drift) 150001 — never less.
		expect(reservations[0].settledMicros).toBeGreaterThanOrEqual(150_000);
		expect(reservations[0].settledMicros).toBeLessThanOrEqual(150_001);
		const snap = await spendSnapshot(db, PAYER);
		expect(snap.settledMicros).toBe(reservations[0].settledMicros);
		expect(snap.reservedMicros).toBe(0); // settled no longer counts as open
	});

	test('refusal at the limit: the call throws, sets the blocker, and never reaches the provider', async () => {
		await createBuildPayer(db, PAYER, 1_000); // $0.001 — far below any call estimate
		const blockers: Array<{ payerId: string; message: string }> = [];
		const inst = registeringInstrumentation(
			makeSpendInstrumentation({ db, setBlocker: (payerId, message) => void blockers.push({ payerId, message }) }),
			PAYER,
		);
		booted = await bootRaw({ instrumentation: inst, script: [{ text: 'never', input: 10, output: 5 }] });

		const c = init(Coordinator, { id: 'conv-blocked' });
		let failed = false;
		try {
			await c.read(await c.dispatch('go'));
		} catch (error) {
			failed = true;
			expect(error).toBeInstanceOf(AgentRunError);
			expect((error as AgentRunError).outcome).toBe('failed');
		}
		expect(failed).toBe(true);
		// The provider was never called — the reservation was refused before next().
		expect(booted.sp.callCount()).toBe(0);
		// The blocker was set with the plan's message naming the $ limit.
		expect(blockers.length).toBeGreaterThanOrEqual(1);
		expect(blockers[0].payerId).toBe(PAYER);
		expect(blockers[0].message).toContain('spending limit of $0.00');
		expect(blockers[0].message).toContain('Your plan and files are saved.');
		// No reserved row survived (the refused insert wrote nothing).
		expect((await spendSnapshot(db, PAYER)).reservedMicros).toBe(0);
	});

	test('a turn that errors releases its reservation (release path)', async () => {
		await createBuildPayer(db, PAYER, 5 * MICROS_PER_UNIT);
		// Script a provider error so the turn settles with isError: true but AFTER
		// the reserve (the reserve happens in the interceptor before next(); the
		// error happens inside next()). An unscripted call index triggers the
		// scripted provider's error path.
		const inst = registeringInstrumentation(makeSpendInstrumentation({ db }), PAYER);
		booted = await bootRaw({ instrumentation: inst, script: [] }); // call #0 has no reply -> error turn

		const c = init(Coordinator, { id: 'conv-release' });
		try {
			await c.read(await c.dispatch('go'));
		} catch {
			// The errored turn may surface as a failed submission; either way the
			// reservation must be released, not left reserved or settled.
		}
		const rows = (await db.prepare('select "status" from "build_spend_reservations"').all<{ status: string }>()).results;
		// A reservation was made then released (nothing settled, nothing still open).
		expect(rows.length).toBe(1);
		expect(rows[0].status).toBe('released');
		expect((await spendSnapshot(db, PAYER)).reservedMicros).toBe(0);
	});

	// FINDING #5 (review 2026-10-23): isError is diagnostic, not proof no paid
	// work happened. A turn that billed real tokens and THEN errored must SETTLE
	// that real cost, not refund it — otherwise repeated paid errors evade the
	// build limit. (The release-path test above is the other case: an error with
	// NO billable cost still releases.)
	test('a turn that errors AFTER billing real tokens settles that cost, never refunds it', async () => {
		await createBuildPayer(db, PAYER, 5 * MICROS_PER_UNIT);
		const inst = registeringInstrumentation(makeSpendInstrumentation({ db }), PAYER);
		// 0.2 Mtok in + 0.1 Mtok out = $0.15 of real billed usage, then isError.
		booted = await bootRaw({
			instrumentation: inst,
			script: [{ text: 'partial', input: 200_000, output: 100_000, errorAfterUsage: true }],
		});

		const c = init(Coordinator, { id: 'conv-error-with-cost' });
		try {
			await c.read(await c.dispatch('go'));
		} catch {
			// The errored turn may surface as a failed submission; the reservation
			// must be SETTLED at the real cost regardless.
		}
		const rows = (await db.prepare('select "status","settledMicros" from "build_spend_reservations"').all<{ status: string; settledMicros: number }>()).results;
		expect(rows.length).toBe(1);
		expect(rows[0].status).toBe('settled'); // NOT released
		expect(rows[0].settledMicros).toBeGreaterThanOrEqual(150_000);
		expect(rows[0].settledMicros).toBeLessThanOrEqual(150_001);
		// The real cost is counted toward the limit, so it is not refundable.
		expect((await spendSnapshot(db, PAYER)).settledMicros).toBeGreaterThanOrEqual(150_000);
	});

	test('kill switch: spend_enforcement=off records nothing-refused — an over-limit call passes through', async () => {
		await createBuildPayer(db, PAYER, 1_000); // tiny limit
		// Turn the enforcement switch off in the stored overrides.
		await db
			.prepare('insert into "platform_switches" ("key","value","updatedAt") values (?,?,?)')
			.bind('spend_enforcement', 'off', new Date().toISOString())
			.run();
		const inst = registeringInstrumentation(makeSpendInstrumentation({ db }), PAYER);
		booted = await bootRaw({ instrumentation: inst, script: [{ text: 'done', input: 10, output: 5 }] });

		const c = init(Coordinator, { id: 'conv-killswitch' });
		// No throw: the over-limit reserve is refused by the trigger, but
		// enforcement=off passes the call through instead of blocking.
		await c.read(await c.dispatch('go'));
		expect(booted.sp.callCount()).toBe(1);
	});

	test('a delegate charges its coordinator build (same instanceId, different conversationId)', async () => {
		await createBuildPayer(db, PAYER, 5 * MICROS_PER_UNIT);
		const inst = registeringInstrumentation(makeSpendInstrumentation({ db }), PAYER);
		booted = await bootRaw({
			instrumentation: inst,
			script: [
				// coordinator delegates via the `task` tool
				{ toolCall: { id: 'c1', name: 'task', arguments: { agent: 'delegate', prompt: 'sub' } }, input: 100, output: 20 },
				// the delegate's own turn (its conversationId differs; instanceId same)
				{ text: 'delegate done', input: 50_000, output: 20_000 },
				// coordinator continues and ends
				{ text: 'all done', input: 120, output: 15 },
			],
		});

		const c = init(Coordinator, { id: 'conv-delegate' });
		await c.read(await c.dispatch('go'));

		// Every model turn (coordinator + delegate + continuation) charged the ONE
		// build payer — the delegate's different conversationId still resolved to
		// the coordinator's build via the shared instanceId.
		const rows = (await db.prepare('select distinct "payerId" from "build_spend_reservations"').all<{ payerId: string }>()).results;
		expect(rows.length).toBe(1);
		expect(rows[0].payerId).toBe(PAYER);
		// Three distinct turns were reserved+settled against that payer.
		const all = (await db.prepare('select "status" from "build_spend_reservations" where "payerId" = ?').bind(PAYER).all<{ status: string }>()).results;
		expect(all.length).toBe(3);
		expect(all.every((r) => r.status === 'settled')).toBe(true);
	});

	test('resolveTurnPayer: registry (instance, then conversation), then the build_workflows D1 fallback', async () => {
		// Registry by instanceId.
		registerBuildPayer('inst-1', PAYER);
		expect(await resolveTurnPayer(db, { instanceId: 'inst-1' } as FlueExecutionContext)).toBe(PAYER);
		// Registry by conversationId.
		registerBuildPayer('conv-1', PAYER);
		expect(await resolveTurnPayer(db, { conversationId: 'conv-1' } as FlueExecutionContext)).toBe(PAYER);
		// Unknown -> null (pass through).
		expect(await resolveTurnPayer(db, { conversationId: 'nobody' } as FlueExecutionContext)).toBeNull();
		// D1 fallback: a build_workflows row carrying spendPayerId for a conversation.
		await seedWorkflowPayer(db, 'conv-db', 'build:from-db:1');
		expect(await resolveTurnPayer(db, { conversationId: 'conv-db' } as FlueExecutionContext)).toBe('build:from-db:1');
	});

	// --- the live id layout (lead review) --------------------------------------
	// Caddie addresses a build's coordinator as /agents/coordinator/<build_workflows.conversationId>,
	// and Flue makes that URL id the agent's instanceId (agent-api.md: "`id` — the `:id` segment of
	// the agent's conversation URL"). Flue's own ctx.conversationId is a different, internal id. The
	// coordinator runs in its own Durable Object, whose payer cache starts empty, so the payer must
	// come from the build row by instanceId, every time.

	test('live ids, empty cache: a coordinator addressed by its build conversationId is refused at its limit', async () => {
		await createBuildPayer(db, PAYER, 1_000); // $0.001 — far below any call estimate
		await seedWorkflowPayer(db, 'conv_build_cold', PAYER);
		const blockers: string[] = [];
		const inst = makeSpendInstrumentation({ db, setBlocker: (_payerId, message) => void blockers.push(message) });
		booted = await bootRaw({ instrumentation: inst, script: [{ text: 'never', input: 10, output: 5 }] });

		const c = init(Coordinator, { id: 'conv_build_cold' });
		let failed = false;
		try {
			await c.read(await c.dispatch('go'));
		} catch (error) {
			failed = true;
			expect(error).toBeInstanceOf(AgentRunError);
		}
		expect(failed).toBe(true);
		expect(booted.sp.callCount()).toBe(0);
		expect(blockers.length).toBeGreaterThanOrEqual(1);
	});

	test('live ids, empty cache: a delegate charges its coordinator build', async () => {
		await createBuildPayer(db, PAYER, 5 * MICROS_PER_UNIT);
		await seedWorkflowPayer(db, 'conv_build_delegate', PAYER);
		const inst = makeSpendInstrumentation({ db });
		booted = await bootRaw({
			instrumentation: inst,
			script: [
				{ toolCall: { id: 'c1', name: 'task', arguments: { agent: 'delegate', prompt: 'sub' } }, input: 100, output: 20 },
				{ text: 'delegate done', input: 50_000, output: 20_000 },
				{ text: 'all done', input: 120, output: 15 },
			],
		});

		const c = init(Coordinator, { id: 'conv_build_delegate' });
		await c.read(await c.dispatch('go'));

		const all = (await db.prepare('select "payerId","status" from "build_spend_reservations"').all<{ payerId: string; status: string }>()).results;
		expect(all.length).toBe(3);
		expect(all.every((r) => r.payerId === PAYER && r.status === 'settled')).toBe(true);
	});

	test("resolveTurnPayer reads the build row fresh: the instance id finds it, and a retry's new payer applies at once", async () => {
		await seedWorkflowPayer(db, 'conv_build_fresh', 'build:fresh:old');
		const ctx = { instanceId: 'conv_build_fresh', conversationId: 'conv_flue_internal' } as FlueExecutionContext;
		expect(await resolveTurnPayer(db, ctx)).toBe('build:fresh:old');
		// retryWorkflow stores a fresh payer on the same build row.
		await db
			.prepare('update build_workflows set "spendPayerId" = ? where "conversationId" = ?')
			.bind('build:fresh:new', 'conv_build_fresh')
			.run();
		expect(await resolveTurnPayer(db, ctx)).toBe('build:fresh:new');
	});
});

/** Seed a build_workflows row carrying a conversationId -> spendPayerId mapping. */
async function seedWorkflowPayer(db: D1Database, conversationId: string, payerId: string): Promise<void> {
	await db
		.prepare(
			'insert into build_workflows (projectId,runId,conversationId,intakeKey,brief,phase,spendPayerId,updatedAt) values (?,?,?,?,?,?,?,?)',
		)
		.bind(`proj-${conversationId}`, `run-${conversationId}`, conversationId, `intake-${conversationId}`, 'brief', 'building', payerId, new Date().toISOString())
		.run();
}
