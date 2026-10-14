/**
 * Client workflow dispatch — OBSERVE ONLY (R02).
 *
 * The server now owns dispatch: `/api/projects/:id/workflow/decision` and
 * `/retry` deliver the pending coordinator message to the DO server-side (see
 * `server/workflow-dispatch.ts`), and the DO's onStart drain owns re-delivery.
 * The browser must NOT also call the coordinator — a second client-side send
 * was the tab-close failure this packet removed.
 *
 * `resumeWorkflow` is kept as a no-op shim so existing call sites and tests
 * keep compiling during the R06 UI consolidation; it resolves immediately and
 * performs no send. Callers should rely on refetching the workflow snapshot to
 * observe progress. Remove the shim once no caller references it.
 */
export async function resumeWorkflow(_projectId: string): Promise<void> {
  // Intentionally does nothing: dispatch is server-owned. Progress is observed
  // by refetching GET /api/projects/:id/workflow.
  return;
}
