import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthEnv } from '../apps/app/src/server/auth.ts';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	Jar,
	applyMigrations,
	d1Exec,
	freePort,
	makeWorker,
	signInAs,
	startProfileFixture,
	stopProfileFixture,
	StubProvider,
} from './fixtures/profile-harness.ts';

/**
 * P14 — memory, profile and (companion file tests/search-isolation.test.ts)
 * search, executed against a real local workerd (`wrangler dev` =
 * miniflare/workerd with a real local SQLite-backed D1 database). Reuses the
 * P01/P02 fixture harness pattern (free ports, readiness identity check,
 * patterned pkill cleanup, temp dirs, stub OAuth provider).
 *
 * Honesty classification:
 *   - Worker runtime, D1 persistence (schema + constraints + isolation
 *     behavior), Better Auth session mechanics via the stub provider:
 *     LOCAL VERIFIED (real workerd, real SQLite-backed D1).
 *   - The OAuth provider endpoints are a stub inside this test process, so
 *     the sign-in flows used to obtain session cookies are SIMULATED at the
 *     provider boundary (same classification as P01/P02).
 *
 * Invariants under test (see the test → invariant map in the P14 ledger):
 *   profile: upsert semantics, strict validation, stackIds restricted to the
 *   five contract StackId values, free-text interest cap, user-scoped
 *   isolation (profile has no project dimension and no cross-user access
 *   path); memory: retracted excluded from injection, correction history,
 *   proposed→confirmed, project vs personal scoping; and the memory service
 *   exposes no authorization surface.
 *
 * The fixture worker entry is tests/fixtures/profile.ts; it mounts the SAME
 * production /api composition app.ts will mount (createProfileApp) plus
 * /__test/* control routes compiled into the fixture only.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const FIXTURE_ENTRY = join(REPO_ROOT, 'tests', 'fixtures', 'profile.ts');
const PROFILE_MIGRATION = join(REPO_ROOT, 'apps', 'app', 'migrations', '0008_profile.sql');

// --- setup ---------------------------------------------------------------------

let WORKER_PORT = 0;
let WORKER_BASE = '';
let stub: StubProvider;

/** Worker fetch bound lazily after beforeAll allocates the port. */
const worker = (jar: Jar, path: string, init?: RequestInit) => makeWorker(WORKER_BASE)(jar, path, init);

beforeAll(async () => {
	if (!existsSync(FIXTURE_ENTRY)) {
		throw new Error('fixture worker entry missing: tests/fixtures/profile.ts');
	}
	if (!existsSync(PROFILE_MIGRATION)) {
		throw new Error('production migration missing: apps/app/migrations/0008_profile.sql');
	}
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	WORKER_PORT = await freePort();
	WORKER_BASE = `http://127.0.0.1:${WORKER_PORT}`;
	await startProfileFixture(WORKER_PORT, { AUTH_STUB_BASE_URL: stub.url });
	await applyMigrations(WORKER_PORT);
}, 180_000);

afterAll(async () => {
	stopProfileFixture(WORKER_PORT);
	await stub.stop();
});

// --- shared helpers --------------------------------------------------------------

