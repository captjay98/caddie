/**
 * S1 spike — the runtime-dependent harness.
 *
 * Everything that imports `@flue/runtime` or `@flue/runtime/node` lives here,
 * in apps/app/test-support/, so the bare specifiers resolve from
 * apps/app/node_modules. The spike test in tests/ imports this file relatively
 * and so needs NO root-level `@flue`/`@earendil-works` symlinks — it runs in a
 * fresh checkout.
 *
 * Contents: the test agents (coordinator, delegate, dispatched worker), the
 * observe()/interceptor instrumentation pair matching part A's
 * `instrument({observe,interceptor})`, a minimal fake D1 for Q2, and a `boot`
 * helper that installs the instrumentation and starts the Node runtime.
 */
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
import { scriptedProvider, type ScriptedReply } from './scripted-provider.ts';

// Re-export the symbols the spike test asserts against, so tests/ imports only
// this one relative module and never a bare @flue specifier.
export { AgentRunError, dispatch, init, instrument };
export type { FlueEvent, FlueExecutionContext, FlueExecutionOperation, Flue };
export { scriptedProvider };
export type { ScriptedReply };

// Mirror the real MODEL_ROUTES rates (src/agents/providers.ts) so the cost math
// is the same as production. $/Mtok. Only the fields the scripted provider uses.
export const ROUTES = [
	{ modelId: 'nvidia/Nemotron-3.5-Super-VL', inputPerMtokUsd: 0.3, outputPerMtokUsd: 0.9, contextWindow: 1048576, maxTokens: 8192 },
	{ modelId: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', inputPerMtokUsd: 0.06, outputPerMtokUsd: 0.24, contextWindow: 262144, maxTokens: 8192 },
] as const;
export const CHAT = 'scripted/nvidia/Nemotron-3.5-Super-VL';
export const HELPER = 'scripted/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B';

/** A captured interception: operation + the ctx fields part A relies on. */
export interface Seen {
	type: FlueExecutionOperation['type'];
	turnId?: string;
	conversationId?: string;
	instanceId?: string;
	agentName?: string;
}

export interface Instrumentation {
	instrumentation: {
		observe(event: FlueEvent): void;
		interceptor: <T>(operation: FlueExecutionOperation, ctx: FlueExecutionContext, next: () => Promise<T>) => Promise<T>;
		dispose(): void;
	};
	events: FlueEvent[];
	seen: Seen[];
	order: Array<{ turnId: string; what: 'turn_request' | 'interceptor' }>;
}

/** The observe()/interceptor pair, matching part A's `instrument({observe,interceptor})`. */
export function makeInstrumentation(opts: {
	/** Called inside the interceptor for each `model` op, BEFORE next(). Throw to fail the call. */
	beforeModel?: (ctx: FlueExecutionContext) => void;
}): Instrumentation {
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
export function perCallCosts(events: FlueEvent[]): number[] {
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
export function makeFakeD1(payers: Record<string, string>) {
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

/** One booted spike runtime: the instrumentation capture + a stop/dispose. */
export interface Booted extends Instrumentation {
	flue: Flue;
	sp: ReturnType<typeof scriptedProvider>;
	stop: () => Promise<void>;
}

/**
 * Install the instrumentation (ONCE — one object, part A's app.ts order) and
 * start the Node runtime with the scripted provider. The caller stops it in an
 * afterEach. instrument() is installed BEFORE start(), at module/isolate scope,
 * exactly as part A installs it in app.ts.
 */
export async function boot(opts: {
	script: ScriptedReply[];
	beforeModel?: (ctx: FlueExecutionContext) => void;
}): Promise<Booted> {
	const inst = makeInstrumentation({ beforeModel: opts.beforeModel });
	const disposeInstrumentation = instrument(inst.instrumentation);
	const sp = scriptedProvider({ providerId: 'scripted', routes: ROUTES, script: opts.script });
	const flue = await start({ agents: [Coordinator, Worker], providers: [sp.provider] });
	return {
		...inst,
		flue,
		sp,
		async stop() {
			await disposeInstrumentation();
			await flue.stop();
		},
	};
}
