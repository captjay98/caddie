#!/usr/bin/env bun
/**
 * Plan 9.1 (live finding, 2026-10-20): in a real build the install step
 * crashed with EBADF while writing sql.js's 13.6 MB tarball to /tmp. This
 * proves the fixed step on the real sandbox: the real React scaffold plus
 * sql.js and fake-indexeddb, installed by the product's own runVerifiedInstall
 * (sha512 check, unpack from memory, then the frozen install) on the
 * production base image with production's PATH, then sql.js loading its wasm.
 *
 * Paid: refuses without CADDIE_LIVE_AUTHORIZED=1. One disposable session,
 * every command under a timeout, the session disposed at the end. Sandbox
 * credentials come from the environment or a .dev.vars file (CADDIE_DEV_VARS
 * names it, default ./.dev.vars) and are never printed. The lock is
 * regenerated here (bun install --lockfile-only), so the scaffold's other pins
 * stay exactly as they are.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySandboxPersistence, SandboxDriver } from '../apps/app/src/server/adapters/sandbox.ts';
import { BUILD_RUNTIME_ENV, DEFAULT_BASE_IMAGE } from '../apps/app/src/server/build-sandbox.ts';
import { runVerifiedInstall } from '../apps/app/src/server/verified-install.ts';
import { SCAFFOLD_FILES } from '../stacks/react-hono/scaffold.ts';

const EXTRA: Record<string, string> = { 'sql.js': '1.15.1', 'fake-indexeddb': '6.2.6' };
const TIMEOUT_MS = 10 * 60_000;
const APP_DIR = 'app';

if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error('probe-sandbox-large-package: BLOCKED — a paid sandbox session needs CADDIE_LIVE_AUTHORIZED=1.');
	process.exit(1);
}
const varsPath = process.env.CADDIE_DEV_VARS ?? '.dev.vars';
if (existsSync(varsPath)) {
	for (const line of readFileSync(varsPath, 'utf8').split('\n')) {
		const match = /^([A-Z_a-z][A-Z0-9_a-z]*)=(.*)$/.exec(line);
		if (match && process.env[match[1]] === undefined && match[2].trim() !== '') process.env[match[1]] = match[2];
	}
}
const baseUrl = process.env.CONTREE_BASE_URL ?? '';
const apiToken = process.env.CONTREE_API_TOKEN ?? '';
const platformProjectId = process.env.CONTREE_PROJECT_ID ?? '';
if (!baseUrl || !apiToken || !platformProjectId) {
	console.error('probe-sandbox-large-package: BLOCKED — CONTREE_BASE_URL/CONTREE_API_TOKEN/CONTREE_PROJECT_ID are not set.');
	process.exit(1);
}

// 1. The app: the real scaffold with two more pinned packages, locked here.
const pkg = JSON.parse(SCAFFOLD_FILES['package.json'] ?? '{}') as { dependencies?: Record<string, string> };
pkg.dependencies = { ...pkg.dependencies, ...EXTRA };
const packageJson = `${JSON.stringify(pkg, null, 2)}\n`;
const work = mkdtempSync(join(tmpdir(), 'large-package-probe-'));
let lock = '';
try {
	writeFileSync(join(work, 'package.json'), packageJson);
	writeFileSync(join(work, 'bun.lock'), SCAFFOLD_FILES['bun.lock'] ?? '');
	const locked = Bun.spawnSync([process.execPath, 'install', '--lockfile-only'], { cwd: work, stdout: 'pipe', stderr: 'pipe' });
	if (locked.exitCode !== 0) throw new Error(`bun install --lockfile-only failed: ${locked.stderr.toString().slice(-600)}`);
	lock = readFileSync(join(work, 'bun.lock'), 'utf8');
} finally {
	rmSync(work, { recursive: true, force: true });
}
for (const name of Object.keys(EXTRA)) {
	if (!lock.includes(`"${name}@${EXTRA[name]}"`)) throw new Error(`the regenerated lock does not pin ${name}@${EXTRA[name]}`);
}
const files: Record<string, string> = { ...SCAFFOLD_FILES, 'package.json': packageJson, 'bun.lock': lock };

// 2. One disposable session on the production base image.
const driver = new SandboxDriver(
	{
		contree: { baseUrl, apiToken, platformProjectId },
		quotas: { maxCommandTimeoutMs: TIMEOUT_MS, maxOutputBytes: 5 * 1024 * 1024, maxUploadBytes: 20 * 1024 * 1024 },
		workspaceRoot: '/workspace',
		pollIntervalMs: 250,
		dispatchTimeoutMs: 30_000,
	},
	new InMemorySandboxPersistence(),
);
const RUN_ID = `large-package-probe-${Date.now()}`;
const { sessionId } = await driver.ensureSession({ sessionKey: `session:${RUN_ID}`, image: DEFAULT_BASE_IMAGE, projectId: 'caddie-live-probe', runId: RUN_ID });
let ok = false;
try {
	console.log(`session ${sessionId} on ${DEFAULT_BASE_IMAGE}: ${Object.keys(files).length} files, plus ${Object.entries(EXTRA).map(([n, v]) => `${n}@${v}`).join(', ')}`);
	await driver.uploadFiles(
		sessionId,
		Object.entries(files).map(([path, content]) => ({ path: `${APP_DIR}/${path}`, contentBase64: Buffer.from(content, 'utf8').toString('base64') })),
	);
	const startedAt = Date.now();
	const install = await runVerifiedInstall(driver, { sessionId, cwd: APP_DIR, env: BUILD_RUNTIME_ENV, operationKey: `${RUN_ID}:install`, timeoutMs: TIMEOUT_MS });
	console.log(`install: exit ${install.exitCode} in ${Date.now() - startedAt} ms`);
	if (install.stdout.trim()) console.log(`  stdout: ${install.stdout.trim().slice(-1500)}`);
	if (install.stderr.trim()) console.log(`  stderr: ${install.stderr.trim().slice(-1500)}`);

	// 3. Receipts on the real filesystem, then sql.js actually loading its wasm.
	const sqlJs = await driver.statFile(sessionId, `${APP_DIR}/node_modules/sql.js/package.json`).catch(() => null);
	const idb = await driver.statFile(sessionId, `${APP_DIR}/node_modules/fake-indexeddb/package.json`).catch(() => null);
	console.log(`  node_modules/sql.js: ${sqlJs?.isFile ? 'present' : 'MISSING'}; node_modules/fake-indexeddb: ${idb?.isFile ? 'present' : 'MISSING'}`);
	const smoke = await driver.execute({
		sessionId,
		cwd: APP_DIR,
		env: BUILD_RUNTIME_ENV,
		operationKey: `${RUN_ID}:smoke`,
		timeoutMs: 120_000,
		command: `bun -e "require('sql.js')().then((SQL) => { const db = new SQL.Database(); db.run('create table t (x)'); db.run('insert into t values (1)'); console.log('sql.js ok', db.exec('select count(*) from t')[0].values[0][0]); })"`,
	});
	console.log(`smoke: exit ${smoke.exitCode}: ${smoke.stdout.trim().slice(-300)}${smoke.stderr.trim() ? ` | stderr: ${smoke.stderr.trim().slice(-300)}` : ''}`);
	ok = install.exitCode === 0 && Boolean(sqlJs?.isFile) && Boolean(idb?.isFile) && smoke.exitCode === 0 && smoke.stdout.includes('sql.js ok 1');
} finally {
	await driver.dispose(sessionId);
}
console.log(`\n=== ${ok ? 'PASS' : 'FAIL'} ===`);
process.exit(ok ? 0 : 1);
