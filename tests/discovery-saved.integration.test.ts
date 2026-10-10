import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
	ALICE_EMAIL,
	BOB_EMAIL,
	Jar,
	StubProvider,
	applyMigrations,
	d1Exec,
	discoveryMigrationPaths,
	freePort,
	makeWorker,
	signIn,
	startDiscoveryFixtureWorker,
	stopDiscoveryFixtureWorker,
} from './fixtures/discovery-harness.ts';

/**
 * B01 — saved hackathons (docs/design/2026-10-10-v2/PACKETS.md).
 *
 * Proven against the real workerd + D1 fixture:
 *   - Save/unsave a candidate WITHOUT accepting it: `savedAt` is its own
 *     axis; status stays 'new'.
 *   - Saving never creates a project and never starts a run.
 *   - Saved state is isolated per account and per project.
 *   - The saved list is project-scoped; accept and save compose (accepting
 *     keeps the bookmark, unsaving keeps the acceptance).
 */

const REPO_ROOT = join(import.meta.dir, '..');
const WORKER_PORT_FREE = await freePort();

const WORKER_PORT = WORKER_PORT_FREE;
const WORKER_BASE = `http://127.0.0.1:${WORKER_PORT_FREE}`;
let stub: StubProvider;
let jarAlice: Jar;
let jarBob: Jar;
let projAlice = '';
let projBob = '';
let candidateId = '';

const worker = makeWorker(`http://127.0.0.1:${WORKER_PORT_FREE}`);
const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const d1 = (sql: string) => d1Exec(`http://127.0.0.1:${WORKER_PORT_FREE}`, sql);

async function createWorkspace(jar: Jar, name: string): Promise<string> {
	const res = await worker(jar, '/api/workspaces', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { workspace: { id: string } }).workspace.id;
}

