import { expect, test } from 'bun:test';
import { evidenceTopic, evidenceConflictCopy, evidenceValue } from '../apps/app/src/shared/evidence-copy.ts';

test('evidence uncertainty uses owner language without pretending work has stopped', () => {
 for (const type of ['eligibility.restricted_countries', 'requirement.submission_deadline', 'unknown.internal_field']) {
  const copy = evidenceConflictCopy(type);
  expect(JSON.stringify(copy)).not.toMatch(/null|winner|authority|retained|Nothing has been built|internal_field/);
  expect(evidenceTopic(type)).not.toContain('.');
 }
 expect(evidenceConflictCopy('eligibility.restricted_countries').headline).toBe('The entry rules need checking');
 expect(evidenceConflictCopy('requirement.submission_deadline').headline).toBe('The submission deadline needs checking');
});

test('country values are readable and preserve differing countries and source prose', () => {
 expect(evidenceValue('eligibility.restricted_countries', 'BR,RU,CU,IR,KP,SY')).toBe('Brazil, Russia, Cuba, Iran, North Korea, Syria');
 expect(evidenceValue('eligibility.restricted_countries', 'BR,RU,CU,IR,KP')).not.toContain('Syria');
 expect(evidenceValue('eligibility.restricted_countries', 'Brazil and Quebec')).toBe('Brazil and Quebec');
 expect(evidenceValue('requirement.submission_deadline', 'Oct 30 at noon')).toBe('Oct 30 at noon');
});
