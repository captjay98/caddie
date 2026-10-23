import type { DecisionCard } from '@caddie/contracts';
import type { MascotMood } from '@caddie/ui/Mascot';
import { cardDesign } from '../brief/card-design.ts';

/** Reading an update does not resolve it. Mood follows work, never unread count. */
export function briefHeaderState(input: {
	cards: readonly DecisionCard[];
	pending: boolean;
	error: boolean;
	transportMood: MascotMood;
}): { title: string; mood: MascotMood; state: 'loading' | 'error' | 'blocked' | 'needs' | 'working' | 'calm' } {
	if (input.pending) return { title: 'Reading your brief…', mood: 'thinking', state: 'loading' };
	if (input.error) return { title: 'Your brief couldn’t be refreshed', mood: 'stuck', state: 'error' };
	const open = input.cards.filter(card => card.status !== 'handled');
	const blocked = open.filter(card => card.status === 'blocked').length;
	if (blocked) return { title: `${blocked} thing${blocked === 1 ? '' : 's'} need${blocked === 1 ? 's' : ''} attention`, mood: 'stuck', state: 'blocked' };
	const needs = open.filter(card => card.status === 'needs-you' || card.kind === 'change').length;
	if (needs) return { title: `${needs} thing${needs === 1 ? '' : 's'} could use you`, mood: 'needs', state: 'needs' };
	if (open.some(card => ['build', 'repair'].includes(cardDesign(card)) || card.build?.features.some(feature => feature.state === 'building')) || input.transportMood === 'building') {
		return { title: 'Caddie is building your app', mood: 'building', state: 'working' };
	}
	if (input.transportMood === 'thinking') return { title: 'Caddie is working on it', mood: 'thinking', state: 'working' };
	return { title: 'Nothing needs you — I’ve got the watch.', mood: 'done', state: 'calm' };
}
