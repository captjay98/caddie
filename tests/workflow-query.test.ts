import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
const { QueryClient } = createRequire(new URL('../apps/app/package.json', import.meta.url))('@tanstack/react-query');
import { workflowQueryOptions, workflowRefreshMs, type WorkflowSnapshot } from '../apps/app/src/client/workflow-query.ts';

test('workflow readers share one in-flight read while actor/project boundaries stay isolated', async () => {
 const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 1000 } } });
 let reads = 0;
 const read = async () => { reads++; await Promise.resolve(); return { workflow: null, plan: null, approval: null, design: null, designApproval: null } satisfies WorkflowSnapshot; };
 try {
  const shared = { ...workflowQueryOptions('alice', 'project-a'), queryFn: read };
  await Promise.all([client.fetchQuery(shared), client.fetchQuery(shared), client.fetchQuery(shared)]);
  expect(reads).toBe(1);
  await client.fetchQuery({ ...workflowQueryOptions('bob', 'project-a'), queryFn: read });
  await client.fetchQuery({ ...workflowQueryOptions('alice', 'project-b'), queryFn: read });
  expect(reads).toBe(3);
 } finally { client.clear(); }
});

test('active work refreshes promptly and a settled workflow reduces idle traffic', () => {
 for (const phase of ['planning', 'design', 'building', 'review', 'design-review', 'blocked', 'ready'] as const) {
  const snapshot = { workflow: { phase } } as WorkflowSnapshot;
  expect(workflowRefreshMs(snapshot)).toBe(['planning', 'design', 'building'].includes(phase) ? 2000 : 30_000);
 }
 expect(workflowRefreshMs(undefined)).toBe(30_000);
});
