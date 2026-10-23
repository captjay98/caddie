import { queryOptions } from '@tanstack/react-query';
import type { ApprovalRecord, PlanDocRevision } from '@caddie/contracts';
import type { BuildWorkflow } from '../server/build-workflow.ts';
import type { ImportPreviewView } from '../server/import-preview.ts';
import { fetchJson } from './api.ts';

export interface WorkflowSnapshot {
 workflow: BuildWorkflow | null;
 plan: PlanDocRevision | null;
 approval: ApprovalRecord | null;
 design: PlanDocRevision | null;
 designApproval: ApprovalRecord | null;
 previewHasServer?: boolean;
 previewKind?: 'web' | 'flutter';
 importPreview?: ImportPreviewView | null;
 /** True when a planning handoff to the coordinator has failed to converge
  * (reconciliation-required past the redelivery lease) — the UI shows an
  * actionable retry instead of the endless "turning your request into a plan"
  * placeholder. Server: workflowSnapshot/planningDispatchStalled. */
 dispatchStalled?: boolean;
}

export function workflowRefreshMs(snapshot: WorkflowSnapshot | undefined): number {
 const phase = snapshot?.workflow?.phase;
 return phase === 'planning' || phase === 'looks' || phase === 'design' || phase === 'building' || snapshot?.importPreview?.status === 'checking' ? 2000 : 30_000;
}

/** One actor/project cache and refresh policy for every view of the workflow. */
export function workflowQueryOptions(actorId: string | null, projectId: string | null) {
 return queryOptions({
  queryKey: ['build-workflow', actorId ?? 'pending', projectId ?? 'none'],
  enabled: Boolean(actorId && projectId),
  queryFn: () => fetchJson<WorkflowSnapshot>(`/api/projects/${encodeURIComponent(projectId ?? '')}/workflow`),
  refetchInterval: query => workflowRefreshMs(query.state.data),
 });
}
