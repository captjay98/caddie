import { test, expect } from 'bun:test';
import { destinationSearch } from '../apps/app/src/client/workspace/navigation-search.ts';
test('destination links retain context but do not leak Settings tabs, filters or preview ids', () => {
 expect(destinationSearch({ project: 'p1', pane: 'channel', tab: 'profile', q: 'secret search', preview: 'preview1', source: 'workflow' })).toEqual({ project: 'p1' });
 expect(destinationSearch({ project: 'p1', pane: 'channel', tab: 'profile' }, 'brief')).toEqual({ project: 'p1', pane: 'brief' });
 expect(destinationSearch({ project: false, pane: 'invalid' })).toEqual({});
});
