import { describe, expect, test } from "bun:test";
import { isProtectedPath, isShellTestCommand } from "../apps/app/src/agents/permissions.ts";
import { scaffoldDigest } from "../stacks/flutter/digest.ts";
import { recipe } from "../stacks/flutter/recipe.ts";
import {
	FLUTTER_APK_PATH,
	FLUTTER_PACKAGE_NAME,
	FLUTTER_SCAFFOLD_BASE_FILES,
	FLUTTER_SCAFFOLD_COMMANDS,
	FLUTTER_SCAFFOLD_FILES,
	FLUTTER_SERVER_PACKAGE,
	FLUTTER_TEST_DIR,
	flutterApkCommand,
} from "../stacks/flutter/scaffold.ts";
import { SCAFFOLD_PACKAGE } from "../stacks/react-hono/scaffold.ts";
import { SERVER_FILES } from "../stacks/react-hono/server-files.ts";

/**
 * Track 3, plan step 3.2: the Flutter scaffold. Its real behaviour (installs
 * from the lockfiles, examples pass, the gate refuses the bare scaffold, web +
 * server + APK builds) is proven by `bun scripts/refresh-flutter-scaffold-lock.ts
 * --check` with a Flutter SDK; these tests pin its shape where no SDK is needed.
 */

const files = FLUTTER_SCAFFOLD_FILES;
const paths = Object.keys(files);

describe("a generic Flutter app with the shared backend", () => {
	test("is an empty starter, not an app", () => {
		const dart = paths.filter((p) => p.endsWith(".dart")).map((p) => files[p]!).join("\n");
		expect(dart).not.toMatch(/\b(todo|task)s?\b/i);
		expect(files["lib/main.dart"]).toContain("Text('Your app'");
	});

	test("ships the Flutter app, its API helper and examples outside the gated test folder", () => {
		for (const path of ["pubspec.yaml", "analysis_options.yaml", "lib/main.dart", "lib/api.dart", "test/examples/widget_example_test.dart"]) expect(paths).toContain(path);
		expect(paths.some((p) => p.startsWith(`${FLUTTER_TEST_DIR}/`))).toBe(false);
		expect(files["pubspec.yaml"]).toContain(`name: ${FLUTTER_PACKAGE_NAME}`);
	});

	test("ships the same server as React apps, minus the React-only sign-in screen", () => {
		for (const path of ["src/server.ts", "caddie/d1.ts", "caddie/ai.ts", "caddie/auth.ts", "caddie/platform.ts", "caddie/check-server.ts", "migrations/0000_caddie_auth.sql", "test/setup/d1.ts", "test/examples/server.example.test.ts"]) expect(paths).toContain(path);
		expect(paths).not.toContain("caddie/sign-in.tsx");
		expect(paths.some((p) => p.endsWith(".tsx"))).toBe(false);
		expect(files["src/server.ts"]).toBe(SERVER_FILES["src/server.ts"]!.replace("the React app", "the Flutter app"));
		expect(files["caddie/d1.ts"]).toBe(SERVER_FILES["caddie/d1.ts"]!);
	});

	test("the server's package versions are the React scaffold's, with no React or DOM test setup", () => {
		expect(FLUTTER_SERVER_PACKAGE.dependencies.hono).toBe(SCAFFOLD_PACKAGE.dependencies.hono);
		expect(FLUTTER_SERVER_PACKAGE.dependencies["better-auth"]).toBe(SCAFFOLD_PACKAGE.dependencies["better-auth"]);
		const pkg = files["package.json"]!;
		expect(pkg).not.toMatch(/react|happy-dom|testing-library/);
		expect(paths).not.toContain("bunfig.toml");
	});
});

describe("installs exactly what was verified", () => {
	test("both lockfiles are present, and pub's records a content hash for every downloaded package", () => {
		expect(files["bun.lock"]).toContain("lockfileVersion");
		const lock = files["pubspec.lock"]!;
		const hosted = (lock.match(/source: hosted/g) ?? []).length;
		expect(hosted).toBeGreaterThan(5);
		expect((lock.match(/sha256: "?[0-9a-f]{64}/g) ?? []).length).toBe(hosted);
	});

	test("the recipe is bound to these exact files (refresh the locks after any scaffold edit)", () => {
		expect(recipe.imageDigest).toBe(scaffoldDigest(FLUTTER_SCAFFOLD_BASE_FILES));
	});

	test("the commands come from the recipe: pub against the lockfile, the frozen server install, the gated test runner", () => {
		expect(FLUTTER_SCAFFOLD_COMMANDS.install).toEqual(["dart caddie/setup.dart", "flutter pub get --enforce-lockfile", "bun install --frozen-lockfile"]);
		expect(FLUTTER_SCAFFOLD_COMMANDS.appSetup).toBe("dart caddie/setup.dart && flutter pub get --enforce-lockfile");
		expect(FLUTTER_SCAFFOLD_COMMANDS.test).toEqual(["sh caddie/run-tests.sh"]);
		expect(files["caddie/run-tests.sh"]).toContain(`flutter test ${FLUTTER_TEST_DIR}\n`);
		expect(FLUTTER_SCAFFOLD_COMMANDS.build).toEqual(["flutter build web --release", "bun run build:server"]);
	});
});

describe("the builder cannot edit what grades it", () => {
	test("the setup, test runner, lint settings and test harness are protected", () => {
		for (const path of ["caddie/setup.dart", "caddie/run-tests.sh", "analysis_options.yaml", "test/setup/d1.ts"]) expect(isProtectedPath(path)).toBe(true);
		for (const path of ["lib/main.dart", "test/app/home_test.dart", "pubspec.yaml", "src/server.ts"]) expect(isProtectedPath(path)).toBe(false);
	});

	test("a raw flutter or dart test run in the shell is refused (checks go through run_checks)", () => {
		for (const command of ["flutter test", "flutter test test/app", "cd app && flutter test", "dart test", "sh caddie/run-tests.sh"]) expect(isShellTestCommand(command)).toBe(true);
		for (const command of ["flutter pub get", "flutter pub add provider", "flutter build web --release", "dart format lib"]) expect(isShellTestCommand(command)).toBe(false);
	});

	test("setup asks for the network once and keeps Gradle inside the sandbox's memory", () => {
		const setup = files["caddie/setup.dart"]!;
		expect(setup).toContain("android.permission.INTERNET");
		expect(setup).toContain("org.gradle.jvmargs=-Xmx1536m");
		expect(setup).toContain("['android', 'web']");
	});
});

describe("the APK build command", () => {
	test("bakes the app's https address in, without a trailing slash", () => {
		expect(flutterApkCommand("https://farm-log.caddieapps.com/")).toBe(
			"flutter build apk --release --target-platform android-arm64 --dart-define=CADDIE_API_BASE=https://farm-log.caddieapps.com",
		);
		expect(FLUTTER_APK_PATH).toBe("build/app/outputs/flutter-apk/app-release.apk");
	});

	test("refuses anything that is not a plain https address (it goes into a shell command)", () => {
		for (const bad of ["http://farm-log.example.com", "https://user:pass@example.com", "https://example.com/$(id)", "https://example.com/a b", "https://example.com/;rm", "not a url", "file:///etc/passwd"]) {
			expect(() => flutterApkCommand(bad)).toThrow();
		}
	});
});
