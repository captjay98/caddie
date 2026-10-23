/**
 * S1 spike — a TEST-ONLY scripted Flue/pi provider.
 *
 * It returns fixed replies with a fixed token usage, and lets pi compute the
 * COST from the model's own catalog rates (`calculateCost`) — the same math
 * the real Nebius provider's responses go through, so `turn.usage.cost.total`
 * in the `observe()` stream and the `turn.usage` the real settlement path
 * reads are produced identically. No HTTP, no key, fully deterministic.
 *
 * This is NOT production code. S1 (part A's spike) proves the `instrument()`
 * design against real Flue agents without a paid Token Factory call; the real
 * provider stays `src/agents/providers.ts`.
 *
 * It lives in apps/app/test-support/ (not tests/) on purpose: its bare
 * specifiers (`@earendil-works/pi-ai`) resolve from apps/app/node_modules, so
 * the spike runs in a fresh checkout with no root-level symlinks. The test in
 * tests/ imports it relatively.
 *
 * Why a custom `api` (not a stubbed `fetch`): pi's openai-completions api
 * drives the OpenAI SDK client over a streaming SSE body, so a stubbed fetch
 * would have to fake an SSE transport. A custom `api.stream` emits the exact
 * `AssistantMessageEventStream` event sequence pi's own adapter emits
 * (start → text/toolcall deltas + *_end → done → end), which is what the
 * runtime consumes — the realistic seam for a scripted model.
 */
import {
	calculateCost,
	createProvider,
	type AssistantMessage,
	type JsonObject,
	type Model,
	type Provider,
	type TranscriptContext,
	type Usage,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

/** One scripted reply: plain text, or a single tool call, with fixed tokens. */
export interface ScriptedReply {
	/** Assistant text to emit (may be ''). */
	text?: string;
	/** Emit exactly one tool call instead of (or beside) text. */
	toolCall?: { id: string; name: string; arguments: JsonObject };
	/** Fixed prompt/completion token counts; cost is computed from the route rates. */
	input: number;
	output: number;
	/**
	 * Model the FINDING #5 case: the model ran and billed real tokens, then the
	 * turn errored (a downstream/abort error after the provider response). The
	 * reply still computes its real usage/cost, but the turn ends `isError`. The
	 * spend instrument must SETTLE this, not refund it.
	 */
	errorAfterUsage?: boolean;
}

export interface ScriptedProviderOptions {
	/** Provider id the model specifiers resolve against, e.g. 'nebius'. */
	providerId: string;
	/**
	 * The routes to serve, mirrored from `src/agents/providers.ts` MODEL_ROUTES
	 * so cost math matches the real registration: modelId + per-Mtok rates.
	 */
	routes: readonly {
		modelId: string;
		/** US dollars per Mtok (pi's unit), e.g. 0.30 for $0.30/Mtok. */
		inputPerMtokUsd: number;
		outputPerMtokUsd: number;
		contextWindow: number;
		maxTokens: number;
	}[];
	/**
	 * The scripted replies, consumed in order across EVERY model call to this
	 * provider (coordinator turns, delegate turns, dispatched-instance turns),
	 * so a test lays out the whole conversation's model calls as a queue.
	 */
	script: ScriptedReply[];
	/**
	 * Called once per model call with the (0-based) call index and the resolved
	 * reply, after usage+cost is computed. Lets a test record per-call cost
	 * independently of the runtime's own observer (for cross-checking Q5).
	 */
	onCall?: (index: number, reply: ScriptedReply, usage: Usage) => void;
}

const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function freshUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { ...EMPTY_COST },
	};
}

/**
 * Build a scripted provider object. Pass `.provider` to `start({ providers })`
 * (the `StartOptions.providers` array takes pi `Provider`s — "a faux
 * provider's `.provider` in tests", per the node adapter docs).
 */
