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
	await startProfileFixture(WORKER_PORT, {
		AUTH_STUB_BASE_URL: stub.url,
		// every identity this suite signs in as (P01 invite fence is fail-closed)
		INVITE_ALLOWLIST:
			'alice@example.com,bob@example.com,alice2@example.com,bob2@example.com,carol@example.com,alice3@example.com,bob3@example.com,p14-strict@example.com',
	});
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

// --- slice 2: memory -------------------------------------------------------------

import * as memoryService from '../apps/app/src/server/memory.ts';
import type { MemoryFact } from '../apps/app/src/server/memory.ts';

async function postMemory(jar: Jar, path: string, body?: unknown): Promise<{ status: number; body: any }> {
	const res = await worker(jar, path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: await res.json().catch(() => null) };
}

async function getMemory(jar: Jar, query = ''): Promise<{ status: number; body: any }> {
	const res = await worker(jar, `/api/memory${query}`);
	return { status: res.status, body: await res.json().catch(() => null) };
}

describe('P14 slice 2: memory service has no authorization surface', () => {
	let strict: Jar;

	beforeAll(async () => {
		strict = await signInAs(worker, stub, 'p14-strict@example.com', 'p14-strict-sub', 'Strict');
	});

	test('the module exports only data functions — no permission, policy or effect-granting surface', () => {
		// Memory informs what the agent SAYS about the user's preferences; it
		// must never change what the agent is ALLOWED to do. The exported API
		// is therefore restricted to typed data functions over D1 — there is
		// deliberately no capability/scope/policy type, no executor and no
		// authorization hook in this module (see the module doc comment).
		const exports = Object.keys(memoryService).sort();
		expect(exports).toEqual([
			'MemoryAddInputSchema',
			'MemoryCorrectionInputSchema',
			'MemoryProposalInputSchema',
			'addMemoryFact',
			'confirmMemoryFact',
			'correctMemoryFact',
			'getMemoryFact',
			'listMemoryFacts',
			'memoryForInjection',
			'proposeMemoryFact',
			'retractMemoryFact',
		]);
		for (const name of exports) {
			expect(/authoriz|permission|polic|grant|allow|scope|effect|execut|can[A-Z]|isAllowed/i.test(name)).toBe(false);
		}
		// even the input schemas cannot carry an authorization field: they are
		// strict objects whose keys are content-only (validated by the strict
		// schema rejection tests below).
	});

	test('no memory input accepts an authorization or capability field (strict schemas reject it)', async () => {
		const { status } = await postMemory(strict, '/api/memory', {
			kind: 'preference',
			content: 'x',
			authorizedEffects: ['deploy'],
		});
		expect(status).toBe(400);
	});
});

