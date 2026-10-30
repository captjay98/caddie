import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { applyFinalSchema } from './fixtures/migrations.ts';
import { onboardingStatus, completeOnboarding } from '../apps/app/src/server/onboarding.ts';

test('onboarding is durable, actor-scoped, and completion is idempotent', async () => {
 const sqlite = new Database(':memory:');
 sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES (\'alice\'), (\'bob\');');
 applyFinalSchema(sqlite);
 const db = { prepare(sql: string) { return { bind(...args: any[]) { return {
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  async run() { return sqlite.prepare(sql).run(...args); },
 }; } }; } } as unknown as D1Database;
 try {
  expect(await onboardingStatus(db, 'alice')).toEqual({ completedAt: null });
  await expect(completeOnboarding(db, 'alice')).rejects.toThrow('Save your profile');
  sqlite.exec("INSERT INTO user_profiles(userId,createdAt,updatedAt) VALUES ('alice',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)");
  const first = await completeOnboarding(db, 'alice');
  expect(first.completedAt).toBeTruthy();
  expect(await onboardingStatus(db, 'alice')).toEqual(first);
  expect(await completeOnboarding(db, 'alice')).toEqual(first);
  sqlite.exec("INSERT INTO user_onboarding(userId,completedAt) VALUES ('bob','2026-10-10')");
  expect(await onboardingStatus(db, 'bob')).toEqual({ completedAt: null });
  await expect(completeOnboarding(db, 'bob')).rejects.toThrow('Save your profile');
  await expect(completeOnboarding(db, 'missing')).rejects.toThrow();
 } finally { sqlite.close(); }
});

import { onboardingDestination } from '../apps/app/src/client/onboarding/destination.ts';

test('onboarding hand-off: the idea start never forces the mobile chat-only view', () => {
	// The bug: 'idea' handed off to ?start=idea&pane=channel, forcing the
	// chat-only full view on desktop too, so the split (start panel + chat) was
	// lost. The fix: 'idea' carries only ?start=idea; the shell picks the layout
	// from the viewport.
	const idea = onboardingDestination('idea');
	expect(idea).toBe('/app/?start=idea');
	expect(idea).not.toContain('pane=channel');

	// Owner 2026-10-28: chat is the primary mode — the hackathon start lands in
	// the shell (Brief + conversation) instead of pushing Discover as a page.
	expect(onboardingDestination('hackathon')).toBe('/app/');
	expect(onboardingDestination('explore')).toBe('/app/');
});
