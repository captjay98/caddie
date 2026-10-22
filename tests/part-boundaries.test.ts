import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { Scope } from '@caddie/contracts';
import type { ArchitectureBlock } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject, createPlanDocRevision } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import {
	areaFor,
	buildManifest,
	diffAgainstManifest,
	inArea,
	isGeneratedPath,
	type SnapshotReadPort,
} from '../apps/app/src/server/part-manifests.ts';
import {
	startPart,
	activePart,
	finishPart,
	restoreFiles,
	clearActivePart,
	type SnapshotWritePort,
} from '../apps/app/src/server/build-steps.ts';
import { assertInArea } from '../apps/app/src/agents/tools.ts';

/**
 * Lane 5, part D (plan docs/plans/2026-10-22-software-team-mode.md): a builder
 * changes only its own part, and the check is on the SAVED FILES, so a change
 * made by a Node, Python or package script is caught the same way. Plus S2:
 * manifest time on a 300-file app, and today's build-loop tests pass with team
 * mode off.
 *
 * LOCAL VERIFIED for the area logic, the manifest walk/diff and the DB-backed
 * start/finish/restore over bun:sqlite D1 and an in-memory snapshot port that
 * serves files exactly as the real contree inspect API does (path + bytes).
 * The in-memory port is NOT evidence about the real sandbox; the driver↔contree
 * transport is proven in tests/sandbox.contract.test.ts.
 */

