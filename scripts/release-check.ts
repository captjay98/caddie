#!/usr/bin/env bun
/**
 * Release readiness check (P17) — the local gate before ANY deployment
 * request. Runs every locally-verifiable check and reports each honestly;
 * missing credentials/capabilities are BLOCKED, never PASS, and a present
 * credential with no recorded live run is PROVISIONED (also never PASS).
 *
 * Deployment itself requires concrete owner authorization (a human decision)
 * and is never performed by this script.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_RECEIPTS_PATH, readLiveReceipts } from './live-receipts.ts';
import { PACKET_KEYS, PACKET_MAP } from './packet-list.ts';

const REPO = import.meta.dir === undefined ? process.cwd() : join(import.meta.dir, '..');

// Load .dev.vars into the environment so credential-gated checks reflect the
// actual provisioning state (gitignored; values never printed).
const devVarsPath = join(REPO, '.dev.vars');
if (existsSync(devVarsPath)) {
	for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
		const match = /^([A-Z_a-z][A-Z0-9_a-z]*)=(.*)$/.exec(line);
		if (match && process.env[match[1]] === undefined && match[2].trim() !== '') {
			process.env[match[1]] = match[2];
		}
	}
}

interface Check {
	name: string;
	/**
	 * PASS — verified here, now. FAIL — broken. BLOCKED — a prerequisite is
	 * absent. PROVISIONED — the credential exists but no live run is recorded:
	 * provisioning is not proof, so it never counts toward PASS.
	 */
	status: 'PASS' | 'FAIL' | 'BLOCKED' | 'PROVISIONED';
	detail: string;
}

const checks: Check[] = [];

function run(name: string, argv: string[]): void {
	const proc = Bun.spawnSync(argv, { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
	const output = `${proc.stdout}${proc.stderr}`.trim();
	checks.push({
		name,
		status: proc.exitCode === 0 ? 'PASS' : 'FAIL',
		detail: proc.exitCode === 0 ? 'exit 0' : output.split('\n').slice(-4).join('\n'),
	});
}

// 1. Typecheck
run('typecheck', ['bun', 'run', 'typecheck']);

// 2. Build (composition included)
run('build', ['bun', 'run', 'build']);

// 3. Every packet's locally-mapped tests (the table itself lives in
// scripts/packet-list.ts: no literal list here to drift out of date)
for (const packet of PACKET_KEYS) {
	const proc = Bun.spawnSync(['bun', 'run', 'verify:packet', packet], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
	const output = `${proc.stdout}${proc.stderr}`;
	const pass = proc.exitCode === 0;
	const notApplicable = output.includes('NOT APPLICABLE');
	checks.push({
		name: `verify:packet ${packet}`,
		status: pass ? 'PASS' : 'FAIL',
		detail: notApplicable && pass ? 'NOT APPLICABLE (named)' : output.split('\n').slice(-2).join(' | '),
	});
}

// 4. Live gates: provisioning is not proof. PASS requires a recorded live
// receipt (docs/live-receipts.json), written by `bun run test:live -- Pxx`
// only after every mapped live spec of that packet passed.
const liveReceipts = readLiveReceipts();
const liveGates: { name: string; packet: string; env: string; configured: boolean }[] = [
	{ name: 'OAuth live callbacks (P01)', packet: 'P01', env: 'GOOGLE_CLIENT_ID + GITHUB_CLIENT_ID', configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GITHUB_CLIENT_ID) },
	{ name: 'Model round-trips (P05)', packet: 'P05', env: 'NEBIUS_API_KEY', configured: Boolean(process.env.NEBIUS_API_KEY) },
	{ name: 'Sandbox live probes (P04)', packet: 'P04', env: 'CONTREE_BASE_URL + CONTREE_API_TOKEN', configured: Boolean(process.env.CONTREE_BASE_URL && process.env.CONTREE_API_TOKEN) },
	{ name: 'Live external retrieval (P10)', packet: 'P10', env: 'CADDIE_LIVE_AUTHORIZED=1', configured: process.env.CADDIE_LIVE_AUTHORIZED === '1' },
];
for (const gate of liveGates) {
	const receipt = liveReceipts.get(gate.packet);
	const mappedLive = PACKET_MAP[gate.packet]?.live ?? [];
	const detail = receipt
		? `live receipt recorded ${receipt.at} — ${receipt.files.length} spec(s), ${receipt.passed} test(s) passed`
		: !gate.configured
			? `BLOCKED — provision ${gate.env} (owner input)`
			: mappedLive.length === 0
				? `PROVISIONED, never PASS — ${gate.env} is present but ${gate.packet} maps no live spec, so only the owner's recorded run (docs/release-evidence.md) can assert this gate`
				: `PROVISIONED, never PASS — ${gate.env} is present but no live receipt exists; run \`bun run test:live -- ${gate.packet}\``;
	checks.push({
		name: gate.name,
		status: receipt ? 'PASS' : gate.configured ? 'PROVISIONED' : 'BLOCKED',
		detail,
	});
}

// 5. Deployment authorization is ALWAYS an explicit human gate
checks.push({
	name: 'deployment authorization',
	status: 'BLOCKED',
	detail: 'deployment requires concrete owner approval against a specific release SHA — this check never reports PASS',
});

// --- report -----------------------------------------------------------------
let failures = 0;
let blocked = 0;
let provisioned = 0;
for (const check of checks) {
	const marker =
		check.status === 'PASS'
			? '[PASS]'
			: check.status === 'FAIL'
				? '[FAIL]'
				: check.status === 'PROVISIONED'
					? '[PROVISIONED]'
					: '[BLOCKED]';
	if (check.status === 'FAIL') failures++;
	if (check.status === 'BLOCKED') blocked++;
	if (check.status === 'PROVISIONED') provisioned++;
	console.log(`${marker} ${check.name} — ${check.detail.split('\n')[0]}`);
}
const passing = checks.length - failures - blocked - provisioned;
console.log(`\nrelease-check: ${passing} PASS, ${failures} FAIL, ${blocked} BLOCKED, ${provisioned} PROVISIONED (not PASS)`);
if (provisioned > 0) {
	console.log(
		`PROVISIONED is provisioning, not proof — a recorded live receipt in ${LIVE_RECEIPTS_PATH.replace(`${REPO}/`, '')} is the only thing that makes a live gate PASS.`,
	);
}
console.log(failures === 0
	? 'All locally-verifiable checks pass. Live gates remain BLOCKED/PROVISIONED pending owner inputs; deployment remains an owner decision.'
	: `${failures} FAILING check(s) — fix before requesting a release.`);
process.exit(failures === 0 ? 0 : 1);
