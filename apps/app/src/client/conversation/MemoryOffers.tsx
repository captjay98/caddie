import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../api.ts';

/**
 * What Caddie can remember, offered right in the chat (plan 6.2): a lasting
 * preference the person stated ("Always use TypeScript.") or something Caddie
 * proposed with remember. Nothing is kept until they press "Remember it";
 * "No thanks" declines it for good (it is never offered again).
 */

interface MemoryOffer {
	readonly id: string;
	readonly content: string;
}

export function MemoryOffers(props: { projectId: string; refreshKey: number }): ReactElement | null {
	const queryClient = useQueryClient();
	const offers = useQuery({
		queryKey: ['memory-offers', props.projectId, props.refreshKey],
		queryFn: () => fetchJson<{ offers: MemoryOffer[] }>(`/api/memory/offers?projectId=${encodeURIComponent(props.projectId)}`),
		select: (data) => data.offers,
		retry: false,
	});
	const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());

	async function answer(offer: MemoryOffer, action: 'confirm' | 'retract'): Promise<void> {
		setAnswered((prev) => new Set(prev).add(offer.id));
		try {
			await postJson(`/api/memory/${encodeURIComponent(offer.id)}/${action}`, {});
		} catch {
			// Not saved: show the offer again so the answer can be given again.
			setAnswered((prev) => {
				const next = new Set(prev);
				next.delete(offer.id);
				return next;
			});
		}
		void queryClient.invalidateQueries({ queryKey: ['memory-offers', props.projectId] });
		void queryClient.invalidateQueries({ queryKey: ['memory'] });
	}

	const waiting = (offers.data ?? []).filter((offer) => !answered.has(offer.id));
	if (waiting.length === 0) return null;
	return (
		<section className="memory-offers" data-testid="memory-offers" aria-label="Things Caddie can remember">
			{waiting.map((offer) => (
				<div key={offer.id} className="memory-offer" data-testid="memory-offer">
					<p className="memory-offer-text">
						Caddie can remember this for next time: <q>{offer.content}</q>
					</p>
					<div className="memory-offer-actions">
						<button type="button" className="btn-key" onClick={() => void answer(offer, 'confirm')}>
							Remember it
						</button>
						<button type="button" className="btn-ghost" onClick={() => void answer(offer, 'retract')}>
							No thanks
						</button>
					</div>
				</div>
			))}
		</section>
	);
}
