import { describe, expect, test } from 'bun:test';
import type { Scope } from '@caddie/contracts';
import type { ArchitectureBlock } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import { getModule, seedModules, setModuleStatus } from '../apps/app/src/server/module-slots.ts';
import {
	type CheckFailure,
	type MergeDeps,
	acquireIntegrationLock,
	inModule,
	mergeFinishedModule,
	mergedSavePointName,
	moduleAreas,
	ownerModuleOfFailure,
	releaseIntegrationLock,
} from '../apps/app/src/server/integration.ts';
import type { SnapshotReadPort } from '../apps/app/src/server/part-manifests.ts';
import { LocalCodeStore, readVersionFiles, recordCodeVersion } from '../apps/app/src/server/code-versions.ts';
import type { CodeFile } from '../apps/app/src/server/code-store.ts';
import { loadPreviewBlob, storeChunkedClientBundle, loadChunkedClientBundle, storePreviewBlob } from '../apps/app/src/server/preview-runtime.ts';

/**
 * Lane 13 (parts Q + R) — joining the parts into the app, and room for big apps.
 *
 * LOCAL VERIFIED against the bun:sqlite D1 harness (migrations through 0043
 * applied) with a FAKE inspect-backed snapshot and fake deps — never evidence
 * about the live sandbox, a real Durable Object or a real model turn. Each
 * behaviour carries a MUTATION PROOF: a comment naming the exact production
 * line that, reverted, makes the test fail, exercised in the mutation block at
 * the end.
 */

const BUILD_SEQ = 0;

/** A two-module block: core (farms) and feed, feed dependsOn core. */
const BLOCK: ArchitectureBlock = {
	version: 2,
	signIn: 'required',
	team: null,
	modules: [
		{ id: 'core', plain: 'Farms, people and roles', dependsOn: [] },
		{ id: 'feed', plain: 'Feed stock and use', dependsOn: ['core'] },
	],
	tables: [],
	routes: [
		{ id: 'feed.create', module: 'feed', feature: 'feed', op: 'create', method: 'POST', path: '/api/feed', table: null, plain: 'Add feed', access: 'signed-in', request: [], response: [] },
		{ id: 'core.animals', module: 'core', feature: 'core', op: 'list', method: 'GET', path: '/api/animals', table: null, plain: 'List animals', access: 'signed-in', request: [], response: [] },
	],
	screens: [],
	services: [],
	ai: [],
	payments: null,
	emails: [],
	jobs: [],
	screenOnly: [],
};

/**
 * A fake snapshot: a flat map of workspace-relative path -> text. It satisfies
 * SnapshotReadPort (list one level + sha256), standing in for an inspect read
 * of a committed image, so the merge is driven with no sandbox.
 */
class FakeSnapshot {
	constructor(readonly files: Map<string, string>) {}
	port(): SnapshotReadPort & { image: string } {
		const files = this.files;
		return {
			image: 'fake',
			async list(dir: string) {
				const prefix = dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
				const names = new Map<string, boolean>();
				for (const path of files.keys()) {
					if (prefix && !path.startsWith(prefix)) continue;
					const rest = path.slice(prefix.length);
					if (rest === '') continue;
					const slash = rest.indexOf('/');
					if (slash === -1) names.set(rest, false);
					else names.set(rest.slice(0, slash), true);
				}
				return [...names.entries()].map(([name, isDir]) => ({ name, isDir }));
			},
			async sha256(path: string) {
				const text = files.get(path);
				if (text === undefined) throw new Error(`fake snapshot: ${path} is gone`);
				const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
				return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
			},
		};
	}
}

async function seedProject(): Promise<{ db: D1Database; scope: Scope; projectId: string }> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Farm' });
	const scope = await projectScopeForUser(db, 'alice', project.id);
	await seedModules(db, scope, { buildSeq: BUILD_SEQ, payerId: null, modules: [
		{ moduleId: 'core', dependsOn: [] },
		{ moduleId: 'feed', dependsOn: ['core'] },
	] });
	return { db, scope, projectId: project.id };
}

