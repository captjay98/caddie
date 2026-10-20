#!/usr/bin/env bun
/** Phase 9.2: one owner-authorized disposable Flutter session, using product commands. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { InMemorySandboxPersistence, SandboxDriver } from '../apps/app/src/server/adapters/sandbox.ts';
import { DEFAULT_FLUTTER_IMAGE, FLUTTER_RUNTIME_ENV } from '../apps/app/src/server/build-sandbox.ts';
import { hostCheckCommands, testsPassed } from '../apps/app/src/server/host-checks.ts';
import { runVerifiedInstall } from '../apps/app/src/server/verified-install.ts';
import { buildAndroidPackage } from '../apps/app/src/server/android-app.ts';
import { FLUTTER_SCAFFOLD_FILES } from '../stacks/flutter/scaffold.ts';

if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error('BLOCKED: set CADDIE_LIVE_AUTHORIZED=1 only with owner authorization for one paid sandbox session.');
	process.exit(1);
}
const varsPath = process.env.CADDIE_DEV_VARS ?? '.dev.vars';
if (existsSync(varsPath)) {
	for (const line of readFileSync(varsPath, 'utf8').split('\n')) {
		const match = /^([A-Z_a-z][A-Z0-9_a-z]*)=(.*)$/.exec(line);
		if (match && process.env[match[1]] === undefined && match[2].trim()) process.env[match[1]] = match[2];
	}
}
const { CONTREE_BASE_URL: baseUrl, CONTREE_API_TOKEN: apiToken, CONTREE_PROJECT_ID: platformProjectId } = process.env;
if (!baseUrl || !apiToken || !platformProjectId) {
	console.error('BLOCKED: sandbox credentials are missing.');
	process.exit(1);
}
const image = process.env.CONTREE_FLUTTER_IMAGE || DEFAULT_FLUTTER_IMAGE;
const projectId = 'caddie-flutter-live-probe';
const runId = `flutter-probe-${Date.now()}`;
const driver = new SandboxDriver({ contree: { baseUrl, apiToken, platformProjectId }, quotas: {
	maxCommandTimeoutMs: 10 * 60_000, maxOutputBytes: 5 * 1024 * 1024, maxUploadBytes: 20 * 1024 * 1024,
}, workspaceRoot: '/workspace', pollIntervalMs: 500, dispatchTimeoutMs: 30_000 }, new InMemorySandboxPersistence());
const { sessionId } = await driver.ensureSession({ sessionKey: `session:${runId}`, image, projectId, runId });
try {
	console.log(`LIVE sandbox session ${sessionId}; image ${image}`);
	const files = { ...FLUTTER_SCAFFOLD_FILES,
		'test/app/probe_test.dart': "import 'package:flutter_test/flutter_test.dart';\nvoid main() { test('phase 9.2 probe', () => expect(1 + 1, 2)); }\n",
	};
	await driver.uploadFiles(sessionId, Object.entries(files).map(([path, content]) => ({ path: `app/${path}`, contentBase64: Buffer.from(content).toString('base64') })));
	for (const check of hostCheckCommands('flutter')) {
		const started = Date.now();
		const operationKey = `${runId}:${check.check}`;
		const result = check.check === 'dependencies'
			? await runVerifiedInstall(driver, { sessionId, cwd: 'app', env: FLUTTER_RUNTIME_ENV, operationKey, timeoutMs: check.timeoutMs })
			: await driver.execute({ sessionId, cwd: 'app', env: FLUTTER_RUNTIME_ENV, operationKey, command: check.command, timeoutMs: check.timeoutMs });
		const receipt = await driver.getOperationReceipt(operationKey);
		console.log(`${check.check}: exit ${result.exitCode}; ${Date.now() - started} ms; receipt ${receipt?.state}; image ${receipt?.resultImage}`);
		if (result.exitCode !== 0 || !receipt || receipt.state !== 'succeeded' || receipt.projectId !== projectId || receipt.runId !== runId || !receipt.resultImage || receipt.timedOut || receipt.outputTruncated) {
			throw new Error(`${check.check} failed: ${(result.stdout + result.stderr).slice(-3000)}`);
		}
		if (check.check === 'behavior-tests' && !testsPassed(result.stdout + '\n' + result.stderr)) throw new Error('No passing test summary.');
	}
	for (const path of ['app/build/web/main.dart.js', 'app/dist/server.js']) {
		const file = await driver.statFile(sessionId, path);
		if (!file.isFile || file.size === null || file.size <= 0) throw new Error(`Missing build artifact: ${path}`);
		console.log(`${path}: ${file.size} bytes`);
	}
	// This address is embedded only. No deployment or request to the published app occurs.
	const native = await buildAndroidPackage(driver, { origin: 'https://caddie.jamalibrahim.dev', projectId, runId, sessionId, root: 'app', operationKey: `${runId}:apk`, env: FLUTTER_RUNTIME_ENV });
	if (!native.apk) throw new Error(`${native.message}\n${native.evidence.slice(-3000)}`);
	const hash = Buffer.from(await crypto.subtle.digest('SHA-256', native.apk.slice().buffer as ArrayBuffer)).toString('hex');
	console.log(`APK: ${native.apk.byteLength} bytes; SHA-256 ${hash}; image ${native.image}; API base ${native.apiBase}`);
	const outputIndex = process.argv.indexOf('--apk-output');
	if (outputIndex >= 0) {
		const path = process.argv[outputIndex + 1];
		if (!path || !path.startsWith('/')) throw new Error('--apk-output requires an absolute path.');
		writeFileSync(path, native.apk);
		console.log(`Saved APK for device verification: ${path}`);
	}
	console.log('LIVE VERIFIED: real sandbox scaffold setup/install, probe test, web/server build, receipt-checked release APK. Device install and deployed API remain unverified.');
} finally {
	await driver.dispose(sessionId);
	console.log('Disposed sandbox session.');
}
