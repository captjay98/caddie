import { describe, expect, test } from 'bun:test';
import type { ExperienceAction, ExperienceStage, ProjectExperience } from '@caddie/contracts';
import { nowPanelModel, relativeUpdated } from '../apps/app/src/client/project/now-panel.ts';

/**
 * The project page's Now panel (2026-10-15 redesign, Stage 1). Bug it
 * replaces: FarmLog AI's page said "Let's get started — Tell Caddie what you
 * want to make" while its own step bar said "Plan · Caddie is drafting it",
 * because the next-step panel read decision cards, not the workflow.
 */
const NOW = Date.parse('2026-10-15T16:00:00Z');

function experience(stage: ExperienceStage, actions: ExperienceAction[] = [], version = NOW - 3 * 60_000): ProjectExperience {
	return { projectId: 'p1', version, stage, plan: null, preview: null, message: `msg:${stage}`, actions };
}
const action = (kind: ExperienceAction['kind'], primary = false, enabled = true, reason?: string): ExperienceAction => ({
	kind,
	label: `label:${kind}`,
	enabled,
	primary,
	...(reason ? { reason } : {}),
});

describe('Now panel model', () => {
	test('a project with no workflow (version 0) gets no Now panel, so the start prompt stays honest', () => {
		expect(nowPanelModel(experience('planning', [], 0), NOW)).toBeNull();
	});

	test('every stage has a plain title and the server message, never the empty-project prompt', () => {
		const titles: Record<ExperienceStage, string> = {
			planning: 'Caddie is writing your plan',
			review: 'Your plan is ready to review',
			building: 'Caddie is building your app',
			checking: 'Caddie is checking your app',
			repairing: 'Caddie is fixing a problem it found',
			ready: 'Your app is ready to try',
			blocked: 'Caddie needs something from you',
			stopped: 'Work on this project is paused',
		};
		for (const [stage, title] of Object.entries(titles) as [ExperienceStage, string][]) {
			const model = nowPanelModel(experience(stage), NOW)!;
			expect(model.title).toBe(title);
			expect(model.message).toBe(`msg:${stage}`);
			expect(model.title).not.toContain('get started');
		}
	});

	test('the live indicator shows only while Caddie is working', () => {
		const working = (stage: ExperienceStage) => nowPanelModel(experience(stage), NOW)!.working;
		for (const stage of ['planning', 'building', 'checking', 'repairing'] as const) expect(working(stage)).toBe(true);
		for (const stage of ['review', 'ready', 'blocked', 'stopped'] as const) expect(working(stage)).toBe(false);
	});

	test('buttons keep server labels, put the primary first and route to the real control', () => {
		const model = nowPanelModel(
			experience('review', [action('suggest_change'), action('approve_plan', true), action('review_plan')]),
			NOW,
		)!;
		expect(model.buttons.map((b) => b.kind)).toEqual(['approve_plan', 'suggest_change', 'review_plan']);
		expect(model.buttons[0]).toMatchObject({ label: 'label:approve_plan', primary: true, route: { kind: 'tab', to: '/design-review' } });
		expect(model.buttons[1]!.route).toEqual({ kind: 'chat' });
		expect(model.buttons[2]!.route).toEqual({ kind: 'tab', to: '/design-review' });
	});

	test('retry and stop post to the workflow routes; preview and input open the chat', () => {
		const model = nowPanelModel(
			experience('blocked', [action('retry', true), action('stop'), action('open_preview'), action('resolve_input')]),
			NOW,
		)!;
		expect(model.buttons.map((b) => b.route)).toEqual([
			{ kind: 'post', path: 'workflow/retry' },
			{ kind: 'post', path: 'workflow/stop' },
			{ kind: 'chat' },
			{ kind: 'chat' },
		]);
	});

	test('a disabled action carries its reason; an enabled one carries none', () => {
		const model = nowPanelModel(experience('building', [action('stop', true, false, 'Already stopping.'), action('retry')]), NOW)!;
		expect(model.buttons[0]).toMatchObject({ enabled: false, reason: 'Already stopping.' });
		expect(model.buttons[1]).toMatchObject({ enabled: true, reason: null });
	});
});

describe('relativeUpdated', () => {
	test('minutes, hours and days; unknown time is null', () => {
		expect(relativeUpdated(NOW - 20_000, NOW)).toBe('Updated just now');
		expect(relativeUpdated(NOW - 3 * 60_000, NOW)).toBe('Updated 3 min ago');
		expect(relativeUpdated(NOW - 2 * 3_600_000, NOW)).toBe('Updated 2 h ago');
		expect(relativeUpdated(NOW - 26 * 3_600_000, NOW)).toBe('Updated 1 day ago');
		expect(relativeUpdated(NOW - 3 * 86_400_000, NOW)).toBe('Updated 3 days ago');
		expect(relativeUpdated(0, NOW)).toBeNull();
		// a clock-skewed future version reads as just now, never negative
		expect(relativeUpdated(NOW + 60_000, NOW)).toBe('Updated just now');
	});
});
