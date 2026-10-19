import { describe, expect, test } from 'bun:test';
import type { ProjectExperience } from '@caddie/contracts';
import { overviewAppState } from '../apps/app/src/client/project/overview-app.ts';

/**
 * Review 2026-10-19 F04: the Overview's "Your app" panel read the older
 * private-share list once, so a checked build or a copied example showed
 * "Your app appears here once the plan is approved and built". It now reads
 * the same state as the Now panel and the Projects card: the workflow
 * projection's preview, then the copied app, with the share link as a separate
 * line. Pure state; the browser spec checks the rendering.
 */

function experience(overrides: Partial<ProjectExperience> = {}): ProjectExperience {
	return {
		projectId: 'proj-a',
		version: 1_760_000_000_000,
		stage: 'ready',
		plan: { id: 'plan-1', revision: '2', approved: true },
		preview: null,
		message: 'Your app is ready.',
		actions: [],
		...overrides,
	} as ProjectExperience;
}

describe('F04 Overview "Your app" follows the workflow, not the share list', () => {
	test('a checked build with no private share link is ready to try', () => {
		const state = overviewAppState({
			experience: experience({ preview: { id: 'out-1', revision: '2', current: true } }),
			copiedApp: null,
			share: { live: false, createdAt: null },
		});
		expect(state).toEqual({ kind: 'ready', source: 'build', current: true, share: null });
	});

	test('a copied example with no build workflow is ready to try, and says it is an example', () => {
		const state = overviewAppState({
			experience: experience({ version: 0, stage: 'planning', plan: null }),
			copiedApp: { status: 'ready', origin: 'example', message: null },
			share: null,
		});
		expect(state).toEqual({ kind: 'ready', source: 'example', current: true, share: null });
		expect(
			overviewAppState({ experience: experience({ version: 0, plan: null }), copiedApp: { status: 'ready', origin: 'github', message: null }, share: null }),
		).toMatchObject({ kind: 'ready', source: 'github' });
	});

	test('a build becoming ready flips the panel on the next projection, no reload', () => {
		const before = overviewAppState({ experience: experience({ stage: 'building', preview: null }), copiedApp: null, share: null });
		expect(before).toEqual({ kind: 'building' });
		const after = overviewAppState({
			experience: experience({ stage: 'ready', preview: { id: 'out-2', revision: '2', current: true } }),
			copiedApp: null,
			share: null,
		});
		expect(after.kind).toBe('ready');
	});

	test('a revoked share does not hide an app the owner can still open; a live share is its own line', () => {
		const ready = experience({ preview: { id: 'out-1', revision: '2', current: true } });
		expect(overviewAppState({ experience: ready, copiedApp: null, share: { live: false, createdAt: null } })).toMatchObject({
			kind: 'ready',
			share: null,
		});
		expect(
			overviewAppState({ experience: ready, copiedApp: null, share: { live: true, createdAt: '2026-10-19T10:00:00.000Z' } }),
		).toMatchObject({ kind: 'ready', share: { createdAt: '2026-10-19T10:00:00.000Z' } });
	});

	test('no output yet: the plan or design still has to be approved; a stale preview says it is an earlier version', () => {
		expect(overviewAppState({ experience: experience({ stage: 'review', plan: { id: 'p', revision: '1', approved: false } }), copiedApp: null, share: null })).toEqual({
			kind: 'none',
		});
		expect(
			overviewAppState({ experience: experience({ preview: { id: 'out-1', revision: '1', current: false } }), copiedApp: null, share: null }),
		).toMatchObject({ kind: 'ready', current: false });
		expect(
			overviewAppState({ experience: experience({ version: 0, plan: null }), copiedApp: { status: 'checking', origin: 'github', message: null }, share: null }),
		).toEqual({ kind: 'building' });
		expect(
			overviewAppState({ experience: experience({ version: 0, plan: null }), copiedApp: { status: 'failed', origin: 'github', message: 'The copy did not build.' }, share: null }),
		).toEqual({ kind: 'failed', message: 'The copy did not build.' });
	});

	test('while the projection is loading or failed, it says so instead of guessing', () => {
		expect(overviewAppState({ experience: undefined, copiedApp: null, share: null })).toEqual({ kind: 'checking' });
		expect(overviewAppState({ experience: null, copiedApp: null, share: null })).toEqual({ kind: 'unavailable' });
	});
});
