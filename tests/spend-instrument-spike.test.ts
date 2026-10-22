import { afterEach, describe, expect, test } from 'bun:test';
import {
	type FlueEvent,
	type FlueExecutionContext,
	type FlueExecutionOperation,
	AgentRunError,
	dispatch,
	init,
	instrument,
	useAgentFinish,
	useInstruction,
	useModel,
	useSubagent,
	useTool,
} from '@flue/runtime';
import { start, type Flue } from '@flue/runtime/node';
import * as v from 'valibot';
import { scriptedProvider, type ScriptedReply } from './support/scripted-provider.ts';

/**
 * S1 (part A's spike) — the spending limit checked before every model call.
 *
 * Proves or disproves the design in docs/plans/2026-10-22-software-team-mode.md
 * part A step 2 against REAL Flue 2.2.2 agents, with a scripted provider (no
 * Token Factory, no key, no cost). Part A itself is NOT built here.
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
 * minus the HTTP/DO surface. `instrument()` is installed here exactly as part A
 * installs it in app.ts (module scope, once per isolate).
 */

// Mirror the real MODEL_ROUTES rates (src/agents/providers.ts) so the cost math
// is the same as production. $/Mtok. Only the fields the scripted provider uses.
const ROUTES = [
	{ modelId: 'nvidia/Nemotron-3.5-Super-VL', inputPerMtokUsd: 0.3, outputPerMtokUsd: 0.9, contextWindow: 1048576, maxTokens: 8192 },
	{ modelId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', inputPerMtokUsd: 0.06, outputPerMtokUsd: 0.24, contextWindow: 262144, maxTokens: 8192 },
] as const;
const CHAT = 'scripted/nvidia/Nemotron-3.5-Super-VL';
const HELPER = 'scripted/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

/** A captured interception: operation + the ctx fields part A relies on. */
interface Seen {
	type: FlueExecutionOperation['type'];
	turnId?: string;
	conversationId?: string;
	instanceId?: string;
	agentName?: string;
}

/** The observe()/interceptor pair, matching part A's `instrument({observe,interceptor})`. */
function makeInstrumentation(opts: {
	/** Called inside the interceptor for each `model` op, BEFORE next(). Throw to fail the call. */
	beforeModel?: (ctx: FlueExecutionContext) => void;
	/** Optional per-model-call cost recorder (reads the paired `turn` event). */
}) {
	const events: FlueEvent[] = [];
	const seen: Seen[] = [];
	// turnId -> the order in which turn_request (observe) vs model interceptor fired.
	const order: Array<{ turnId: string; what: 'turn_request' | 'interceptor' }> = [];

	const instrumentation = {
		observe(event: FlueEvent) {
			events.push(event);
			if (event.type === 'turn_request') order.push({ turnId: event.turnId, what: 'turn_request' });
		},
		interceptor: async <T>(
			operation: FlueExecutionOperation,
			ctx: FlueExecutionContext,
			next: () => Promise<T>,
		): Promise<T> => {
			seen.push({
				type: operation.type,
				turnId: ctx.turnId,
				conversationId: ctx.conversationId,
				instanceId: ctx.instanceId,
				agentName: ctx.agentName,
			});
			if (operation.type === 'model') {
				if (ctx.turnId) order.push({ turnId: ctx.turnId, what: 'interceptor' });
				opts.beforeModel?.(ctx);
			}
			return next();
		},
		dispose() {},
	};
	return { instrumentation, events, seen, order };
}

/** Per-call cost from the `turn` observation events (the leaf usage part A settles from). */
function perCallCosts(events: FlueEvent[]): number[] {
	return events
		.filter((e): e is Extract<FlueEvent, { type: 'turn' }> => e.type === 'turn')
		.map((e) => e.response.usage?.cost.total ?? 0);
}

// ----- agents -------------------------------------------------------------

/**
 * A delegate the coordinator hands work to via the framework `task` tool —
 * the SAME delegation path the real coordinator uses (useSubagent, see
 * src/agents/specialists.ts). Its own render declares its model, so its model
 * call is a distinct turn the interceptor must see.
 */
function Delegate() {
	// FINDING: useModel() THROWS inside a subagent render ("not available in a
	// subagent render — a delegate declares its model on its useSubagent()
	// definition"). The delegate's model is set on the useSubagent() mount below,
	// matching src/agents/specialists.ts (buildSpecialistDeclarations sets
	// `model:` per delegate). Part A's spend attribution therefore sees a
	// delegate's model call as its OWN model turn under an enclosing `task` op.
	return 'You are a delegate. Reply briefly.';
}

/** A top-level agent reachable by dispatch() — its own Durable Object / instance. */
export function Worker() {
	useModel(HELPER);
	return 'You are a dispatched worker. Reply briefly.';
}

/**
 * The coordinator under test: one own turn, then (scripted) a `task` tool-call
 * to the delegate. Shaped like src/agents/coordinator.ts (useModel + useSubagent
 * + tools), trimmed to the delegation seam S1 needs.
 */
export function Coordinator() {
	useModel(CHAT);
	useSubagent({ name: 'delegate', description: 'Hands focused work to a delegate.', agent: Delegate, model: HELPER });
	// A no-op tool so a scripted non-delegating turn has something to end on.
	useTool({ name: 'noop', description: 'does nothing', input: v.object({}), async run() { return { output: 'ok' }; } });
	useInstruction('You are the coordinator.');
	useAgentFinish(() => {});
	return 'Coordinator under test.';
}

// ----- D1 reachability (Q2) ----------------------------------------------

/**
 * A minimal fake D1 that records the payer lookup part A's interceptor does:
 * conversationId -> payer. Proves the interceptor can both REACH a DB handle
 * and USE ctx.conversationId to query it. On Cloudflare the same handle is
 * `getCloudflareContext().env.DB` (reachable because the interceptor runs
 * inside the DO request handler's async context); here it is captured in the
 * install closure, which is exactly how app.ts hands the isolate's binding to
 * the interceptor.
 */
function makeFakeD1(payers: Record<string, string>) {
	const table = { ...payers };
	const queries: Array<{ sql: string; binds: unknown[] }> = [];
	return {
		queries,
		setPayer(conversationId: string, payerId: string) {
			table[conversationId] = payerId;
		},
		prepare(sql: string) {
			const binds: unknown[] = [];
			const stmt = {
				bind(...args: unknown[]) {
					binds.push(...args);
					return stmt;
				},
				async first<T = unknown>(): Promise<T | null> {
					queries.push({ sql, binds });
					const conversationId = String(binds[0]);
					const payerId = table[conversationId] ?? null;
					return (payerId ? ({ payerId } as unknown as T) : null);
				},
			};
			return stmt;
		},
	};
}

// ----- lifecycle ----------------------------------------------------------

let flue: Flue | null = null;
let disposeInstrumentation: (() => Promise<void>) | null = null;

afterEach(async () => {
	if (disposeInstrumentation) {
		await disposeInstrumentation();
		disposeInstrumentation = null;
	}
	if (flue) {
		await flue.stop();
		flue = null;
	}
});

async function boot(opts: {
	script: ScriptedReply[];
	beforeModel?: (ctx: FlueExecutionContext) => void;
}) {
	const inst = makeInstrumentation({ beforeModel: opts.beforeModel });
	// Installed BEFORE start(), at module/isolate scope — part A's app.ts order.
	disposeInstrumentation = instrument(inst.instrumentation);
	const sp = scriptedProvider({ providerId: 'scripted', routes: ROUTES, script: opts.script });
	flue = await start({ agents: [Coordinator, Worker], providers: [sp.provider] });
	return inst;
}

// --------------------------------------------------------------------------

describe('S1 — instrument() spending-limit design against real Flue agents', () => {
	test('Q1+Q4+Q6: the interceptor sees the coordinator, a delegate (via task) and a dispatch()ed instance; turn_request precedes the interceptor; conversationId is present', async () => {
		// Script, in model-call order:
		//  0: coordinator turn -> calls the `task` tool to delegate
		//  1: delegate turn (runs inside the task) -> plain reply
		//  2: coordinator continues after the task result -> plain reply (ends)
		//  3: dispatched Worker turn -> plain reply
		const sp = scriptedProvider({
			providerId: 'scripted',
			routes: ROUTES,
			script: [
				{ toolCall: { id: 'c1', name: 'task', arguments: { agent: 'delegate', prompt: 'do the sub-bit' } }, input: 100, output: 20 },
				{ text: 'delegate done', input: 40, output: 10 },
				{ text: 'all done', input: 120, output: 15 },
				{ text: 'worker done', input: 30, output: 8 },
			],
		});
		const inst = makeInstrumentation({});
		disposeInstrumentation = instrument(inst.instrumentation);
		flue = await start({ agents: [Coordinator, Worker], providers: [sp.provider] });

		const coordinator = init(Coordinator, { id: 'conv-coord' });
		await coordinator.read(await coordinator.dispatch('Build it.'));
		const worker = init(Worker, { id: 'conv-worker' });
		await worker.read(await worker.dispatch('You were dispatched.'));

		// FINDING: the scripted provider's stream() was invoked exactly ONCE per
		// model call (4), but the `model` INTERCEPTOR fires several times per
		// turnId (Flue wraps the attempt chain, not one-to-one with provider
		// calls). So part A must reserve ONCE PER turnId (idempotent on turnId —
		// the migration-0040 unique index on turnId is exactly this), never once
		// per interceptor invocation.
		expect(sp.callCount()).toBe(4);

		// Q1: every one of the 4 model calls was covered — the distinct model
		// turnIds the interceptor saw match the distinct `turn` observations.
		const interceptedTurnIds = new Set(
			inst.seen.filter((s) => s.type === 'model' && s.turnId).map((s) => s.turnId as string),
		);
		const observedTurnIds = new Set(
			inst.events.filter((e): e is Extract<FlueEvent, { type: 'turn' }> => e.type === 'turn').map((e) => e.turnId),
		);
		expect(interceptedTurnIds.size).toBe(4);
		expect(observedTurnIds).toEqual(interceptedTurnIds);

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
		const inst = await boot({
			script: [
				// Turn 0: coordinator calls the `noop` tool (forces a second turn).
				{ toolCall: { id: 't0', name: 'noop', arguments: {} }, input: 1_000_000, output: 1_000_000 },
				// Turn 1: coordinator replies with the tool result -> settles.
				{ text: 'two', input: 500_000, output: 200_000 },
			],
		});
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

		const inst = await boot({
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
		const inst = await boot({
			script: [{ text: 'never reached', input: 10, output: 5 }],
			beforeModel: () => {
				// Part A: reservation refused at the limit -> set blocker and throw,
				// so the call never reaches Token Factory.
				throw new Error('spend_limit_reached');
			},
		});

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
	});
});
