import { test, expect } from 'bun:test';
import { guardPlanWrites } from '../apps/app/src/agents/plan-write-guard.ts';

test('invalid look repair is bounded across coordinator and specialist calls and preserves valid revisions', async () => {
 let failures = 0, writes = 0, blocks = 0;
 const deps = { failures: () => failures, remember: (n: number) => { failures = n; }, block: async () => { blocks++; }, write: async () => { writes++; throw new Error('LOOKS_INVALID: bad density and contrast'); } };
 const save = guardPlanWrites(deps);
 for (let i = 0; i < 3; i++) await expect(save({ kind: 'looks', body: 'invalid', planRevision: 'p1' })).rejects.toThrow('LOOKS_INVALID');
 // Reconstructing the wrapper (a coordinator render/restart) retains the cap.
 await expect(guardPlanWrites(deps)({ kind: 'looks', body: 'invalid', planRevision: 'p1' })).rejects.toThrow('LOOKS_REPAIR_LIMIT');
 expect(writes).toBe(3);
 expect(blocks).toBe(1);
});

test('a valid repair clears consecutive failures; unrelated save failures do not consume the repair cap', async () => {
 let failures = 2;
 const save = guardPlanWrites({ failures: () => failures, remember: n => { failures = n; }, block: async () => {}, write: async input => { if (input.kind === 'note') throw new Error('database unavailable'); } });
 await expect(save({ kind: 'note', body: '', planRevision: 'p' })).rejects.toThrow('database unavailable');
 expect(failures).toBe(2);
 await save({ kind: 'looks', body: 'valid', planRevision: 'p' });
 expect(failures).toBe(0);
});
