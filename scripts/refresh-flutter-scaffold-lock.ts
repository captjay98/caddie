/**
 * Regenerate (default) or verify (`--check`) the Flutter scaffold's lockfiles.
 *
 *   bun scripts/refresh-flutter-scaffold-lock.ts           # write stacks/flutter/scaffold-lock.ts
 *   bun scripts/refresh-flutter-scaffold-lock.ts --check   # fail if a lockfile is stale or the scaffold is broken
 *   ... --apk                                              # also build a release APK (needs Java + the Android SDK)
 *
 * Needs `flutter` (and its `dart`) on PATH, or FLUTTER=<path to the flutter binary>.
 * Both modes materialise the scaffold in a temp directory and PROVE it works:
 *   1. `bun install --frozen-lockfile` and `flutter pub get --enforce-lockfile`
 *      reproduce the install without rewriting either lockfile;
 *   2. caddie/setup.dart creates the Android project, adds the network
 *      permission once, caps Gradle, and leaves no stray counter test;
 *   3. the examples pass (`flutter test test/examples`, `bun test test/examples`);
 *   4. caddie/run-tests.sh FAILS on the bare scaffold (the gate needs the
 *      builder's tests in test/app) and passes once test/app has one;
 *   5. `flutter build web --release` emits build/web/main.dart.js;
 *   6. the Workers server bundle builds and passes Caddie's check;
 *   7. `flutter analyze` finds nothing.
 * Needs network access to the npm registry and pub.dev (public packages).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scaffoldDigest } from "../stacks/flutter/digest.ts";
import { FLUTTER_SCAFFOLD_BASE_FILES, FLUTTER_TEST_DIR } from "../stacks/flutter/scaffold.ts";
import { FLUTTER_BUN_LOCK, FLUTTER_PUBSPEC_LOCK } from "../stacks/flutter/scaffold-lock.ts";

const check = process.argv.includes("--check");
const apk = process.argv.includes("--apk");
const LOCK_MODULE = join(import.meta.dir, "..", "stacks", "flutter", "scaffold-lock.ts");
const FLUTTER = process.env.FLUTTER || "flutter";
const DART = process.env.FLUTTER ? join(dirname(process.env.FLUTTER), "dart") : "dart";
const bun = process.execPath;

function run(cwd: string, command: string, args: string[], timeoutMs = 600_000): { code: number; out: string } {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, NO_COLOR: "1", FLUTTER_SUPPRESS_ANALYTICS: "true", CI: "true" } });
	return { code: result.status ?? 1, out: `${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}` };
}

class CheckFailed extends Error {}

function fail(message: string, detail = ""): never {
	throw new CheckFailed(`FAIL: ${message}${detail ? `\n${detail.trim().slice(-2500)}` : ""}`);
}

const dir = mkdtempSync(join(tmpdir(), "caddie-flutter-scaffold-"));
const steps: string[] = [];
try {
	for (const [path, text] of Object.entries(FLUTTER_SCAFFOLD_BASE_FILES)) {
		const full = join(dir, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	if (check) {
		if (!FLUTTER_BUN_LOCK || !FLUTTER_PUBSPEC_LOCK) fail("scaffold-lock.ts is empty; run without --check to generate it");
		writeFileSync(join(dir, "bun.lock"), FLUTTER_BUN_LOCK);
		writeFileSync(join(dir, "pubspec.lock"), FLUTTER_PUBSPEC_LOCK);
	} else {
		const install = run(dir, bun, ["install"]);
		if (install.code !== 0) fail("bun install failed", install.out);
		const pub = run(dir, FLUTTER, ["pub", "get"]);
		if (pub.code !== 0) fail("flutter pub get failed", pub.out);
	}
	const bunLock = readFileSync(join(dir, "bun.lock"), "utf8");
	const pubLock = readFileSync(join(dir, "pubspec.lock"), "utf8");
	if (!/sha256:/.test(pubLock)) fail("pubspec.lock records no content hashes, so --enforce-lockfile could not check packages");

	// 1. The lockfiles alone reproduce the install, unchanged.
	rmSync(join(dir, "node_modules"), { recursive: true, force: true });
	const frozen = run(dir, bun, ["install", "--frozen-lockfile"]);
	if (frozen.code !== 0) fail("bun install --frozen-lockfile failed", frozen.out);
	const enforced = run(dir, FLUTTER, ["pub", "get", "--enforce-lockfile"]);
	if (enforced.code !== 0) fail("flutter pub get --enforce-lockfile failed", enforced.out);
	if (readFileSync(join(dir, "bun.lock"), "utf8") !== bunLock) fail("the frozen install rewrote bun.lock");
	if (readFileSync(join(dir, "pubspec.lock"), "utf8") !== pubLock) fail("pub get rewrote pubspec.lock");
	steps.push("locks reproduce the install");

	// 2. Android project, network permission once, Gradle caps, no stray test.
	for (let pass = 1; pass <= 2; pass++) {
		const setup = run(dir, DART, ["caddie/setup.dart"]);
		if (setup.code !== 0 || !/android project ready/.test(setup.out)) fail(`caddie/setup.dart failed (run ${pass})`, setup.out);
	}
	const manifest = readFileSync(join(dir, "android/app/src/main/AndroidManifest.xml"), "utf8");
	if ((manifest.match(/android\.permission\.INTERNET/g) ?? []).length !== 1) fail("the main manifest does not ask for the network exactly once", manifest);
	const properties = readFileSync(join(dir, "android/gradle.properties"), "utf8");
	if (!/^org\.gradle\.jvmargs=-Xmx1536m/m.test(properties) || (properties.match(/^org\.gradle\.jvmargs=/gm) ?? []).length !== 1) fail("Gradle's memory is not capped exactly once", properties);
	if (existsSync(join(dir, "test/widget_test.dart"))) fail("flutter create left its counter test behind");
	if (readFileSync(join(dir, "lib/main.dart"), "utf8") !== FLUTTER_SCAFFOLD_BASE_FILES["lib/main.dart"]) fail("flutter create overwrote lib/main.dart");
	steps.push("setup.dart (android/, INTERNET once, Gradle capped, idempotent)");

	// 3. The examples pass.
	const dartExamples = run(dir, FLUTTER, ["test", "test/examples"]);
	if (dartExamples.code !== 0 || !/\+2: All tests passed!/.test(dartExamples.out)) fail("the Flutter examples did not pass", dartExamples.out);
	const serverExamples = run(dir, bun, ["test", "test/examples"]);
	const serverPassed = Number(/\b(\d+) pass\b/.exec(serverExamples.out)?.[1] ?? 0);
	if (serverExamples.code !== 0 || serverPassed === 0) fail("the server examples did not pass", serverExamples.out);
	steps.push(`examples (2 Flutter, ${serverPassed} server)`);

	// 4. The gate needs the builder's own tests.
	const bare = run(dir, "sh", ["caddie/run-tests.sh"]);
	if (bare.code === 0) fail("caddie/run-tests.sh passed on the bare scaffold; the gate would not need builder tests", bare.out);
	const probeTest = join(dir, FLUTTER_TEST_DIR, "probe_test.dart");
	mkdirSync(dirname(probeTest), { recursive: true });
	writeFileSync(probeTest, "import 'package:flutter_test/flutter_test.dart';\n\nvoid main() {\n  test('probe', () => expect(1 + 1, 2));\n}\n");
	const gated = run(dir, "sh", ["caddie/run-tests.sh"]);
	rmSync(join(dir, FLUTTER_TEST_DIR), { recursive: true, force: true });
	if (gated.code !== 0 || !/\+1: All tests passed!/.test(gated.out)) fail("caddie/run-tests.sh did not pass with one builder test", gated.out);
	steps.push("gate refuses the bare scaffold, passes with a builder test");

	// 5. The web build (the preview).
	const web = run(dir, FLUTTER, ["build", "web", "--release"]);
	if (web.code !== 0 || !existsSync(join(dir, "build/web/main.dart.js"))) fail("flutter build web did not emit build/web/main.dart.js", web.out);
	steps.push(`flutter build web (main.dart.js ${(statSync(join(dir, "build/web/main.dart.js")).size / 1e6).toFixed(2)} MB)`);

	// 6. The Workers server bundle and Caddie's check.
	const server = run(dir, bun, ["run", "build:server"]);
	if (server.code !== 0 || !existsSync(join(dir, "dist/server.js")) || !/ok for Cloudflare Workers/.test(server.out)) fail("the server bundle or its Workers check failed", server.out);
	steps.push("server bundle + Workers check");

	// 7. Lints.
	const analyze = run(dir, FLUTTER, ["analyze"]);
	if (analyze.code !== 0 || !/No issues found/.test(analyze.out)) fail("flutter analyze reported issues", analyze.out);
	steps.push("flutter analyze clean");

	if (apk) {
		const built = run(dir, FLUTTER, ["build", "apk", "--release", "--target-platform", "android-arm64"], 1_200_000);
		const path = join(dir, "build/app/outputs/flutter-apk/app-release.apk");
		if (built.code !== 0 || !existsSync(path)) fail("flutter build apk failed", built.out);
		steps.push(`release APK ${(statSync(path).size / 1e6).toFixed(1)} MB`);
	}

	const digest = scaffoldDigest(FLUTTER_SCAFFOLD_BASE_FILES);
	if (check) {
		console.log(`OK: Flutter scaffold lockfiles are current (${digest}); ${steps.join("; ")}`);
	} else {
		writeFileSync(
			LOCK_MODULE,
			[
				"// GENERATED by scripts/refresh-flutter-scaffold-lock.ts — do not edit by hand.",
				"// The Flutter scaffold's bun.lock (the server) and pubspec.lock (the app, with",
				"// content hashes), so the build installs exactly what the scaffold was verified with.",
				`export const FLUTTER_BUN_LOCK = ${JSON.stringify(bunLock)};`,
				`export const FLUTTER_PUBSPEC_LOCK = ${JSON.stringify(pubLock)};`,
				`export const FLUTTER_SCAFFOLD_DIGEST = ${JSON.stringify(digest)};`,
				"",
			].join("\n"),
		);
		console.log(`OK: wrote ${LOCK_MODULE}; ${steps.join("; ")}`);
	}
} catch (error) {
	if (!(error instanceof CheckFailed)) throw error;
	console.error(error.message);
	if (steps.length > 0) console.error(`passed before the failure: ${steps.join("; ")}`);
	process.exitCode = 1;
} finally {
	rmSync(dir, { recursive: true, force: true });
}