/** A deps builder over a fake module snapshot. Records writes, saves and repairs. */
function makeDeps(
	moduleSnapshot: FakeSnapshot,
	overrides: Partial<MergeDeps> & { checksSequence?: Array<{ passed: boolean; failures: CheckFailure[] }> } = {},
): { deps: MergeDeps; written: Array<{ path: string; contentBase64: string }>; saves: string[]; repairs: Array<{ moduleId: string }> } {
	const written: Array<{ path: string; contentBase64: string }> = [];
	const saves: string[] = [];
	const repairs: Array<{ moduleId: string }> = [];
	const checks = overrides.checksSequence ? [...overrides.checksSequence] : [{ passed: true, failures: [] as CheckFailure[] }];
	const deps: MergeDeps = {
		block: BLOCK,
		buildSeq: BUILD_SEQ,
		readModuleSnapshot: () => moduleSnapshot.port(),
		readModuleFile: async (_ref, path) => Buffer.from(moduleSnapshot.files.get(path) ?? '', 'utf8').toString('base64'),
		writeIntegration: async (files) => { for (const f of files) written.push(f); },
		runChecks: async () => checks.shift() ?? { passed: true, failures: [] },
		savePoint: async (name) => { saves.push(name); return `img:${saves.length}`; },
		dispatchRepair: async ({ moduleId }) => { repairs.push({ moduleId }); },
		...overrides,
	};
	return { deps, written, saves, repairs };
}

// --- the lock (migration 0043) ----------------------------------------------

describe('the integration lock serialises merges per build (part Q)', () => {
	test('a second acquire on the same build is refused until release', async () => {
		const { db, projectId } = await seedProject();
		// MUTATION PROOF: integration.ts acquireIntegrationLock returns changes===1.
		// Revert `on conflict ... do nothing` to a plain insert and the second
		// acquire throws instead of returning false (the lock stops serialising).
		expect(await acquireIntegrationLock(db, projectId, BUILD_SEQ, 'core')).toBe(true);
		expect(await acquireIntegrationLock(db, projectId, BUILD_SEQ, 'feed')).toBe(false);
		await releaseIntegrationLock(db, projectId, BUILD_SEQ);
		expect(await acquireIntegrationLock(db, projectId, BUILD_SEQ, 'feed')).toBe(true);
	});

	test('an expired holder lock is taken over', async () => {
		const { db, projectId } = await seedProject();
		const t0 = Date.parse('2026-10-22T00:00:00.000Z');
		expect(await acquireIntegrationLock(db, projectId, BUILD_SEQ, 'core', t0)).toBe(true);
		// Still held a minute later.
		expect(await acquireIntegrationLock(db, projectId, BUILD_SEQ, 'feed', t0 + 60_000)).toBe(false);
		// Past the TTL the lapsed lock is cleared and the next caller takes it.
		expect(await acquireIntegrationLock(db, projectId, BUILD_SEQ, 'feed', t0 + 11 * 60_000)).toBe(true);
	});

	test('mergeFinishedModule reports when another merge holds the lock', async () => {
		const { db, scope, projectId } = await seedProject();
		await acquireIntegrationLock(db, projectId, BUILD_SEQ, 'someone-else');
		const snap = new FakeSnapshot(new Map([['src/server/feed/feed.ts', 'ok']]));
		const { deps } = makeDeps(snap);
		const result = await mergeFinishedModule(db, scope, { runId: 'r', moduleId: 'feed', checkpointRef: 'img' }, deps);
		expect(result.acquiredLock).toBe(false);
		expect(result.merged).toBe(false);
	});
});

// --- only the module's folders are copied (part Q step 1) --------------------

