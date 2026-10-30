import { queryOptions } from '@tanstack/react-query';
import type { ApprovalRecord, PlanDocRevision } from '@caddie/contracts';
import type { BuildWorkflow, ReadyChange } from '../server/build-workflow.ts';
import type { ImportPreviewView } from '../server/import-preview.ts';
import type { PreparationProgress } from '../server/preparation-progress.ts';
import type { PlanStages } from '../server/build-features.ts';
import { fetchJson } from './api.ts';

export interface WorkflowSnapshot {
 workflow: BuildWorkflow | null;
 plan: PlanDocRevision | null;
 approval: ApprovalRecord | null;
 /** The looks proposal the owner is choosing from (its raw plan note), or null
  * outside the look step. Parse its body with parseLooks to render the picker. */
 looks?: PlanDocRevision | null;
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
 /** The project's open or most recent post-ready change (server: workflowSnapshot). */
 change?: ReadyChange | null;
 /** Plan/looks/screens: which stage, which pass, since when (server: preparation-progress.ts). */
 preparationProgress?: PreparationProgress | null;
 /** Staged builds: the first version and the "add after" ideas (server: build-features.ts planStages). */
 planStages?: PlanStages | null;
}

export function workflowRefreshMs(snapshot: WorkflowSnapshot | undefined): number {
 const phase = snapshot?.workflow?.phase;
 return phase === 'planning' || phase === 'looks' || phase === 'design' || phase === 'building' || snapshot?.importPreview?.status === 'checking' || (snapshot?.change?.status === 'proposed' && !snapshot.change.proposal) ? 2000 : 30_000;
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