async function getProfile(jar: Jar): Promise<{ status: number; body: any }> {
	const res = await worker(jar, '/api/profile');
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function putProfile(jar: Jar, body: unknown): Promise<{ status: number; body: any }> {
	const res = await worker(jar, '/api/profile', {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

// --- slice 1: profile ------------------------------------------------------------

describe('P14 slice 1: migration 0008 applies on real D1', () => {
	test('user_profiles and memory_facts tables exist after the migration', async () => {
		const res = await d1Exec(WORKER_BASE, `select name from sqlite_master where type = 'table'`);
		const tables = (res.results as { name: string }[]).map((r) => r.name);
		for (const table of ['user_profiles', 'memory_facts']) {
			expect(tables).toContain(table);
		}
		// the frozen identity + product tables are still there (same DB)
		for (const table of ['user', 'session', 'workspaces', 'projects', 'plan_doc_revisions']) {
			expect(tables).toContain(table);
		}
	});

	test('the migration file is append-only numbered 0008 and contains both P14 tables', () => {
		const ddl = readFileSync(PROFILE_MIGRATION, 'utf8');
		expect(ddl.includes('create table "user_profiles"')).toBe(true);
		expect(ddl.includes('create table "memory_facts"')).toBe(true);
		// no destructive statements: rollback must never delete user data
		expect(/drop\s+table/i.test(ddl)).toBe(false);
	});
});

describe('P14 slice 1: profile upsert and validation', () => {
	let alice: Jar;
	let bob: Jar;

	beforeAll(async () => {
		alice = await signInAs(worker, stub, ALICE_EMAIL, 'p14-alice-sub', 'Alice P14');
		bob = await signInAs(worker, stub, BOB_EMAIL, 'p14-bob-sub', 'Bob P14');
	});

	test('unauthenticated profile access is rejected (401, fail-closed)', async () => {
		const res = await getProfile(new Jar());
		expect(res.status).toBe(401);
	});

	test('profile starts empty: GET returns null before any upsert', async () => {
		const res = await getProfile(alice);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ profile: null });
	});

	test('full valid upsert persists every structured field and returns it', async () => {
		const res = await putProfile(alice, {
			country: 'CL',
			timezone: 'America/Santiago',
			weeklyHours: 12,
			experienceLevel: 'intermediate',
			stackIds: ['react-hono', 'flutter'],
			freeTextInterests: ['Rust compilers', 'race telemetry'],
		});
		expect(res.status).toBe(200);
		expect(res.body?.profile).toMatchObject({
			country: 'CL',
			timezone: 'America/Santiago',
			weeklyHours: 12,
			experienceLevel: 'intermediate',
			stackIds: ['react-hono', 'flutter'],
			freeTextInterests: ['Rust compilers', 'race telemetry'],
		});
		const back = await getProfile(alice);
		expect(back.body?.profile?.stackIds).toEqual(['react-hono', 'flutter']);
	});

	test('partial upsert merges: absent fields keep their values, explicit null clears', async () => {
		const res = await putProfile(alice, { weeklyHours: 40 });
		expect(res.status).toBe(200);
		expect(res.body?.profile?.weeklyHours).toBe(40);
		expect(res.body?.profile?.country).toBe('CL');
		expect(res.body?.profile?.timezone).toBe('America/Santiago');

		const cleared = await putProfile(alice, { experienceLevel: null });
		expect(cleared.status).toBe(200);
		expect(cleared.body?.profile?.experienceLevel).toBeNull();
		expect(cleared.body?.profile?.weeklyHours).toBe(40);
	});

	test('validation rejections: malformed country / timezone / hours / level', async () => {
		const cases: [string, unknown][] = [
			['country not alpha-2', { country: 'Chile' }],
			['country lowercase', { country: 'cl' }],
			['country three letters', { country: 'CHL' }],
			['country empty string', { country: '' }],
			['timezone not IANA', { timezone: 'Mars/Olympus' }],
			['timezone empty', { timezone: '' }],
			['weeklyHours negative', { weeklyHours: -1 }],
			['weeklyHours over 80', { weeklyHours: 81 }],
			['weeklyHours fractional', { weeklyHours: 7.5 }],
			['weeklyHours not a number', { weeklyHours: 'ten' }],
			['experienceLevel unknown', { experienceLevel: 'expert' }],
		];
		for (const [name, payload] of cases) {
			const res = await putProfile(alice, payload);
			expect(res.status, name).toBe(400);
			expect(res.body?.error, name).toBe('invalid_input');
		}
	});

	test('stackIds are restricted to the five known contract stack values', async () => {
		const ok = await putProfile(alice, {
			stackIds: ['react-hono', 'tanstack-start', 'laravel-inertia', 'fastapi-react', 'flutter'],
		});
		expect(ok.status).toBe(200);
		expect(ok.body?.profile?.stackIds).toHaveLength(5);

		for (const bad of [['vue-firebase'], ['react-hono', 'vue-firebase'], [42], 'react-hono']) {
			const res = await putProfile(alice, { stackIds: bad });
			expect(res.status, JSON.stringify(bad)).toBe(400);
			expect(res.body?.error, JSON.stringify(bad)).toBe('invalid_input');
		}
		// the last accepted value survived the rejected attempts
		const back = await getProfile(alice);
		expect(back.body?.profile?.stackIds).toHaveLength(5);
	});

	test('free-text interests are capped (count and length) and kept distinct from stackIds', async () => {
		const twelve = await putProfile(alice, {
			freeTextInterests: Array.from({ length: 12 }, (_, i) => `interest ${i}`),
		});
		expect(twelve.status).toBe(200);
		expect(twelve.body?.profile?.freeTextInterests).toHaveLength(12);

		const thirteen = await putProfile(alice, {
			freeTextInterests: Array.from({ length: 13 }, (_, i) => `interest ${i}`),
		});
		expect(thirteen.status).toBe(400);

		const tooLong = await putProfile(alice, { freeTextInterests: ['x'.repeat(61)] });
		expect(tooLong.status).toBe(400);

		const emptyItem = await putProfile(alice, { freeTextInterests: ['   '] });
		expect(emptyItem.status).toBe(400);

		// free text never becomes a stack id and vice versa: unknown "stacks"
		// cannot ride in through freeTextInterests, and stackIds stay validated
		const mixed = await putProfile(alice, {
			freeTextInterests: ['vue-firebase'],
			stackIds: ['flutter'],
		});
		expect(mixed.status).toBe(200);
		expect(mixed.body?.profile?.freeTextInterests).toEqual(['vue-firebase']);
		expect(mixed.body?.profile?.stackIds).toEqual(['flutter']);
	});

	test('strict schema: a smuggled userId or projectId key is rejected (400)', async () => {
		const smuggledUser = await putProfile(alice, { userId: 'bob' });
		expect(smuggledUser.status).toBe(400);
		const smuggledProject = await putProfile(alice, { projectId: 'proj-x' });
		expect(smuggledProject.status).toBe(400);
	});

	test('cross-user isolation: bob never sees or writes alice\u2019s profile and no endpoint addresses another user', async () => {
		// bob starts empty even though alice has a full profile
		const bobBefore = await getProfile(bob);
		expect(bobBefore.status).toBe(200);
		expect(bobBefore.body).toEqual({ profile: null });

		// bob writes his own profile; alice's is untouched
		const bobPut = await putProfile(bob, { country: 'DE', weeklyHours: 5 });
		expect(bobPut.status).toBe(200);
		expect(bobPut.body?.profile?.country).toBe('DE');

		const aliceAfter = await getProfile(alice);
		expect(aliceAfter.body?.profile?.country).toBe('CL');
		expect(aliceAfter.body?.profile?.weeklyHours).toBe(40);

		// D1 holds exactly two rows, each keyed by its own user id — the profile
		// is user-scoped with no project dimension
		const rows = await d1Exec(WORKER_BASE, 'select "userId" from "user_profiles" order by "userId"');
		expect(rows.results).toHaveLength(2);
	});
});
