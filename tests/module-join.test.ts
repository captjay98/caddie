import { describe, expect, test } from 'bun:test';
import { migratedDatabase, addUser } from './fixtures/sqlite-d1.ts';
import { createWorkspace, createProject } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';
import type { ArchitectureBlock, Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import type { SnapshotReadPort } from '../apps/app/src/server/part-manifests.ts';
import { getModule, moduleInstanceId } from '../apps/app/src/server/module-slots.ts';
import { acquireIntegrationLock, releaseIntegrationLock, type CheckFailure } from '../apps/app/src/server/integration.ts';
import { startAfterFoundation } from '../apps/app/src/server/big-build.ts';
import { joinFinishedModule, MAX_JOIN_TRIES, type JoinCopy, type JoinPorts } from '../apps/app/src/server/module-join.ts';

/**
 * Big apps (plan part P step 3, part Q): a part whose builder has finished is
 * joined into the app. The part's own folders are written into a copy of the
 * NEWEST joined save point, the full checks run there, and:
 *   - green: that copy is the new newest save point, the build's own copy
 *     points at it, the part's builder slot is freed and the parts that were
 *     waiting on it start;
 *   - red: the copy is thrown away (nothing changes in the app), and the part
 *     goes back to its builder with the failures, up to two joins; after the
 *     second it is "not joined" and the rest of the app carries on.
 * When nothing is left to build, Caddie (the coordinator) is told once.
 *
 * LOCAL VERIFIED against the bun:sqlite D1 harness with every migration and a
 * fake image store / join copy standing in for the sandbox. No model, no
 * Durable Object, no sandbox.
 */

const RUN = 'run-1';
const FEATURES: Record<string, string[]> = { core: ['farms'], feed: ['feed-log'], tasks: ['tasks'], money: ['sales'] };

function route(id: string, module: string, feature: string) {
	return { id, module, feature, op: 'create', method: 'POST', path: `/api/${id}`, table: null, plain: id, access: 'signed-in', request: [], response: [] };
}

/** core; feed and tasks need core; money needs core and feed. */
function block(): ArchitectureBlock {
	return {
		modules: [
			{ id: 'core', plain: 'Farms', dependsOn: [] },
			{ id: 'feed', plain: 'Feed', dependsOn: ['core'] },
			{ id: 'tasks', plain: 'Tasks', dependsOn: ['core'] },
			{ id: 'money', plain: 'Money', dependsOn: ['core', 'feed'] },
		],
		routes: [route('farms.create', 'core', 'farms'), route('feed.create', 'feed', 'feed-log'), route('tasks.create', 'tasks', 'tasks'), route('money.create', 'money', 'sales')],
	} as unknown as ArchitectureBlock;
}

/** Committed images: path -> text, read the way the inspect port reads them. */
class Images {
	readonly images = new Map<string, Map<string, string>>();
	private n = 0;
	add(files: Record<string, string> | Map<string, string>, name?: string): string {
		const id = name ?? `img-${++this.n}`;
		this.images.set(id, new Map(files instanceof Map ? files : Object.entries(files)));
		return id;
	}
	files(image: string): Map<string, string> {
		const found = this.images.get(image);
		if (!found) throw new Error(`no image ${image}`);
		return found;
	}
	port(image: string): SnapshotReadPort & { image: string } {
		const files = this.files(image);
		return {
			image,
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
				if (text === undefined) throw new Error(`${path} is gone from ${image}`);
				const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
				return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
			},
		};
	}
}

type Checks = { passed: boolean; failures: CheckFailure[] };

/** A join copy: a writable clone of an image; checkpoint commits a new image. */
class Copy implements JoinCopy {
	readonly files: Map<string, string>;
	readonly checksRun: Array<{ attempt: string; features: readonly string[] }> = [];
	constructor(private readonly store: Images, readonly from: string, private readonly script: Checks[]) {
		this.files = new Map(store.files(from));
	}
	async write(files: ReadonlyArray<{ path: string; contentBase64: string }>) {
		for (const f of files) this.files.set(f.path, Buffer.from(f.contentBase64, 'base64').toString('utf8'));
	}
	async runChecks(input: { attempt: string; features: readonly string[] }) {
		this.checksRun.push(input);
		return this.script.shift() ?? { passed: true, failures: [] };
	}
	async checkpoint() {
		return this.store.add(this.files);
	}
}

