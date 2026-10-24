import { describe, expect, test } from 'bun:test';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { savePushSubscription, listPushSubscriptions, deletePushSubscription } from '../apps/app/src/server/notifications.ts';

/** Push subscription storage (0045): save / list / upsert / delete. LOCAL VERIFIED. */

const sub = (endpoint: string) => ({ endpoint, p256dh: 'pub-' + endpoint, auth: 'auth-' + endpoint });

describe('push subscriptions', () => {
	test('save then list returns the device keys', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, 'u1', 'u1@example.com');
		await savePushSubscription(db, 'u1', sub('https://push.example/a'));
		const list = await listPushSubscriptions(db, 'u1');
		expect(list).toHaveLength(1);
		expect(list[0]).toEqual({ endpoint: 'https://push.example/a', p256dh: 'pub-https://push.example/a', auth: 'auth-https://push.example/a' });
		sqlite.close();
	});

	test('re-subscribing the SAME endpoint updates in place (no duplicate)', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, 'u1', 'u1@example.com');
		await savePushSubscription(db, 'u1', { endpoint: 'https://push.example/a', p256dh: 'old', auth: 'old' });
		await savePushSubscription(db, 'u1', { endpoint: 'https://push.example/a', p256dh: 'new', auth: 'new' });
		const list = await listPushSubscriptions(db, 'u1');
		expect(list).toHaveLength(1);
		expect(list[0]!.p256dh).toBe('new');
		sqlite.close();
	});

	test('a user never sees another user’s devices, and delete removes just one', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, 'u1', 'u1@example.com');
		addUser(sqlite, 'u2', 'u2@example.com');
		await savePushSubscription(db, 'u1', sub('https://push.example/a'));
		await savePushSubscription(db, 'u1', sub('https://push.example/b'));
		await savePushSubscription(db, 'u2', sub('https://push.example/c'));
		expect(await listPushSubscriptions(db, 'u2')).toHaveLength(1);
		await deletePushSubscription(db, 'u1', 'https://push.example/a');
		const left = await listPushSubscriptions(db, 'u1');
		expect(left.map((s) => s.endpoint)).toEqual(['https://push.example/b']);
		sqlite.close();
	});
});
