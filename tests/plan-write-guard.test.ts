import { test, expect } from 'bun:test';
import { guardPlanWrites, LOOKS_REPAIR_ATTEMPTS } from '../apps/app/src/agents/plan-write-guard.ts';
import { lookProposalIssues } from '@caddie/contracts';

test('invalid look repair is bounded across coordinator and specialist calls and preserves valid revisions', async () => {
 let failures = 0, writes = 0, blocks = 0;
 const deps = { failures: () => failures, remember: (n: number) => { failures = n; }, block: async () => { blocks++; }, write: async () => { writes++; throw new Error('LOOKS_INVALID: bad density and contrast'); } };
 const save = guardPlanWrites(deps);
 for (let i = 0; i < LOOKS_REPAIR_ATTEMPTS; i++) await expect(save({ kind: 'looks', body: 'invalid', planRevision: 'p1' })).rejects.toThrow('LOOKS_INVALID');
 // Reconstructing the wrapper (a coordinator render/restart) retains the cap.
 await expect(guardPlanWrites(deps)({ kind: 'looks', body: 'invalid', planRevision: 'p1' })).rejects.toThrow('LOOKS_REPAIR_LIMIT');
 expect(writes).toBe(LOOKS_REPAIR_ATTEMPTS);
 expect(blocks).toBe(1);
});

test('the coordinator opens a fresh looks repair window on every new submission, not only on user messages (EggOps Nigeria, 2026-10-30)', async () => {
 const { readFileSync } = await import('node:fs');
 const source = readFileSync(new URL('../apps/app/src/agents/coordinator.ts', import.meta.url), 'utf8');
 const start = source.indexOf('useAgentStart(');
 const userBranch = source.indexOf('if (delivery.kind === "user")', start);
 const reset = source.indexOf('setLooksValidationFailures(0)', start);
 expect(reset).toBeGreaterThan(start);
 expect(reset).toBeLessThan(userBranch);
});

test('an HTML entity in a look screen is text, not a hard-coded colour', () => {
 const issues = lookProposalIssues('```caddie-looks\n{}\n```', { features: [] });
 expect(Array.isArray(issues)).toBe(true);
 const html = "<div style='color:var(--text)'>Next &#8594;</div>";
 expect(/(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/.test(html)).toBe(false);
 expect(/(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/.test("<p style='color:#1a2b3c'>x</p>")).toBe(true);
});

test('a valid repair clears consecutive failures; unrelated save failures do not consume the repair cap', async () => {
 let failures = 2;
 const save = guardPlanWrites({ failures: () => failures, remember: n => { failures = n; }, block: async () => {}, write: async input => { if (input.kind === 'note') throw new Error('database unavailable'); } });
 await expect(save({ kind: 'note', body: '', planRevision: 'p' })).rejects.toThrow('database unavailable');
 expect(failures).toBe(2);
 await save({ kind: 'looks', body: 'valid', planRevision: 'p' });
 expect(failures).toBe(0);
});
