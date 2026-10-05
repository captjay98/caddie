import { setProvider } from '@flue/runtime';
import {
	createProvider,
	envApiKeyAuth,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

/**
 * P05 providers — Nebius Token Factory registration with the EVALUATED
 * compatibility options (adjudication carry-in; see docs/flue-contracts.md):
 * supportsDeveloperRole:false / supportsStore:false / maxTokensField:"max_tokens"
 * — TF 422s the OpenAI `developer` role without the block.
 *
 * Registration happens once per isolate via `registerNebiusProvider()`; the
 * app entry (app.ts) calls it so `flue.config providers` stays built-in-IDs
 * only (custom registration belongs in app.ts — the runtime's documented
 * precedence point). No credential is read here at import time; the env name
 * is declared and resolved lazily by the provider.
 */

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

/** Model routes are FROZEN per run (contracts.md: payer/model/pricing binding). */
export interface ModelRoute {
	id: string;
	/** Full specifier the Flue runtime resolves: provider-prefixed model id. */
	specifier: string;
	providerId: 'nebius';
	modelId: string;
	/** The pricingVersion rows P03 budgets resolve against. */
	pricingVersion: string;
	unitPriceMinorUnits: number;
	currency: string;
}

export const MODEL_ROUTES: readonly ModelRoute[] = [
	{
		id: 'nemotron-3-super',
		specifier: 'nebius/nvidia/nemotron-3-super-120b-a12b',
		providerId: 'nebius',
		modelId: 'nvidia/nemotron-3-super-120b-a12b',
		pricingVersion: '2026-10-adjudication',
		unitPriceMinorUnits: 40, // $0.40 per Mtok, in minor units per Mtok
		currency: 'usd',
	},
];

export function findModelRoute(modelRouteId: string): ModelRoute {
	const route = MODEL_ROUTES.find((route) => route.id === modelRouteId);
	if (!route) {
		throw new Error(
			`unknown model route ${modelRouteId} — routes are frozen; a run may never silently fall back to a different provider or price`,
		);
	}
	return route;
}

let registered = false;

/** Idempotent isolate-level registration of the custom Nebius provider. */
export function registerNebiusProvider(): void {
	if (registered) return;
	registered = true;
	setProvider(
		createProvider({
			id: 'nebius',
			name: 'Nebius Token Factory',
			baseUrl: NEBIUS_BASE_URL,
			auth: { apiKey: envApiKeyAuth('Nebius API key', ['NEBIUS_API_KEY']) },
			models: MODEL_ROUTES.map((route) => ({
				id: route.modelId,
				name: route.modelId,
				api: 'openai-completions',
				provider: 'nebius',
				baseUrl: NEBIUS_BASE_URL,
				reasoning: true,
				input: ['text'],
				// pi-ai 0.87.1 rates are dollars-per-Mtok; the budget ledger's
				// minor-unit price (P03) is derived separately in MODEL_ROUTES.
				cost: {
					input: route.unitPriceMinorUnits / 100,
					output: route.unitPriceMinorUnits / 100,
					cacheRead: route.unitPriceMinorUnits / 100 / 10,
					cacheWrite: route.unitPriceMinorUnits / 100 / 10,
				},
				contextWindow: 128000,
				maxTokens: 4096,
				compat: {
					supportsDeveloperRole: false,
					supportsStore: false,
					maxTokensField: 'max_tokens',
				},
			})),
			api: openAICompletionsApi(),
		}),
	);
}
