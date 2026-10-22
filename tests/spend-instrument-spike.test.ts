import { afterEach, describe, expect, test } from 'bun:test';
import {
	type Booted,
	type FlueEvent,
	AgentRunError,
	boot,
	init,
	perCallCosts,
	makeFakeD1,
	Coordinator,
	Worker,
} from '../apps/app/test-support/spend-harness.ts';

/**
 * S1 (part A's spike) — the spending limit checked before every model call.
 *
 * Proves or disproves the design in docs/plans/2026-10-22-software-team-mode.md
 * part A step 2 against REAL Flue 2.2.2 agents, with a scripted provider (no
 * Token Factory, no key, no cost). Part A itself is NOT built here.
 *
 * The runtime-dependent harness (scripted provider, agents, instrument/start
 * wiring) lives in apps/app/test-support/ so its `@flue/runtime` and
 * `@earendil-works/pi-ai` bare specifiers resolve from apps/app/node_modules.
 * This test imports it RELATIVELY, so the spike runs in a fresh checkout with
 * no root-level symlinks.
 *
 * Six questions (§A "S1 must prove"), each with evidence from a committed test:
 *   1. instrument({observe,interceptor}) install point; the interceptor sees
 *      EVERY model call — coordinator, a delegate (via the `task` tool), and a
 *      dispatch()'d instance.
 *   2. Whether D1 (env.DB) is reachable inside the interceptor, and how.
 *   3. What a throw from the interceptor does: clean fail, what the turn sees,
 *      and whether the build host can turn it into a blocked build.
 *   4. Ordering: does the paired observer's turn_request arrive before the
 *      interceptor runs for the same turnId?
 *   5. Does the sum of per-call usage.cost.total equal the response's own total
 *      (no double counting) with the scripted numbers?
 *   6. Is the conversation id (to find the build's payer) in the interceptor?
 *
 * Harness: `start()` (@flue/runtime/node) is the documented in-process
 * bootstrap "mirroring what a generated Flue server entry does at boot" — the
 * same runtime behind `init()`/`dispatch()` that a Cloudflare isolate runs,
 * minus the HTTP/DO surface. `instrument()` is installed by boot() exactly as
 * part A installs it in app.ts (module scope, ONE object, once per isolate).
 */

let booted: Booted | null = null;

afterEach(async () => {
	if (booted) {
		await booted.stop();
		booted = null;
	}
});

