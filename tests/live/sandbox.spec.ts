import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	InMemorySandboxPersistence,
	SandboxDriver,
	SandboxError,
} from '../../apps/app/src/server/adapters/sandbox.ts';

/**
 * P04/P05 live sandbox probe — the REAL contree (Nebius TF Sandboxes) service.
 *
 * Honesty rules (AGENTS.md):
 *   - BLOCKED without owner-provided credentials and explicit live
 *     authorization: CONTREE_BASE_URL/CONTREE_API_TOKEN/CONTREE_PROJECT_ID in
 *     the repo-root .dev.vars (gitignored, never printed) AND
 *     CADDIE_LIVE_AUTHORIZED=1 in the invoking environment. The spec fails
 *     clearly in both cases — it never silently passes.
 *   - What runs here drives the SAME driver path the agent tools use
 *     (SandboxDriver.ensureSession → execute → writeFile → readFile →
 *     stat/readdir) against the real REST surface. Receipts (operation
 *     uuids, image uuids, durations) are printed to stdout.
 *   - Only tests that actually completed against the real service count as
 *     LIVE VERIFIED; any failure surfaces the real HTTP error.
 *
 * Sessions in contree are OUR bookkeeping over content-addressed image
 * chains: this probe creates one real image chain under the probe's workspace
 * directory. Instances run inside the owner's standing sandbox envelope
 * (free beta); no other external effect is performed.
 */

// Load .dev.vars (gitignored; values never printed) so a direct `bun test`
// invocation sees the same owner inputs verify-packet loads. Real env wins.
{
	const devVarsPath = join(import.meta.dir, '..', '..', '.dev.vars');
	if (existsSync(devVarsPath)) {
		for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
			const match = /^([A-Z_a-z][A-Z0-9_a-z]*)=(.*)$/.exec(line);
			if (match && process.env[match[1]] === undefined && match[2].trim() !== '') {
				process.env[match[1]] = match[2];
			}
		}
	}
}

const LIVE_AUTHORIZED = process.env.CADDIE_LIVE_AUTHORIZED === '1';
const BASE_URL = process.env.CONTREE_BASE_URL ?? '';
const API_TOKEN = process.env.CONTREE_API_TOKEN ?? '';
const PROJECT_ID = process.env.CONTREE_PROJECT_ID ?? '';
const IMAGE = process.env.CONTREE_IMAGE ?? 'tag:tt-base:1';

const LIVE_PROJECT = 'caddie-live-probe';
const LIVE_RUN = `probe-${Date.now()}`;
const SESSION_KEY = `session:${LIVE_RUN}`;

function requireLive(): void {
	if (!LIVE_AUTHORIZED || !BASE_URL || !API_TOKEN || !PROJECT_ID) {
		throw new Error(
			'BLOCKED: the live sandbox probe requires CADDIE_LIVE_AUTHORIZED=1 and CONTREE_BASE_URL/' +
				'CONTREE_API_TOKEN/CONTREE_PROJECT_ID (repo-root .dev.vars). This suite never runs against mocks.',
		);
	}
}

function receipt(label: string, detail: Record<string, unknown>): void {
	console.log(`[live-receipt] ${label}: ${JSON.stringify(detail)}`);
}

function makeDriver(): { driver: SandboxDriver; persistence: InMemorySandboxPersistence } {
	const persistence = new InMemorySandboxPersistence();
	const driver = new SandboxDriver(
		{
			contree: { baseUrl: BASE_URL, apiToken: API_TOKEN, platformProjectId: PROJECT_ID },
			quotas: {
				maxCommandTimeoutMs: 15 * 60_000,
				maxOutputBytes: 5 * 1024 * 1024,
				maxUploadBytes: 20 * 1024 * 1024,
			},
			workspaceRoot: '/workspace',
			pollIntervalMs: 250,
			dispatchTimeoutMs: 30_000,
		},
		persistence,
	);
	return { driver, persistence };
}

