import { describe, expect, test } from 'bun:test';
import { activeStep, workflowSteps } from '../apps/app/src/client/workspace/project-status.ts';

/**
 * Project step bar (2026-10-15 redesign, Stage 4). Before this, the bar only
 * highlighted the TAB being viewed, so on the overview no step looked active
 * even while Caddie was planning, and its wording ("Not started yet") said
 * nothing about when a step happens.
 */
describe('active step (where the work is)', () => {
	test('Plan while planning or in review, Build while building or blocked, Check once ready', () => {
		expect(activeStep('planning')).toBe('plan');
		expect(activeStep('review')).toBe('plan');
		expect(activeStep('building')).toBe('build');
		expect(activeStep('blocked')).toBe('build');
		expect(activeStep('ready')).toBe('check');
	});
	test('no workflow yet: nothing is highlighted', () => {
		expect(activeStep(null)).toBeNull();
	});
});

describe('step wording', () => {
	test('a hackathon project while Caddie plans', () => {
		expect(workflowSteps('planning')).toEqual({
			plan: { text: 'Caddie is drafting it', tone: 'neutral' },
			build: { text: 'After you approve', tone: 'neutral' },
			check: { text: 'Before you submit', tone: 'neutral' },
			submission: { text: 'Hand in when ready', tone: 'neutral' },
		});
	});
	test('a personal project says when Check happens without mentioning submission', () => {
		const steps = workflowSteps('review', { personal: true });
		expect(steps.plan).toEqual({ text: 'Ready to review', tone: 'needs' });
		expect(steps.check).toEqual({ text: 'After it’s built', tone: 'neutral' });
		expect(steps.submission).toEqual({ text: 'Optional', tone: 'neutral' });
	});
	test('green only when the data says done', () => {
		const ready = workflowSteps('ready');
		expect(ready.plan?.tone).toBe('done');
		expect(ready.build).toEqual({ text: 'Ready to try', tone: 'done' });
		expect(ready.check?.tone).toBe('neutral');
		expect(workflowSteps('ready', { checkReady: { verified: 2, total: 3 } }).check).toEqual({ text: '2 of 3 ready', tone: 'needs' });
		expect(workflowSteps('blocked').build).toEqual({ text: 'Needs your help', tone: 'needs' });
	});
});

/**
 * "Paused" alone can't tell a stuck plan from a paused build (the workflow
 * phase is `blocked` for both). The project status knows whether the plan was
 * approved, so the steps say the same thing as the Now card.
 */
describe('a pause after approval vs a stuck plan', () => {
	test('a build paused after approval: Plan stays approved, Build needs you, Build is where the work is', () => {
		const steps = workflowSteps('blocked', { planApproved: true });
		expect(steps.plan).toEqual({ text: 'Approved', tone: 'done' });
		expect(steps.build).toEqual({ text: 'Needs your help', tone: 'needs' });
		expect(activeStep('blocked', { planApproved: true })).toBe('build');
	});
	test('a plan that got stuck before approval: Plan needs you, Build has not started, Plan is where the work is', () => {
		const steps = workflowSteps('blocked', { planApproved: false });
		expect(steps.plan).toEqual({ text: 'Paused — check with Caddie', tone: 'needs' });
		expect(steps.build).toEqual({ text: 'After you approve', tone: 'neutral' });
		expect(activeStep('blocked', { planApproved: false })).toBe('plan');
	});
	test('approval unknown (the status could not be read): the cautious wording stays', () => {
		expect(workflowSteps('blocked').plan).toEqual({ text: 'Paused — check with Caddie', tone: 'needs' });
		expect(activeStep('blocked')).toBe('build');
	});
});
