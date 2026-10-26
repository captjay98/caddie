import type { StartingPoint } from './Start.tsx';

/**
 * Where onboarding hands off, by the starting point the person chose.
 *
 * Walkthrough finding (2026-10-26): the 'idea' hand-off used to be
 * `/app/?start=idea&pane=channel`. `pane=channel` is the MOBILE view — "the
 * conversation IS the Chat tab, full-height" (Chrome.tsx). Forcing it on every
 * viewport meant a judge on a computer landed on bare chat instead of the
 * split: the "What would you like to build?" start panel on the left, the
 * conversation on the right. So 'idea' now carries only `?start=idea`, and the
 * shell picks the layout from the viewport — split on desktop/tablet, the
 * conversation on mobile (its default on `/`). This is the default target only;
 * a saved same-origin destination still wins in finish().
 */
export function onboardingDestination(startingPoint: StartingPoint): string {
	switch (startingPoint) {
		case 'hackathon':
			return '/app/discover';
		case 'idea':
			return '/app/?start=idea';
		default:
			return '/app/';
	}
}