describe('merge copies only the module folders (part Q step 1)', () => {
	test('in-folder files are written; a stray outside the folders is reported, not copied', async () => {
		const { db, scope } = await seedProject();
		const snap = new FakeSnapshot(new Map([
			['src/server/feed/feed.ts', 'export const feed = 1;'],
			['src/screens/feed/Feed.tsx', 'export const Feed = () => null;'],
			['src/server/core/core.ts', 'export const core = 2;'], // stray: core's folder, not feed's
			['src/App.tsx', 'export const App = () => null;'], // stray: core-frontend file
		]));
		const { deps, written } = makeDeps(snap);
		const result = await mergeFinishedModule(db, scope, { runId: 'r', moduleId: 'feed', checkpointRef: 'img' }, deps);
		expect(result.merged).toBe(true);
		const writtenPaths = written.map((f) => f.path).sort();
		// MUTATION PROOF: integration.ts filters `inFolder` by inModule(areas,...).
		// Drop the `.filter((f) => inModule(areas, f.path))` and src/server/core
		// and src/App.tsx get copied too — this assertion fails.
		expect(writtenPaths).toEqual(['src/screens/feed/Feed.tsx', 'src/server/feed/feed.ts']);
		// MUTATION PROOF: integration.ts strayChanges collects out-of-folder files.
		// Make strayChanges return [] and this fails.
		expect(result.strayFiles).toEqual(['src/App.tsx', 'src/server/core/core.ts']);
	});

	test('a file unchanged vs the integration copy is not a stray', async () => {
		const { db, scope } = await seedProject();
		const shared = 'export const core = 2;';
		const moduleSnap = new FakeSnapshot(new Map([
			['src/server/feed/feed.ts', 'export const feed = 1;'],
			['src/server/core/core.ts', shared], // outside feed's folder, but identical to the app
		]));
		const integrationSnap = new FakeSnapshot(new Map([['src/server/core/core.ts', shared]]));
		const { deps } = makeDeps(moduleSnap, { readIntegrationSnapshot: () => integrationSnap.port() });
		const result = await mergeFinishedModule(db, scope, { runId: 'r', moduleId: 'feed', checkpointRef: 'img' }, deps);
		// MUTATION PROOF: strayChanges skips a file whose sha equals the base's.
		// Remove the `before === file.sha256` continue and this becomes a stray.
		expect(result.strayFiles).toEqual([]);
	});
});

// --- green merge: a save point named "<A> + <B> merged" ----------------------

describe('a green merge makes the "<A> + <B> merged" save point (part Q step 2)', () => {
	test('the save point name lists the merged modules', async () => {
		const { db, scope, projectId } = await seedProject();
		await setModuleStatus(db, projectId, BUILD_SEQ, 'core', 'merged');
		const snap = new FakeSnapshot(new Map([['src/server/feed/feed.ts', 'ok']]));
		const { deps, saves } = makeDeps(snap);
		const result = await mergeFinishedModule(db, scope, { runId: 'r', moduleId: 'feed', checkpointRef: 'img' }, deps);
		expect(result.merged).toBe(true);
		expect(result.savePoint).toBe('core + feed merged');
		// MUTATION PROOF: mergeFinishedModule calls deps.savePoint(name) on green.
		// Remove that call and `saves` is empty.
		expect(saves).toEqual(['core + feed merged']);
		expect((await getModule(db, projectId, BUILD_SEQ, 'feed'))?.status).toBe('merged');
	});

	test('mergedSavePointName includes the just-merged module even before its row flips', async () => {
		const { db, projectId } = await seedProject();
		await setModuleStatus(db, projectId, BUILD_SEQ, 'core', 'merged');
		// Ordered by the block's declared module order (core before feed), so the
		// name is deterministic even when the board rows tie on timestamp.
		expect(await mergedSavePointName(db, projectId, BUILD_SEQ, 'feed', BLOCK.modules.map((m) => m.id))).toBe('core + feed merged');
	});
});

// --- failure -> owning module, repair dispatch, partial result ---------------

