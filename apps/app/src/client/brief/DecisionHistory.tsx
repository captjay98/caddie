import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { DecisionCard } from '@caddie/contracts';
import type { ApprovalHistoryPage } from '../../server/brief.ts';
import { fetchJson } from '../api.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { DecisionCardView } from './DecisionCard.tsx';
/** History loads only on request; the initial feed stays small. Exact original
 * decisions stay available even after they leave the recent Brief window. */
export function DecisionHistory({ existingIds, onAction, names }: { existingIds: string[]; onAction?: (card: DecisionCard) => void; names: Map<string, string> }) {
 const chrome = useWorkspaceChrome();
 const [enabled, setEnabled] = useState(false);
 const history = useInfiniteQuery({ queryKey: ['brief-history', chrome.actorId], enabled: enabled && Boolean(chrome.actorId), initialPageParam: null as { at: string; id: string } | null,
  queryFn: ({ pageParam }) => fetchJson<ApprovalHistoryPage>(`/api/brief/history${pageParam ? `?${new URLSearchParams({ beforeTime: pageParam.at, beforeId: pageParam.id })}` : ''}`),
  getNextPageParam: page => page.next ?? undefined,
 });
 const cards = (history.data?.pages.flatMap(page => page.cards) ?? []).filter(card => !existingIds.includes(card.id));
 return <div className="decision-history" data-testid="decision-history">{cards.map(card => <DecisionCardView key={card.id} card={card} contextLabel={names.get(card.projectId)} onAction={onAction} />)}
 {history.isError ? <p role="alert">Older decisions could not be loaded. <button className="btn-ghost" type="button" onClick={() => void history.refetch()}>Try again</button></p> : null}
 {!enabled || history.hasNextPage ? <button type="button" className="btn-ghost" disabled={history.isFetching} onClick={() => { if (!enabled) setEnabled(true); else void history.fetchNextPage(); }}>{history.isFetching ? 'Loading decisions…' : 'Load older decisions'}</button> : history.isFetching ? <p role="status">Loading decisions…</p> : !history.isError ? <p className="state-detail">All recorded decisions are shown.</p> : null}
 </div>;
}
