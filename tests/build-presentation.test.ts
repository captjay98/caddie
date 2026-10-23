import { expect, test } from 'bun:test';
import { buildPresentation } from '../apps/app/src/client/project/build-presentation.ts';
import type { BuildActivityView } from '../apps/app/src/client/queries.ts';
const snapshot = (phase: BuildActivityView['phase'], quiet = false, openIssues = 0) => ({
 phase, openIssues, timeline: { quiet, stages: [] } as unknown as BuildActivityView['timeline'],
});
test('quiet or unreadable activity overrides an active repair claim', () => {
 const quiet = buildPresentation(snapshot('building', true, 1));
 expect(quiet.title).toBe('Let’s check this build.');
 expect(quiet.label).toBe('No recent activity');
 expect(quiet.summary).toContain('can’t confirm');
 expect(quiet.mood).toBe('needs');
 expect(buildPresentation(snapshot('building'), true).label).toBe('Couldn’t refresh');
});
test('fresh repair, stopped and ready builds have distinct explanations', () => {
 expect(buildPresentation(snapshot('building', false, 1)).title).toBe('Fixing a check that failed.');
 expect(buildPresentation(snapshot('building')).label).toBe('Caddie is working');
 expect(buildPresentation(snapshot('ready')).title).toBe('Your app is ready to try.');
 expect(buildPresentation(snapshot('blocked')).title).toBe('The build has stopped.');
});