describe('S1 — instrument() spending-limit design against real Flue agents', () => {
	test('Q1+Q4+Q6: the interceptor sees the coordinator, a delegate (via task) and a dispatch()ed instance; turn_request precedes the interceptor; conversationId is present', async () => {
		// Script, in model-call order:
		//  0: coordinator turn -> calls the `task` tool to delegate
		//  1: delegate turn (runs inside the task) -> plain reply
		//  2: coordinator continues after the task result -> plain reply (ends)
		//  3: dispatched Worker turn -> plain reply
		//
		// boot() installs exactly ONE instrument() object (part A's app.ts order),
		// which is the correct way to count the interceptor's firing behaviour.
		booted = await boot({
			script: [
				{ toolCall: { id: 'c1', name: 'task', arguments: { agent: 'delegate', prompt: 'do the sub-bit' } }, input: 100, output: 20 },
				{ text: 'delegate done', input: 40, output: 10 },
				{ text: 'all done', input: 120, output: 15 },
				{ text: 'worker done', input: 30, output: 8 },
			],
		});
		const inst = booted;

		const coordinator = init(Coordinator, { id: 'conv-coord' });
		await coordinator.read(await coordinator.dispatch('Build it.'));
		const worker = init(Worker, { id: 'conv-worker' });
		await worker.read(await worker.dispatch('You were dispatched.'));

		// FINDING (re-checked with exactly ONE instrument() registration): the
		// scripted provider's stream() is invoked exactly ONCE per model call (4),
		// and the `model` INTERCEPTOR fires MORE THAN ONCE per turnId (see the
		// per-turn assertion below).
		//
		// RE-CHECK OUTCOME (the S1 report left this open): the "~8 interceptor
		// calls per turnId" reading is REAL, not a double-registration artifact.
		// Re-verified in a fresh process with exactly ONE instrument() object (one
		// plain turn → STREAM_CALLS 1, MODEL_INTERCEPTIONS 8). The interceptor
		// registry (errors-*.mjs: `interceptors` array) holds exactly one entry per
		// install and dispatchExecution walks it once per ENTRY, so the 8 are 8
		// genuine entries into the SINGLE model-op interception site
		// (emitTurnRequestAndStream, conversation-stream-store line 1214) for one
		// turn — the runtime's own per-turn execution machinery re-enters the model
		// wrapper around the single provider stream. It is NOT retries-on-error
		// (the turn settles clean, stopReason stop/toolUse) and NOT compaction
		// (the other model-op site, line 4239, never fires here).
		//
		// DESIGN IMPLICATION (strengthened): part A MUST reserve idempotently
		// per turnId — insert the reservation keyed on turnId, and on a turnId that
		// already has a row, do NOT insert again and do NOT read the duplicate as
		// "limit reached" (migration-0040's UNIQUE index on turnId is exactly this
		// dedupe key). Reserving once per interceptor invocation would reserve 8×
		// for one model call.
		expect(inst.sp.callCount()).toBe(4);

		// Q1: every one of the 4 model calls was covered — the distinct model
		// turnIds the interceptor saw match the distinct `turn` observations.
		const modelSeen = inst.seen.filter((s) => s.type === 'model' && s.turnId);
		const interceptedTurnIds = new Set(modelSeen.map((s) => s.turnId as string));
		const observedTurnIds = new Set(
			inst.events.filter((e): e is Extract<FlueEvent, { type: 'turn' }> => e.type === 'turn').map((e) => e.turnId),
		);
		expect(interceptedTurnIds.size).toBe(4);
		expect(observedTurnIds).toEqual(interceptedTurnIds);

		// RE-CHECK assertion: the interceptor fires multiple times per turnId
		// (observed 8), while the provider stream is called once per turn (4). A
		// per-invocation reserve would overcount; a per-turnId reserve is correct.
		const perTurn = new Map<string, number>();
		for (const s of modelSeen) perTurn.set(s.turnId as string, (perTurn.get(s.turnId as string) ?? 0) + 1);
		expect([...perTurn.values()].every((n) => n > 1)).toBe(true); // >1: NOT 1:1 with provider calls
		expect([...perTurn.values()].every((n) => n === 8)).toBe(true); // observed: exactly 8 per turn
		expect(modelSeen.length).toBe(32); // 4 turns × 8 interceptor entries each

		// The delegate ran inside a `task` operation (the delegation path), and a
		// separate `agent` op wrapped the dispatched Worker submission.
		expect(inst.seen.some((s) => s.type === 'task')).toBe(true);
		const agentNames = new Set(inst.seen.filter((s) => s.type === 'agent').map((s) => s.agentName));
		expect(agentNames.has('Coordinator')).toBe(true);
		expect(agentNames.has('Worker')).toBe(true);

		// Q6: a conversation id is present on every model interception (session
		// scope). FINDING: the payer key is the INSTANCE, not the raw
		// conversationId. The coordinator and its DELEGATE share one instanceId
		// ("cc") but have DIFFERENT conversationIds — a delegate runs in a detached
		// `task:default:...` sub-session with its own conversationId. The
		// dispatch()ed worker is a separate instanceId ("ww"). So part A must
		// attribute a delegate's spend to its PARENT build (resolve payer by
		// instanceId / build lineage, cached per isolate — plan step 2/step 4),
		// not by the delegate's own conversationId. The plan's wording "find the
		// payer from ctx.conversationId" must become "from the build this
		// instance/turn belongs to".
		const modelOps = inst.seen.filter((s) => s.type === 'model');
		expect(modelOps.every((s) => typeof s.conversationId === 'string' && s.conversationId.length > 0)).toBe(true);
		expect(modelOps.every((s) => typeof s.instanceId === 'string' && s.instanceId!.length > 0)).toBe(true);
		// 3 distinct conversations (coordinator, its delegate, the worker)...
		expect(new Set(modelOps.map((s) => s.conversationId)).size).toBe(3);
		// ...but only 2 instances: the coordinator+delegate share one, the
		// dispatched worker is its own.
		expect(new Set(modelOps.map((s) => s.instanceId)).size).toBe(2);
		// The delegate's model turn carries a different conversationId from the
		// coordinator's yet the SAME instanceId — the parent-build attribution seam.
		const coordInstance = inst.seen.find((s) => s.type === 'agent' && s.agentName === 'Coordinator')?.instanceId;
		const taskScoped = inst.seen.filter((s) => s.type === 'model' && s.instanceId === coordInstance);
		expect(new Set(taskScoped.map((s) => s.conversationId)).size).toBe(2); // coordinator + its delegate

		// Q4: for every turnId, observe()'s turn_request fires before the model
		// interceptor runs for that same turnId.
		const byTurn = new Map<string, { req?: number; interceptor?: number }>();
		inst.order.forEach((o, i) => {
			const slot = byTurn.get(o.turnId) ?? {};
			if (o.what === 'turn_request' && slot.req === undefined) slot.req = i;
			if (o.what === 'interceptor' && slot.interceptor === undefined) slot.interceptor = i;
			byTurn.set(o.turnId, slot);
		});
		let checkedTurns = 0;
		for (const [, slot] of byTurn) {
			if (slot.req !== undefined && slot.interceptor !== undefined) {
				expect(slot.req).toBeLessThan(slot.interceptor);
				checkedTurns++;
			}
		}
		expect(checkedTurns).toBe(4); // coordinator turn-with-task, coordinator continuation, delegate, worker
	});

	test('Q5: sum of per-call usage.cost.total equals the per-call Flue totals (no double counting)', async () => {
		booted = await boot({
			script: [
				// Turn 0: coordinator calls the `noop` tool (forces a second turn).
				{ toolCall: { id: 't0', name: 'noop', arguments: {} }, input: 1_000_000, output: 1_000_000 },
				// Turn 1: coordinator replies with the tool result -> settles.
				{ text: 'two', input: 500_000, output: 200_000 },
			],
		});
		const inst = booted;
		const coordinator = init(Coordinator, { id: 'conv-cost' });
		const r = await coordinator.dispatch('go');
		await coordinator.read(r);

		const costs = perCallCosts(inst.events);
		expect(costs.length).toBe(2);
		// Super VL $0.30 in / $0.90 out per Mtok: 1 Mtok in + 1 Mtok out = $1.20.
		expect(costs[0]).toBeCloseTo(0.3 + 0.9, 9);
		// 0.5 Mtok in ($0.15) + 0.2 Mtok out ($0.18) = $0.33.
		expect(costs[1]).toBeCloseTo(0.15 + 0.18, 9);

		// Part A settles from these per-call leaf totals; summing them is the full
		// spend, with no response/operation roll-up added on top.
		const summed = costs.reduce((a, b) => a + b, 0);
		expect(summed).toBeCloseTo(1.2 + 0.33, 9);

		// Cross-check against the leaf `turn` events only (roll-ups would appear on
		// usage-bearing `agent`/operation events; part A must NOT also count those).
		const turnEvents = inst.events.filter((e) => e.type === 'turn');
		expect(turnEvents.length).toBe(2);
		// No `turn` was an error, so both costs are real spend.
		expect(turnEvents.every((e) => e.type === 'turn' && e.isError === false)).toBe(true);
	});

	test('Q2: D1 is reachable inside the interceptor and keyed by the interceptor-provided ctx.conversationId', async () => {
		// FINDING: ctx.conversationId is Flue's INTERNAL instance id (e.g.
		// "conv_01M5..."), NOT the id passed to init(). Part A must map THAT
		// string -> payer. We discover it inside the interceptor and seed the
		// fake D1 with it, then assert the lookup round-trips on that exact key.
		const d1 = makeFakeD1({});
		const resolvedPayers: Array<string | null> = [];
		let interceptorConversationId: string | undefined;

		booted = await boot({
			script: [{ text: 'done', input: 10, output: 5 }],
			beforeModel: (ctx) => {
				// The interceptor reaches a DB handle (closure-captured here; on
				// Cloudflare it is getCloudflareContext().env.DB, reachable because the
				// interceptor runs inside the DO request handler's async context) and
				// looks up the payer for THIS turn's conversation — part A step 2.
				interceptorConversationId = ctx.conversationId;
				const conversationId = ctx.conversationId ?? '';
				// Seed the payer row keyed by the runtime's own conversation id, then
				// run the same lookup part A runs.
				d1.setPayer(conversationId, 'build:run-7');
				void d1
					.prepare('SELECT payerId FROM build_spend_reservations WHERE conversationId = ?1 LIMIT 1')
					.bind(conversationId)
					.first<{ payerId: string }>()
					.then((row) => resolvedPayers.push(row?.payerId ?? null));
			},
		});
		const inst = booted;

		const coordinator = init(Coordinator, { id: 'conv-withpayer' });
		const r = await coordinator.dispatch('go');
		await coordinator.read(r);

		// A conversation id was present on the model interception (Q6 too).
		expect(typeof interceptorConversationId).toBe('string');
		expect(interceptorConversationId!.length).toBeGreaterThan(0);
		// The interceptor ran a real query against the handle, bound the turn's
		// conversationId, and the lookup resolved the payer for that exact key.
		expect(d1.queries.length).toBeGreaterThanOrEqual(1);
		expect(d1.queries[0].binds[0]).toBe(interceptorConversationId);
		await new Promise((res) => setTimeout(res, 0));
		expect(resolvedPayers).toContain('build:run-7');
		expect(inst.seen.some((s) => s.type === 'model' && s.conversationId === interceptorConversationId)).toBe(true);
	});

	test('Q3: a throw from the interceptor fails the call cleanly; the turn settles failed (AgentRunError), the host can read it as a blocked build', async () => {
		booted = await boot({
			script: [{ text: 'never reached', input: 10, output: 5 }],
			beforeModel: () => {
				// Part A: reservation refused at the limit -> set blocker and throw,
				// so the call never reaches Token Factory.
				throw new Error('spend_limit_reached');
			},
		});
		const inst = booted;

		const coordinator = init(Coordinator, { id: 'conv-blocked' });
		const receipt = await coordinator.dispatch('go');

		// The turn settles failed; read() rejects with AgentRunError('failed') —
		// the SAME settlement the build host's dispatch read sees. The host turns
		// a failed coordinator turn into a blocked build (see
		// server/coordinator-host.ts blockBuild and the useAgentFinish gate in
		// src/agents/coordinator.ts). Here we assert the failed settlement the
		// host keys on.
		let failed = false;
		try {
			await coordinator.read(receipt);
		} catch (error) {
			failed = true;
			expect(error).toBeInstanceOf(AgentRunError);
			expect((error as AgentRunError).outcome).toBe('failed');
		}
		expect(failed).toBe(true);

		// FINDING: the model call is intercepted and the throw pre-empts next(), so
		// the provider is never called — but Flue STILL emits a `turn` event for it,
		// with isError: true. So part A must NOT read "a turn event exists" as money
		// spent: the scripted provider produced no usage (next() never ran), and the
		// isError turn is precisely the signal to RELEASE the reservation
		// (part A step 3: "A failed call releases it").
		const turnEvents = inst.events.filter(
			(e): e is Extract<(typeof inst.events)[number], { type: 'turn' }> => e.type === 'turn',
		);
		expect(turnEvents.length).toBe(1);
		expect(turnEvents[0].isError).toBe(true);
		// The errored turn carries no usage from the (never-made) provider call.
		expect(turnEvents[0].response.usage?.cost.total ?? 0).toBe(0);
		expect(inst.seen.some((s) => s.type === 'model')).toBe(true);
		// The provider was never called (next() pre-empted).
		expect(inst.sp.callCount()).toBe(0);
	});
});
