import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { onboardingStatus, completeOnboarding } from '../apps/app/src/server/onboarding.ts';

test('onboarding is durable, actor-scoped, and completion is idempotent', async () => {
 const sqlite = new Database(':memory:');
 sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES (\'alice\'), (\'bob\');');
 sqlite.exec(readFileSync(new URL('../apps/app/migrations/0016_onboarding.sql', import.meta.url), 'utf8'));
 sqlite.exec(readFileSync(new URL('../apps/app/migrations/0008_profile.sql', import.meta.url), 'utf8'));
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
