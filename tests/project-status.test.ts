import { describe, expect, test } from 'bun:test';
import type { DecisionCard } from '@caddie/contracts';
import { projectStatus } from '../apps/app/src/client/workspace/project-status.ts';

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