describe('P14 slice 2: memory facts — personal vs project scoping', () => {
	let alice: Jar;
	let bob: Jar;
	let carol: Jar;
	let projectId: string;

	beforeAll(async () => {
		alice = await signInAs(worker, stub, 'alice2@example.com', 'p14-alice2-sub', 'Alice Two');
		bob = await signInAs(worker, stub, 'bob2@example.com', 'p14-bob2-sub', 'Bob Two');
		carol = await signInAs(worker, stub, 'carol@example.com', 'p14-carol-sub', 'Carol');

		// alice creates a workspace + project via the real P02 routes
		const ws = await worker(alice, '/api/workspaces', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'P14 memory ws' }),
		});
		const wsBody = (await ws.json()) as { workspace?: { id?: string } };
		const wsId = wsBody.workspace?.id;
		if (!wsId) throw new Error(`workspace creation failed: ${ws.status}`);
		const proj = await worker(alice, '/api/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspaceId: wsId, name: 'Memory probe project', description: 'alpha telemetry' }),
		});
		const projBody = (await proj.json()) as { project?: { id?: string } };
		projectId = projBody.project?.id ?? '';
		if (!projectId) throw new Error(`project creation failed: ${proj.status}`);

		// carol joins the workspace directly at the D1 boundary (fixture-only
		// control route) so project-memory sharing between members is testable
		await d1Exec(
			WORKER_BASE,
			`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
			 select 'p14-mem-carol', '${wsId}', (select "id" from "user" where email = 'carol@example.com'), 'member', '2026-10-05T00:00:00.000Z'`,
		);
	});

	test('a user-authored personal fact is created confirmed and listed', async () => {
		const res = await postMemory(alice, '/api/memory', {
			kind: 'preference',
			content: 'Prefers pnpm over npm',
		});
		expect(res.status).toBe(201);
		expect(res.body?.fact).toMatchObject({
			kind: 'preference',
			content: 'Prefers pnpm over npm',
			status: 'confirmed',
			projectId: null,
			sourceRunId: null,
			correctsId: null,
		});
	});

	test('an agent proposal starts proposed with its source run recorded and is NOT injected until confirmed', async () => {
		const res = await postMemory(alice, '/api/memory/proposals', {
			kind: 'fact',
			content: 'Deploys only on weekends',
			sourceRunId: 'run-proposal-1',
		});
		expect(res.status).toBe(201);
		expect(res.body?.fact?.status).toBe('proposed');
		expect(res.body?.fact?.sourceRunId).toBe('run-proposal-1');

		const injection = await getMemory(alice, '/injection');
		const contents = (injection.body?.facts as MemoryFact[]).map((f) => f.content);
		expect(contents).toContain('Prefers pnpm over npm');
		expect(contents).not.toContain('Deploys only on weekends');

		// management list still shows it (it is visible, just not injected)
		const list = await getMemory(alice);
		expect((list.body?.facts as MemoryFact[]).map((f) => f.content)).toContain('Deploys only on weekends');
	});

	test('confirming a proposal moves it into injection; confirming a non-proposed fact is rejected', async () => {
		const list = await getMemory(alice);
		const proposed = (list.body?.facts as MemoryFact[]).find((f) => f.status === 'proposed');
		expect(proposed).toBeTruthy();

		const res = await postMemory(alice, `/api/memory/${proposed!.id}/confirm`);
		expect(res.status).toBe(200);
		expect(res.body?.fact?.status).toBe('confirmed');

		const injection = await getMemory(alice, '/injection');
		expect((injection.body?.facts as MemoryFact[]).map((f) => f.content)).toContain('Deploys only on weekends');

		const again = await postMemory(alice, `/api/memory/${proposed!.id}/confirm`);
		expect(again.status).toBe(409);
	});

	test('project-scoped fact: members see it in the project view, non-members get 403 and never see it', async () => {
		const res = await postMemory(alice, '/api/memory', {
			projectId,
			kind: 'fact',
			content: 'Project uses Bun for all scripts',
		});
		expect(res.status).toBe(201);
		expect(res.body?.fact?.projectId).toBe(projectId);

		// carol is a member: sees it in the project memory view
		const carolView = await getMemory(carol, `?projectId=${projectId}`);
		expect((carolView.body?.facts as MemoryFact[]).map((f) => f.content)).toContain(
			'Project uses Bun for all scripts',
		);

		// bob is not a member: the project view is denied outright (403), and
		// his personal memory never contains the project fact
		const bobView = await getMemory(bob, `?projectId=${projectId}`);
		expect(bobView.status).toBe(403);
		const bobPersonal = await getMemory(bob);
		expect((bobPersonal.body?.facts as MemoryFact[]).map((f) => f.content)).not.toContain(
			'Project uses Bun for all scripts',
		);
	});

	test('writing a project fact requires membership (403) and an unknown project is 404', async () => {
		const notMember = await postMemory(bob, '/api/memory', {
			projectId,
			kind: 'preference',
			content: 'smuggled into a foreign project',
		});
		expect(notMember.status).toBe(403);
		expect(notMember.body?.error).toBe('not_a_member');

		const missing = await postMemory(alice, '/api/memory', {
			projectId: 'proj-does-not-exist',
			kind: 'preference',
			content: 'x',
		});
		expect(missing.status).toBe(404);
		expect(missing.body?.error).toBe('project_not_found');
	});

	test('personal facts are owner-only: bob\u2019s personal memory never contains alice\u2019s rows', async () => {
		const bobPersonal = await getMemory(bob);
		const contents = (bobPersonal.body?.facts as MemoryFact[]).map((f) => f.content);
		expect(contents).not.toContain('Prefers pnpm over npm');
		expect(contents).not.toContain('Deploys only on weekends');
	});
});

