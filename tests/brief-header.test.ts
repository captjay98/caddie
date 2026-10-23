import { describe, expect, test } from 'bun:test';
import type { DecisionCard } from '@caddie/contracts';
import { briefHeaderState } from '../apps/app/src/client/workspace/brief-header.ts';

const card = (changes: Partial<DecisionCard> = {}): DecisionCard => ({
	id: 'card-1', projectId: 'project-1', kind: 'approval', status: 'needs-you',
	headline: 'Review your plan', summary: 'A plan is ready.', evidenceIds: [],
	primaryAction: { kind: 'review', label: 'Review plan', targetId: 'plan-1' },
	updatedAt: '2026-10-23T11:00:00Z', seen: false, ...changes,
});
const status = (cards: DecisionCard[], changes = {}) => briefHeaderState({ cards, pending: false, error: false, transportMood: 'ready', ...changes });

describe('unified Brief header truth', () => {
	test('marking an approval read never makes Caddie look caught up', () => {
		expect(status([card({ seen: true })])).toMatchObject({ state: 'needs', mood: 'needs', title: '1 thing could use you' });
	});
	test('a blocker is concerned even while another conversation is active', () => {
		expect(status([card({ status: 'blocked' })], { transportMood: 'thinking' })).toMatchObject({ state: 'blocked', mood: 'stuck' });
	});
	test('loading and failed reads never claim everything is caught up', () => {
		expect(status([], { pending: true }).state).toBe('loading');
		expect(status([], { error: true }).mood).toBe('stuck');
	});
	test('only a real active feature or transport claims work is running', () => {
		expect(status([card({ status: 'handled', kind: 'change' })]).state).toBe('calm');
		expect(status([card({ status: 'changed', kind: 'result', build: { features: [{ title: 'Save farms', state: 'building' }], builtCount: 0 } })]).mood).toBe('building');
		expect(status([], { transportMood: 'thinking' }).state).toBe('working');
	});
});
