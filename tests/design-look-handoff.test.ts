import { test, expect } from 'bun:test';
import { parseLooks, parseAppTheme } from '@caddie/contracts';
import { designInLookMessage } from '../apps/app/src/server/build-workflow.ts';
import { looksBody, LOOKS_SET } from './fixtures/looks-fixture.ts';

test('design handoff carries the selected composition, not only its palette', () => {
 const parsed = parseLooks(looksBody({ ...LOOKS_SET, looks: LOOKS_SET.looks.map((look, i) => ({ ...look, screen: { title: i ? 'Overview first' : 'Tasks first', html: `<main><h1>${i ? 'Overview' : 'Tasks'}</h1></main>` } })) }));
 if (!parsed.ok) throw new Error(parsed.error);
 const chosen = parsed.set.looks[0]!;
 const handoff = designInLookMessage('plan-1', parsed.set, chosen, '');
 expect(handoff).toContain('<h1>Tasks</h1>');
 expect(handoff).not.toContain('<h1>Overview</h1>');
 expect(handoff).toContain('untrusted');
 expect(parseAppTheme(handoff).ok).toBe(true);
});