describe('P14 slice 2: memory deletion, correction and history', () => {
	let alice: Jar;
	let bob: Jar;
	let sharedProjectId = '';

	beforeAll(async () => {
		alice = await signInAs(worker, stub, 'alice3@example.com', 'p14-alice3-sub', 'Alice Three');
		bob = await signInAs(worker, stub, 'bob3@example.com', 'p14-bob3-sub', 'Bob Three');

		// a shared project where bob is a member but owns nothing
		const ws = await worker(alice, '/api/workspaces', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'P14 ownership ws' }),
		});
		const wsBody = (await ws.json()) as { workspace?: { id?: string } };
		const wsId = wsBody.workspace?.id;
		if (!wsId) throw new Error(`workspace creation failed: ${ws.status}`);
		const proj = await worker(alice, '/api/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspaceId: wsId, name: 'Ownership probe project' }),
		});
		const projBody = (await proj.json()) as { project?: { id?: string } };
		sharedProjectId = projBody.project?.id ?? '';
		if (!sharedProjectId) throw new Error(`project creation failed: ${proj.status}`);
		await d1Exec(
			WORKER_BASE,
			`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
			 select 'p14-mem-bob3', '${wsId}', (select "id" from "user" where email = 'bob3@example.com'), 'member', '2026-10-05T00:00:00.000Z'`,
		);
	});

	test('retraction is deletion: retracted facts leave every live view but the row is retained', async () => {
		const created = await postMemory(alice, '/api/memory', {
			kind: 'preference',
			content: 'Likes dark mode by default',
		});
		const id = created.body?.fact?.id as string;
		expect(id).toBeTruthy();

		const before = await d1CountRows('memory_facts');
		const res = await postMemory(alice, `/api/memory/${id}/retract`);
		expect(res.status).toBe(200);
		expect(res.body?.fact?.status).toBe('retracted');

		// the row count did not change — never hard-deleted
		expect(await d1CountRows('memory_facts')).toBe(before);

		// excluded from the default (live) list and from injection
		const list = await getMemory(alice);
		expect((list.body?.facts as MemoryFact[]).map((f) => f.id)).not.toContain(id);
		const injection = await getMemory(alice, '/injection');
		expect((injection.body?.facts as MemoryFact[]).map((f) => f.id)).not.toContain(id);

		// still retrievable as history (management view with retracted included)
		const history = await getMemory(alice, '?includeRetracted=1');
		const retracted = (history.body?.facts as MemoryFact[]).find((f) => f.id === id);
		expect(retracted?.status).toBe('retracted');
	});

	test('explicit correction creates a new confirmed version and retracts the old one (history retained)', async () => {
		const created = await postMemory(alice, '/api/memory', {
			kind: 'fact',
			content: 'Timezone is UTC+2',
		});
		const id = created.body?.fact?.id as string;

		const res = await postMemory(alice, `/api/memory/${id}/correct`, { content: 'Timezone is UTC+3 (moved)' });
		expect(res.status).toBe(201);
		const corrected = res.body?.fact;
		expect(corrected?.kind).toBe('correction');
		expect(corrected?.status).toBe('confirmed');
		expect(corrected?.content).toBe('Timezone is UTC+3 (moved)');
		expect(corrected?.correctsId).toBe(id);

		// old version is retracted but retained
		const history = await getMemory(alice, '?includeRetracted=1');
		const oldFact = (history.body?.facts as MemoryFact[]).find((f) => f.id === id);
		expect(oldFact?.status).toBe('retracted');

		// injection shows only the corrected content
		const injection = await getMemory(alice, '/injection');
		const contents = (injection.body?.facts as MemoryFact[]).map((f) => f.content);
		expect(contents).toContain('Timezone is UTC+3 (moved)');
		expect(contents).not.toContain('Timezone is UTC+2');

		// correcting a retracted fact is rejected (409) — the history is final
		const again = await postMemory(alice, `/api/memory/${id}/correct`, { content: 'Timezone is UTC+4' });
		expect(again.status).toBe(409);
	});

	test('only the owner can confirm/retract/correct a fact — even a project member cannot mutate someone else\u2019s row', async () => {
		// A foreign PERSONAL fact is invisible: mutation attempts read as 404
		// (existence is never revealed across users).
		const personal = await postMemory(alice, '/api/memory', {
			kind: 'preference',
			content: 'Owner-only mutation probe',
		});
		const personalId = personal.body?.fact?.id as string;

		for (const path of [
			`/api/memory/${personalId}/confirm`,
			`/api/memory/${personalId}/retract`,
			`/api/memory/${personalId}/correct`,
		]) {
			const res = await postMemory(bob, path, path.endsWith('/correct') ? { content: 'hijack' } : undefined);
			expect(res.status, path).toBe(404);
		}

		// The fact is unchanged and still live for its owner
		const list = await getMemory(alice);
		const fact = (list.body?.facts as MemoryFact[]).find((f) => f.id === personalId);
		expect(fact?.status).toBe('confirmed');
		expect(fact?.content).toBe('Owner-only mutation probe');

		// bob addressing an unknown id is a plain 404 (existence not leaked)
		const missing = await postMemory(bob, '/api/memory/mem-nope/confirm');
		expect(missing.status).toBe(404);
	});

	test('a project fact is visible to a fellow member but mutable only by its owner (member mutation = 403)', async () => {
		const created = await postMemory(alice, '/api/memory', {
			projectId: sharedProjectId,
			kind: 'fact',
			content: 'Shared fact owned by alice',
		});
		const id = created.body?.fact?.id as string;
		expect(id).toBeTruthy();

		// bob, a member, can SEE the shared fact but cannot change it
		const see = await getMemory(bob, `?projectId=${sharedProjectId}`);
		expect((see.body?.facts as MemoryFact[]).map((f) => f.id)).toContain(id);
		for (const path of [`/api/memory/${id}/confirm`, `/api/memory/${id}/retract`]) {
			const res = await postMemory(bob, path);
			expect(res.status, path).toBe(403);
			expect(res.body?.error, path).toBe('not_permitted');
		}
		const hijack = await postMemory(bob, `/api/memory/${id}/correct`, { content: 'bob was here' });
		expect(hijack.status).toBe(403);

		// the owner can still mutate it normally
		const retracted = await postMemory(alice, `/api/memory/${id}/retract`);
		expect(retracted.status).toBe(200);
		expect(retracted.body?.fact?.status).toBe('retracted');
	});

	test('injection never returns facts outside the caller\u2019s reach (personal of others, foreign projects, retracted)', async () => {
		// alice writes a personal fact; bob's injection must not include it
		await postMemory(alice, '/api/memory', { kind: 'preference', content: 'Alice-only injection probe' });
		const bobInjection = await getMemory(bob, '/injection');
		const contents = (bobInjection.body?.facts as MemoryFact[]).map((f) => f.content);
		expect(contents).not.toContain('Alice-only injection probe');

		// a retracted fact never comes back through injection
		const created = await postMemory(alice, '/api/memory', { kind: 'fact', content: 'Retract-then-inject probe' });
		const id = created.body?.fact?.id as string;
		await postMemory(alice, `/api/memory/${id}/retract`);
		const aliceInjection = await getMemory(alice, '/injection');
		expect((aliceInjection.body?.facts as MemoryFact[]).map((f) => f.id)).not.toContain(id);
	});

	test('the D1 schema enforces the memory status and kind domains (constraint backstop)', async () => {
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "memory_facts" ("id","userId","kind","content","status","createdAt","updatedAt")
				 values ('p14-bad-1', (select "id" from "user" where email = 'alice3@example.com'), 'preference', 'x', 'deleted', '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')`,
			),
		).rejects.toThrow();
		await expect(
			d1Exec(
				WORKER_BASE,
				`insert into "memory_facts" ("id","userId","kind","content","status","createdAt","updatedAt")
				 values ('p14-bad-2', (select "id" from "user" where email = 'alice3@example.com'), 'rumor', 'x', 'confirmed', '2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z')`,
			),
		).rejects.toThrow();
	});
});

async function d1CountRows(table: string): Promise<number> {
	const res = await d1Exec(WORKER_BASE, `select count(*) as n from "${table}"`);
	return Number((res.results as { n: number }[])[0]?.n ?? -1);
}
