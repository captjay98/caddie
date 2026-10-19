#!/usr/bin/env bun
/**
 * Track 3 decision input (2026-10-19): can Caddie get an APK-sized file out of
 * the build sandbox?
 *
 *   CADDIE_LIVE_AUTHORIZED=1 bun scripts/probe-sandbox-download.ts
 *
 * ONE non-disposable run on the production base image writes two files of
 * random (incompressible) bytes: 16,000,000 bytes (a release APK for one phone
 * type is 16.0 MB) and 48,000,000 bytes (roughly an APK for all three phone
 * types). Each is then read back through ContreeClient.inspectDownload, the
 * call the product's SandboxDriver.readFile makes, and its sha256 and size are
 * compared with what the sandbox computed.
 *
 * Paid: refuses without CADDIE_LIVE_AUTHORIZED=1. Prints no credential values.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContreeClient } from '../apps/app/src/server/adapters/contree.ts';
import { DEFAULT_BASE_IMAGE } from '../apps/app/src/server/build-sandbox.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error('probe-sandbox-download: BLOCKED — a live sandbox run needs CADDIE_LIVE_AUTHORIZED=1 (owner-approved).');
	process.exit(1);
}
const env: Record<string, string> = {};
if (existsSync(join(ROOT, '.dev.vars'))) {
	for (const line of readFileSync(join(ROOT, '.dev.vars'), 'utf8').split('\n')) {
		const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
		if (match) env[match[1]!] = match[2]!;
	}
}
const value = (key: string) => process.env[key] ?? env[key] ?? '';
if (!value('CONTREE_BASE_URL') || !value('CONTREE_API_TOKEN') || !value('CONTREE_PROJECT_ID')) {
	console.error('probe-sandbox-download: BLOCKED — CONTREE_BASE_URL/CONTREE_API_TOKEN/CONTREE_PROJECT_ID are not set.');
	process.exit(1);
}
const client = new ContreeClient({ baseUrl: value('CONTREE_BASE_URL'), apiToken: value('CONTREE_API_TOKEN'), platformProjectId: value('CONTREE_PROJECT_ID') });

const FILES = [
	{ path: '/root/probe-16mb.bin', bytes: 16_000_000 },
	{ path: '/root/probe-48mb.bin', bytes: 48_000_000 },
];
const command = ['set -eu', ...FILES.map((f) => `head -c ${f.bytes} /dev/urandom > ${f.path} && sha256sum ${f.path}`)].join('\n');

const image = await client.resolveImageRef(DEFAULT_BASE_IMAGE);
const { operationId } = await client.spawnInstance({ image, command, shell: true, disposable: false, timeoutSec: 120 });
let op = await client.getOperation(operationId);
while (op && ['PENDING', 'ASSIGNED', 'EXECUTING'].includes(op.state)) {
	await Bun.sleep(1500);
	op = await client.getOperation(operationId);
}
if (!op || op.state !== 'SUCCEEDED' || op.exitCode !== 0 || !op.resultImage) {
	console.log(`write run failed: ${op?.state} exit=${op?.exitCode}\n${op?.stderr.slice(-800)}`);
	process.exit(1);
}
console.log(`write run ${op.durationMs} ms, image ${op.resultImage}`);
const expected = new Map(op.stdout.trim().split('\n').map((line) => { const [hash, path] = line.split(/\s+/); return [path!, hash!]; }));

let ok = true;
for (const file of FILES) {
	const started = performance.now();
	try {
		const bytes = await client.inspectDownload(op.resultImage, file.path);
		const ms = Math.round(performance.now() - started);
		if (bytes === null) {
			console.log(`${file.path}: 404`);
			ok = false;
			continue;
		}
		const hash = createHash('sha256').update(bytes).digest('hex');
		const match = hash === expected.get(file.path) && bytes.byteLength === file.bytes;
		ok &&= match;
		console.log(`${file.path}: ${bytes.byteLength} bytes in ${ms} ms (${((bytes.byteLength / 1e6) / (ms / 1000)).toFixed(1)} MB/s), sha256 ${match ? 'MATCHES' : 'DIFFERS'}`);
	} catch (error) {
		ok = false;
		console.log(`${file.path}: FAILED after ${Math.round(performance.now() - started)} ms: ${error instanceof Error ? error.message : String(error)}`);
	}
}
process.exit(ok ? 0 : 1);
