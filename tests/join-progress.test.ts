import { describe, expect, test } from 'bun:test';
import {
	deriveJoinSteps,
	joinStepsComplete,
	readGithubSkipped,
	writeGithubSkipped,
	buildGuidedStepsCard,
	type JoinSignals,
} from '../apps/app/src/client/join/progress.ts';

/**
 * Join-progress derivation (apps/app/src/client/join/progress.ts): the ONE
 * source the in-chat GuidedStepsCard and the Overview stepper both read, so
 * their step states can never drift. Every state must be DERIVED from a real
 * signal — this pins the full truth table, the "skip never walls build" rule,
 * completion, and the per-project skip persistence.
 */

function states(signals: JoinSignals) {
	const steps = deriveJoinSteps(signals);
	return { project: steps[0]!.state, github: steps[1]!.state, build: steps[2]!.state };
}

describe('deriveJoinSteps — truth table', () => {
	test('fresh project, no repo, not skipped: project done, github active, build todo', () => {
		expect(states({ projectExists: true, hasRepo: false, githubSkipped: false, hasPlanDraft: false })).toEqual({
			project: 'done',
			github: 'active',
			build: 'todo',
		});
	});

	test('repo connected: github done, build becomes active', () => {
		expect(states({ projectExists: true, hasRepo: true, githubSkipped: false, hasPlanDraft: false })).toEqual({
			project: 'done',
			github: 'done',
			build: 'active',
		});
	});

	test('github skipped: github skipped, build still active (skip never walls build)', () => {
		expect(states({ projectExists: true, hasRepo: false, githubSkipped: true, hasPlanDraft: false })).toEqual({
			project: 'done',
			github: 'skipped',
			build: 'active',
		});
	});

	test('plan draft exists: build done', () => {
		expect(states({ projectExists: true, hasRepo: true, githubSkipped: false, hasPlanDraft: true })).toEqual({
			project: 'done',
			github: 'done',
			build: 'done',
		});
	});

	test('connecting a repo supersedes a prior skip (hasRepo wins over githubSkipped)', () => {
		expect(states({ projectExists: true, hasRepo: true, githubSkipped: true, hasPlanDraft: false }).github).toBe(
			'done',
		);
	});

	test('build done even while github skipped (user built before connecting)', () => {
		expect(states({ projectExists: true, hasRepo: false, githubSkipped: true, hasPlanDraft: true })).toEqual({
			project: 'done',
			github: 'skipped',
			build: 'done',
		});
	});

	test('no project yet (defensive): project active, github todo (nothing before it settled)', () => {
		expect(states({ projectExists: false, hasRepo: false, githubSkipped: false, hasPlanDraft: false })).toEqual({
			project: 'active',
			github: 'todo',
			build: 'todo',
		});
	});

	test('exactly three ordered steps project → github → build', () => {
		const steps = deriveJoinSteps({ projectExists: true, hasRepo: false, githubSkipped: false, hasPlanDraft: false });
		expect(steps.map((s) => s.id)).toEqual(['project', 'github', 'build']);
		for (const step of steps) {
			expect(step.title.length).toBeGreaterThan(0);
			expect(step.detail.length).toBeGreaterThan(0);
		}
	});

	test('detail text tracks state for the github step', () => {
		const done = deriveJoinSteps({ projectExists: true, hasRepo: true, githubSkipped: false, hasPlanDraft: false })[1]!;
		const skipped = deriveJoinSteps({ projectExists: true, hasRepo: false, githubSkipped: true, hasPlanDraft: false })[1]!;
		const active = deriveJoinSteps({ projectExists: true, hasRepo: false, githubSkipped: false, hasPlanDraft: false })[1]!;
		expect(done.detail).not.toBe(skipped.detail);
		expect(skipped.detail).not.toBe(active.detail);
		expect(skipped.detail.toLowerCase()).toContain('skip');
	});
});

describe('joinStepsComplete', () => {
	test('complete when all done', () => {
		expect(
			joinStepsComplete(
				deriveJoinSteps({ projectExists: true, hasRepo: true, githubSkipped: false, hasPlanDraft: true }),
			),
		).toBe(true);
	});
	test('complete when github skipped and the rest done', () => {
		expect(
			joinStepsComplete(
				deriveJoinSteps({ projectExists: true, hasRepo: false, githubSkipped: true, hasPlanDraft: true }),
			),
		).toBe(true);
	});
	test('not complete while build is active/todo', () => {
		expect(
			joinStepsComplete(
				deriveJoinSteps({ projectExists: true, hasRepo: true, githubSkipped: false, hasPlanDraft: false }),
			),
		).toBe(false);
	});
});

describe('github-skip persistence (per project, reversible)', () => {
	function fakeStorage(): Storage {
		const map = new Map<string, string>();
		return {
			getItem: (k) => map.get(k) ?? null,
			setItem: (k, v) => void map.set(k, String(v)),
			removeItem: (k) => void map.delete(k),
			clear: () => map.clear(),
			key: (i) => [...map.keys()][i] ?? null,
			get length() {
				return map.size;
			},
		} as Storage;
	}

	test('defaults to not skipped', () => {
		expect(readGithubSkipped('proj-1', fakeStorage())).toBe(false);
	});

	test('write then read is true; scoped per project', () => {
		const s = fakeStorage();
		writeGithubSkipped('proj-1', true, s);
		expect(readGithubSkipped('proj-1', s)).toBe(true);
		expect(readGithubSkipped('proj-2', s)).toBe(false); // isolation
	});

	test('un-skip removes it (reversible)', () => {
		const s = fakeStorage();
		writeGithubSkipped('proj-1', true, s);
		writeGithubSkipped('proj-1', false, s);
		expect(readGithubSkipped('proj-1', s)).toBe(false);
	});

	test('null storage is safe (private mode): read false, write no-throw', () => {
		expect(readGithubSkipped('proj-1', null)).toBe(false);
		expect(() => writeGithubSkipped('proj-1', true, null)).not.toThrow();
	});
});

describe('buildGuidedStepsCard', () => {
	test('carries context + derived steps; empty context defaults to ""', () => {
		const steps = deriveJoinSteps({ projectExists: true, hasRepo: false, githubSkipped: false, hasPlanDraft: false });
		const card = buildGuidedStepsCard({
			projectId: 'proj-1',
			contestTitle: 'Nebius × NVIDIA',
			contestUrl: 'https://example.com',
			steps,
		});
		expect(card.projectId).toBe('proj-1');
		expect(card.contestContext).toBe('');
		expect(card.steps).toHaveLength(3);
		expect(card.steps[1]!.id).toBe('github');
	});
});