function harness(store: Images, script: Checks[] = []) {
	const copies: Copy[] = [];
	const opened: Array<{ image: string; key: string }> = [];
	const pointed: Array<{ image: string; name: string }> = [];
	const dispatched: Array<{ instanceId: string; moduleId: string; message: string; features: readonly string[] }> = [];
	const notified: Array<{ key: string; message: string }> = [];
	const ports: JoinPorts = {
		openCopy: async (image, key) => {
			opened.push({ image, key });
			const copy = new Copy(store, image, script);
			copies.push(copy);
			return copy;
		},
		readSnapshot: (image) => store.port(image),
		readFile: async (image, path) => Buffer.from(store.files(image).get(path) ?? '', 'utf8').toString('base64'),
		pointBuildCopyAt: async (image, name) => void pointed.push({ image, name }),
		dispatch: (d) => void dispatched.push(d),
		features: (m) => FEATURES[m] ?? [],
		notifyCoordinator: (n) => void notified.push(n),
	};
	return { ports, copies, opened, pointed, dispatched, notified };
}

async function seed(): Promise<{ db: D1Database; scope: Scope; store: Images; started: string[] }> {
	const { sqlite, db } = migratedDatabase();
	addUser(sqlite, 'alice', 'alice@example.com');
	const ws = await createWorkspace(db, 'alice', { name: 'W' });
	const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Farm' });
	const scope = await projectScopeForUser(db, 'alice', project.id);
	const now = new Date().toISOString();
	await db.prepare('insert into "build_spend_limits" ("payerId","limitMicros","createdAt","updatedAt") values (?,?,?,?)').bind('pay-1', 40_000_000, now, now).run();
	const store = new Images();
	store.add({ 'src/server/core/farms.ts': 'core v1', 'src/App.tsx': 'shell' }, 'img-core');
	const started: string[] = [];
	await startAfterFoundation(db, scope, {
		runId: RUN,
		block: block(),
		featureIds: ['farms', 'feed-log', 'tasks', 'sales'],
		payerId: 'pay-1',
		foundationRef: 'img-core',
		dispatch: (d) => void started.push(d.moduleId),
	});
	return { db, scope, store, started };
}

/** A part's finished copy: the newest joined app plus its own work (and, optionally, a stray). */
function finishedPart(store: Images, from: string, moduleId: string, version = 'v1', stray = false): string {
	const files = new Map(store.files(from));
	files.set(`src/server/${moduleId}/${moduleId}.ts`, `${moduleId} ${version}`);
	files.set(`src/screens/${moduleId}/${moduleId}.tsx`, `${moduleId} screen ${version}`);
	if (stray) files.set('src/server/core/farms.ts', `core edited by ${moduleId}`);
	return store.add(files);
}

const status = async (db: D1Database, scope: Scope, moduleId: string) => (await getModule(db, scope.projectId, 0, moduleId))?.status;
const slotHeld = async (db: D1Database, scope: Scope, moduleId: string) =>
	Number(
		((await db.prepare('select count(*) as n from "build_module_slots" where "projectId" = ? and "moduleId" = ?').bind(scope.projectId, moduleId).all()).results?.[0] as { n: number }).n,
	) > 0;
const red = (output: string): Checks => ({ passed: false, failures: [{ check: 'behavior-tests', output }] });