function sha256(text: string): string {
	return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * A SnapshotReadPort + SnapshotWritePort over an in-memory file map, serving
 * exactly what the real driver serves: one directory level (list) and a file's
 * content sha256 (sha256). `startFiles` is the frozen start-of-part snapshot
 * restore reads from; `files` is the mutable current snapshot.
 */
function memoryPort(files: Record<string, string>) {
	const current = new Map(Object.entries(files).map(([p, c]) => [norm(p), c]));
	const start = new Map(current);
	const image = 'img-start';
	const port = {
		image,
		async list(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
			const prefix = dir === '' ? '' : `${norm(dir)}/`;
			const names = new Map<string, boolean>();
			for (const path of current.keys()) {
				if (prefix && !path.startsWith(prefix)) continue;
				const rest = path.slice(prefix.length);
				if (rest === '') continue;
				const slash = rest.indexOf('/');
				if (slash === -1) names.set(rest, false);
				else names.set(rest.slice(0, slash), true);
			}
			return [...names.entries()].map(([name, isDir]) => ({ name, isDir }));
		},
		async sha256(path: string): Promise<string> {
			const content = current.get(norm(path));
			if (content === undefined) throw new Error(`no such file ${path}`);
			return sha256(content);
		},
		async readFromStart(path: string): Promise<string> {
			const content = start.get(norm(path));
			if (content === undefined) throw new Error(`no such start file ${path}`);
			return Buffer.from(content, 'utf8').toString('base64');
		},
		async writeBatch(batch: Array<{ path: string; contentBase64: string }>): Promise<void> {
			for (const { path, contentBase64 } of batch) current.set(norm(path), Buffer.from(contentBase64, 'base64').toString('utf8'));
		},
		// test helpers
		write(path: string, content: string) {
			current.set(norm(path), content);
		},
		remove(path: string) {
			current.delete(norm(path));
		},
		read(path: string): string | undefined {
			return current.get(norm(path));
		},
	};
	return port;
}

function norm(path: string): string {
	return path.replaceAll('\\', '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

const SMALL_BLOCK: ArchitectureBlock = {
	version: 2,
	signIn: 'required',
	team: null,
	modules: [{ id: 'app', plain: 'The app', dependsOn: [] }],
	tables: [],
	routes: [],
	screens: [],
	services: [],
	ai: [],
	payments: null,
	emails: [],
	jobs: [],
	screenOnly: [],
};

const BIG_BLOCK: ArchitectureBlock = {
	version: 2,
	signIn: 'required',
	team: { table: 'farms', plain: 'A farm', roles: ['owner', 'worker'], creatorRole: 'owner' },
	modules: [
		{ id: 'core', plain: 'Farms and people', dependsOn: [] },
		{ id: 'feed', plain: 'Feed', dependsOn: ['core'] },
	],
	tables: [],
	routes: [],
	screens: [],
	services: [],
	ai: [],
	payments: null,
	emails: [],
	jobs: [],
	screenOnly: [],
};

// --- Part D: areas per role, small and big apps (with mutation proofs) -------

describe('part D — areas per role', () => {
	test('small app: backend owns src/server, src/server.ts, migrations; frontend the rest of src; mobile lib/test-app', () => {
		const backend = areaFor(SMALL_BLOCK, 'backend');
		expect(inArea(backend, 'src/server.ts')).toBe(true);
		expect(inArea(backend, 'src/server/routes/todos.ts')).toBe(true);
		expect(inArea(backend, 'src/server.test.ts')).toBe(true);
		expect(inArea(backend, 'migrations/0005_todos.sql')).toBe(true);
		// backend may NOT touch the UI
		expect(inArea(backend, 'src/App.tsx')).toBe(false);

		const frontend = areaFor(SMALL_BLOCK, 'frontend');
		expect(inArea(frontend, 'src/App.tsx')).toBe(true);
		expect(inArea(frontend, 'src/components/List.tsx')).toBe(true);
		// the backend files inside src/ are carved OUT of the frontend area
		expect(inArea(frontend, 'src/server.ts')).toBe(false);
		expect(inArea(frontend, 'src/server/db.ts')).toBe(false);
		// frontend may NOT touch migrations
		expect(inArea(frontend, 'migrations/0005_todos.sql')).toBe(false);

		const mobile = areaFor(SMALL_BLOCK, 'mobile');
		expect(inArea(mobile, 'lib/main.dart')).toBe(true);
		expect(inArea(mobile, 'test/app/widget_test.dart')).toBe(true);
		expect(inArea(mobile, 'src/App.tsx')).toBe(false);
	});

	// Mutation proof: if the small-frontend carve-out of the backend files were
	// removed (frontend allowed to own src/server.ts), this assertion flips.
	test('small app frontend does NOT own the backend files (carve-out)', () => {
		const frontend = areaFor(SMALL_BLOCK, 'frontend');
		expect(inArea(frontend, 'src/server.ts')).toBe(false);
	});

	test('big app: each module owns src/server/<mod> and src/screens/<mod>; core owns App/main/styles', () => {
		const coreBack = areaFor(BIG_BLOCK, 'backend', 'core');
		expect(inArea(coreBack, 'src/server/core/farms.ts')).toBe(true);
		expect(inArea(coreBack, 'src/server/feed/stock.ts')).toBe(false); // another module's backend

		const feedBack = areaFor(BIG_BLOCK, 'backend', 'feed');
		expect(inArea(feedBack, 'src/server/feed/stock.ts')).toBe(true);
		expect(inArea(feedBack, 'src/server/core/farms.ts')).toBe(false);

		const coreFront = areaFor(BIG_BLOCK, 'frontend', 'core');
		expect(inArea(coreFront, 'src/screens/core/Home.tsx')).toBe(true);
		expect(inArea(coreFront, 'src/App.tsx')).toBe(true);
		expect(inArea(coreFront, 'src/main.tsx')).toBe(true);
		expect(inArea(coreFront, 'src/styles.css')).toBe(true);

		const feedFront = areaFor(BIG_BLOCK, 'frontend', 'feed');
		expect(inArea(feedFront, 'src/screens/feed/Feed.tsx')).toBe(true);
		// a non-core module's frontend does NOT own the app shell
		expect(inArea(feedFront, 'src/App.tsx')).toBe(false);
		expect(inArea(feedFront, 'src/screens/core/Home.tsx')).toBe(false);
	});

	// Mutation proof: only core's frontend owns App.tsx. If that guard were
	// dropped (every module owned App.tsx), this flips.
	test('big app: a non-core module frontend may not change the app shell', () => {
		expect(inArea(areaFor(BIG_BLOCK, 'frontend', 'feed'), 'src/App.tsx')).toBe(false);
	});

	test('generated and protected paths are in no area', () => {
		expect(isGeneratedPath('caddie/contract.ts')).toBe(true);
		expect(isGeneratedPath('migrations/0001_schema.sql')).toBe(true);
		expect(isGeneratedPath('migrations/0000_caddie_auth.sql')).toBe(true);
		expect(isGeneratedPath('test/setup/ai.ts')).toBe(true);
		expect(inArea(areaFor(SMALL_BLOCK, 'backend'), 'caddie/contract.ts')).toBe(false);
		expect(inArea(areaFor(SMALL_BLOCK, 'backend'), 'migrations/0001_schema.sql')).toBe(false);
	});
});

// --- Part D: a script change outside the area is caught (snapshot diff) ------

describe('part D — a change outside the area is caught on the snapshot', () => {
	test('a file a script wrote outside the backend area is reported out-of-area', async () => {
		const port = memoryPort({
			'src/server.ts': 'export const api = 1;',
			'src/App.tsx': 'export const App = () => null;',
		});
		const area = areaFor(SMALL_BLOCK, 'backend');
		const start = await buildManifest(port);
		// A package/Node/Python script (not a write tool) edits a FRONTEND file.
		port.write('src/App.tsx', 'export const App = () => "changed by a script";');
		const current = await buildManifest(port);
		const out = diffAgainstManifest(area, start, current);
		expect(out.map((c) => `${c.path}:${c.kind}`)).toEqual(['src/App.tsx:modified']);
	});

	// Mutation proof: an in-area change (backend edits its own file) is NOT
	// reported. If diffAgainstManifest dropped the inArea filter, this flips.
	test('an in-area change is not reported', async () => {
		const port = memoryPort({ 'src/server.ts': 'a', 'src/App.tsx': 'b' });
		const area = areaFor(SMALL_BLOCK, 'backend');
		const start = await buildManifest(port);
		port.write('src/server.ts', 'a-edited');
		const out = diffAgainstManifest(area, start, await buildManifest(port));
		expect(out).toEqual([]);
	});

	test('an out-of-area add and delete are both caught', async () => {
		const port = memoryPort({ 'src/server.ts': 'a', 'src/App.tsx': 'b' });
		const area = areaFor(SMALL_BLOCK, 'backend');
		const start = await buildManifest(port);
		port.write('src/new-ui.tsx', 'added by a script'); // out-of-area add
		port.remove('src/App.tsx'); // out-of-area delete
		const out = diffAgainstManifest(area, start, await buildManifest(port));
		expect(out.map((c) => `${c.path}:${c.kind}`).sort()).toEqual(['src/App.tsx:deleted', 'src/new-ui.tsx:added']);
	});
});

// --- DB-backed start_part / finish_part / restore_files / active role --------

async function seed(block: ArchitectureBlock): Promise<{ sqlite: Database; db: D1Database; scope: Scope }> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, {
		workspaceId: ws.id,
		name: 'Farm',
	});
	const scope = await projectScopeForUser(db, 'alice', project.id);
	const design = [
		'# Design',
		'```caddie-architecture',
		JSON.stringify(block),
		'```',
	].join('\n');
	await createPlanDocRevision(db, scope, { kind: 'design', body: design });
	return { sqlite, db, scope };
}

describe('part D — start_part / finish_part / restore_files', () => {
	let world: Awaited<ReturnType<typeof seed>>;
	afterEach(() => world?.sqlite.close());

	test('start_part records the manifest and the active role; finish refuses out-of-area, restore fixes it', async () => {
		world = await seed(SMALL_BLOCK);
		const { db, scope } = world;
		const port = memoryPort({
			'src/server.ts': 'export const api = 1;',
			'src/App.tsx': 'export const App = () => null;',
			'caddie/contract.ts': 'generated', // excluded from the manifest
		});

		const started = await startPart(db, scope, port, { featureId: 'f1', role: 'backend' });
		expect(started.role).toBe('backend');
		expect(started.files).toBe(2); // caddie/ is not manifested

		const active = await activePart(db, scope);
		expect(active?.role).toBe('backend');
		expect(active?.featureId).toBe('f1');

		// Clean so far.
		expect(await finishPart(db, scope, port)).toEqual({ ok: true });

		// A script edits a frontend file — outside the backend part.
		port.write('src/App.tsx', 'export const App = () => "oops";');
		const refused = await finishPart(db, scope, port);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error('unreachable');
		expect(refused.outOfArea.map((c) => c.path)).toEqual(['src/App.tsx']);

		// restore_files puts it back from the start snapshot, in one call.
		const restored = await restoreFiles(db, scope, port, ['src/App.tsx']);
		expect(restored.restored).toEqual(['src/App.tsx']);
		expect(port.read('src/App.tsx')).toBe('export const App = () => null;');
		expect(await finishPart(db, scope, port)).toEqual({ ok: true });
	});

	// Mutation proof: restore reads from the START image. If readFromStart read
	// the CURRENT file instead, the restored content would be the edited text.
	test('restore_files restores the start content, not the current content', async () => {
		world = await seed(SMALL_BLOCK);
		const { db, scope } = world;
		const port = memoryPort({ 'src/server.ts': 's', 'src/App.tsx': 'original' });
		await startPart(db, scope, port, { featureId: 'f1', role: 'backend' });
		port.write('src/App.tsx', 'edited');
		await restoreFiles(db, scope, port, ['src/App.tsx']);
		expect(port.read('src/App.tsx')).toBe('original');
	});

	test('restore_files reports a file absent at start as not restorable', async () => {
		world = await seed(SMALL_BLOCK);
		const { db, scope } = world;
		const port = memoryPort({ 'src/server.ts': 's' });
		await startPart(db, scope, port, { featureId: 'f1', role: 'backend' });
		port.write('src/brand-new.tsx', 'added');
		const result = await restoreFiles(db, scope, port, ['src/brand-new.tsx']);
		expect(result.restored).toEqual([]);
		expect(result.absentAtStart).toEqual(['src/brand-new.tsx']);
	});

	test('a big app requires the module id for start_part', async () => {
		world = await seed(BIG_BLOCK);
		const { db, scope } = world;
		const port = memoryPort({ 'src/server/core/a.ts': 'x' });
		await expect(startPart(db, scope, port, { featureId: 'f1', role: 'backend' })).rejects.toThrow(/module/i);
		const ok = await startPart(db, scope, port, { featureId: 'f1', role: 'backend', moduleId: 'core' });
		expect(ok.moduleId).toBe('core');
	});
});

// --- Part D: the active-role refusal (write-tool early feedback) -------------

describe('part D — active-role refusal (assertInArea)', () => {
	test('refuses another role and an out-of-area path; allows the active role in-area', async () => {
		const area = areaFor(SMALL_BLOCK, 'backend');
		const active = async () => ({ role: 'backend', area });
		// A frontend tool while backend is active: refused.
		await expect(assertInArea({ role: 'frontend', active }, 'src/App.tsx')).rejects.toThrow(/OUT_OF_PART/);
		// The active role writing OUTSIDE its area: refused.
		await expect(assertInArea({ role: 'backend', active }, 'src/App.tsx')).rejects.toThrow(/OUT_OF_AREA/);
		// The active role in its own area: allowed.
		await expect(assertInArea({ role: 'backend', active }, 'src/server/x.ts')).resolves.toBeUndefined();
	});

	// Mutation proof: with NO active part the guard allows every write (today's
	// behaviour, team mode off). If assertInArea stopped short-circuiting on a
	// null active part, this would throw.
	test('no active part: every write is allowed (team mode off)', async () => {
		await expect(assertInArea({ role: 'frontend', active: async () => null }, 'anything.ts')).resolves.toBeUndefined();
		// and with no guard at all
		await expect(assertInArea(undefined, 'anything.ts')).resolves.toBeUndefined();
	});
});

// --- S2 spike ----------------------------------------------------------------

describe('S2 — manifest time on a 300-file app; build loop unchanged with team mode off', () => {
	test('a manifest of 300 source files builds quickly', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 150; i++) files[`src/server/mod${i % 10}/file${i}.ts`] = `export const v${i} = ${i};`;
		for (let i = 0; i < 150; i++) files[`src/screens/mod${i % 10}/Screen${i}.tsx`] = `export const S${i} = () => ${i};`;
		const port = memoryPort(files);
		const t0 = performance.now();
		const manifest = await buildManifest(port);
		const elapsed = performance.now() - t0;
		expect(manifest.files.length).toBe(300);
		// Local wall-clock sanity bound (measured ~single-digit ms in-process).
		expect(elapsed).toBeLessThan(2000);
		// eslint-disable-next-line no-console
		console.log(`S2: manifest of ${manifest.files.length} files in ${elapsed.toFixed(1)}ms`);
	});

	test('with team mode off there is no active part, so finish is a no-op and nothing is refused', async () => {
		const world = await seed(SMALL_BLOCK);
		try {
			const port = memoryPort({ 'src/App.tsx': 'x', 'src/server.ts': 'y' });
			// No startPart was called (team mode off). The boundary check is inert.
			expect(await activePart(world.db, world.scope)).toBeNull();
			expect(await finishPart(world.db, world.scope, port)).toEqual({ ok: true });
			await clearActivePart(world.db, world.scope); // idempotent, safe
		} finally {
			world.sqlite.close();
		}
	});
});
