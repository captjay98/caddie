import { deadlineInstantKey, normalizeDeadline } from './evidence/deadlines.ts';
import type { D1Database } from './auth.ts';

export async function readContestDeadline(db: D1Database, projectId: string, eventUrl: string, listingDate: string | null): Promise<ContestDeadline | null> {
 if (!listingDate) return null;
 const {results} = await db.prepare(`select c.id,c.claimType,c.value,c.quote,c.status,c.snapshotId,
  s.latestSnapshotId,s.canonicalUrl as sourceUrl,s.authority,s.lastOutcome,s.observedAt,p.content
  from evidence_claims c join evidence_sources s on s.id=c.sourceId and s.projectId=c.projectId
  join evidence_snapshots p on p.id=c.snapshotId and p.projectId=c.projectId and p.sourceId=s.id
  where c.projectId=? and c.claimType='requirement.submission_deadline' and c.status='active' limit 21`)
  .bind(projectId).all<DeadlineEvidence>();
 return results.length > 20 ? null : chooseContestDeadline(results,eventUrl,listingDate,Date.now());
}

/** A current claim joined to its immutable source and snapshot. */
export interface DeadlineEvidence {
 id: string; claimType: string; value: string; quote: string; status: string;
 snapshotId: string; latestSnapshotId: string | null; sourceUrl: string;
 authority: string; lastOutcome: string; observedAt: string | null; content: string;
}
export interface ContestDeadline { utc: string; sourceUrl: string; claimId: string; original: string }

const MAX_SOURCE_AGE_MS = 24 * 60 * 60_000;

/** Extract only the literal end of an explicitly labelled submission period. */
export function extractSubmissionDeadline(content: string): string | null {
 const pattern = /\bSubmission\s+Period\s*:\s*[^\r\n]{0,300}?[–—-]\s*(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\s+\(\d{1,2}:\d{2}(?::\d{2})?\s*[ap]m\s+(?:Pacific Time|Eastern Time|UTC|GMT)\))/gi;
 const values = [...content.matchAll(pattern)].map(match => match[1]!);
 return values.length > 0 && values.every(value => value === values[0]) ? values[0]! : null;
}

function contestSourceKind(sourceUrl: string, eventUrl: string): 'rules' | 'other' | null {
 try {
  const source = new URL(sourceUrl); const event = new URL(eventUrl);
  if (source.protocol !== 'https:' || event.protocol !== 'https:' || source.username || source.password || event.username || event.password || source.origin !== event.origin) return null;
  const path = event.pathname.replace(/\/+$/, '');
  const sourcePath = source.pathname.replace(/\/+$/, '');
  if (sourcePath === `${path}/rules`) return 'rules';
  if ([`${path}/faq`, `${path}/updates`].includes(sourcePath)) return 'other';
  return null;
 } catch { return null; }
}

/** Require a literal source quote, explicit timezone, current rules and agreement. */
export function chooseContestDeadline(rows: readonly DeadlineEvidence[], eventUrl: string, listingDate: string, nowMs: number): ContestDeadline | null {
 const authoritative = ['binding_rules', 'organizer_message', 'official_faq', 'official_overview'];
 const relevant = rows.filter(row => row.claimType === 'requirement.submission_deadline' && row.status === 'active' && authoritative.includes(row.authority) && contestSourceKind(row.sourceUrl, eventUrl));
 if (relevant.length === 0) return null;
 // Any other authoritative reading needs reconciliation before choosing a
 // rules value. Never silently ignore a conflicting organizer or FAQ claim.
 if (relevant.some(row => row.authority !== 'binding_rules' || contestSourceKind(row.sourceUrl, eventUrl) !== 'rules')) return null;
 const results: ContestDeadline[] = [];
 for (const row of relevant) {
  const observed = Date.parse(row.observedAt ?? '');
  if (!['succeeded', 'unchanged'].includes(row.lastOutcome) || row.snapshotId !== row.latestSnapshotId || !Number.isFinite(observed) || observed > nowMs || nowMs - observed > MAX_SOURCE_AGE_MS || !row.quote.includes(row.value) || !row.content.includes(row.quote)) return null;
  const value = row.value.trim();
  let utc: string | null = null; let date: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
   const instant = deadlineInstantKey(value);
   if (instant) { utc = new Date(Number(instant)).toISOString(); date = value.slice(0, 10); }
  } else {
   // Official pages commonly parenthesize the time. Only normalize that
   // exact shape after the literal quote has been checked against the source.
   const plain = value.replace(/\s+\((\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?\s+(?:Pacific Time|Eastern Time|UTC|GMT))\)$/i, ' at $1');
   if (/^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\s+(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?\s+(?:Pacific Time|Eastern Time|UTC|GMT)$/i.test(plain)) {
    const zone = /\bPacific Time\b/i.test(plain) ? 'America/Los_Angeles' : /\bEastern Time\b/i.test(plain) ? 'America/New_York' : 'UTC';
    const normalized = normalizeDeadline(plain, zone); if (normalized.status === 'resolved') { utc = normalized.utc; date = normalized.date; }
   }
  }
  if (!utc || date !== listingDate) return null;
  results.push({ utc, sourceUrl: row.sourceUrl, claimId: row.id, original: value });
 }
 return results.every(result => result.utc === results[0]!.utc) ? results[0]! : null;
}
