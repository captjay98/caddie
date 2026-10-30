import { expect, test } from 'bun:test';
import { chooseContestDeadline, extractSubmissionDeadline, type DeadlineEvidence } from '../apps/app/src/server/contest-source-deadline.ts';

const now = Date.parse('2026-10-27T12:00:00Z');
const value = 'October 30, 2026 at 10:00 AM Pacific Time';
const quote = `Submissions close ${value}.`;
const row: DeadlineEvidence = {
 id: 'claim-1', claimType: 'requirement.submission_deadline', value, quote,
 status: 'active', snapshotId: 'snapshot-1', latestSnapshotId: 'snapshot-1',
 sourceUrl: 'https://event.example/rules', authority: 'binding_rules', lastOutcome: 'succeeded',
 observedAt: '2026-10-27T11:00:00Z', content: quote,
};
const choose = (rows: DeadlineEvidence[]) => chooseContestDeadline(rows, 'https://event.example/', '2026-10-30', now);

test('a fresh, quoted deadline from this contest rules resolves in Pacific time', () => {
 expect(choose([row])).toEqual({ utc: '2026-10-30T17:00:00.000Z', sourceUrl: row.sourceUrl, claimId: row.id, original: value });
 const officialText = 'October 30, 2026 (10:00 am Pacific Time)';
 expect(choose([{ ...row, value: officialText, quote: officialText, content: officialText }])?.utc).toBe('2026-10-30T17:00:00.000Z');
});
test('unverified, stale, conflicting or unrelated sources never establish an exact time', () => {
 for (const change of [
  { sourceUrl: 'https://other.example/rules' }, { sourceUrl: 'https://event.example/other/rules' },
  { authority: 'community' }, { lastOutcome: 'failed' }, { status: 'superseded' },
  { latestSnapshotId: 'newer' }, { observedAt: '2026-10-25T00:00:00Z' },
  { content: 'Different content' }, { quote: 'Different quote' },
  { value: 'October 30, 2026 at 10:00 AM' },
 ]) expect(choose([{ ...row, ...change }])).toBeNull();
 const other = { ...row, id: 'claim-2', value: 'October 30, 2026 at 11:00 AM Pacific Time', quote: 'October 30, 2026 at 11:00 AM Pacific Time', content: 'October 30, 2026 at 11:00 AM Pacific Time' };
 expect(choose([row, other])).toBeNull();
	const alternate = { ...other, sourceUrl: 'https://event.example/faq', authority: 'official_faq' };
	expect(choose([row, alternate])).toBeNull();
	const range = { ...row, value: 'October 29, 2026 at 10:00 AM Pacific Time – October 30, 2026 at 10:00 AM Pacific Time', quote: '', content: '' };
	range.quote = range.value; range.content = range.value;
	expect(choose([range])).toBeNull();
 expect(chooseContestDeadline([row], 'https://event.example/', '2026-10-31', now)).toBeNull();
});

test('extracts only a single explicit submission-period end from verbatim rules', () => {
 const text = 'Submission Period: Wednesday, August 26, 2026 (9:00 am Pacific Time) – Friday, October 30, 2026 (10:00 am Pacific Time) (“Submission Period”). Judging Period: December 1, 2026.';
 expect(extractSubmissionDeadline(text)).toBe('October 30, 2026 (10:00 am Pacific Time)');
 expect(extractSubmissionDeadline('Submission Period: August 26, 2026 – October 30, 2026.')).toBeNull();
 expect(extractSubmissionDeadline(`${text}\nSubmission Period: August 1, 2026 – October 29, 2026 (10:00 am Pacific Time).`)).toBeNull();
 expect(extractSubmissionDeadline('Judging Period: August 1, 2026 – October 30, 2026 (10:00 am Pacific Time).')).toBeNull();
});

// --- Handover coverage matrix: DST transitions, impossible dates, two contests ----
test('a winter claim resolves at Pacific Standard Time, not Pacific Daylight Time', () => {
 // December 15, 2026 is after the DST fall-back: 10:00 AM Pacific = 18:00 UTC.
 const winter = { ...row, id: 'claim-dst', value: 'December 15, 2026 at 10:00 AM Pacific Time', quote: 'Submissions close December 15, 2026 at 10:00 AM Pacific Time.', content: 'Submissions close December 15, 2026 at 10:00 AM Pacific Time.' };
 expect(chooseContestDeadline([winter], 'https://event.example/', '2026-12-15', now)?.utc).toBe('2026-12-15T18:00:00.000Z');
});
test('a local time skipped by a DST transition, and an impossible calendar date, never pin an instant', () => {
 // 2026 spring-forward: 02:30 local time does not exist on March 8 in Los Angeles.
 const skipped = { ...row, id: 'claim-gap', value: 'March 8, 2026 at 2:30 AM Pacific Time', quote: 'Submissions close March 8, 2026 at 2:30 AM Pacific Time.', content: 'Submissions close March 8, 2026 at 2:30 AM Pacific Time.' };
 expect(choose([skipped])).toBeNull();
 for (const impossible of ['February 30, 2027 at 10:00 AM Pacific Time', 'October 31, 2026 at 10:99 AM Pacific Time']) {
  const bad = { ...row, id: 'claim-bad', value: impossible, quote: `Submissions close ${impossible}.`, content: `Submissions close ${impossible}.` };
  expect(choose([bad])).toBeNull();
 }
});
test('evidence from a different contest never mixes into this event\u2019s deadline', () => {
 // Contest B's rules live on a different origin+path: contestSourceKind drops
 // it, so contest A resolves alone — and A never borrows B's time.
 const contestB = { ...row, id: 'claim-b', sourceUrl: 'https://other-event.example/rules', value: 'November 20, 2026 at 5:00 PM Eastern Time', quote: 'Submissions close November 20, 2026 at 5:00 PM Eastern Time.', content: 'Submissions close November 20, 2026 at 5:00 PM Eastern Time.' };
 expect(choose([contestB])).toBeNull();
 expect(choose([row, contestB])?.utc).toBe('2026-10-30T17:00:00.000Z');
 expect(choose([contestB, row])?.utc).toBe('2026-10-30T17:00:00.000Z');
});
