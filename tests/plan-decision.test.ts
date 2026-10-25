import { expect, test } from 'bun:test';
import type { ApprovalRecord } from '@caddie/contracts';
import { approvalForRevision, approvalExpired, planReviewState } from '../apps/app/src/client/planning/plan-decision.ts';
import { projectCardFromExperience, workflowSteps } from '../apps/app/src/client/workspace/project-status.ts';
const now = Date.parse('2026-10-24T10:00:00Z');
const plan = { id: 'plan-2', bodyHash: 'hash-2' };
const approval: ApprovalRecord = { id: 'approval-2', projectId: 'p', resourceId: plan.id, revisionHash: plan.bodyHash, action: 'design', status: 'approved', expiresAt: '2026-10-25T10:00:00Z', policyVersion: 'v1', intentHash: 'intent', decidedBy: 'owner' };

test('an approved record still at review remains actionable and never becomes a rejection', () => {
 const state = planReviewState(plan, approval, now);
 expect(state.label).toBe('Plan ready');
 expect(state.action).toBe('Review plan');
});
test('a decision on an earlier revision cannot describe the current plan', () => {
 for (const changed of [{ ...plan, id: 'plan-3' }, { ...plan, bodyHash: 'hash-3' }]) {
  expect(approvalForRevision(changed, approval)).toBeNull();
  expect(planReviewState(changed, { ...approval, status: 'rejected' }, now).label).toBe('Plan ready');
 }
});
test('a rejected current revision reads the same in chat and Projects', () => {
 const state = planReviewState(plan, { ...approval, status: 'rejected' }, now);
 expect(state.label).toBe('Changes requested');
 expect(state.action).toBe('Continue the plan');
 expect(workflowSteps('review', { reviewLabel: state.label }).plan).toEqual({ text: 'Changes requested', tone: 'needs' });
 expect(projectCardFromExperience({ projectId: 'p', version: 1, stage: 'review', plan: { id: plan.id, revision: '2', approved: false }, preview: null, message: '', actions: [] }, state)).toMatchObject({ label: state.label, detail: state.detail, action: { label: state.action, target: 'plan' } });
});
test('revoked, superseded, explicitly expired and time-expired approvals do not read as ready', () => {
 for (const status of ['revoked', 'superseded', 'expired'] as const) expect(planReviewState(plan, { ...approval, status }, now).label).toBe('Review needed');
 expect(planReviewState(plan, approval, Date.parse(approval.expiresAt)).label).toBe('Review needed');
 expect(approvalExpired({ ...approval, expiresAt: 'invalid' }, now)).toBe(true);
 expect(approvalExpired(null, now)).toBe(false);
});
