import { useQuery } from '@tanstack/react-query';
import { workflowQueryOptions } from '../workflow-query.ts';
import { fetchJson } from '../api.ts';
import type { DecisionCard } from '@caddie/contracts';
import { useAccountBrief, useMarkBriefRead } from '../queries.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { briefActionRoute } from './navigate.ts';

/** Brief and transcript cards open the same scoped target; reading never decides. */
export function useDecisionCardAction() {
 const chrome = useWorkspaceChrome();
 const markRead = useMarkBriefRead({ actorId: chrome.actorId });
 return (card: DecisionCard) => {
  if (card.key) markRead.mutate([card.key]);
  const route = briefActionRoute(card, chrome.homeProject?.id ?? null);
  chrome.goProjectTab(route.to, route.search);
 };
}

/** Transcript parts are immutable snapshots; prefer the same current feed as Brief. */
export function useCurrentDecisionCard(snapshot: DecisionCard): DecisionCard {
 const chrome = useWorkspaceChrome();
 const brief = useAccountBrief({ actorId: chrome.actorId }, false);
 const workflowCard = /^brf_workflow_(build|repair|blocked)_/.test(snapshot.id);
 const current = brief.data?.cards.find(card => card.projectId === snapshot.projectId && (workflowCard ? card.id.startsWith('brf_workflow_') && (card.runId ?? card.primaryAction.targetId) === (snapshot.runId ?? snapshot.primaryAction.targetId) : card.kind === snapshot.kind && card.primaryAction.targetId === snapshot.primaryAction.targetId));
 const workflow = useQuery({ ...workflowQueryOptions(chrome.actorId, snapshot.projectId), enabled: workflowCard && !current && Boolean(chrome.actorId), refetchInterval: false });
 // Recent Brief windows are bounded. A historical chat approval outside that
 // window still reads its durable record rather than reverting to Pending.
 const original = useQuery({ queryKey: ['approval-card', chrome.actorId, snapshot.projectId, snapshot.primaryAction.targetId], enabled: snapshot.kind === 'approval' && !current && Boolean(chrome.actorId), queryFn: () => fetchJson<{ approval?: { projectId: string; status: string; decidedAt: string | null } }>(`/api/approvals/${encodeURIComponent(snapshot.primaryAction.targetId)}`) });
 const record = original.data?.approval;
 if (current) return current;
 const state = workflow.data?.workflow;
 if (workflowCard && state && state.runId === (snapshot.runId ?? snapshot.primaryAction.targetId)) {
  if (state.phase === 'ready' && state.previewId) return { ...snapshot, id: `brf_workflow_preview_${state.previewId}`, kind: 'result', status: 'handled', headline: 'Your app is ready to try', summary: state.detail ?? 'The build is complete. Open this checked preview to try it.', updatedAt: state.updatedAt, primaryAction: { kind: 'preview', label: 'Try the app', targetId: state.previewId } };
  if (state.phase === 'blocked') return { ...snapshot, id: `brf_workflow_blocked_${state.runId}`, status: 'blocked', headline: 'Your build needs attention', summary: state.detail ?? 'The build stopped. Your plan and saved files are retained.', updatedAt: state.updatedAt };
 }
 if (workflowCard && workflow.isSuccess && (!state || state.runId !== (snapshot.runId ?? snapshot.primaryAction.targetId) || state.phase !== 'building')) return { ...snapshot, id: `brf_workflow_history_${snapshot.id}`, status: 'handled', headline: 'An earlier build update', summary: snapshot.summary, primaryAction: { kind: 'inspect', label: 'View activity', targetId: snapshot.primaryAction.targetId } };
 if (record && record.projectId === snapshot.projectId && record.status !== 'pending') return { ...snapshot, status: 'handled', headline: `${snapshot.headline} · ${record.status}`, summary: `Decision recorded: ${record.status}. Open the original decision for its scope and revision.`, updatedAt: record.decidedAt ?? snapshot.updatedAt, primaryAction: { ...snapshot.primaryAction, label: 'View decision' } };
 return snapshot;
}