export function scriptedProvider(options: ScriptedProviderOptions): {
	provider: Provider;
	callCount: () => number;
} {
	let next = 0;
	const replies = options.script;

	const api = {
		stream(model: Model<'openai-completions'>, _context: TranscriptContext): AssistantMessageEventStream {
			const stream = new AssistantMessageEventStream();
			const index = next++;
			const reply = replies[index];
			void (async () => {
				const output: AssistantMessage = {
					role: 'assistant',
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					responseId: `scripted-resp-${index}`,
					responseModel: model.id,
					usage: freshUsage(0, 0),
					stopReason: 'pending',
					timestamp: Date.now(),
				};
				if (!reply) {
					// More model calls happened than the script provided — surface it
					// loudly so a test never passes on an unscripted call.
					output.stopReason = 'error';
					output.errorMessage = `scripted-provider: no scripted reply for model call #${index}`;
					stream.push({ type: 'start', partial: output });
					stream.push({ type: 'error', reason: 'error', error: output });
					stream.end();
					return;
				}

				stream.push({ type: 'start', partial: output });

				if (reply.text && reply.text.length > 0) {
					const block = { type: 'text' as const, text: reply.text };
					output.content.push(block);
					stream.push({ type: 'text_start', contentIndex: 0, partial: output });
					stream.push({ type: 'text_delta', contentIndex: 0, delta: reply.text, partial: output });
					stream.push({ type: 'text_end', contentIndex: 0, content: reply.text, partial: output });
				}

				if (reply.toolCall) {
					const tc = reply.toolCall;
					const block = { type: 'toolCall' as const, id: tc.id, name: tc.name, arguments: tc.arguments };
					const contentIndex = output.content.push(block) - 1;
					stream.push({ type: 'toolcall_start', contentIndex, partial: output });
					stream.push({
						type: 'toolcall_delta',
						contentIndex,
						delta: JSON.stringify(tc.arguments),
						partial: output,
					});
					stream.push({ type: 'toolcall_end', contentIndex, toolCall: block, partial: output });
				}

				// Fixed tokens; cost from THIS route's catalog rates (same path the
				// real provider's usage goes through). Mutates output.usage.cost.
				const usage = freshUsage(reply.input, reply.output);
				calculateCost(model, usage);
				output.usage = usage;
				output.stopReason = reply.toolCall ? 'toolUse' : 'stop';

				options.onCall?.(index, reply, usage);

				if (reply.errorAfterUsage) {
					// The model ran and billed `usage`, then the turn errored. Emit an
					// error carrying that usage so observe() sees isError WITH cost.
					output.stopReason = 'error';
					output.errorMessage = 'scripted-provider: error after usage was billed (finding #5)';
					stream.push({ type: 'error', reason: 'error', error: output });
					stream.end();
					return;
				}

				stream.push({ type: 'done', reason: output.stopReason, message: output });
				stream.end();
			})();
			return stream;
		},
		streamSimple(model: Model<'openai-completions'>, context: TranscriptContext): AssistantMessageEventStream {
			return api.stream(model, context);
		},
	};

	const provider = createProvider<'openai-completions'>({
		id: options.providerId,
		name: `scripted (${options.providerId})`,
		baseUrl: 'http://scripted.invalid/v1',
		// Keyless: resolve() reports configured so Models dispatches to us.
		auth: { apiKey: { name: 'scripted (keyless)', resolve: async () => ({ auth: {} }) } },
		models: options.routes.map((route) => ({
			id: route.modelId,
			name: route.modelId,
			api: 'openai-completions' as const,
			provider: options.providerId as Model<'openai-completions'>['provider'],
			baseUrl: 'http://scripted.invalid/v1',
			reasoning: true,
			input: ['text'],
			cost: {
				input: route.inputPerMtokUsd,
				output: route.outputPerMtokUsd,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: route.contextWindow,
			maxTokens: route.maxTokens,
		})),
		api,
	});

	return { provider, callCount: () => next };
}
