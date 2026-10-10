import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	Jar,
	StubProvider,
	applyMigrations,
	d1Exec,
	freePort,
	makeWorker,
	signInAs,
	startProfileFixture,
	stopProfileFixture,
} from './fixtures/profile-harness.ts';

/**
 * B03 — "Tell me when it's ready" for build tools
 * (docs/design/2026-10-10-v2/PACKETS.md).
 *
 * Proven against the real workerd + D1 fixture:
 *   - Toggling a per-actor subscription for a planned stack persists it and
 *     is isolated per actor.
 *   - Subscribing to an ENABLED stack is rejected (typed 409) — the
 *     notification would never fire and the toggle would lie.
 *   - When a stack flips to enabled, exactly ONE notification per subscriber
 *     (the unique dedupe key absorbs repeated flip notifications), and the
 *     flip runs the real notifyStackEnabled helper via a test-only control
 *     route (in production it fires from the deploy path).
 */

const REPO_ROOT = join(import.meta.dir, '..');
const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';

let WORKER_PORT = 0;
let WORKER_BASE = '';
let stub: StubProvider;
let jarAlice: Jar;
let jarBob: Jar;
let aliceActorId = '';
let bobActorId = '';

type WorkerFn = ReturnType<typeof makeWorker>;
const worker: WorkerFn = (jar, path, init) =>
	makeWorker(`http://127.0.0.1:${WORKER_PORT}`)(jar, path, init);

beforeAll(async () => {
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	await startProfileFixture(WORKER_PORT, {
		AUTH_STUB_BASE_URL: stub.url,
		INVITE_ALLOWLIST: `${ALICE_EMAIL},${BOB_EMAIL}`,
	});
	await applyMigrations(WORKER_PORT);

	jarAlice = await signInAs(worker, stub, ALICE_EMAIL, 'b03-alice', 'Alice B03');
	jarBob = await signInAs(worker, stub, BOB_EMAIL, 'b03-bob', 'Bob B03');
	aliceActorId = String(
		((await (await worker(jarAlice, '/api/auth/get-session')).json()) as { user: { id: string } }).user.id,
	);
	bobActorId = String(
		((await (await worker(jarBob, '/api/auth/get-session')).json()) as { user: { id: string } }).user.id,
	);
}, 180_000);

afterAll(async () => {
	stopProfileFixture(WORKER_PORT);
	await stub.stop();
});

describe('B03 integration: stack availability alerts', () => {
	test('subscribing to a planned stack persists per actor; unsubscribing removes it', async () => {
		const sub = await worker(jarAlice, '/api/stacks/flutter/notify', { method: 'POST' });
		expect(sub.status).toBe(200);
		const body = (await sub.json()) as { subscription: { actorId: string; stackId: string } };
		expect(body.subscription).toMatchObject({ actorId: aliceActorId, stackId: 'flutter' });

		// Isolation: bob's subscription list is empty.
		const bobList = await worker(jarBob, '/api/stacks/notify');
		expect(((await bobList.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(0);
		const aliceList = (await (await worker(jarAlice, '/api/stacks/notify')).json()) as {
			subscriptions: { stackId: string }[];
		};
		expect(aliceList.subscriptions.map((s) => s.stackId)).toEqual(['flutter']);

		const gone = await worker(jarAlice, '/api/stacks/flutter/notify', { method: 'DELETE' });
		expect(gone.status).toBe(200);
		expect(((await gone.json()) as { removed: boolean }).removed).toBe(true);
		const empty = (await (await worker(jarAlice, '/api/stacks/notify')).json()) as {
			subscriptions: unknown[];
		};
		expect(empty.subscriptions).toHaveLength(0);
	});

	test('subscribing to an ENABLED stack is rejected with a typed 409', async () => {
		const res = await worker(jarAlice, '/api/stacks/react-hono/notify', { method: 'POST' });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('stack_already_enabled');
	});

	test('an unknown stack id is a typed 404', async () => {
		const res = await worker(jarAlice, '/api/stacks/no-such-stack/notify', { method: 'POST' });
		expect(res.status).toBe(404);
	});

	test('when a stack flips to enabled: one notification per subscriber, none for others', async () => {
		// Both alice and bob subscribe to flutter, then the "flip" runs the REAL
		// notifyStackEnabled helper against the fixture's D1 via the test-only
		// control route.
		await worker(jarAlice, '/api/stacks/flutter/notify', { method: 'POST' });
		await worker(jarBob, '/api/stacks/flutter/notify', { method: 'POST' });

		const flip = await fetch(`${WORKER_BASE}/__test/notify-stack-enabled`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ stackId: 'flutter' }),
		});
		expect(flip.status).toBe(200);
		expect(((await flip.json()) as { notified: number }).notified).toBe(2);

		// A repeated flip does not double-notify (unique dedupe key per user).
		const flip2 = await fetch(`${WORKER_BASE}/__test/notify-stack-enabled`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ stackId: 'flutter' }),
		});
		expect(((await flip2.json()) as { notified: number }).notified).toBe(0);

		const aliceRows = await d1Exec(
			WORKER_BASE,
			`select count(*) as n from "notifications" where "dedupeKey" = 'stack_enabled:flutter:' || (select "id" from "user" where email = '${ALICE_EMAIL}')`,
		);
		expect((aliceRows.results as { n: number }[])[0]!.n).toBe(1);
		const bobRows = await d1Exec(
			WORKER_BASE,
			`select count(*) as n from "notifications" where "dedupeKey" = 'stack_enabled:flutter:' || (select "id" from "user" where email = '${BOB_EMAIL}')`,
		);
		expect((bobRows.results as { n: number }[])[0]!.n).toBe(1);
	});
});
