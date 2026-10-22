import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * Migration 0040 (software-team mode foundations, plan section 4).
 *
 * LOCAL VERIFIED: the migration applies over the full migration set (the shared
 * allMigrationPaths helper, so 0040 is always applied after every earlier one),
 * every enum CHECK refuses a bad value, and the reservation guard refuses the
 * one over-limit insert while letting reservation + settlement stay within the
 * limit. Not evidence about production D1 itself — the same statement surface,
 * run over bun:sqlite.
 */

describe('0040 team-mode migration', () => {
	let sqlite: Database;

	beforeEach(() => {
		({ sqlite } = migratedDatabase());
	});
	afterEach(() => sqlite.close());

	const now = '2026-10-22T00:00:00.000Z';

	test('build_workflows gains the five team-mode columns with safe defaults', () => {
		const cols = (sqlite.prepare('pragma table_info(build_workflows)').all() as Array<{ name: string; dflt_value: unknown }>);
		const byName = new Map(cols.map((c) => [c.name, c]));
		for (const name of ['teamMode', 'bigApps', 'appFeatures', 'spendPayerId', 'approvedDesignRevisionId']) {
			expect(byName.has(name)).toBe(true);
		}
		// The three mode flags default to 0 (off) so an existing row read before
		// a stamp never looks like team mode.
		expect(String(byName.get('teamMode')!.dflt_value)).toBe('0');
		expect(String(byName.get('bigApps')!.dflt_value)).toBe('0');
		expect(String(byName.get('appFeatures')!.dflt_value)).toBe('0');
	});

	test('every new table exists', () => {
		const names = (sqlite
			.prepare("select name from sqlite_master where type='table'")
			.all() as Array<{ name: string }>).map((r) => r.name);
		for (const t of [
			'build_spend_limits',
			'build_spend_reservations',
			'architecture_reviews',
			'build_modules',
			'integration_locks',
			'part_manifests',
			'app_test_emails',
			'app_job_runs',
			'platform_switches',
			'platform_switch_log',
		]) {
			expect(names).toContain(t);
		}
	});

	test('the mode-column CHECK refuses a value outside {0,1}', () => {
		// build_workflows needs a projects row for its FK; seed the minimum.
		sqlite.prepare('insert into projects (id, workspaceId, name, status, createdAt, updatedAt) values (?,?,?,?,?,?)').run('p1', 'w1', 'P', 'active', now, now);
		const insert = (teamMode: number) =>
			sqlite
				.prepare('insert into build_workflows (projectId, runId, conversationId, intakeKey, brief, phase, teamMode, updatedAt) values (?,?,?,?,?,?,?,?)')
				.run('p1', 'r1', 'c1', 'k1', 'b', 'planning', teamMode, now);
		expect(() => insert(2)).toThrow();
	});

	test('platform_switches CHECKs refuse a bad key and a bad value', () => {
		expect(() => sqlite.prepare('insert into platform_switches (key, value, updatedAt) values (?,?,?)').run('team_mode', 'on', now)).not.toThrow();
		expect(() => sqlite.prepare('insert into platform_switches (key, value, updatedAt) values (?,?,?)').run('nope', 'on', now)).toThrow();
		expect(() => sqlite.prepare('insert into platform_switches (key, value, updatedAt) values (?,?,?)').run('big_apps', 'maybe', now)).toThrow();
	});

	test('status/mode CHECKs refuse bad values on the other tables', () => {
		sqlite.prepare('insert into projects (id, workspaceId, name, status, createdAt, updatedAt) values (?,?,?,?,?,?)').run('p1', 'w1', 'P', 'active', now, now);
		expect(() =>
			sqlite.prepare('insert into build_modules (id, projectId, buildSeq, moduleId, status, createdAt, updatedAt) values (?,?,?,?,?,?,?)').run('m1', 'p1', 0, 'core', 'nonsense', now, now),
		).toThrow();
		expect(() =>
			sqlite.prepare('insert into app_test_emails (id, projectId, mode, toEmail, subject, textBody, createdAt) values (?,?,?,?,?,?,?)').run('e1', 'p1', 'sent', 'a@b.c', 's', 't', now),
		).toThrow();
		expect(() =>
			sqlite.prepare('insert into app_job_runs (id, projectId, mode, jobId, status, startedAt) values (?,?,?,?,?,?)').run('j1', 'p1', 'preview', 'job', 'queued', now),
		).toThrow();
		expect(() =>
			sqlite.prepare('insert into build_spend_reservations (turnId, payerId, conversationId, reservedMicros, status, createdAt, updatedAt) values (?,?,?,?,?,?,?)').run('t1', 'payer-x', 'c1', 1, 'pending', now, now),
		).toThrow();
	});

	test('the reservation guard refuses the one over-limit insert in a single conditional insert', () => {
		sqlite.prepare('insert into build_spend_limits (payerId, limitMicros, createdAt, updatedAt) values (?,?,?,?)').run('payer-1', 1_000_000, now, now);
		const reserve = (turnId: string, micros: number) =>
			sqlite
				.prepare('insert into build_spend_reservations (turnId, payerId, conversationId, reservedMicros, status, createdAt, updatedAt) values (?,?,?,?,?,?,?)')
				.run(turnId, 'payer-1', 'c1', micros, 'reserved', now, now);

		// Two simultaneous reservations within the limit both land.
		expect(() => reserve('t1', 600_000)).not.toThrow();
		expect(() => reserve('t2', 400_000)).not.toThrow();
		// A third that would exceed it is refused — the insert itself aborts.
		expect(() => reserve('t3', 1)).toThrow(/spend_limit_exceeded/);

		// Settling t2 to its real (small) usage frees room: settled + reserved
		// counts the settlement, not the worst-case estimate, so a new reservation
		// now fits where it did not a moment ago.
		sqlite.prepare("update build_spend_reservations set status='settled', settledMicros=? , updatedAt=? where turnId='t2'").run(10_000, now);
		expect(() => reserve('t4', 300_000)).not.toThrow();
		// settled(10_000)+reserved(600_000+300_000)=910_000; a 100_001 reserve tips over.
		expect(() => reserve('t5', 100_001)).toThrow(/spend_limit_exceeded/);
		// A release leaves money uncounted; releasing t1 frees its 600_000.
		sqlite.prepare("update build_spend_reservations set status='released', updatedAt=? where turnId='t1'").run(now);
		expect(() => reserve('t6', 600_000)).not.toThrow();

		expect(() => reserve('t1', 5)).toThrow(); // turnId is unique (primary key).
	});

	test('a reservation for a payer with no limit row is refused (the guard fails closed)', () => {
		// The tests' SQLite doesn't enforce foreign keys, so this proves the
		// trigger itself refuses, whatever the database's foreign-key setting.
		expect(() =>
			sqlite
				.prepare('insert into build_spend_reservations (turnId, payerId, conversationId, reservedMicros, status, createdAt, updatedAt) values (?,?,?,?,?,?,?)')
				.run('t-orphan', 'payer-without-limit', 'c1', 1, 'reserved', now, now),
		).toThrow(/spend_limit_exceeded/);
	});
});
