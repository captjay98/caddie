import type { PreparationProgress } from '../../server/preparation-progress.ts';

const WHAT: Record<PreparationProgress['step'], string> = { plan: 'your plan', looks: 'the 3 looks', design: 'your screens' };
/** No recorded model call, draft or check for this long: say so instead of a clock. */
export const QUIET_AFTER_MS = 5 * 60_000;

/**
 * What the owner reads while a plan, the looks or the screens are prepared:
 * the stage in plain words and how long it has been going. No percentage —
 * nobody knows one — but never a silent wait either, and never "10 of about
 * 5–10 min" once the range is used up (owner 2026-10-29). When Caddie has
 * recorded nothing for a while the line says that, so the owner knows the
 * step may need a nudge.
 */
export function preparationLines(progress: PreparationProgress, nowMs: number): { stage: string; time: string; quiet: boolean } {
	const what = WHAT[progress.step];
	const stage = progress.stage === 'writing'
		? `Writing ${what}`
		: progress.stage === 'checking'
			? progress.pass > 1 ? `Checking ${what} again` : `Checking ${what}`
			: `Fixing ${what}`;
	const minutes = Math.max(0, Math.floor((nowMs - Date.parse(progress.startedAt)) / 60_000));
	if (!Number.isFinite(minutes)) return { stage, time: 'in progress', quiet: false };
	const lastActivity = progress.lastActivityAt ? Date.parse(progress.lastActivityAt) : Number.NaN;
	const quietFor = Number.isFinite(lastActivity) ? nowMs - lastActivity : 0;
	if (quietFor >= QUIET_AFTER_MS) return { stage, time: `no update for ${Math.floor(quietFor / 60_000)} min`, quiet: true };
	const [low, high] = progress.typicalMinutes;
	if (minutes < 1) return { stage, time: `usually ${low}–${high} min`, quiet: false };
	return { stage, time: minutes >= high ? `${minutes} min · longer than usual` : `${minutes} of about ${low}–${high} min`, quiet: false };
}
