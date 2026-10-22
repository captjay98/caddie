import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	InMemorySandboxPersistence,
	SandboxDriver,
} from '../apps/app/src/server/adapters/sandbox.ts';
import { ContreeClient } from '../apps/app/src/server/adapters/contree.ts';
import { SandboxStub } from './fixtures/sandbox-stub.ts';
import { areaFor, buildManifest, diffAgainstManifest } from '../apps/app/src/server/part-manifests.ts';
import type { ArchitectureBlock } from '@caddie/contracts';
import { snapshotReadPort, snapshotWritePort, type ImageInspect } from '../apps/app/src/server/part-snapshot.ts';

/**
 * Lane 5, part D / review item 5: the REAL snapshot ports in part-snapshot.ts,
 * reading a COMMITTED image through Contree's inspect API — never a command.
 *
 * Proven two ways:
 *   1. END TO END against the real SandboxDriver wired to the local contree
 *      REST stub: a file a build changes through `sandbox_exec` OUTSIDE its
 *      area is caught by the snapshot diff — because the manifest is read from
 *      the committed image, not from what tool the model called.
 *   2. The 300-file manifest timing through the ports over the stub (S2).
 *
 * LOCAL VERIFIED for the driver↔contree transport (the same stub the P04/P05
 * contract suite uses); never evidence about the live service.
 */

const TOKEN = 'stub-token-local-only-not-a-secret';
const IMAGE_TAG = 'tag:base:1';
const WORKSPACE_ROOT = '/workspace';

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

describe('part-snapshot — real ports over the driver + contree stub', () => {
	let stub: SandboxStub;

	beforeAll(async () => {
		stub = new SandboxStub({ expectedToken: TOKEN });
		stub.seedImage(IMAGE_TAG);
		await stub.start();
	});
	afterAll(async () => {
		await stub.stop();
	});

	function makeDriver(): { driver: SandboxDriver; inspect: ImageInspect } {
		const driver = new SandboxDriver(
			{
				contree: { baseUrl: stub.url, apiToken: TOKEN, platformProjectId: 'platform-project-test' },
				quotas: { maxUploadBytes: 1024 * 1024, maxOutputBytes: 64 * 1024, maxCommandTimeoutMs: 30_000 },
				workspaceRoot: WORKSPACE_ROOT,
				pollIntervalMs: 5,
				dispatchTimeoutMs: 2_000,
			},
			new InMemorySandboxPersistence(),
		);
		// The READ port reads committed images straight through Contree's inspect
		// API (what the driver uses internally); a ContreeClient at the same stub
		// IS that API.
		const inspect = new ContreeClient({ baseUrl: stub.url, apiToken: TOKEN, platformProjectId: 'platform-project-test' }) as unknown as ImageInspect;
		return { driver, inspect };
	}

	test('a file a script changed through sandbox_exec OUTSIDE the backend area is caught end to end', async () => {
		const { driver, inspect } = makeDriver();
		const projectId = 'proj-e2e';
		const { sessionId } = await driver.ensureSession({ sessionKey: 'session:e2e', image: IMAGE_TAG, projectId, runId: 'run-e2e' });

		// Seed the start-of-part source: one backend file, one frontend file.
		await driver.uploadFiles(sessionId, [
			{ path: 'src/server.ts', contentBase64: Buffer.from('export const api = 1;', 'utf8').toString('base64') },
			{ path: 'src/App.tsx', contentBase64: Buffer.from('export const App = () => null;', 'utf8').toString('base64') },
		]);
		const startImage = await sessionImage(driver, sessionId);
		const root = `${WORKSPACE_ROOT}/${projectId}`;
		const start = await buildManifest(snapshotReadPort(inspect, startImage, root));
		expect(start.files.map((f) => f.path).sort()).toEqual(['src/App.tsx', 'src/server.ts']);

		// A build SCRIPT — not a write tool — rewrites a FRONTEND file via a shell
		// command (exactly what `sandbox_exec` runs). The stub commits the file
		// the command leaves behind (behavior.writes), modelling a script that
		// wrote outside its area; the committed image advances.
		stub.setBehavior('generate-ui', {
			exitCode: 0,
			writes: { [`${root}/src/App.tsx`]: 'export const App = () => "changed by a script";' },
		});
		await driver.execute({
			sessionId,
			command: `node scripts/generate-ui.mjs`,
			operationKey: 'op-script-edit',
			timeoutMs: 10_000,
		});
		const currentImage = await sessionImage(driver, sessionId);
		expect(currentImage).not.toBe(startImage); // the script committed a new image

		// The part is BACKEND; the diff reads the committed image through inspect
		// and reports the frontend change as out of area — command origin or not.
		const current = await buildManifest(snapshotReadPort(inspect, currentImage, root));
		const out = diffAgainstManifest(areaFor(SMALL_BLOCK, 'backend'), start, current);
		expect(out.map((c) => `${c.path}:${c.kind}`)).toEqual(['src/App.tsx:modified']);

		// The write port restores it from the start image, through the driver's
		// batched upload (no command).
		const writePort = snapshotWritePort(inspect, startImage, driver, sessionId, root);
		const restored = await writePort.readFromStart('src/App.tsx');
		expect(Buffer.from(restored, 'base64').toString('utf8')).toBe('export const App = () => null;');
		await writePort.writeBatch([{ path: 'src/App.tsx', contentBase64: restored }]);
		const afterImage = await sessionImage(driver, sessionId);
		const afterRestore = await buildManifest(snapshotReadPort(inspect, afterImage, root));
		expect(diffAgainstManifest(areaFor(SMALL_BLOCK, 'backend'), start, afterRestore)).toEqual([]);
	});

	test('S2: a 300-file manifest through the ports over the stub', async () => {
		const { inspect } = makeDriver();
		// Seed a committed image with 300 source files directly (a finished build).
		const files: Record<string, string> = {};
		for (let i = 0; i < 150; i++) files[`${WORKSPACE_ROOT}/proj-300/src/server/mod${i % 10}/file${i}.ts`] = `export const v${i} = ${i};`;
		for (let i = 0; i < 150; i++) files[`${WORKSPACE_ROOT}/proj-300/src/screens/mod${i % 10}/Screen${i}.tsx`] = `export const S${i} = () => ${i};`;
		const image = stub.seedImageWithFiles(files);
		const root = `${WORKSPACE_ROOT}/proj-300`;
		const t0 = performance.now();
		const manifest = await buildManifest(snapshotReadPort(inspect, image, root));
		const elapsed = performance.now() - t0;
		expect(manifest.files.length).toBe(300);
		// eslint-disable-next-line no-console
		console.log(`S2 (ports over stub): manifest of ${manifest.files.length} files in ${elapsed.toFixed(1)}ms`);
	});
});

/** Read a session's current committed image from the driver's persistence. */
async function sessionImage(driver: SandboxDriver, sessionId: string): Promise<string> {
	// The driver exposes no getter; read the persisted record it keeps.
	const persistence = (driver as unknown as { persistence: { load(key: string): Promise<{ image: string | null } | null> } }).persistence;
	const record = await persistence.load(`session:${sessionId}`);
	if (!record?.image) throw new Error('no session image');
	return record.image;
}
