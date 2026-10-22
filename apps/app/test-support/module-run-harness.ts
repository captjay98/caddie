/**
 * Gap 4 (plan part P / S3, strengthened) — the runtime-dependent harness that
 * runs TWO real ModuleBuilder-shaped Flue agents, through the real
 * `@flue/runtime/node` runtime, on scripted providers (no Token Factory, no
 * key, no cost). Unlike tests/module-builder-s3.test.ts (which runs NO agent —
 * a scripted routine stands in for the builder), here a real Flue model turn
 * drives each builder's `build_next_feature` / `finish_feature` tool calls.
 *
 * Everything importing `@flue/runtime` lives here in apps/app/test-support/ so
 * the bare specifiers resolve from apps/app/node_modules; the test imports this
 * file relatively and needs no root-level @flue symlink.
 *
 * Each module instance gets its OWN scripted provider (its own deterministic
 * model-call queue), selected by its own model id `scripted-<moduleId>/...`, so
 * two concurrently-dispatched instances never share a queue and the script is
 * interleaving-safe.
 *
 * WHAT IS STUBBED (said plainly, as the lane rules require):
 *  - the MODEL is scripted (scriptedProvider), not Token Factory;
 *  - the module HOST BEHIND the tools is a seam, not createCoordinatorContext:
 *    `build_next_feature` hands out the module's single scripted feature, and
 *    `finish_feature` writes the module's file into ITS OWN real SandboxDriver
 *    session (the P04/P05 contree stub transport), checkpoints it, and calls the
 *    real server/modules.ts `finishModule` with that save point. The full
 *    host's run_checks / contract checks are NOT exercised — this proves the
 *    PARALLEL-BUILDER orchestration (own copy, own save point, one hook, and
 *    the module-feature boundary), not the check pipeline.
 */
import {
	AgentRunError,
	init,
	instrument,
	useInitialData,
	useInstruction,
	useModel,
	useTool,
} from '@flue/runtime';
import { start, type Flue } from '@flue/runtime/node';
import * as v from 'valibot';
import { scriptedProvider, type ScriptedReply } from './scripted-provider.ts';

export { AgentRunError, init };
export type { Flue, ScriptedReply };

const MODEL_ID = 'nvidia/Nemotron-3.5-Super-VL';
const ROUTE = { modelId: MODEL_ID, inputPerMtokUsd: 0.3, outputPerMtokUsd: 0.9, contextWindow: 1048576, maxTokens: 8192 } as const;

/** One module's model specifier: its own provider so its queue is private. */
export function modelFor(moduleId: string): string {
	return `scripted-${moduleId}/${MODEL_ID}`;
}

/**
 * The host seam one ModuleBuilder instance talks to. A test provides it per
 * instance id; the agent's tools call through it. It mirrors the two host
 * tools a module builder actually calls (build_next_feature / finish_feature).
 */
export interface ModuleHostSeam {
	buildNextFeature(): Promise<{ done: boolean; featureId?: string }>;
	/** Finish the feature build_next_feature handed out (the seam remembers it,
	 *  as the real host does — the feature id is not re-supplied across turns). */
	finishFeature(): Promise<{ passed: boolean; checkpointRef: string }>;
}

const seams = new Map<string, ModuleHostSeam>();
export function registerSeam(instanceId: string, seam: ModuleHostSeam): void {
	seams.set(instanceId, seam);
}
export function resetSeams(): void {
	seams.clear();
}

export const ModuleBuilderInitialData = v.object({ moduleId: v.pipe(v.string(), v.minLength(1)) });

/**
 * The real `'use agent'` ModuleBuilder under test (trimmed to the two host
 * tools the parallel-builder orchestration needs). It reads its module from
 * initialData, runs on that module's own scripted provider, and calls through
 * the per-instance host seam — the same shape as src/agents/module-builder.ts,
 * minus the Cloudflare env resolution a test cannot provide. The feature id
 * lives on the SEAM (durable across turns), never in render-scoped state (Flue
 * re-renders the agent each turn, so a render `let` would reset).
 */
export function ModuleBuilder({ id }: { id?: string }) {
	const seed = useInitialData<{ moduleId: string }>();
	useModel(modelFor(seed?.moduleId ?? 'unknown'));

	useTool({
		name: 'build_next_feature',
		description: 'Get the next feature of this module to build.',
		input: v.object({}),
		async run() {
			const seam = id ? seams.get(id) : undefined;
			if (!seam) throw new Error(`no host seam for instance ${id}`);
			return { output: JSON.stringify(await seam.buildNextFeature()) };
		},
	});
	useTool({
		name: 'finish_feature',
		description: 'Finish the current feature of this module.',
		input: v.object({}),
		async run() {
			const seam = id ? seams.get(id) : undefined;
			if (!seam) throw new Error(`no host seam for instance ${id}`);
			return { output: JSON.stringify(await seam.finishFeature()) };
		},
	});

	useInstruction(`You build the "${seed?.moduleId ?? 'unknown'}" module. Call build_next_feature, then finish_feature, then reply done.`);
	return 'Module builder under test.';
}
ModuleBuilder.agentName = 'ModuleBuilder';
ModuleBuilder.initialData = ModuleBuilderInitialData;

export interface BootedModules {
	flue: Flue;
	callCount: (moduleId: string) => number;
	stop: () => Promise<void>;
}

/**
 * Boot the Node runtime with the ModuleBuilder agent and ONE scripted provider
 * per module (keyed by moduleId). Each provider serves that module's own
 * deterministic model-call queue, so concurrent instances never collide.
 */
export async function bootModules(opts: { scripts: Record<string, ScriptedReply[]> }): Promise<BootedModules> {
	const dispose = instrument({ observe() {}, interceptor: async (_op, _ctx, next) => next(), dispose() {} });
	const providers = Object.entries(opts.scripts).map(([moduleId, script]) => ({
		moduleId,
		sp: scriptedProvider({ providerId: `scripted-${moduleId}`, routes: [ROUTE], script }),
	}));
	const flue = await start({ agents: [ModuleBuilder], providers: providers.map((p) => p.sp.provider) });
	const byModule = new Map(providers.map((p) => [p.moduleId, p.sp]));
	return {
		flue,
		callCount: (moduleId: string) => byModule.get(moduleId)?.callCount() ?? 0,
		async stop() {
			await dispose();
			await flue.stop();
		},
	};
}
