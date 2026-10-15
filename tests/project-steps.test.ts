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
		expect(steps.plan).toEqual({ text: 'Ready for you to review', tone: 'needs' });
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
