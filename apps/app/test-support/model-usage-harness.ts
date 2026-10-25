/** Local-only provider fixture exercising Flue's real per-call event stream. */
import { init, instrument, useAgentStart, useDelivery, useModel, type FlueInstrumentation } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { MODEL_ROUTES, coordinatorModelSelection, findModelRouteForRole } from '../src/agents/providers.ts';
import { MODEL_SELECTION_LOG } from '../src/server/model-call-instrument.ts';
import { scriptedProvider, type ScriptedReply } from './scripted-provider.ts';

function UsageCoordinator() {
	const delivery = useDelivery();
	const selection = coordinatorModelSelection({ isHome: false, ideationTurnsLeft: 0, request: delivery.kind === 'user' ? delivery.body : '' });
	const route = findModelRouteForRole(selection.role);
	useModel(route.specifier);
	useAgentStart(ctx => { ctx.log.info(MODEL_SELECTION_LOG, { role: selection.role, reason: selection.reason, routeId: route.id }); });
	return 'Reply briefly.';
}

export async function bootModelUsageFixture(instrumentation: FlueInstrumentation, script: ScriptedReply[]) {
	const dispose = instrument(instrumentation);
	const sp = scriptedProvider({ providerId: 'nebius', script, routes: MODEL_ROUTES.map(route => ({
		modelId: route.modelId, inputPerMtokUsd: route.inputPriceMinorUnits / 100, outputPerMtokUsd: route.outputPriceMinorUnits / 100,
		contextWindow: route.contextWindow, maxTokens: route.maxTokens,
	})) });
	const flue = await start({ agents: [UsageCoordinator], providers: [sp.provider] });
	const client = init(UsageCoordinator, { id: 'usage-project' });
	return { client, async stop() { await dispose(); await flue.stop(); } };
}
