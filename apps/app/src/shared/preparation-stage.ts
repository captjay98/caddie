/** Describe paused work without calling a pre-build review a failed build. */
export function pausedPreparation(workflow: {
 phase: string; previewId?: string | null; looksBaseline?: number | null;
 designBaseline?: number | null; approvedDesignRevisionId?: string | null;
}, planWasApproved: boolean): 'plan' | 'looks' | 'design' | null {
 if (workflow.phase !== 'blocked' || workflow.previewId) return null;
 if (!planWasApproved) return 'plan';
 if (workflow.looksBaseline == null || workflow.approvedDesignRevisionId) return null;
 return workflow.designBaseline == null ? 'looks' : 'design';
}

export function preparationRetryLabel(stage: 'plan' | 'looks' | 'design' | null): string {
 return stage === 'plan' ? 'Continue the plan' : stage === 'looks' ? 'Continue the looks' : stage === 'design' ? 'Continue the design' : 'Retry build';
}
