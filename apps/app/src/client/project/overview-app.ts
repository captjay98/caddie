import type { ProjectExperience } from '@caddie/contracts';
import type { CopiedAppSummary } from '../workspace/project-status.ts';

/**
 * What the project Overview's "Your app" panel says (review 2026-10-19 F04).
 *
 * It reads the same truth as the Now panel and the Projects card: the
 * workflow projection's checked preview first, then, for a project with no
 * workflow yet, the copied app (a GitHub copy or a judge's example). A live
 * private share link is a separate fact (`share`), never the source of "is
 * there an app". The panel used to read only the share list, once, so a
 * checked build or a copied example said "Your app appears here once ...".
 */
export type OverviewApp =
	/** The projection has not loaded yet. */
	| { readonly kind: 'checking' }
	/** The projection could not be read. */
	| { readonly kind: 'unavailable' }
	| {
			readonly kind: 'ready';
			readonly source: 'build' | 'example' | 'github';
			/** False when the preview predates the latest approved plan. */
			readonly current: boolean;
			/** A live private share link, as its own line; null when there is none. */
			readonly share: { readonly createdAt: string | null } | null;
	  }
	/** Caddie is building or checking it (or copying it in) right now. */
	| { readonly kind: 'building' }
	/** A copied app that did not build. */
	| { readonly kind: 'failed'; readonly message: string | null }
	/** Nothing built yet: the plan and design still have to be approved and built. */
	| { readonly kind: 'none' };

const WORKING: readonly ProjectExperience['stage'][] = ['building', 'checking', 'repairing'];

export function overviewAppState(input: {
	/** undefined while loading; null when it failed or did not parse. */
	readonly experience: ProjectExperience | null | undefined;
	readonly copiedApp: CopiedAppSummary | null;
	readonly share: { readonly live: boolean; readonly createdAt: string | null } | null;
}): OverviewApp {
	const { experience, copiedApp, share } = input;
	if (experience === undefined) return { kind: 'checking' };
	if (experience === null) return { kind: 'unavailable' };
	const liveShare = share?.live ? { createdAt: share.createdAt } : null;
	if (experience.preview) return { kind: 'ready', source: 'build', current: experience.preview.current, share: liveShare };
	// No workflow yet (version 0): a copied app may already be there.
	if (experience.version === 0 && copiedApp) {
		if (copiedApp.status === 'ready') {
			return { kind: 'ready', source: copiedApp.origin === 'example' ? 'example' : 'github', current: true, share: liveShare };
		}
		if (copiedApp.status === 'checking') return { kind: 'building' };
		return { kind: 'failed', message: copiedApp.message };
	}
	if (WORKING.includes(experience.stage)) return { kind: 'building' };
	return { kind: 'none' };
}