async function createProject(jar: Jar, workspaceId: string, name: string): Promise<string> {
	const res = await worker(jar, '/api/projects', {
		method: 'POST',
		headers: JSON_HEADERS,
		body: JSON.stringify({ workspaceId, name }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { project: { id: string } }).project.id;
}

beforeAll(async () => {
	stub = new StubProvider();
	const stubPort = await freePort();
	await stub.start(stubPort);
	await startDiscoveryFixtureWorker(REPO_ROOT, WORKER_PORT, [ALICE_EMAIL, BOB_EMAIL], {
		AUTH_STUB_BASE_URL: stub.url,
	});
	// 0013 rides the standard migration list (the 0011 drift lesson).
	await applyMigrations(WORKER_BASE, discoveryMigrationPaths());

	jarAlice = await signIn(worker, stub, ALICE_EMAIL, 'stub-b01-alice', 'Alice B01');
	jarBob = await signIn(worker, stub, BOB_EMAIL, 'stub-b01-bob', 'Bob B01');
	const wsAlice = await createWorkspace(jarAlice, 'Alice WS B01');
	const wsBob = await createWorkspace(jarBob, 'Bob WS B01');
	projAlice = await createProject(jarAlice, wsAlice, 'Alice saved test');
	projBob = await createProject(jarBob, wsBob, 'Bob saved test');

	// Seed one candidate and run the feed for BOTH projects so each has its
	// own ingested copy (candidate rows are project-scoped).
	await d1(
		`insert into "discovery_seed_candidates" ("id", "source", "url", "title", "summary", "requirementsJson", "createdAt")
		 values ('seed-b01-1', 'local-seed', 'https://contest.example/b01', 'B01 Contest', 'A saved test contest.', '[]', '2026-10-01')`,
	);
	const feedA = await worker(jarAlice, `/api/projects/${projAlice}/discovery/feed`, { method: 'POST' });
	expect(feedA.status).toBe(201);
	const feedB = await worker(jarBob, `/api/projects/${projBob}/discovery/feed`, { method: 'POST' });
	expect(feedB.status).toBe(201);

	const listRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates`);
	const list = (await listRes.json()) as { candidates: { id: string }[] };
	expect(list.candidates.length).toBeGreaterThan(0);
	candidateId = list.candidates[0]!.id;
}, 180_000);

afterAll(async () => {
	stopDiscoveryFixtureWorker(WORKER_PORT);
	await stub.stop();
});

describe('B01 integration: saved hackathons', () => {
	test('saving bookmarks without accepting: status stays new, no project or run created', async () => {
		const before = await d1(`select count(*) as n from "projects"`);
		const runsBefore = await d1(`select count(*) as n from "run_bindings"`);

		const saved = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates/${candidateId}/save`, {
			method: 'POST',
		});
		expect(saved.status).toBe(200);
		const savedBody = (await saved.json()) as { candidate: { savedAt: string | null; status: string } };
		expect(savedBody.candidate.savedAt).not.toBeNull();
		// The bookmark never flips the status.
		expect(savedBody.candidate.status).toBe('new');

		const after = await d1(`select count(*) as n from "projects"`);
		expect((after.results as { n: number }[])[0]!.n).toBe((before.results as { n: number }[])[0]!.n);
		const runsAfter = await d1(`select count(*) as n from "run_bindings"`);
		expect((runsAfter.results as { n: number }[])[0]!.n).toBe((runsBefore.results as { n: number }[])[0]!.n);
	});

	test('the saved list is project-scoped and isolated per account and project', async () => {
		const aliceRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/saved`);
		expect(aliceRes.status).toBe(200);
		const aliceSaved = (await aliceRes.json()) as { candidates: { id: string; savedAt: string | null }[] };
		expect(aliceSaved.candidates.map((c) => c.id)).toContain(candidateId);

		// Bob's project has its own copy of the same real-world candidate, but
		// Bob never saved it — cross-account leakage would show here.
		const bobRes = await worker(jarBob, `/api/projects/${projBob}/discovery/saved`);
		expect(bobRes.status).toBe(200);
		const bobSaved = (await bobRes.json()) as { candidates: unknown[] };
		expect(bobSaved.candidates).toHaveLength(0);

		// The same actor's OTHER project does not inherit the bookmark either.
		const bobListRes = await worker(jarBob, `/api/projects/${projBob}/discovery/candidates`);
		const bobList = (await bobListRes.json()) as { candidates: { savedAt: string | null }[] };
		for (const candidate of bobList.candidates) {
			expect(candidate.savedAt).toBeNull();
		}
	});

	test('unsaving clears the bookmark; the candidate itself stays in the feed', async () => {
		const unsavedRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates/${candidateId}/save`, {
			method: 'DELETE',
		});
		expect(unsavedRes.status).toBe(200);
		const unsaved = (await unsavedRes.json()) as { candidate: { savedAt: string | null; status: string } };
		expect(unsaved.candidate.savedAt).toBeNull();
		expect(unsaved.candidate.status).toBe('new'); // still never accepted

		const aliceRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/saved`);
		const aliceSaved = (await aliceRes.json()) as { candidates: { id: string }[] };
		expect(aliceSaved.candidates.map((c) => c.id)).not.toContain(candidateId);

		const listRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates`);
		const list = (await listRes.json()) as { candidates: { id: string }[] };
		expect(list.candidates.map((c) => c.id)).toContain(candidateId);
	});

	test('saving, accepting, and unsaving compose: accept flips status, unsave keeps it accepted', async () => {
		const savedRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates/${candidateId}/save`, {
			method: 'POST',
		});
		const saved = (await savedRes.json()) as { candidate: { savedAt: string | null } };
		expect(saved.candidate.savedAt).not.toBeNull();

		const acceptedRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates/${candidateId}/accept`, {
			method: 'POST',
		});
		expect(acceptedRes.status).toBe(200);
		const accepted = (await acceptedRes.json()) as { candidate: { status: string; savedAt: string | null } };
		expect(accepted.candidate.status).toBe('accepted');
		// Accepting does not clear the bookmark — they are separate axes.
		expect(accepted.candidate.savedAt).not.toBeNull();

		const unsavedRes = await worker(jarAlice, `/api/projects/${projAlice}/discovery/candidates/${candidateId}/save`, {
			method: 'DELETE',
		});
		const unsaved = (await unsavedRes.json()) as { candidate: { status: string; savedAt: string | null } };
		expect(unsaved.candidate.savedAt).toBeNull();
		expect(unsaved.candidate.status).toBe('accepted'); // untouched by unsave
	});
});
