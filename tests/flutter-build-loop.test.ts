import { describe, expect, test } from 'bun:test';
import { FLUTTER_RECIPE_INSTRUCTION, BUILD_RECIPE_INSTRUCTION, recipeInstructionFor } from '../apps/app/src/agents/specialists.ts';
import { BUILD_RUNTIME_ENV, DEFAULT_BASE_IMAGE, DEFAULT_FLUTTER_IMAGE, FLUTTER_RUNTIME_ENV, stackRuntime } from '../apps/app/src/server/build-sandbox.ts';
import { hostCheckCommands, testsPassed } from '../apps/app/src/server/host-checks.ts';
import { VERIFIED_INSTALL_COMMAND } from '../apps/app/src/server/verified-install.ts';

/**
 * Track 3, stage C: a run's stack decides its image, environment, host checks
 * and builder instructions. Web apps must come out exactly as before.
 */

describe('host checks per kind of app', () => {
	test('a web app runs exactly the three checks it always did', () => {
		expect(hostCheckCommands('react-hono')).toEqual([
			{ check: 'dependencies', command: VERIFIED_INSTALL_COMMAND, timeoutMs: 120_000 },
			{ check: 'behavior-tests', command: 'bun run test', timeoutMs: 120_000 },
			{ check: 'browser-bundle', command: 'bun run build', timeoutMs: 120_000 },
		]);
	});

	test('an Android app sets up its projects first, then installs, tests and builds web + server', () => {
		const checks = hostCheckCommands('flutter');
		expect(checks.map((c) => c.check)).toEqual(['app-setup', 'dependencies', 'behavior-tests', 'browser-bundle']);
		expect(checks[0]!.command).toBe('dart caddie/setup.dart && flutter pub get --enforce-lockfile');
		expect(checks[1]!.command).toBe(VERIFIED_INSTALL_COMMAND);
		expect(checks[2]!.command).toBe('sh caddie/run-tests.sh');
		expect(checks[3]!.command).toBe('flutter build web --release && bun run build:server');
		for (const check of checks) expect(check.timeoutMs).toBe(600_000);
	});
});

describe('when a test run counts', () => {
	test('at least one pass and no failure, from bun, flutter or both', () => {
		expect(testsPassed(' 3 pass\n 0 fail')).toBe(true);
		expect(testsPassed('00:03 +2: All tests passed!')).toBe(true);
		expect(testsPassed('00:03 +2: All tests passed!\n 3 pass\n 0 fail')).toBe(true);
	});

	test('no tests, a failure in either runner, or no summary does not count', () => {
		expect(testsPassed(' 0 pass\n 0 fail')).toBe(false);
		expect(testsPassed('00:05 +0 -1: Some tests failed.')).toBe(false);
		expect(testsPassed('00:03 +2: All tests passed!\n 3 pass\n 1 fail')).toBe(false);
		expect(testsPassed('Test directory "test/app" not found.')).toBe(false);
	});
});

describe('image and environment', () => {
	test('a web app keeps the base image and its PATH', () => {
		expect(stackRuntime('react-hono', {})).toEqual({ image: DEFAULT_BASE_IMAGE, env: BUILD_RUNTIME_ENV });
		expect(stackRuntime(undefined, { CONTREE_IMAGE: 'tag:other:1' }).image).toBe('tag:other:1');
	});

	test('an Android app uses the Flutter image (overridable) with Flutter, Java, Android and Bun on hand', () => {
		expect(stackRuntime('flutter', {})).toEqual({ image: DEFAULT_FLUTTER_IMAGE, env: FLUTTER_RUNTIME_ENV });
		expect(stackRuntime('flutter', { CONTREE_FLUTTER_IMAGE: 'img-2', CONTREE_IMAGE: 'tag:other:1' }).image).toBe('img-2');
		const path = FLUTTER_RUNTIME_ENV.PATH!.split(':');
		for (const dir of ['/opt/flutter/bin', '/opt/android-sdk/platform-tools', '/root/.bun/bin']) expect(path).toContain(dir);
		expect(FLUTTER_RUNTIME_ENV).toMatchObject({ HOME: '/root', ANDROID_HOME: '/opt/android-sdk', PUB_CACHE: '/root/.pub-cache' });
	});
});

describe('builder instructions per kind of app', () => {
	test('web apps keep the React recipe; Android apps get the Flutter one', () => {
		expect(recipeInstructionFor('react-hono')).toBe(BUILD_RECIPE_INSTRUCTION);
		expect(recipeInstructionFor(undefined)).toBe(BUILD_RECIPE_INSTRUCTION);
		expect(recipeInstructionFor('flutter')).toBe(FLUTTER_RECIPE_INSTRUCTION);
	});

	test('the Flutter recipe names the real files, the gated test folder and run_checks, and no React', () => {
		for (const phrase of ['lib/main.dart', 'lib/api.dart', 'apiUri', 'test/app/', 'run_checks', 'MockClient', 'src/server.ts', 'migrations/', 'request_app_key', 'c.env.CADDIE.ai', 'caddie/']) {
			expect(FLUTTER_RECIPE_INSTRUCTION).toContain(phrase);
		}
		expect(FLUTTER_RECIPE_INSTRUCTION).not.toMatch(/React|happy-dom|Testing Library|\.tsx/);
	});
});
