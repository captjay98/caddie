import { useCallback, useState } from 'react';
import { useFlueAgent } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import type { RunBindingRecord } from '@caddie/contracts';
import { postJson } from './api.ts';
import { useRunBindings, type ActorScope } from './queries.ts';
import { standbySource, type ChannelSource } from './conversation/channel-store.ts';

/**
 * The coordinator run transport — the P05 wiring the channel-store header
 * promised: the @flue/react snapshot (shaped exactly like {@link ChannelSource})
 * replaces `standbySource`, and sends go to the Flue conversation the
 * /agents/coordinator guard serves.
 *
 * One ACTIVE run per project: the run binding is the payer+model contract
 * (frozen route, P03 budgets hang off it) and its conversationId is the
 * conversation key. It is created lazily on the FIRST send — never on page
 * view — and later sends/reloads reuse the latest binding.
 *
 * Idempotency: the key is generated at compose time in the draft store and
 * travels with every attempt (retries reuse it), matching the transport's
 * at-most-once admission contract.
 */

const COORDINATOR_MODEL_ROUTE = 'nemotron-3-super';

export interface CoordinatorTransport {
	/** Live agent snapshot; `standbySource` until the project has a run. */
	source: ChannelSource;
	/** True once the project has an active run (a real conversation key). */
	hasRun: boolean;
	/**
	 * Admit one message under an explicit idempotency key. Resolves when the
	 * send is admitted (the run/answer streams separately through `source`);
	 * rejects on transport failure — the draft stays and retries.
	 */
	send: (text: string, idempotencyKey: string) => Promise<void>;
}

export function useCoordinatorTransport(
	actor: ActorScope,
	projectId: string | null,
): CoordinatorTransport | null {
	const bindings = useRunBindings(actor, projectId);
	// A run created in this session wins until the list refetch includes it.
	const [sessionRun, setSessionRun] = useState<RunBindingRecord | null>(null);
	const run = sessionRun ?? bindings.data?.runBindings?.[0] ?? null;

	const agent = useFlueAgent({
		url: run ? `/agents/coordinator/${encodeURIComponent(run.conversationId)}` : undefined,
	});

	const send = useCallback(
		async (text: string, idempotencyKey: string): Promise<void> => {
			let active = run;
			if (!active) {
				if (!projectId || actor.actorId === null) {
					throw new Error('the run transport needs a selected project');
				}
				const created = await postJson<{ run: RunBindingRecord }>(
					`/api/projects/${encodeURIComponent(projectId)}/runs`,
					{ modelRouteId: COORDINATOR_MODEL_ROUTE, payerId: actor.actorId, planRevision: '' },
				);
				setSessionRun(created.run);
				active = created.run;
				// First message of a brand-new conversation: the hook binds to the
				// url on the next render, so admit this one out-of-band — the
				// documented adoption path for conversations created after mount.
				const client = createFlueClient({
					url: `/agents/coordinator/${encodeURIComponent(active.conversationId)}`,
				});
				await client.send({ message: { kind: 'user', body: text }, idempotencyKey });
				return;
			}
			await agent.sendMessage(text, { idempotencyKey });
		},
		[run, projectId, actor.actorId, agent],
	);

	const source: ChannelSource = run ? agent : standbySource;
	return { source, hasRun: run !== null, send };
}
