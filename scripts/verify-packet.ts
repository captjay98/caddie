#!/usr/bin/env bun
/**
 * Packet verifier (P00).
 *
 *   bun run verify:packet Pxx     run the packet's mapped unit/workerd tests
 *   bun run test:live -- Pxx      run the packet's mapped live specs
 *   bun run test:browser -- Pxx   run the packet's mapped browser specs
 *
 * Honesty rules:
 *   - A mapped test file that does not exist FAILS the command. Missing
 *     functionality is never a vacuous pass.
 *   - A test file that exists but runs zero tests FAILS the command.
 *   - A harness category with no existing files FAILS the command.
 *   - Live invocation additionally requires CADDIE_LIVE_AUTHORIZED=1 (explicit
 *     owner authorization for any external effect); without it the command is
 *     BLOCKED, exit nonzero.
 *   - Default verification never deploys and never spends.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .dev.vars (gitignored; values never printed) so live verification
// reflects the owner's standing authorization instead of failing on bun's
// empty process.env. Real env wins over the file.
{
	const devVarsPath = join(fileURLToPath(new URL('..', import.meta.url)), '.dev.vars');
	if (existsSync(devVarsPath)) {
		for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
			const match = /^([A-Z_a-z][A-Z0-9_a-z]*)=(.*)$/.exec(line);
			if (match && process.env[match[1]] === undefined && match[2].trim() !== '') {
				process.env[match[1]] = match[2];
			}
		}
	}
}

type Category = 'tests' | 'browser' | 'live';

const PACKET_MAP: Record<string, Record<Category, string[]>> = {
	P00: {
		tests: ['tests/contracts.test.ts', 'tests/routing.test.ts'],
		browser: [],
		live: [],
	},
	P01: {
		tests: ['tests/auth.integration.test.ts'],
		browser: ['tests/browser/auth.spec.ts'],
		live: [],
	},
	P02: {
		tests: ['tests/project-isolation.integration.test.ts'],
		browser: [],
		live: [],
	},
	P03: {
		tests: ['tests/controls.integration.test.ts', 'tests/budget-races.integration.test.ts'],
		browser: [],
		live: [],
	},
	P04: {
		tests: ['tests/sandbox.contract.test.ts'],
		browser: [],
		live: ['tests/live/sandbox.spec.ts'],
	},
	P05: {
		tests: ['tests/agent-permissions.test.ts'],
		browser: [],
		live: ['tests/live/flue-lifecycle.spec.ts'],
	},
	P06: {
		tests: [],
		browser: ['tests/browser/workspace.spec.ts', 'tests/browser/conversation.spec.ts'],
		live: [],
	},
	P07: {
		tests: ['tests/preview-access.integration.test.ts'],
		browser: ['tests/browser/artifacts.spec.ts'],
		live: ['tests/live/preview.spec.ts'],
	},
	P08: {
		tests: ['tests/github.integration.test.ts'],
		browser: [],
		live: ['tests/live/github.spec.ts'],
	},
	P09: {
		tests: ['tests/p09-local.test.ts'],
		browser: ['tests/browser/forge-journey.spec.ts'],
		live: ['tests/live/forge-react-hono.spec.ts'],
	},
	P10: {
		tests: ['tests/evidence.test.ts', 'tests/evidence.integration.test.ts'],
		browser: [],
		live: [],
	},
	P11: {
		tests: ['tests/discovery.test.ts', 'tests/planning.integration.test.ts'],
		browser: ['tests/browser/discovery.spec.ts'],
		live: [],
	},
	P12: {
		tests: ['tests/schedules.integration.test.ts', 'tests/sentinel.test.ts'],
		browser: [],
		live: ['tests/live/notifications.spec.ts'],
	},
	P13: {
		tests: ['tests/judge.test.ts', 'tests/submission.test.ts'],
		browser: ['tests/browser/submission.spec.ts'],
		live: [],
	},
	P14: {
		tests: ['tests/memory.integration.test.ts', 'tests/search-isolation.test.ts'],
		browser: ['tests/browser/settings.spec.ts'],
		live: [],
	},
	P15a: { tests: [], browser: [], live: ['tests/live/stacks/tanstack-start.spec.ts'] },
	P15b: { tests: [], browser: [], live: ['tests/live/stacks/laravel-inertia.spec.ts'] },
	P15c: { tests: [], browser: [], live: ['tests/live/stacks/fastapi-react.spec.ts'] },
	P15d: { tests: [], browser: [], live: ['tests/live/stacks/flutter.spec.ts'] },
	P16: {
		tests: [],
		browser: ['tests/browser/landing.spec.ts'],
		live: [],
	},
	P17: {
		tests: [],
		browser: ['tests/browser/release.spec.ts'],
		live: ['tests/live/release.spec.ts'],
	},
};

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Check {
	name: string;
	command: string;
	exitCode: number;
	detail: string;
}

function runSpec(file: string, category: Category): Check {
	// Browser specs execute under Playwright; unit/integration/live specs
	// execute under the bun test runner (live specs gate env themselves and
	// CADDIE_LIVE_AUTHORIZED is already enforced above).
	const command =
		category === 'browser' ? `bunx playwright test ${file}` : `bun test ${file}`;
	const argv = category === 'browser' ? ['bunx', 'playwright', 'test', file] : ['bun', 'test', file];
	const proc = Bun.spawnSync(argv, {
		cwd: REPO_ROOT,
		stdout: 'pipe',
		stderr: 'pipe',
		env: process.env,
	});
	const output = `${proc.stdout}${proc.stderr}`;
	const passMatch = /(\d+) pass/.exec(output);
	const ran = passMatch ? Number(passMatch[1]) : 0;
	if (proc.exitCode !== 0) {
		return { name: file, command, exitCode: proc.exitCode ?? 1, detail: output.trim().split('\n').slice(-6).join('\n') };
	}
	if (category !== 'browser' && ran === 0) {
		// bun-test-runner categories (unit/integration/live) must run at least
		// one test; Playwright fails on its own when a browser spec runs zero.
		return { name: file, command, exitCode: 1, detail: 'file exists but ran 0 tests — vacuous verification is rejected' };
	}
	return { name: file, command, exitCode: 0, detail: `${ran} test(s) passed` };
}

function fail(message: string): never {
	console.error(`verify-packet: FAIL — ${message}`);
	process.exit(1);
}

// --- argument parsing -------------------------------------------------------

const argv = process.argv.slice(2);
let category: Category = 'tests';
let packetId: string | undefined;
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === '--live') category = 'live';
	else if (arg === '--browser') category = 'browser';
	else if (arg === '--') continue;
	else if (!arg.startsWith('-') && packetId === undefined) packetId = arg;
	else fail(`unrecognized argument: ${arg}`);
}
if (packetId === undefined) {
	fail('usage: bun run verify:packet Pxx | bun run test:live -- Pxx | bun run test:browser -- Pxx');
}
const packet = PACKET_MAP[packetId];
if (!packet) {
	fail(`unknown packet ${packetId}; known: ${Object.keys(PACKET_MAP).join(', ')}`);
}

// --- live authorization gate -------------------------------------------------

if (category === 'live' && process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error(
		`verify-packet: BLOCKED — live verification for ${packetId} requires explicit authorization. Set CADDIE_LIVE_AUTHORIZED=1 with owner-approved budget/environment/recipient.`,
	);
	process.exit(1);
}

// --- run checks ----------------------------------------------------------------

const mapped = packet[category];
const checks: Check[] = [];
const missing: string[] = [];
for (const file of mapped) {
	if (!existsSync(join(REPO_ROOT, file))) {
		missing.push(file);
		continue;
	}
	checks.push(runSpec(file, category));
}

if (mapped.length === 0) {
	console.log(`verify-packet: ${packetId} has no ${category} mapped — NOT APPLICABLE (named, not faked)`);
	process.exit(0);
}
if (checks.length === 0) {
	fail(`${packetId} ${category}: none of the mapped tests exist:\n${missing.map((m) => `  MISSING ${m}`).join('\n')}`);
}
if (missing.length > 0) {
	fail(
		`${packetId} ${category}: missing test files (incomplete verification):\n${missing.map((m) => `  MISSING ${m}`).join('\n')}`,
	);
}

let failed = 0;
for (const check of checks) {
	const status = check.exitCode === 0 ? 'PASS' : 'FAIL';
	if (check.exitCode !== 0) failed++;
	console.log(`[${status}] ${check.name} — ${check.command} (exit ${check.exitCode})`);
	if (check.exitCode !== 0) console.error(check.detail);
	else console.log(`        ${check.detail}`);
}

if (failed > 0) {
	console.error(`verify-packet: ${packetId} ${category}: ${failed} check(s) FAILED`);
	process.exit(1);
}
console.log(`verify-packet: ${packetId} ${category}: all ${checks.length} check(s) PASS`);
