import { expect, test } from 'bun:test';
import { ownWordsOrNothing, rememberSaid } from '../apps/app/src/shared/owner-words.ts';

const said = ['the nebius one. i want an app for my poultry farm. me and my 2 workers log feed eggs and dead birds every day and it tells me if something looks wrong'];

test('a quote the person really wrote is kept, ignoring case and punctuation', () => {
	expect(ownWordsOrNothing('Me and my 2 workers', said)).toBe('Me and my 2 workers');
	expect(ownWordsOrNothing('it tells me if something looks wrong', said)).toBe('it tells me if something looks wrong');
});
test('a paraphrase or an invented detail is left out', () => {
	expect(ownWordsOrNothing('We log feed, eggs and dead birds on paper, so we miss trends', said)).toBeUndefined();
	expect(ownWordsOrNothing('Me and my two workers on our poultry farm in Nigeria.', said)).toBeUndefined();
	expect(ownWordsOrNothing(undefined, said)).toBeUndefined();
});
test('remembered messages are bounded to the newest', () => {
	let kept: string[] = [];
	for (let i = 0; i < 15; i++) kept = rememberSaid(kept, `message ${i}`);
	expect(kept).toHaveLength(12);
	expect(kept[0]).toBe('message 3');
});
