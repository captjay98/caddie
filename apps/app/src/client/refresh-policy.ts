const ACTIVE = new Set(['planning', 'looks', 'design', 'building', 'checking', 'repairing']);
/** Keep active work fresh; focus and explicit actions also refresh stable pages. */
export function experienceRefreshMs(data: { stage: string } | undefined): number {
 return !data || ACTIVE.has(data.stage) ? 3000 : 30_000;
}
