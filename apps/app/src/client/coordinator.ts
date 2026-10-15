import { useCallback, useEffect, useState } from 'react';
import { useFlueAgent } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import type { InputAttachment, RunBindingRecord } from '@caddie/contracts';
import { postJson } from './api.ts';
import { toDeliveredImages } from './conversation/image-attachments.ts';
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

// MUST equal MODEL_ROLES.chat in apps/app/src/agents/providers.ts (the server
// authority). The client can't import that module (it pulls server-only Flue /
// pi-ai deps), so this literal mirrors it; the server re-verifies the route id
// against the frozen registry (findModelRoute throws on a mismatch), so a drift
// here fails closed rather than silently mis-pricing a run.
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
	send: (text: string, idempotencyKey: string, opts?: { attachments?: readonly InputAttachment[] }) => Promise<void>;
}

export function useCoordinatorTransport(
	actor: ActorScope,
	projectId: string | null,
): CoordinatorTransport | null {
	const bindings = useRunBindings(actor, projectId);
	// A run created in this session wins until the list refetch includes it.
	const [sessionRun, setSessionRun] = useState<RunBindingRecord | null>(null);
	// The transport can now outlive one workspace mount (it lives in the
	// chrome so the mobile composer works on every route): a scope switch must
	// never carry the previous actor's or project's run forward.
	useEffect(() => {
		setSessionRun(null);
	}, [actor.actorId, projectId]);
	const run = sessionRun ?? bindings.data?.runBindings?.[0] ?? null;

	const agent = useFlueAgent({
		url: run ? `/agents/coordinator/${encodeURIComponent(run.conversationId)}` : undefined,
	});

	const send = useCallback(
		async (
			text: string,
			idempotencyKey: string,
			opts?: { attachments?: readonly InputAttachment[] },
		): Promise<void> => {
			// Images ride as inline Flue image parts so the coordinator can route
			// the turn to the vision model; text files are not delivered yet.
			const { images } = await toDeliveredImages(opts?.attachments ?? []);
			let active = run;
			if (!active) {
				if (!projectId || actor.actorId === null) {
					throw new Error('the run transport needs a selected project');
				}
				const created = await postJson<{ run: RunBindingRecord }>(
					`/api/projects/${encodeURIComponent(projectId)}/runs`,
					// planRevision is server-derived: the project's current plan
					// revision, or rev-0 before the coordinator writes the first one.
					{ modelRouteId: COORDINATOR_MODEL_ROUTE, payerId: actor.actorId },
				);
				setSessionRun(created.run);
				active = created.run;
				// First message of a brand-new conversation: the hook binds to the
				// url on the next render, so admit this one out-of-band — the
				// documented adoption path for conversations created after mount.
				const client = createFlueClient({
					url: `/agents/coordinator/${encodeURIComponent(active.conversationId)}`,
				});
				await client.send({
					message: { kind: 'user', body: text, ...(images.length ? { attachments: images.map((image) => ({ ...image })) } : {}) },
					idempotencyKey,
				});
				return;
			}
			await agent.sendMessage(text, {
				idempotencyKey,
				...(images.length ? { images: images.map((image) => ({ ...image })) } : {}),
			});
		},
		[run, projectId, actor.actorId, agent],
	);

	const source: ChannelSource = run ? agent : standbySource;
	return { source, hasRun: run !== null, send };
}
