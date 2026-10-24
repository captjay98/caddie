import { describe, expect, test } from 'bun:test';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import {
	channelsForKind,
	DEFAULT_CHANNEL_PREFS,
	FALLBACK_CHANNEL_PREFS,
	listNotificationPrefs,
	setNotificationPref,
} from '../apps/app/src/server/notifications.ts';

/**
 * Notification preferences (0045): the pure per-kind channel resolver and the
 * list/set over real migrated D1. In-app is always on and never stored — these
 * decide only the two OPT-IN channels (email, push). LOCAL VERIFIED.
 */

describe('channelsForKind (pure)', () => {
	test('an explicit preference wins over the default', () => {
		// build_paused defaults email+push on; an explicit all-off must win.
		expect(channelsForKind('build_paused', { email: false, push: false })).toEqual({ email: false, push: false });
	});

	test('no explicit preference falls back to the kind default', () => {
		expect(channelsForKind('build_paused', null)).toEqual(DEFAULT_CHANNEL_PREFS.build_paused);
		expect(channelsForKind('discovery_fit', undefined)).toEqual(DEFAULT_CHANNEL_PREFS.discovery_fit);
	});

	test('an unknown kind uses the fallback (email on, push off)', () => {
		expect(channelsForKind('brand_new_kind', null)).toEqual(FALLBACK_CHANNEL_PREFS);
		expect(FALLBACK_CHANNEL_PREFS).toEqual({ email: true, push: false });
	});
});

describe('list / set notification prefs over D1', () => {
	test('a fresh user sees every tunable kind at its default, marked isDefault', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, 'u1', 'u1@example.com');
		const prefs = await listNotificationPrefs(db, 'u1');
		expect(prefs.map((p) => p.kind).sort()).toEqual(Object.keys(DEFAULT_CHANNEL_PREFS).sort());
		for (const p of prefs) {
			expect(p.isDefault).toBe(true);
			expect({ email: p.email, push: p.push }).toEqual(DEFAULT_CHANNEL_PREFS[p.kind]!);
		}
		sqlite.close();
	});

	test('setting a preference overrides the default and is marked not-default', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, 'u1', 'u1@example.com');
		await setNotificationPref(db, 'u1', 'task_reminder', { email: false, push: true });
		const prefs = await listNotificationPrefs(db, 'u1');
		const tr = prefs.find((p) => p.kind === 'task_reminder')!;
		expect({ email: tr.email, push: tr.push, isDefault: tr.isDefault }).toEqual({ email: false, push: true, isDefault: false });
		// The others still read as their defaults.
		expect(prefs.find((p) => p.kind === 'discovery_fit')!.isDefault).toBe(true);
		sqlite.close();
	});

	test('setting twice upserts the SAME row (no duplicate), last write wins', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, 'u1', 'u1@example.com');
		await setNotificationPref(db, 'u1', 'task_reminder', { email: true, push: true });
		await setNotificationPref(db, 'u1', 'task_reminder', { email: false, push: false });
		const rows = sqlite.prepare('select count(*) as n from notification_prefs where userId = ? and kind = ?').get('u1', 'task_reminder') as { n: number };
		expect(rows.n).toBe(1);
		const tr = (await listNotificationPrefs(db, 'u1')).find((p) => p.kind === 'task_reminder')!;
		expect({ email: tr.email, push: tr.push }).toEqual({ email: false, push: false });
		sqlite.close();
	});

	test('an unknown kind is refused', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, 'u1', 'u1@example.com');
		await expect(setNotificationPref(db, 'u1', 'not_a_kind', { email: true, push: false })).rejects.toThrow();
		sqlite.close();
	});
});
