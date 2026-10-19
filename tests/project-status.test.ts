import { describe, expect, test } from 'bun:test';
import type { DecisionCard, ExperienceStage, ProjectExperience } from '@caddie/contracts';
import { projectCardFromCopiedApp, projectCardFromExperience, projectStatus } from '../apps/app/src/client/workspace/project-status.ts';

function card(id: string, kind: DecisionCard['kind'], status: DecisionCard['status'], updatedAt = '2026-10-11T12:00:00Z'): DecisionCard {
 return { id, projectId: 'project-a', kind, status, headline: id, summary: id + ' details', evidenceIds: [], updatedAt, primaryAction: { label: 'Review', kind: 'review', targetId: id } };
}
describe('Project summaries from real brief events', () => {
 test('a failed result cannot imply that a build or checks finished', () => {
  const failure = card('brf_failed-run_1', 'result', 'blocked');
  expect(projectStatus([failure])).toEqual({ label: 'Needs attention', detail: failure.summary, next: failure });
 });
 test('an unresolved decision stays actionable even when a later preview exists', () => {
  const pending = card('brf_approval_1', 'approval', 'needs-you', '2026-10-10T12:00:00Z');
  const preview = card('brf_preview_1', 'result', 'handled');
  const cards = [preview, pending];
  expect(projectStatus(cards).next).toBe(pending);
  expect(projectStatus(cards).label).toBe('Decision needed');
  expect(cards).toEqual([preview, pending]);
 });
 test('a preview link is reported without claiming checks or delivery passed', () => {
  expect(projectStatus([card('brf_preview_1', 'result', 'handled')]).label).toBe('Preview available');
 });
 test('empty history reports no invented activity or progress', () => {
  expect(projectStatus([])).toEqual({ label: 'No updates yet', detail: 'Tell Caddie what you would like to build or change.', next: null });
 });
});

describe('Projects card from the shared projection', () => {
 const experience = (stage: ExperienceStage): ProjectExperience => ({ projectId: 'project-a', version: 1, stage, plan: null, preview: null, message: 'm', actions: [] });
 test('the design step reads as designing, then as a design waiting for review — never as still planning', () => {
  expect(projectCardFromExperience(experience('design'))).toMatchObject({ label: 'Designing', working: true, action: { target: 'chat' } });
  expect(projectCardFromExperience(experience('design_review'))).toMatchObject({ label: 'Design ready', working: false, action: { label: 'Review design', target: 'chat' } });
 });
});

describe('Projects card for a project that only has a copied app', () => {
 test("a judge's example reads ready to try, never 'No updates yet'", () => {
  expect(projectCardFromCopiedApp({ status: 'ready', origin: 'example', message: null })).toEqual({
   label: 'Ready to try', tone: 'ok', working: false,
   detail: 'An example app Caddie built. Try it, then tell Caddie what to change.',
   action: { label: 'Try app', target: 'project' },
  });
 });
 test('a GitHub copy reads ready once built, and building while it is checked', () => {
  expect(projectCardFromCopiedApp({ status: 'ready', origin: 'github', message: null })).toMatchObject({ label: 'Ready to try', detail: 'Your app from GitHub is ready. Try it, then tell Caddie what to change.' });
  // An older answer without an origin is a GitHub copy.
  expect(projectCardFromCopiedApp({ status: 'ready', message: null }).detail).toContain('GitHub');
  expect(projectCardFromCopiedApp({ status: 'checking', origin: 'github', message: null })).toMatchObject({ label: 'Getting it ready', working: true, action: { target: 'project' } });
 });
 test('a copy that could not be built says so in its own words', () => {
  const message = "Caddie couldn't build this app the way it was copied, so there's nothing to try yet.";
  expect(projectCardFromCopiedApp({ status: 'failed', origin: 'github', message })).toMatchObject({ label: 'Code copied', tone: 'warn', detail: message, action: { target: 'chat' } });
 });
});