describe('joining a finished part into the app (part P step 3)', () => {
	test('green: its own folders go into a copy of the newest save point; that becomes the newest; the waiting parts start', async () => {
		const { db, scope, store, started } = await seed();
		expect(started).toEqual(['feed', 'tasks']);
		const h = harness(store);
		const feedRef = finishedPart(store, 'img-core', 'feed', 'v1', true);
		const out = await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: feedRef, block: block(), attempt: 'call-1' }, h.ports);

		expect(out).toMatchObject({ joined: true });
		// One copy, opened from the newest joined save point (the foundation's).
		expect(h.opened.map((o) => o.image)).toEqual(['img-core']);
		const copy = h.copies[0]!;
		expect(copy.files.get('src/server/feed/feed.ts')).toBe('feed v1');
		expect(copy.files.get('src/screens/feed/feed.tsx')).toBe('feed screen v1');
		// A file the part changed outside its own folders is never copied.
		expect(copy.files.get('src/server/core/farms.ts')).toBe('core v1');
		// The checks ran with the contract covering every joined part's features.
		expect(copy.checksRun.map((c) => [...c.features].sort())).toEqual([['farms', 'feed-log']]);
		// The new save point is the newest joined one, and the build's own copy points at it.
		const core = await getModule(db, scope.projectId, 0, 'core');
		expect(core?.checkpointRef).not.toBe('img-core');
		expect(store.files(core!.checkpointRef!).get('src/server/feed/feed.ts')).toBe('feed v1');
		expect(h.pointed).toEqual([{ image: core!.checkpointRef!, name: 'core + feed merged' }]);
		expect(await status(db, scope, 'feed')).toBe('merged');
		expect(await slotHeld(db, scope, 'feed')).toBe(false);
		// money needed core and feed: it starts now, from the new save point.
		expect(h.dispatched.map((d) => [d.moduleId, [...d.features]])).toEqual([['money', ['sales']]]);
		expect((await getModule(db, scope.projectId, 0, 'money'))?.checkpointRef).toBe(core!.checkpointRef);
		expect(h.notified).toEqual([]); // tasks and money are still building
	});

	test('red: nothing changes in the app; the part goes back to its builder with the failures and one try left', async () => {
		const { db, scope, store } = await seed();
		const h = harness(store, [red('1 fail: the feed total is wrong')]);
		const feedRef = finishedPart(store, 'img-core', 'feed');
		const out = await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: feedRef, block: block(), attempt: 'call-1' }, h.ports);

		expect(out).toMatchObject({ joined: false, triesLeft: MAX_JOIN_TRIES - 1 });
		expect('failures' in out && out.failures).toEqual([{ check: 'behavior-tests', output: '1 fail: the feed total is wrong' }]);
		expect('next' in out && out.next).toContain('call finish_module again');
		// MUTATION: leave the part "not joined" after its first red join and this
		// reads not-merged; its builder could then never try again.
		expect(await status(db, scope, 'feed')).toBe('building');
		expect((await getModule(db, scope.projectId, 0, 'feed'))?.attempts).toBe(1);
		expect(await slotHeld(db, scope, 'feed')).toBe(true);
		expect((await getModule(db, scope.projectId, 0, 'core'))?.checkpointRef).toBe('img-core');
		expect(h.pointed).toEqual([]);
		expect(h.dispatched).toEqual([]); // money still waits on feed
	});

	test('a second red join ends the part "not joined": its slot is freed, a part that needs it never starts, and Caddie is told what is missing once nothing is building', async () => {
		const { db, scope, store } = await seed();
		const h = harness(store, [red('1 fail'), red('still 1 fail'), { passed: true, failures: [] }]);
		await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: finishedPart(store, 'img-core', 'feed', 'v1'), block: block(), attempt: 'call-1' }, h.ports);
		const out = await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: finishedPart(store, 'img-core', 'feed', 'v2'), block: block(), attempt: 'call-2' }, h.ports);

		expect(out).toMatchObject({ joined: false, final: true });
		expect(await status(db, scope, 'feed')).toBe('not-merged');
		expect(await slotHeld(db, scope, 'feed')).toBe(false);
		expect(h.notified).toEqual([]); // tasks is still building

		// tasks joins green: now nothing is building and money can never start.
		const tasks = await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'tasks', moduleRef: finishedPart(store, 'img-core', 'tasks'), block: block(), attempt: 'call-3' }, h.ports);
		expect(tasks).toMatchObject({ joined: true });
		expect(h.dispatched.map((d) => d.moduleId)).toEqual([]);
		expect(await status(db, scope, 'money')).toBe('pending');
		expect(h.notified.length).toBe(1);
		expect(h.notified[0]!.key).toBe(`parts-settled:${RUN}:0`);
		expect(h.notified[0]!.message).toContain('feed');
		expect(h.notified[0]!.message).toContain('money');
	});

	test('a later join starts from the newest save point, so the parts joined before it stay in the app', async () => {
		const { db, scope, store } = await seed();
		const h = harness(store);
		await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: finishedPart(store, 'img-core', 'feed'), block: block(), attempt: 'call-1' }, h.ports);
		const afterFeed = (await getModule(db, scope.projectId, 0, 'core'))!.checkpointRef!;
		// tasks was built from the foundation, before feed joined.
		await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'tasks', moduleRef: finishedPart(store, 'img-core', 'tasks'), block: block(), attempt: 'call-2' }, h.ports);
		// MUTATION: never record the green save point on the foundation row (the
		// newest joined one), and this copy opens from the foundation's first
		// save point: feed's files vanish from the app.
		expect(h.opened.map((o) => o.image)).toEqual(['img-core', afterFeed]);
		const newest = store.files((await getModule(db, scope.projectId, 0, 'core'))!.checkpointRef!);
		expect(newest.get('src/server/feed/feed.ts')).toBe('feed v1');
		expect(newest.get('src/server/tasks/tasks.ts')).toBe('tasks v1');
		expect(h.pointed.at(-1)!.name).toBe('core + feed + tasks merged');
	});

	test('while another part is being joined this one waits its turn; the holder joins it too and sends it its failures', async () => {
		const { db, scope, store } = await seed();
		const h = harness(store, [red('1 fail in feed'), { passed: true, failures: [] }]);
		const feedRef = finishedPart(store, 'img-core', 'feed');
		expect(await acquireIntegrationLock(db, scope.projectId, 0, 'someone-else', Date.now())).toBe(true);
		const queued = await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: feedRef, block: block(), attempt: 'call-1' }, h.ports);
		expect(queued).toMatchObject({ joined: false, queued: true });
		expect(h.opened).toEqual([]);
		expect(await status(db, scope, 'feed')).toBe('passed');
		await releaseIntegrationLock(db, scope.projectId, 0, 'someone-else');

		// tasks finishes next and holds the lock: it joins feed first (design order), then itself.
		const tasks = await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'tasks', moduleRef: finishedPart(store, 'img-core', 'tasks'), block: block(), attempt: 'call-2' }, h.ports);
		expect(tasks).toMatchObject({ joined: true });
		// feed's red join was thrown away: tasks joined into a fresh copy of the foundation.
		expect(h.opened.map((o) => o.image)).toEqual(['img-core', 'img-core']);
		expect(store.files((await getModule(db, scope.projectId, 0, 'core'))!.checkpointRef!).has('src/server/feed/feed.ts')).toBe(false);
		// feed's builder hears about its failures (it ended its turn while queued).
		// MUTATION: only report failures for the caller's own part, and feed is
		// left "not joined" after one try with nobody told.
		expect(await status(db, scope, 'feed')).toBe('building');
		expect(h.dispatched.map((d) => [d.moduleId, d.instanceId])).toEqual([['feed', moduleInstanceId(scope.projectId, 0, 'feed')]]);
		expect(h.dispatched[0]!.message).toContain('1 fail in feed');
		expect(h.dispatched[0]!.message).toContain('finish_module');
	});

	test('when the last part joins, Caddie is told once that every part is in the app', async () => {
		const { db, scope, store } = await seed();
		const h = harness(store);
		await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: finishedPart(store, 'img-core', 'feed'), block: block(), attempt: 'c1' }, h.ports);
		await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'tasks', moduleRef: finishedPart(store, 'img-core', 'tasks'), block: block(), attempt: 'c2' }, h.ports);
		expect(h.notified).toEqual([]);
		const newest = (await getModule(db, scope.projectId, 0, 'core'))!.checkpointRef!;
		await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'money', moduleRef: finishedPart(store, newest, 'money'), block: block(), attempt: 'c3' }, h.ports);
		expect(h.notified.length).toBe(1);
		expect(h.notified[0]!.message).toContain('Every part is joined into the app');
		expect(h.notified[0]!.message).toContain('verify_build');
	});

	test('a replayed finish_module (tool calls can arrive twice) answers from where the part stands and joins nothing again', async () => {
		const { db, scope, store } = await seed();
		const h = harness(store, [{ passed: true, failures: [] }, red('1 fail'), red('1 fail')]);
		await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'tasks', moduleRef: finishedPart(store, 'img-core', 'tasks'), block: block(), attempt: 'c1' }, h.ports);
		const newest = (await getModule(db, scope.projectId, 0, 'core'))!.checkpointRef;
		// MUTATION: drop the replay guard and this second call opens a copy and
		// makes a second save point for a part that is already in the app.
		expect(await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'tasks', moduleRef: 'img-ignored', block: block(), attempt: 'c1' }, h.ports)).toMatchObject({ joined: true });
		expect(h.opened.length).toBe(1);
		expect((await getModule(db, scope.projectId, 0, 'core'))!.checkpointRef).toBe(newest);
		// A part that ended "not joined" stays that way when asked again.
		await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: finishedPart(store, newest!, 'feed', 'v1'), block: block(), attempt: 'c2' }, h.ports);
		await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: finishedPart(store, newest!, 'feed', 'v2'), block: block(), attempt: 'c3' }, h.ports);
		expect(await status(db, scope, 'feed')).toBe('not-merged');
		const opens = h.opened.length;
		expect(await joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId: 'feed', moduleRef: 'img-ignored', block: block(), attempt: 'c3' }, h.ports)).toMatchObject({ joined: false, final: true });
		expect(h.opened.length).toBe(opens);
	});
});

