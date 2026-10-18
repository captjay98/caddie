#!/usr/bin/env bun
/**
 * Packet verifier (P00).
 *
 *   bun run verify:packet Pxx     run the packet's mapped unit/workerd tests
 *   bun run verify:packet --all   run EVERY packet's tests, print a summary
 *   bun run test:live -- Pxx      run the packet's mapped live specs
 *   bun run test:browser -- Pxx   run the packet's mapped browser specs
 *
 * `--all` combines with `--live` / `--browser` (all packets, that category).
 * CI calls `--all`, so a packet cannot be skipped by omitting it from a list:
 * the packet table lives in `scripts/packet-list.ts` and nowhere else.
 *
 * Honesty rules:
 *   - A mapped test file that does not exist FAILS the command. Missing
 *     functionality is never a vacuous pass.
 *   - A test file that exists but runs zero tests FAILS the command.
 *   - A harness category with no existing files FAILS the command.
 *   - Live invocation additionally requires CADDIE_LIVE_AUTHORIZED=1 (explicit
 *     owner authorization for any external effect); without it the command is
 *     BLOCKED, exit nonzero. A passing live packet records a receipt in
 *     `docs/live-receipts.json` — the only thing `release-check.ts` accepts as
 *     PASS for a credential-gated gate.
 *   - Default verification never deploys and never spends.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordLiveReceipt } from './live-receipts.ts';
import { PACKET_KEYS, PACKET_MAP, type PacketCategory } from './packet-list.ts';

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

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Check {
	name: string;
	command: string;
	exitCode: number;
	detail: string;
}

type PacketStatus = 'PASS' | 'FAIL' | 'NOT APPLICABLE';

interface Outcome {
	packet: string;
	status: PacketStatus;
	detail: string;
	/** Test cases that passed across the packet's mapped files. */
	passed: number;
}

function runSpec(file: string, category: PacketCategory): Check {
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

/**
 * Run one packet's mapped files for a category. Prints per-file lines unless
 * `quiet` (the `--all` summary), which still prints every failure detail.
 */
function verifyPacket(packetId: string, category: PacketCategory, quiet: boolean): Outcome {
	const packet = PACKET_MAP[packetId];
	if (!packet) fail(`unknown packet ${packetId}; known: ${PACKET_KEYS.join(', ')}`);
	const mapped = packet[category];
	if (mapped.length === 0) {
		if (!quiet) console.log(`verify-packet: ${packetId} has no ${category} mapped — NOT APPLICABLE (named, not faked)`);
		return { packet: packetId, status: 'NOT APPLICABLE', detail: `no ${category} mapped`, passed: 0 };
	}

	const checks: Check[] = [];
	const missing: string[] = [];
	for (const file of mapped) {
		if (!existsSync(join(REPO_ROOT, file))) {
			missing.push(file);
			continue;
		}
		checks.push(runSpec(file, category));
	}

	if (missing.length > 0 || checks.length === 0) {
		const lines = missing.map((m) => `  MISSING ${m}`).join('\n');
		console.error(
			`verify-packet: FAIL — ${packetId} ${category}: ${
				checks.length === 0 ? 'none of the mapped tests exist' : 'missing test files (incomplete verification)'
			}:\n${lines}`,
		);
		for (const check of checks) {
			if (check.exitCode !== 0) console.error(`${check.name}\n${check.detail}`);
		}
		return { packet: packetId, status: 'FAIL', detail: `missing mapped files: ${missing.join(', ')}`, passed: 0 };
	}

	let failed = 0;
	let passed = 0;
	for (const check of checks) {
		const status = check.exitCode === 0 ? 'PASS' : 'FAIL';
		if (check.exitCode !== 0) failed++;
		else passed += Number(/(\d+) test\(s\) passed/.exec(check.detail)?.[1] ?? 0);
		if (!quiet || check.exitCode !== 0) {
			console.log(`[${status}] ${check.name} — ${check.command} (exit ${check.exitCode})`);
			if (check.exitCode !== 0) console.error(check.detail);
			else console.log(`        ${check.detail}`);
		}
	}

	if (failed > 0) {
		if (!quiet) console.error(`verify-packet: ${packetId} ${category}: ${failed} check(s) FAILED`);
		return { packet: packetId, status: 'FAIL', detail: `${failed} check(s) FAILED`, passed: 0 };
	}

	// A green live packet is evidence: record the receipt release-check reads.
	if (category === 'live') {
		const receipt = recordLiveReceipt({ packet: packetId, files: mapped, passed });
		if (!quiet) console.log(`verify-packet: recorded live receipt for ${packetId} (${receipt.files.length} spec(s), ${receipt.passed} test(s), ${receipt.at})`);
	}
	if (!quiet) console.log(`verify-packet: ${packetId} ${category}: all ${checks.length} check(s) PASS`);
	return { packet: packetId, status: 'PASS', detail: `${checks.length} check(s) PASS`, passed };
}

// --- argument parsing -------------------------------------------------------

const argv = process.argv.slice(2);
let category: PacketCategory = 'tests';
let packetId: string | undefined;
let all = false;
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === '--live') category = 'live';
	else if (arg === '--browser') category = 'browser';
	else if (arg === '--all') all = true;
	else if (arg === '--') continue;
	else if (!arg.startsWith('-') && packetId === undefined) packetId = arg;
	else fail(`unrecognized argument: ${arg}`);
}
if (all && packetId !== undefined) fail('use either --all or a single packet id, not both');
if (!all && packetId === undefined) {
	fail('usage: bun run verify:packet Pxx | --all [--live|--browser] | bun run test:live -- Pxx | bun run test:browser -- Pxx');
}

// --- live authorization gate -------------------------------------------------

if (category === 'live' && process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error(
		`verify-packet: BLOCKED — live verification${all ? '' : ` for ${packetId}`} requires explicit authorization. Set CADDIE_LIVE_AUTHORIZED=1 with owner-approved budget/environment/recipient.`,
	);
	process.exit(1);
}

// --- run ---------------------------------------------------------------------

if (all) {
	const outcomes: Outcome[] = [];
	for (const key of PACKET_KEYS) outcomes.push(verifyPacket(key, category, true));

	const passed = outcomes.filter((o) => o.status === 'PASS');
	const failed = outcomes.filter((o) => o.status === 'FAIL');
	const notApplicable = outcomes.filter((o) => o.status === 'NOT APPLICABLE');
	for (const outcome of outcomes) {
		const marker = outcome.status === 'PASS' ? '[PASS]' : outcome.status === 'FAIL' ? '[FAIL]' : '[N/A]';
		console.log(`${marker} ${outcome.packet} — ${outcome.detail}`);
	}
	console.log(
		`\nverify-packet --all ${category}: ${outcomes.length} packet(s) — ${passed.length} PASS, ${failed.length} FAIL, ${notApplicable.length} NOT APPLICABLE`,
	);
	if (failed.length > 0) {
		console.error(`verify-packet --all: FAILING packets: ${failed.map((o) => o.packet).join(', ')}`);
		process.exit(1);
	}
	console.log('verify-packet --all: every mapped test in every packet passed (NOT APPLICABLE packets are named, not faked).');
	process.exit(0);
}

const outcome = verifyPacket(packetId as string, category, false);
process.exit(outcome.status === 'FAIL' ? 1 : 0);
