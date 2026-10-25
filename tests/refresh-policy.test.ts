import { test, expect } from 'bun:test';
import { experienceRefreshMs } from '../apps/app/src/client/refresh-policy.ts';
test('active work stays fresh while stable pages stop polling every three seconds', () => {
 for (const stage of ['planning', 'looks', 'design', 'building', 'checking', 'repairing']) expect(experienceRefreshMs({ stage })).toBe(3000);
 for (const stage of ['ready', 'review', 'looks_review', 'design_review', 'stopped', 'blocked']) expect(experienceRefreshMs({ stage })).toBe(30_000);
 expect(experienceRefreshMs(undefined)).toBe(3000);
});
