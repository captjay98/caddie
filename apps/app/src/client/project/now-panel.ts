import type { ExperienceAction, ExperienceStage, ProjectExperience } from '@caddie/contracts';

/**
 * The project page's "Now" panel, derived ONLY from the server's
 * ProjectExperience projection — the same truth the chat card reads — so the
 * page can never say "Let's get started" while Caddie is drafting a plan.
 * Pure: no React, no fetch, unit-testable.
 */

/** Where a Now-panel button goes. Commands are re-authorised server-side. */
export type NowRoute =
	| { readonly kind: 'tab'; readonly to: '/design-review' }
	| { readonly kind: 'chat' }
	| { readonly kind: 'post'; readonly path: 'workflow/retry' | 'workflow/stop' };

export interface NowButton {
	readonly kind: ExperienceAction['kind'];
	readonly label: string;
	readonly enabled: boolean;
	readonly reason: string | null;
	readonly primary: boolean;
	readonly route: NowRoute;
}

export interface NowPanelModel {
	readonly title: string;
	readonly message: string;
	/** True while Caddie is actively working — shows the live indicator. */
	readonly working: boolean;
	/** "Updated 3 min ago", or null when the time is unknown. */
	readonly updated: string | null;
	readonly buttons: readonly NowButton[];
}

const TITLES: Readonly<Record<ExperienceStage, string>> = {
	planning: 'Caddie is writing your plan',
	review: 'Your plan is ready to review',
	design: 'Caddie is designing your app',
	design_review: 'Your design is ready to review',
	building: 'Caddie is building your app',
	checking: 'Caddie is checking your app',
	repairing: 'Caddie is fixing a problem it found',
	ready: 'Your app is ready to try',
	blocked: 'Caddie needs something from you',
	planning_blocked: "Caddie couldn't finish your plan",
	stopped: 'Work on this project is paused',
};

const WORKING: ReadonlySet<ExperienceStage> = new Set(['planning', 'design', 'building', 'checking', 'repairing']);

/**
 * Plan review/approval happens on the plan page; the design review card,
 * talking and previews live in the chat.
 */
function routeFor(kind: ExperienceAction['kind']): NowRoute {
	switch (kind) {
		case 'review_plan':
		case 'approve_plan':
			return { kind: 'tab', to: '/design-review' };
		case 'retry':
			return { kind: 'post', path: 'workflow/retry' };
		case 'stop':
			return { kind: 'post', path: 'workflow/stop' };
		case 'review_design':
		case 'suggest_change':
		case 'open_preview':
		case 'resolve_input':
			return { kind: 'chat' };
	}
}

/** "just now" / "3 min ago" / "2 h ago" / "4 days ago" from an epoch-ms version. */
export function relativeUpdated(versionMs: number, nowMs: number): string | null {
	if (!Number.isFinite(versionMs) || versionMs <= 0) return null;
	const minutes = Math.floor(Math.max(0, nowMs - versionMs) / 60_000);
	if (minutes < 1) return 'Updated just now';
	if (minutes < 60) return `Updated ${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `Updated ${hours} h ago`;
	const days = Math.floor(hours / 24);
	return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The panel for a project with a workflow, or null when the project has none
 * yet (version 0 — the projection defaults its stage to `planning` then, which
 * must NOT be shown as "Caddie is writing your plan").
 */
export function nowPanelModel(experience: ProjectExperience, nowMs: number): NowPanelModel | null {
	if (experience.version === 0) return null;
	// Primary first, then the rest in server order.
	const ordered = [...experience.actions].sort((a, b) => Number(b.primary) - Number(a.primary));
	return {
		title: TITLES[experience.stage],
		message: experience.message,
		working: WORKING.has(experience.stage),
		updated: relativeUpdated(experience.version, nowMs),
		buttons: ordered.map((action) => ({
			kind: action.kind,
			label: action.label,
			enabled: action.enabled,
			reason: action.enabled ? null : (action.reason ?? null),
			primary: action.primary,
			route: routeFor(action.kind),
		})),
	};
}
