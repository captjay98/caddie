#!/usr/bin/env bun
/**
 * Track 3 decision input (2026-10-19): what the build sandbox runs on.
 *
 *   CADDIE_LIVE_AUTHORIZED=1 bun scripts/probe-sandbox-host.ts
 *
 * ONE disposable instance on the production base image (no image is kept),
 * about ten seconds. It reports the CPU type (Google publishes Android's
 * build tools for Linux on x86-64 only), cores, memory, disk, the C library,
 * whether the Android SDK, Flutter and Gradle download hosts answer, and the
 * account's own limits (GET /whoami), plus the operation's raw resource
 * fields. Contree's docs call those diagnostic only, with units unconfirmed;
 * billing records are the invoice truth.
 *
 * Paid: refuses without CADDIE_LIVE_AUTHORIZED=1. Values from .dev.vars are
 * never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContreeClient } from '../apps/app/src/server/adapters/contree.ts';
import { DEFAULT_BASE_IMAGE } from '../apps/app/src/server/build-sandbox.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error('probe-sandbox-host: BLOCKED — a live sandbox run needs CADDIE_LIVE_AUTHORIZED=1 (owner-approved).');
	process.exit(1);
}

{
	const devVarsPath = join(REPO_ROOT, '.dev.vars');
	if (existsSync(devVarsPath)) {
		for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
			const match = /^([A-Z_a-z][A-Z0-9_a-z]*)=(.*)$/.exec(line);
			if (match && process.env[match[1]!] === undefined && match[2]!.trim() !== '') process.env[match[1]!] = match[2];
		}
	}
}

const BASE_URL = process.env.CONTREE_BASE_URL ?? '';
const API_TOKEN = process.env.CONTREE_API_TOKEN ?? '';
const PROJECT_ID = process.env.CONTREE_PROJECT_ID ?? '';
const IMAGE = process.env.CONTREE_IMAGE ?? DEFAULT_BASE_IMAGE;
if (!BASE_URL || !API_TOKEN || !PROJECT_ID) {
	console.error('probe-sandbox-host: BLOCKED — CONTREE_BASE_URL/CONTREE_API_TOKEN/CONTREE_PROJECT_ID are not set (env and .dev.vars).');
	process.exit(1);
}

const COMMAND = [
	'set +e',
	'echo "arch=$(uname -m)"',
	'echo "kernel=$(uname -sr)"',
	'echo "cpus=$(nproc)"',
	"lscpu 2>/dev/null | grep -E '^(Architecture|Vendor ID|Model name|CPU\\(s\\)|Thread\\(s\\) per core|Hypervisor vendor):' | sed 's/^/lscpu: /'",
	"grep -m1 -E '^model name' /proc/cpuinfo | sed 's/^/cpuinfo: /'",
	"awk '/^(MemTotal|MemAvailable):/ {printf \"mem: %s %d MiB\\n\", $1, $2/1024}' /proc/meminfo",
	"df -h / /tmp 2>/dev/null | sed 's/^/disk: /'",
	'. /etc/os-release 2>/dev/null && echo "os=$PRETTY_NAME"',
	"ldd --version 2>&1 | head -1 | sed 's/^/libc: /'",
	"for t in java flutter sdkmanager; do printf 'tool %s: ' \"$t\"; command -v \"$t\" || echo none; done",
	"for u in https://dl.google.com/android/repository/repository2-3.xml https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json https://services.gradle.org/distributions/; do printf 'net %s -> ' \"$u\"; curl -s -o /dev/null -I -w '%{http_code} in %{time_total}s\\n' --max-time 10 \"$u\" || echo 'no answer'; done",
].join('\n');

async function raw(path: string): Promise<Record<string, unknown> | null> {
	const response = await fetch(`${BASE_URL}/v1${path}`, { headers: { authorization: `Bearer ${API_TOKEN}`, project: PROJECT_ID } });
	if (!response.ok) {
		console.log(`raw ${path.split('/')[1]}: HTTP ${response.status}`);
		return null;
	}
	return (await response.json()) as Record<string, unknown>;
}

const client = new ContreeClient({ baseUrl: BASE_URL, apiToken: API_TOKEN, platformProjectId: PROJECT_ID });

const who = await raw('/whoami');
console.log(`account limits (GET /whoami): ${JSON.stringify(who?.['limits'] ?? null)}`);

const image = await client.resolveImageRef(IMAGE);
console.log(`image ${IMAGE} -> ${image}`);
const started = Date.now();
const { operationId } = await client.spawnInstance({ image, command: COMMAND, shell: true, disposable: true, timeoutSec: 60, truncateOutputAt: 64 * 1024 });
console.log(`operation ${operationId} dispatched (disposable: no image kept)`);

let op = await client.getOperation(operationId);
while (op && (op.state === 'PENDING' || op.state === 'ASSIGNED' || op.state === 'EXECUTING') && Date.now() - started < 120_000) {
	await Bun.sleep(1500);
	op = await client.getOperation(operationId);
}
if (!op) {
	console.log('operation not found');
	process.exit(1);
}
console.log(`state=${op.state} exit=${op.exitCode} duration=${op.durationMs} ms wall=${Date.now() - started} ms truncated=${op.outputTruncated}`);
console.log('--- stdout');
console.log(op.stdout.trim());
if (op.stderr.trim()) console.log(`--- stderr\n${op.stderr.trim().slice(-1500)}`);

const detail = await raw(`/operations/${encodeURIComponent(operationId)}`);
const resources = ((detail?.['metadata'] as Record<string, unknown> | undefined)?.['result'] as Record<string, unknown> | undefined)?.['resources'];
console.log(`--- raw resources (diagnostic only; units unconfirmed): ${JSON.stringify(resources ?? null)}`);
process.exit(op.state === 'SUCCEEDED' && op.exitCode === 0 ? 0 : 1);