describe('P04/P05 live sandbox probe (BLOCKED without credentials)', () => {
	test('live authorization is explicit', () => {
		requireLive();
		expect(LIVE_AUTHORIZED).toBe(true);
	});

	test('ensureSession → execute → writeFile → readFile → stat/readdir against the REAL service', async () => {
		requireLive();
		const { driver, persistence } = makeDriver();
		const t0 = Date.now();

		// 1. Session on first use: one real bootstrap run commits the workspace
		//    directory and the binding (key → current image) is persisted.
		const created = await driver.ensureSession({
			sessionKey: SESSION_KEY,
			image: IMAGE,
			projectId: LIVE_PROJECT,
			runId: LIVE_RUN,
		});
		const bootstrappedAt = Date.now();
		const record = await persistence.load(`session:${SESSION_KEY}`);
		expect(record?.state).toBe('active');
		expect(record?.image).toBeTruthy();
		receipt('ensureSession', {
			sessionKey: SESSION_KEY,
			sessionId: created.sessionId,
			currentImage: record?.image,
			durationMs: bootstrappedAt - t0,
		});

		// 2. Reuse: a FRESH driver over the SAME persistence adopts the binding
		//    (isolate-restart semantics) without a second bootstrap.
		const reused = await makeDriver().driver.ensureSession({
			sessionKey: SESSION_KEY,
			image: IMAGE,
			projectId: LIVE_PROJECT,
			runId: LIVE_RUN,
		});
		expect(reused.sessionId).toBe(created.sessionId);
		const recordAfterReuse = await persistence.load(`session:${SESSION_KEY}`);
		expect(recordAfterReuse?.image).toBe(record?.image);
		receipt('ensureSession-reuse', { adopted: true, imageUnchanged: true });

		// 3. Execute a real command.
		const executedAt = Date.now();
		const execution = await driver.execute({
			sessionId: created.sessionId,
			command: 'echo live-sandbox-ok',
			operationKey: `live-exec:${LIVE_RUN}`,
			timeoutMs: 120_000,
		});
		expect(execution.exitCode).toBe(0);
		expect(execution.stdout.trim()).toBe('live-sandbox-ok');
		receipt('execute', {
			remoteId: execution.remoteId,
			command: 'echo live-sandbox-ok',
			stdout: execution.stdout.trim(),
			durationMs: Date.now() - executedAt,
		});

		// 4. Write a file and read it back through the inspect endpoint.
		const writtenAt = Date.now();
		const content = `caddie live probe ${new Date().toISOString()}\n`;
		await driver.writeFile(created.sessionId, 'probe/live.txt', Buffer.from(content, 'utf8').toString('base64'));
		const writeMs = Date.now() - writtenAt;
		const read = await driver.readFile(created.sessionId, 'probe/live.txt');
		expect(Buffer.from(read.contentBase64, 'base64').toString('utf8')).toBe(content);
		receipt('write+readFile', { path: 'probe/live.txt', bytes: read.size, writeMs, readOk: true });

		// 5. Stat/readdir fidelity on the real filesystem.
		const fileStat = await driver.statFile(created.sessionId, 'probe/live.txt');
		expect(fileStat.isFile).toBe(true);
		expect(fileStat.size).toBe(content.length);
		const entries = await driver.listDir(created.sessionId, 'probe');
		expect(entries).toContain('live.txt');
		receipt('stat/readdir', { size: fileStat.size, entries });

		// 6. Injection safety ON THE REAL SERVICE: a hostile path must land as
		//    inert file paths — never execute.
		const injectionPath = `y'; echo pwned > /tmp/caddie-injection-check; echo '`;
		await driver.mkdir(created.sessionId, injectionPath, { recursive: true });
		const injectionCheck = await driver.execute({
			sessionId: created.sessionId,
			command: 'test -f /tmp/caddie-injection-check && echo PWNED || echo clean',
			operationKey: `live-injection:${LIVE_RUN}`,
			timeoutMs: 120_000,
		});
		expect(injectionCheck.exitCode).toBe(0);
		expect(injectionCheck.stdout.trim()).toBe('clean');
		receipt('injection-check', { markerAbsent: true, stdout: injectionCheck.stdout.trim() });

		// 7. Missing file is a typed 404.
		let missingCode: string | null = null;
		try {
			await driver.readFile(created.sessionId, 'probe/never-written.txt');
		} catch (error) {
			missingCode = error instanceof SandboxError ? error.code : null;
		}
		expect(missingCode).toBe('FILE_NOT_FOUND');

		// Local truth only: the binding is disposed; the remote image chain
		// remains (content-addressed, inside the standing beta envelope).
		await driver.dispose(created.sessionId);
		receipt('dispose', { localBindingDisposed: true });
	}, 300_000);
});
