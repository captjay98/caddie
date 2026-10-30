import type { D1Database } from './auth.ts';
/**
 * Honest progress for the steps no one can put a percentage on (plan, looks,
 * screens). Everything here is a recorded fact: when the step started, whether
 * a draft is being written, checked, or fixed after a check, which pass it is
 * on, and when Caddie last did anything for it (a model call, a draft or a
 * check). The typical range comes from real runs and is shown as "usually",
 * never as a promise or a percentage (owner 2026-10-29: "the user just keeps
 * waiting without knowing how long").
 */
export interface PreparationProgress {
	step: 'plan' | 'looks' | 'design';
	stage: 'writing' | 'checking' | 'fixing';
	/** 1 for the first draft, 2 after one round of fixes, and so on. */
	pass: number;
	startedAt: string;
	typicalMinutes: readonly [number, number];
	/** The newest recorded work for this step: a model call, a draft or a check. */
	lastActivityAt?: string;
}
const STEP: Record<string, { step: PreparationProgress['step']; kind: string; typical: readonly [number, number] }> = {
	// One fix round per AI-reviewed plan; looks are machine-checked in seconds
	// (owner 2026-10-29), so the looks step is one designer turn plus fixes.
	planning: { step: 'plan', kind: 'prd', typical: [4, 10] },
	looks: { step: 'looks', kind: 'looks', typical: [3, 8] },
	design: { step: 'design', kind: 'design', typical: [5, 10] },
};
export async function preparationProgress(
	db: D1Database,
	workflow: { projectId: string; phase: string; updatedAt: string; conversationId?: string } | null,
): Promise<PreparationProgress | null> {
	const step = workflow ? STEP[workflow.phase] : undefined;
	if (!workflow || !step) return null;
	let drafts: { status: string; createdAt: string }[] = [];
	try {
		drafts = (await db
			.prepare('select status, createdAt from artifact_candidates where projectId = ? and kind = ? and createdAt >= ? order by createdAt')
			.bind(workflow.projectId, step.kind, workflow.updatedAt)
			.all<{ status: string; createdAt: string }>()).results;
	} catch (error) {
		if (!/no such table/i.test(String(error))) throw error;
	}
	let lastCall: string | null = null;
	if (workflow.conversationId) {
		try {
			lastCall = (await db
				.prepare('select max("createdAt") as "t" from "model_call_usage" where "instanceId" = ? and "createdAt" >= ?')
				.bind(workflow.conversationId, workflow.updatedAt)
				.all<{ t: string | null }>()).results[0]?.t ?? null;
		} catch (error) {
			if (!/no such (table|column)/i.test(String(error))) throw error;
		}
	}
	const last = drafts.at(-1)?.status;
	const reviewed = drafts.filter((row) => row.status === 'revise').length;
	const stage: PreparationProgress['stage'] =
		last === 'pending' || last === 'reviewing' ? 'checking' : reviewed > 0 ? 'fixing' : 'writing';
	const lastActivityAt = [workflow.updatedAt, drafts.at(-1)?.createdAt, lastCall]
		.filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
		.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
	return { step: step.step, stage, pass: reviewed + 1, startedAt: workflow.updatedAt, typicalMinutes: step.typical, ...(lastActivityAt ? { lastActivityAt } : {}) };
}