describe('one holder joins several waiting parts in a row', () => {
	/** core plus three parts that each need only core. */
	function threeParts(): ArchitectureBlock {
		return {
			modules: [
				{ id: 'core', plain: 'Farms', dependsOn: [] },
				{ id: 'alpha', plain: 'A', dependsOn: ['core'] },
				{ id: 'beta', plain: 'B', dependsOn: ['core'] },
				{ id: 'gamma', plain: 'C', dependsOn: ['core'] },
			],
			routes: [route('farms.create', 'core', 'farms'), route('a.create', 'alpha', 'a'), route('b.create', 'beta', 'b'), route('c.create', 'gamma', 'c')],
		} as unknown as ArchitectureBlock;
	}

	test('a red part between two green ones never drops the first one or leaks its own files', async () => {
		const { sqlite, db } = migratedDatabase();
		addUser(sqlite, 'alice', 'alice@example.com');
		const ws = await createWorkspace(db, 'alice', { name: 'W' });
		const project = await createProject(db, { workspaceId: ws.id, actorId: 'alice' } as never, { workspaceId: ws.id, name: 'Farm' });
		const scope = await projectScopeForUser(db, 'alice', project.id);
		const now = new Date().toISOString();
		await db.prepare('insert into "build_spend_limits" ("payerId","limitMicros","createdAt","updatedAt") values (?,?,?,?)').bind('pay-1', 40_000_000, now, now).run();
		const store = new Images();
		store.add({ 'src/server/core/farms.ts': 'core v1' }, 'img-core');
		await startAfterFoundation(db, scope, { runId: RUN, block: threeParts(), featureIds: ['farms', 'a', 'b', 'c'], payerId: 'pay-1', foundationRef: 'img-core', dispatch: () => {} });
		const h = harness(store, [{ passed: true, failures: [] }, red('beta breaks the build'), { passed: true, failures: [] }]);
		const join = (moduleId: string, attempt: string) =>
			joinFinishedModule(db, scope, { runId: RUN, buildSeq: 0, moduleId, moduleRef: finishedPart(store, 'img-core', moduleId), block: threeParts(), attempt }, h.ports);

		// alpha and beta finish while someone else holds the lock: both wait.
		expect(await acquireIntegrationLock(db, scope.projectId, 0, 'someone-else', Date.now())).toBe(true);
		expect(await join('alpha', 'c1')).toMatchObject({ queued: true });
		expect(await join('beta', 'c2')).toMatchObject({ queued: true });
		await releaseIntegrationLock(db, scope.projectId, 0, 'someone-else');

		// gamma holds the lock and joins alpha (green), beta (red), then itself (green).
		expect(await join('gamma', 'c3')).toMatchObject({ joined: true });
		const newest = store.files((await getModule(db, scope.projectId, 0, 'core'))!.checkpointRef!);
		// MUTATION: don't move the copy's image forward on a green save point,
		// and beta's rollback reopens the foundation: alpha's files vanish.
		expect(newest.get('src/server/alpha/alpha.ts')).toBe('alpha v1');
		expect(newest.get('src/server/gamma/gamma.ts')).toBe('gamma v1');
		// MUTATION: keep the copy after beta's red join, and beta's files ride into gamma's save point.
		expect(newest.has('src/server/beta/beta.ts')).toBe(false);
		expect(await status(db, scope, 'beta')).toBe('building');
		expect(h.dispatched.map((d) => d.moduleId)).toEqual(['beta']);
		expect(h.pointed.map((p) => p.name)).toEqual(['core + alpha merged', 'core + alpha + gamma merged']);
	});
});
