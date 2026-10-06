#!/usr/bin/env bun
/**
 * capture-android.ts (P15d) — REAL Android evidence capture via adb.
 *
 *   bun scripts/capture-android.ts --serial emulator-5554 --out shots/home.png
 *   bun scripts/capture-android.ts --serial emulator-5554 --out clips/journey.mp4 --record 20
 *
 * Resolves adb from ANDROID_HOME / ANDROID_SDK_ROOT / PATH. Captures a PNG
 * screenshot (default) or an mp4 screenrecording (--record <seconds>) from
 * the NAMED device serial, writing to --out and printing a sha256 receipt.
 *
 * Honesty rules:
 *   - A missing adb, an absent/unauthorized device, or a failed capture is a
 *     clean BLOCKED exit (code 1) naming the missing input — never a fake
 *     artifact, never a crash. Without a booted emulator this script cannot
 *     produce evidence, and it says so instead of pretending.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

interface Args {
	serial: string;
	out: string;
	recordSeconds?: number;
}

function usage(): never {
	console.error(
		'usage: bun scripts/capture-android.ts --serial <device-serial> --out <output-path> [--record <seconds>]',
	);
	process.exit(1);
}

function parseArgs(argv: string[]): Args {
	const args: Args = { serial: '', out: '' };
	for (let i = 0; i < argv.length; i++) {
		const value = argv[i + 1];
		if (argv[i] === '--serial' && value) {
			args.serial = value;
			i++;
		} else if (argv[i] === '--out' && value) {
			args.out = value;
			i++;
		} else if (argv[i] === '--record' && value) {
			const seconds = Number(value);
			if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 180) {
				console.error('BLOCKED: --record expects seconds in (0, 180] — device screenrecord caps at 3 minutes.');
				process.exit(1);
			}
			args.recordSeconds = seconds;
			i++;
		} else {
			usage();
		}
	}
	if (!args.serial || !args.out) usage();
	return args;
}

function resolveAdb(): string {
	const candidates: string[] = [];
	for (const envKey of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
		const root = process.env[envKey];
		if (root) candidates.push(join(root, 'platform-tools', 'adb'), join(root, 'adb'));
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	const onPath = Bun.which('adb');
	if (onPath) return onPath;
	console.error(
		'BLOCKED: adb not found. Install the Android SDK platform-tools and set ANDROID_HOME ' +
			'(or put adb on PATH). Screenshot/screenrecord evidence needs the real toolchain; ' +
			'none is simulated here.',
	);
	process.exit(1);
}

function run(adb: string, args: string[], opts: { binary?: boolean } = {}): {
	code: number;
	stdout: Buffer | string;
	stderr: string;
} {
	const proc = spawnSync(adb, args, { encoding: opts.binary ? 'buffer' : 'utf8' });
	return {
		code: proc.status ?? 1,
		stdout: (proc.stdout ?? (opts.binary ? Buffer.alloc(0) : '')) as Buffer | string,
		stderr: String(proc.stderr ?? ''),
	};
}

function deviceIsReady(adb: string, serial: string): boolean {
	const state = run(adb, ['-s', serial, 'get-state']);
	return state.code === 0 && String(state.stdout).trim() === 'device';
}

const args = parseArgs(process.argv.slice(2));
const adb = resolveAdb();

if (!deviceIsReady(adb, args.serial)) {
	const listing = run(adb, ['devices']);
	console.error(
		`BLOCKED: device "${args.serial}" is not connected and authorized (state != "device").\n` +
			`adb devices:\n${String(listing.stdout).trim() || '(no output)'}\n` +
			'Boot an emulator (e.g. `flutter emulators --launch caddie-test`) or pass its serial; ' +
			'this capture never fakes a device.',
	);
	process.exit(1);
}

mkdirSync(dirname(args.out), { recursive: true });

if (args.recordSeconds !== undefined) {
	const remotePath = '/sdcard/caddie-capture.mp4';
	const record = run(adb, ['-s', args.serial, 'shell', 'screenrecord', '--time-limit', String(args.recordSeconds), remotePath]);
	if (record.code !== 0) {
		console.error(`BLOCKED: screenrecord failed on ${args.serial}: ${record.stderr.trim() || '(no stderr)'}`);
		process.exit(1);
	}
	const pull = run(adb, ['-s', args.serial, 'pull', remotePath, args.out], { binary: false });
	if (pull.code !== 0 || !existsSync(args.out)) {
		console.error(`BLOCKED: pulling ${remotePath} failed: ${pull.stderr.trim() || pull.stdout}`);
		process.exit(1);
	}
	run(adb, ['-s', args.serial, 'shell', 'rm', remotePath]);
} else {
	const capture = run(adb, ['-s', args.serial, 'exec-out', 'screencap', '-p'], { binary: true });
	const png = capture.stdout as Buffer;
	if (capture.code !== 0 || png.length < 8 || png.subarray(0, 4).toString('binary') !== '\x89PNG') {
		console.error(
			`BLOCKED: screenshot capture failed on ${args.serial} ` +
				`(exit ${capture.code}, ${png.length} bytes${capture.stderr.trim() ? `: ${capture.stderr.trim()}` : ''}).`,
		);
		process.exit(1);
	}
	writeFileSync(args.out, png);
}

const bytes = existsSync(args.out) ? Bun.file(args.out) : null;
if (!bytes) {
	console.error(`BLOCKED: no artifact written to ${args.out}.`);
	process.exit(1);
}
const buffer = Buffer.from(await bytes.arrayBuffer());
console.log(
	`capture-android: PASS ${args.out} (${buffer.length} bytes, sha256 ${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}, device ${args.serial})`,
);
