#!/usr/bin/env bun
/**
 * Release readiness check (P17) — the local gate before ANY deployment
 * request. Runs every locally-verifiable check and reports each honestly;
 * missing credentials/capabilities are BLOCKED, never PASS.
 *
 * Deployment itself requires concrete owner authorization (a human decision)
 * and is never performed by this script.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = import.meta.dir === undefined ? process.cwd() : join(import.meta.dir, '..');

interface Check {
	name: string;
	status: 'PASS' | 'FAIL' | 'BLOCKED';
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

// 3. Every packet's locally-mapped tests
const PACKETS = ['P00', 'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P13', 'P14', 'P15a', 'P15b', 'P15c', 'P15d', 'P16', 'P17'];
for (const packet of PACKETS) {
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

// 4. Live gates: BLOCKED, never PASS without explicit authorization
const liveGates: { name: string; env: string; configured: boolean }[] = [
	{ name: 'OAuth live callbacks (P01)', env: 'GOOGLE_CLIENT_ID + GITHUB_CLIENT_ID', configured: false },
	{ name: 'Model round-trips (P05)', env: 'NEBIUS_API_KEY', configured: Boolean(process.env.NEBIUS_API_KEY) },
	{ name: 'Sandbox live probes (P04)', env: 'CONTREE_BASE_URL + CONTREE_API_TOKEN', configured: Boolean(process.env.CONTREE_BASE_URL) },
	{ name: 'Live external retrieval (P10)', env: 'CADDIE_LIVE_AUTHORIZED=1', configured: process.env.CADDIE_LIVE_AUTHORIZED === '1' },
];
for (const gate of liveGates) {
	checks.push({
		name: gate.name,
		status: gate.configured ? 'PASS' : 'BLOCKED',
		detail: gate.configured ? 'credentials present (live run still needs authorization)' : `BLOCKED — provision ${gate.env} (owner input)`,
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
for (const check of checks) {
	const marker = check.status === 'PASS' ? '[PASS]' : check.status === 'FAIL' ? '[FAIL]' : '[BLOCKED]';
	if (check.status === 'FAIL') failures++;
	if (check.status === 'BLOCKED') blocked++;
	console.log(`${marker} ${check.name} — ${check.detail.split('\n')[0]}`);
}
console.log(`\nrelease-check: ${checks.length - failures - blocked} PASS, ${failures} FAIL, ${blocked} BLOCKED`);
console.log(failures === 0
	? 'All locally-verifiable checks pass. Live gates remain BLOCKED pending owner inputs; deployment remains an owner decision.'
	: `${failures} FAILING check(s) — fix before requesting a release.`);
process.exit(failures === 0 ? 0 : 1);
