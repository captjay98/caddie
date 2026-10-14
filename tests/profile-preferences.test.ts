import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { getProfile, upsertProfile } from '../apps/app/src/server/profiles.ts';

/**
 * 0017 profile preferences (format, skills, project highlight, budget) —
 * validation, persistence round-trip, and merge semantics, exercised against
 * the real service over the real migration files (0008 + 0017).
 */

function makeDb(): { db: D1Database; sqlite: Database } {
 const sqlite = new Database(':memory:');
 sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES (\'alice\');');
 sqlite.exec(readFileSync(new URL('../apps/app/migrations/0008_profile.sql', import.meta.url), 'utf8'));
 sqlite.exec(readFileSync(new URL('../apps/app/migrations/0017_profile_preferences.sql', import.meta.url), 'utf8'));
 const db = { prepare(sql: string) { return { bind(...args: any[]) { return {
  async all() { return { results: sqlite.prepare(sql).all(...args) }; },
  async run() { return sqlite.prepare(sql).run(...args); },
 }; } }; } } as unknown as D1Database;
 return { db, sqlite };
}

test('new profile preferences round-trip with validation and merge semantics', async () => {
 const { db, sqlite } = makeDb();
 try {
  const saved = await upsertProfile(db, 'alice', {
   formatPreference: 'either',
   skills: ['Coding', 'Design', 'Domain knowledge'],
   projectHighlight: 'A study planner my class used',
   budget: { mode: 'set', amount: 50, currency: 'USD' },
  });
  expect(saved.formatPreference).toBe('either');
  expect(saved.skills).toEqual(['Coding', 'Design', 'Domain knowledge']);
  expect(saved.projectHighlight).toBe('A study planner my class used');
  expect(saved.budget).toEqual({ mode: 'set', amount: 50, currency: 'USD' });
  expect(await getProfile(db, 'alice')).toEqual(saved);

  // Merge: an update that omits the new fields keeps their stored values.
  const merged = await upsertProfile(db, 'alice', { country: 'NG' });
  expect(merged.country).toBe('NG');
  expect(merged.skills).toEqual(['Coding', 'Design', 'Domain knowledge']);
  expect(merged.formatPreference).toBe('either');
  expect(merged.budget).toEqual({ mode: 'set', amount: 50, currency: 'USD' });

  // skills are replaced only when provided; nulls clear their field.
  const swapped = await upsertProfile(db, 'alice', { skills: ['Research'], projectHighlight: null, formatPreference: 'online' });
  expect(swapped.skills).toEqual(['Research']);
  expect(swapped.projectHighlight).toBeNull();
  expect(swapped.formatPreference).toBe('online');

  // budget normalizes non-"set" modes to amount/currency null; explicit null clears.
  const freeOnly = await upsertProfile(db, 'alice', { budget: { mode: 'free_only' } });
  expect(freeOnly.budget).toEqual({ mode: 'free_only', amount: null, currency: null });
  const cleared = await upsertProfile(db, 'alice', { budget: null });
  expect(cleared.budget).toBeNull();

  // Validation: unknown format, bad budget shapes, and caps are all rejected.
  await expect(upsertProfile(db, 'alice', { formatPreference: 'hybrid' })).rejects.toThrow('formatPreference');
  await expect(upsertProfile(db, 'alice', { budget: { mode: 'set', amount: 50 } })).rejects.toThrow('required only when');
  await expect(upsertProfile(db, 'alice', { budget: { mode: 'set', amount: 50, currency: 'usd' } })).rejects.toThrow('ISO-4217');
  await expect(upsertProfile(db, 'alice', { budget: { mode: 'free_only', amount: 50, currency: 'USD' } })).rejects.toThrow('required only when');
  await expect(upsertProfile(db, 'alice', { budget: { mode: 'set', amount: -1, currency: 'USD' } })).rejects.toThrow('budget.amount');
  await expect(upsertProfile(db, 'alice', { skills: Array.from({ length: 13 }, (_, i) => `s${i}`) })).rejects.toThrow('at most 12 skills');
  await expect(upsertProfile(db, 'alice', { projectHighlight: 'x'.repeat(281) })).rejects.toThrow('280 characters');
 } finally { sqlite.close(); }
});

test('a corrupt skills column never crashes a read', async () => {
 const { db, sqlite } = makeDb();
 try {
  await upsertProfile(db, 'alice', { skills: ['Coding'] });
  sqlite.exec("update user_profiles set skills = 'not json' where userId = 'alice'");
  const profile = await getProfile(db, 'alice');
  expect(profile?.skills).toEqual([]);
 } finally { sqlite.close(); }
});