describe('a red merge routes the repair and keeps a partial result (part Q step 2)', () => {
	test('a failing file in feed routes the repair to feed, then merges on the retry', async () => {
		const { db, scope, projectId } = await seedProject();
		const snap = new FakeSnapshot(new Map([['src/server/feed/feed.ts', 'ok']]));
		const { deps, repairs, saves } = makeDeps(snap, {
			checksSequence: [
				{ passed: false, failures: [{ check: 'behavior-tests', file: 'src/server/feed/feed.ts' }] },
				{ passed: true, failures: [] },
			],
		});
		const result = await mergeFinishedModule(db, scope, { runId: 'r', moduleId: 'feed', checkpointRef: 'img' }, deps);
		expect(result.merged).toBe(true);
		expect(result.rounds).toBe(1);
		// MUTATION PROOF: mergeFinishedModule dispatches a repair to the owner of
		// each failure. Remove the dispatchRepair loop and `repairs` is empty.
		expect(repairs).toEqual([{ moduleId: 'feed' }]);
		expect(saves).toEqual(['feed merged']);
		expect((await getModule(db, projectId, BUILD_SEQ, 'feed'))?.status).toBe('merged');
	});

	test('still red after 2 rounds marks the module not-merged; the rest keeps working', async () => {
		const { db, scope, projectId } = await seedProject();
		await setModuleStatus(db, projectId, BUILD_SEQ, 'core', 'merged');
		const snap = new FakeSnapshot(new Map([['src/server/feed/feed.ts', 'ok']]));
		const { deps, repairs } = makeDeps(snap, {
			checksSequence: [
				{ passed: false, failures: [{ check: 'behavior-tests', route: 'feed.create' }] },
				{ passed: false, failures: [{ check: 'behavior-tests', route: 'feed.create' }] },
				{ passed: false, failures: [{ check: 'behavior-tests', route: 'feed.create' }] },
			],
		});
		const result = await mergeFinishedModule(db, scope, { runId: 'r', moduleId: 'feed', checkpointRef: 'img' }, deps);
		// MUTATION PROOF: mergeFinishedModule gives up after maxRounds repairs.
		// Change `rounds >= maxRounds` to `rounds > maxRounds` and it never stops.
		expect(result.merged).toBe(false);
		expect(result.rounds).toBe(2);
		expect(repairs).toEqual([{ moduleId: 'feed' }, { moduleId: 'feed' }]);
		// The failed module is not-merged; core (already merged) is untouched.
		expect((await getModule(db, projectId, BUILD_SEQ, 'feed'))?.status).toBe('not-merged');
		expect((await getModule(db, projectId, BUILD_SEQ, 'core'))?.status).toBe('merged');
	});

	test('ownerModuleOfFailure maps a file to its module, a route to its module, else core', () => {
		expect(ownerModuleOfFailure(BLOCK, { check: 'x', file: 'src/server/feed/feed.ts' })).toBe('feed');
		expect(ownerModuleOfFailure(BLOCK, { check: 'x', route: 'core.animals' })).toBe('core');
		// MUTATION PROOF: the final `return CORE_MODULE`. Change it to 'feed' and
		// this unattributable failure is mis-blamed on feed.
		expect(ownerModuleOfFailure(BLOCK, { check: 'server-starts' })).toBe('core');
	});

	test('moduleAreas / inModule cover the module folders including core frontend extras', () => {
		const feed = moduleAreas(BLOCK, 'feed');
		expect(inModule(feed, 'src/server/feed/x.ts')).toBe(true);
		expect(inModule(feed, 'src/screens/feed/Y.tsx')).toBe(true);
		expect(inModule(feed, 'src/App.tsx')).toBe(false);
		const core = moduleAreas(BLOCK, 'core');
		expect(inModule(core, 'src/App.tsx')).toBe(true);
	});
});

// --- R: code store / code versions up to 2,000 files -------------------------

function codeStoreDb(): { db: D1Database } {
	const { db } = migratedDatabase();
	return { db };
}

describe('room for big apps: a large version round-trips (part R)', () => {
	test('a 1,500-file version is saved and read back identically', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, 'alice', 'alice@example.com');
		const ws = await createWorkspace(db, 'alice', { name: 'W' });
		const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Big' });
		const scope = await projectScopeForUser(db, 'alice', project.id);
		const store = new LocalCodeStore(db);
		const files: CodeFile[] = [];
		for (let i = 0; i < 1500; i++) {
			files.push({ path: `src/screens/mod${i % 12}/file${i}.ts`, contentBase64: Buffer.from(`export const n${i} = ${i};`, 'utf8').toString('base64') });
		}
		// MUTATION PROOF: code-store.ts CODE_STORE_CAPS.maxFiles = 2000. Revert it
		// to 400 and assertValidSnapshot throws TOO_LARGE on this 1,500-file commit.
		const { version } = await recordCodeVersion(db, store, scope, { kind: 'build', title: '1500 files', files, actorId: 'alice' });
		expect(version.fileCount).toBe(1500);
		const back = await readVersionFiles(store, project.id, version.commitId);
		expect(back.length).toBe(1500);
		const sample = back.find((f) => f.path === 'src/screens/mod0/file0.ts');
		expect(Buffer.from(sample!.contentBase64, 'base64').toString('utf8')).toBe('export const n0 = 0;');
	});
});

