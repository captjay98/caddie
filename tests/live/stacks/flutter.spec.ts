import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FLUTTER_SCAFFOLD_FILES } from '../../../stacks/flutter/scaffold.ts';

/**
 * P15d live Flutter journey — the REAL template flow behind explicit
 * toolchain gates. The acceptance bar is a REAL debug APK launched on a REAL
 * emulator with an interaction capture; a Flutter-web screenshot is never a
 * substitute and this suite never fakes one.
 *
 * Gates, each a named BLOCKED when absent (never auto-installed):
 *   1. CADDIE_LIVE_AUTHORIZED=1  (pub.dev + gradle fetches are network effects)
 *   2. flutter on PATH           (the SDK)
 *   3. adb                       (ANDROID_HOME/ANDROID_SDK_ROOT or PATH)
 *   4. a booted, authorized emulator (`adb devices` state "device")
 *
 * When every gate passes: flutter pub get → flutter test (real in-process
 * loopback HTTP) → flutter create --platforms=android (platform host folder
 * is generated, never vendored) → flutter build apk --debug → install, launch
 * and capture via scripts/capture-android.ts. A phase failure fails here.
 */

const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1';
const REPO = join(import.meta.dir, '..', '..', '..');
const APP_ID = 'dev.caddie.app.caddie_app';

function adbPath(): string | null {
	for (const envKey of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
		const root = process.env[envKey];
		if (root && existsSync(join(root, 'platform-tools', 'adb'))) {
			return join(root, 'platform-tools', 'adb');
		}
	}
	return Bun.which('adb');
}

function bootedDevice(adb: string): string | null {
	const proc = spawnSync(adb, ['devices'], { encoding: 'utf8' });
	if (proc.status !== 0) return null;
	for (const line of String(proc.stdout).split('\n').slice(1)) {
		const [serial, state] = line.trim().split(/\s+/);
		if (serial && state === 'device') return serial;
	}
	return null;
}

function run(argv: string[], cwd: string): { code: number; output: string } {
	const proc = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' });
	return { code: proc.status ?? 1, output: `${proc.stdout}${proc.stderr}` };
}

describe('P15d live Flutter journey (BLOCKED without toolchain/emulator/authorization)', () => {
	test('live authorization is explicit', () => {
		if (!authorized) {
			throw new Error(
				'BLOCKED: the P15d Flutter journey requires CADDIE_LIVE_AUTHORIZED=1 (pub get + gradle are ' +
					'network effects). When authorized it probes flutter/adb/a booted emulator, then drives the ' +
					'REAL recipe flow (flutter pub get, flutter test, flutter build apk --debug) and captures a ' +
					'real emulator interaction via scripts/capture-android.ts. Nothing is mocked; a web screenshot ' +
					'would not pass.',
			);
		}
		expect(authorized).toBe(true);
	});

	test(
		'the template tests, builds a debug APK and proves a real emulator launch',
		() => {
			if (!authorized) return; // gated above

			if (!Bun.which('flutter')) {
				throw new Error(
					'BLOCKED: flutter SDK not found on PATH (or the contree sandbox image that carries it). ' +
						'Toolchains are never auto-installed.',
				);
			}
			const adb = adbPath();
			if (!adb) {
				throw new Error(
					'BLOCKED: adb not found — set ANDROID_HOME (platform-tools) or put adb on PATH. ' +
						'Real device evidence needs the Android toolchain; none is simulated.',
				);
			}
			const serial = bootedDevice(adb);
			if (!serial) {
				throw new Error(
					`BLOCKED: no booted emulator ("device" state in \`adb devices\`). Start one first, e.g. ` +
						'`flutter emulators --launch caddie-test`, then re-run. The acceptance bar is a real ' +
						'APK launch + interaction receipt, not a skipped or faked one.',
				);
			}

			const dir = mkdtempSync(join(tmpdir(), 'p15d-flutter-'));
			try {
				// The scaffold every Flutter app starts from (stacks/flutter/scaffold.ts),
				// with its own setup creating the Android project and its lockfile pins.
				for (const [path, text] of Object.entries(FLUTTER_SCAFFOLD_FILES)) {
					mkdirSync(dirname(join(dir, path)), { recursive: true });
					writeFileSync(join(dir, path), text);
				}

				const setup = run(['dart', 'caddie/setup.dart'], dir);
				expect(setup.code, setup.output.slice(-2000)).toBe(0);
				const pubGet = run(['flutter', 'pub', 'get', '--enforce-lockfile'], dir);
				expect(pubGet.code, pubGet.output.slice(-2000)).toBe(0);

				const tests = run(['flutter', 'test', 'test/examples'], dir);
				expect(tests.code, tests.output.slice(-2500)).toBe(0);
				expect(tests.output).toMatch(/All tests passed!/);

				const build = run(['flutter', 'build', 'apk', '--debug'], dir);
				expect(build.code, build.output.slice(-2500)).toBe(0);
				const apk = join(dir, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk');
				expect(existsSync(apk), 'real debug APK emitted').toBe(true);
				const apkBytes = readFileSync(apk);
				expect(apkBytes.length).toBeGreaterThan(1_000_000); // a real APK, not a stub
				const apkSha = createHash('sha256').update(apkBytes).digest('hex').slice(0, 16);

				let install = run([adb, '-s', serial, 'install', '-r', apk], dir);
				if (install.code !== 0 && install.output.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
					// The device already carries this app id signed by another key —
					// a release APK from the app's own download journey, for one. Drop
					// that stale install and put the fresh debug build in its place.
					// The acceptance bar (a real launch) is unchanged.
					run([adb, '-s', serial, 'uninstall', APP_ID], dir);
					install = run([adb, '-s', serial, 'install', '-r', apk], dir);
				}
				expect(install.code, install.output.slice(-1500)).toBe(0);

				const launch = run([adb, '-s', serial, 'shell', 'monkey', '-p', APP_ID, '1'], dir);
				expect(launch.code, launch.output.slice(-1500)).toBe(0);

				// Give the activity a moment to draw, then capture the REAL screen.
				spawnSync('sleep', ['3']);
				const out = join(dir, 'emulator-launch.png');
				const capture = run(['bun', join(REPO, 'scripts', 'capture-android.ts'), '--serial', serial, '--out', out], dir);
				expect(capture.code, capture.output.slice(-1500)).toBe(0);
				expect(capture.output).toContain('capture-android: PASS');
				expect(existsSync(out), 'screenshot artifact exists').toBe(true);

				console.log(
					`p15d: APK sha256-${apkSha} (${apkBytes.length} bytes), launched on ${serial}, capture at ${out}`,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		1_200_000,
	);
});