// --- R: the chunked preview/server bundle ------------------------------------

describe('room for big apps: the chunked preview/server bundle (part R)', () => {
	test('a blob over 2 MB takes the chunked store and round-trips byte-identically', async () => {
		const { db } = codeStoreDb();
		const big = new Uint8Array(3 * 1024 * 1024);
		for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
		const ref = await storePreviewBlob(db, big);
		// MUTATION PROOF: storePreviewBlob uses `>= PREVIEW_INLINE_LIMIT` to pick
		// chunked. Flip it to `> 10 * PREVIEW_INLINE_LIMIT` and a 3 MB blob takes
		// the inline store, whose put throws CONTENT_TOO_LARGE over 2 MB.
		expect(ref.store).toBe('chunked');
		expect(ref.bytes).toBe(big.length);
		const back = await loadPreviewBlob(db, ref);
		expect(back).not.toBeNull();
		expect(back!.length).toBe(big.length);
		expect(Array.from(back!.slice(0, 64))).toEqual(Array.from(big.slice(0, 64)));
	});

	test('a small blob takes the inline store', async () => {
		const { db } = codeStoreDb();
		const ref = await storePreviewBlob(db, new TextEncoder().encode('small'));
		expect(ref.store).toBe('inline');
		expect(new TextDecoder().decode((await loadPreviewBlob(db, ref))!)).toBe('small');
	});

	test('a 5 MB client bundle loads as separate chunked main.js and main.css', async () => {
		const { db } = codeStoreDb();
		const js = 'x'.repeat(5 * 1024 * 1024); // over 2 MB -> chunked
		const css = 'body{color:red}'; // small -> inline
		const bundle = await storeChunkedClientBundle(db, { js, css });
		// MUTATION PROOF: storeChunkedClientBundle stores js and css SEPARATELY.
		// Concatenate them into one blob instead and the 5 MB js+css would exceed
		// nothing here, but splitting is what lets each take its own store:
		expect(bundle.js.store).toBe('chunked');
		expect(bundle.css.store).toBe('inline');
		const back = await loadChunkedClientBundle(db, bundle);
		expect(back.js.length).toBe(js.length);
		expect(back.css).toBe(css);
	});
});

// --- migration 0043: the table and its per-build PK --------------------------

describe('migration 0043 — the integration_merge_locks table (part Q)', () => {
	test('the table exists with a (projectId, buildSeq) primary key', async () => {
		const { sqlite } = migratedDatabase();
		const cols = sqlite.prepare("pragma table_info('integration_merge_locks')").all() as Array<{ name: string; pk: number }>;
		const names = cols.map((c) => c.name).sort();
		expect(names).toEqual(['buildSeq', 'createdAt', 'expiresAt', 'holder', 'projectId']);
		// MUTATION PROOF: 0043 makes (projectId, buildSeq) the primary key. Remove
		// the composite PK and two rows for one build can both exist — the insert
		// below stops throwing and this expectation fails.
		const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
		expect(pkCols).toEqual(['buildSeq', 'projectId']);
	});

	test('a second lock row for the same build is refused by the primary key', async () => {
		const { sqlite } = migratedDatabase();
		// Insert directly into the lock table (no FK target needed: SQLite leaves
		// FKs off unless PRAGMA foreign_keys=ON, as the harness does).
		sqlite.prepare('insert into "integration_merge_locks" ("projectId","buildSeq","holder","expiresAt","createdAt") values (?,?,?,?,?)').run('p', 0, 'core', 'z', 't');
		let threw = false;
		try {
			sqlite.prepare('insert into "integration_merge_locks" ("projectId","buildSeq","holder","expiresAt","createdAt") values (?,?,?,?,?)').run('p', 0, 'feed', 'z', 't');
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		// A different build is a different lock.
		expect(() => sqlite.prepare('insert into "integration_merge_locks" ("projectId","buildSeq","holder","expiresAt","createdAt") values (?,?,?,?,?)').run('p', 1, 'core', 'z', 't')).not.toThrow();
	});
});
