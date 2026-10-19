import { SCAFFOLD_PACKAGE } from "../react-hono/scaffold.ts";
import { SERVER_FILES } from "../react-hono/server-files.ts";
import { AUTH_FILES } from "../react-hono/auth-files.ts";
import { recipe } from "./recipe.ts";
import { FLUTTER_BUN_LOCK, FLUTTER_PUBSPEC_LOCK } from "./scaffold-lock.ts";

/**
 * The scaffold for Flutter apps (Track 3, plan step 3.2): a GENERIC Flutter
 * app (the phone and web client) plus the same Hono + D1 backend every
 * react-hono app gets (stacks/react-hono/server-files.ts, auth-files.ts), so a
 * Flutter project starts from code that already installs, tests and builds in
 * the Flutter sandbox image (scripts/build-flutter-image.ts). Like the React
 * scaffold it is not an app: no todo list, no acceptance assertions.
 *
 * Layout, one project root:
 *   pubspec.yaml, lib/, test/      the Flutter app (package caddie_app)
 *   android/                       created once by caddie/setup.dart, so it
 *                                  always matches the image's Flutter
 *   package.json, src/server.ts,   the backend (Hono on Cloudflare Workers,
 *   migrations/, caddie/*.ts       env.DB, env.CADDIE.ai, sign-in)
 *
 * The host's checks (stacks/flutter/recipe.ts):
 *   dependencies   dart caddie/setup.dart (Android project, network permission,
 *                  Gradle held inside the sandbox's ~3.8 GB), pub get against
 *                  the lockfile, then the verified bun install for the server
 *   behavior tests sh caddie/run-tests.sh: `flutter test test/app` and, when
 *                  the app has any, the server's tests in src/
 *   bundle         flutter build web (the preview) + the Workers server bundle
 * The examples live in test/examples, outside test/app, so the bare scaffold
 * can never pass the test gate: the builder's own tests must.
 *
 * Not included from the React scaffold: its DOM test setup (happy-dom,
 * Testing Library) and the React sign-in screen. A Flutter app signs users in
 * through the same /api/auth routes.
 */

/** The Flutter package name every app uses (Android id dev.caddie.app.caddie_app). */
export const FLUTTER_PACKAGE_NAME = "caddie_app";

/** Where the builder's widget tests live; the gate runs only this folder. */
export const FLUTTER_TEST_DIR = "test/app";

/** The backend's package.json: the React scaffold's server versions, no React. */
export const FLUTTER_SERVER_PACKAGE = {
	name: "caddie-project",
	private: true,
	type: "module",
	scripts: {
		"test:server": "bun test src/",
		// The app's server for Cloudflare Workers (dist/server.js), then Caddie's
		// check that it uses nothing Workers lacks (same as the React scaffold).
		"build:server":
			"bun build src/server.ts --outfile dist/server.js --target browser --format esm --conditions workerd --external 'cloudflare:*' --external 'node:*' && " +
			"bun run caddie/check-server.ts",
		start: "bun run src/server.ts",
	},
	dependencies: {
		hono: SCAFFOLD_PACKAGE.dependencies.hono,
		"better-auth": SCAFFOLD_PACKAGE.dependencies["better-auth"],
	},
	devDependencies: {
		"@types/bun": SCAFFOLD_PACKAGE.devDependencies["@types/bun"],
	},
} as const;

const REACT_ONLY = new Set(["caddie/sign-in.tsx", "test/examples/sign-in-screen.example.test.tsx"]);

const BACKEND_FILES: Record<string, string> = Object.fromEntries(
	Object.entries({ ...SERVER_FILES, ...AUTH_FILES })
		.filter(([path]) => !REACT_ONLY.has(path))
		.map(([path, text]) => [path, path === "src/server.ts" ? text.replace("everything else is the React app.", "everything else is the Flutter app.") : text]),
);

const FLUTTER_FILES: Readonly<Record<string, string>> = {
	"pubspec.yaml": [
		`name: ${FLUTTER_PACKAGE_NAME}`,
		"description: A Caddie app.",
		"publish_to: none",
		"version: 1.0.0+1",
		"",
		"environment:",
		"  sdk: ^3.12.0",
		"",
		"dependencies:",
		"  flutter:",
		"    sdk: flutter",
		"  http: ^1.2.0",
		"",
		"dev_dependencies:",
		"  flutter_test:",
		"    sdk: flutter",
		"  flutter_lints: ^6.0.0",
		"",
		"flutter:",
		"  uses-material-design: true",
		"",
	].join("\n"),
	"analysis_options.yaml": [
		"# Caddie's lint settings. Do not edit.",
		"include: package:flutter_lints/flutter.yaml",
		"",
	].join("\n"),
	"lib/main.dart": [
		"import 'package:flutter/material.dart';",
		"",
		"void main() => runApp(const App());",
		"",
		"class App extends StatelessWidget {",
		"  const App({super.key});",
		"",
		"  @override",
		"  Widget build(BuildContext context) {",
		"    return MaterialApp(",
		"      title: 'Your app',",
		"      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),",
		"      home: const Scaffold(",
		"        body: Center(child: Text('Your app', style: TextStyle(fontSize: 24))),",
		"      ),",
		"    );",
		"  }",
		"}",
		"",
	].join("\n"),
	"lib/api.dart": [
		"import 'package:http/http.dart' as http;",
		"",
		"/// Where the app's server lives. Empty in the browser preview and on the",
		"/// web, where the app and its server share one address. Caddie builds the",
		"/// Android app with `--dart-define=CADDIE_API_BASE=https://your-app-address`.",
		"const String apiBase = String.fromEnvironment('CADDIE_API_BASE');",
		"",
		"/// The full address of one of the server's routes, e.g. apiUri('/api/health').",
		"Uri apiUri(String path) => apiBase.isEmpty ? Uri.base.resolve(path) : Uri.parse('$apiBase$path');",
		"",
		"/// The HTTP client the app uses. Tests pass their own (package:http/testing.dart).",
		"http.Client createClient() => http.Client();",
		"",
	].join("\n"),
	"test/examples/widget_example_test.dart": [
		"// Example widget tests. Put the app's real tests in test/app/*_test.dart:",
		"// the build runs `flutter test test/app`, so these examples never count.",
		"import 'dart:convert';",
		"",
		"import 'package:caddie_app/api.dart';",
		"import 'package:caddie_app/main.dart';",
		"import 'package:flutter/material.dart';",
		"import 'package:flutter_test/flutter_test.dart';",
		"import 'package:http/http.dart' as http;",
		"import 'package:http/testing.dart';",
		"",
		"/// Shows what GET /api/health answers. The client is a parameter, so a",
		"/// test can answer for the server (flutter_test blocks real network calls).",
		"class ServerStatus extends StatelessWidget {",
		"  const ServerStatus({super.key, required this.client});",
		"",
		"  final http.Client client;",
		"",
		"  Future<bool> _healthy() async {",
		"    final response = await client.get(apiUri('/api/health'));",
		"    return response.statusCode == 200 && (jsonDecode(response.body) as Map<String, dynamic>)['ok'] == true;",
		"  }",
		"",
		"  @override",
		"  Widget build(BuildContext context) {",
		"    return FutureBuilder<bool>(",
		"      future: _healthy(),",
		"      builder: (context, snapshot) => Text(",
		"        !snapshot.hasData ? 'Server: checking' : snapshot.data! ? 'Server: ok' : 'Server: not answering',",
		"      ),",
		"    );",
		"  }",
		"}",
		"",
		"void main() {",
		"  testWidgets('renders the starter heading', (tester) async {",
		"    await tester.pumpWidget(const App());",
		"    expect(find.text('Your app'), findsOneWidget);",
		"  });",
		"",
		"  testWidgets('talks to the server through an injected client', (tester) async {",
		"    final client = MockClient((request) async {",
		"      expect(request.url.path, '/api/health');",
		"      return http.Response(jsonEncode({'ok': true}), 200, headers: {'content-type': 'application/json'});",
		"    });",
		"    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ServerStatus(client: client))));",
		"    await tester.pumpAndSettle();",
		"    expect(find.text('Server: ok'), findsOneWidget);",
		"  });",
		"}",
		"",
	].join("\n"),
	"caddie/setup.dart": [
		"// Caddie runtime file. Do not edit: the build runs it before every check.",
		"// Creates the Android and web projects once (so they match the build image's",
		"// Flutter), lets the release app reach the network, and keeps Gradle inside",
		"// the build sandbox's memory.",
		"import 'dart:io';",
		"",
		"Future<void> main() async {",
		"  final missing = ['android', 'web'].where((platform) => !Directory(platform).existsSync()).toList();",
		"  if (missing.isNotEmpty) {",
		"    final hadDefaultTest = File('test/widget_test.dart').existsSync();",
		"    final created = await Process.run(",
		"      'flutter',",
		`      ['create', '--no-pub', '--platforms=\${missing.join(',')}', '--org', 'dev.caddie.app', '--project-name', '${FLUTTER_PACKAGE_NAME}', '.'],`,
		"      runInShell: true,",
		"    );",
		"    if (created.exitCode != 0) {",
		"      stderr.write('${created.stdout}${created.stderr}');",
		"      exit(created.exitCode);",
		"    }",
		"    // flutter create adds a counter test that does not match this app.",
		"    if (!hadDefaultTest && File('test/widget_test.dart').existsSync()) File('test/widget_test.dart').deleteSync();",
		"  }",
		"  final manifest = File('android/app/src/main/AndroidManifest.xml');",
		"  final xml = manifest.readAsStringSync();",
		"  if (!xml.contains('android.permission.INTERNET')) {",
		"    // Release builds only get the network when the main manifest asks for it.",
		"    manifest.writeAsStringSync(xml.replaceFirst('<application', '<uses-permission android:name=\"android.permission.INTERNET\"/>\\n    <application'));",
		"  }",
		"  final properties = File('android/gradle.properties');",
		"  final kept = properties",
		"      .readAsLinesSync()",
		"      .where((line) => !RegExp(r'^(org\\.gradle\\.jvmargs|org\\.gradle\\.workers\\.max|org\\.gradle\\.daemon|kotlin\\.daemon\\.jvmargs)=').hasMatch(line))",
		"      .toList();",
		"  properties.writeAsStringSync([",
		"    ...kept,",
		"    'org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m',",
		"    'org.gradle.workers.max=2',",
		"    'org.gradle.daemon=false',",
		"    'kotlin.daemon.jvmargs=-Xmx512m',",
		"    '',",
		"  ].join('\\n'));",
		"  stdout.writeln('caddie setup: android project ready');",
		"}",
		"",
	].join("\n"),
	"caddie/run-tests.sh": [
		"#!/bin/sh",
		"# Caddie runtime file. Do not edit: the build's test check runs it.",
		"# The app's widget tests (test/app), then the server's tests when the app has any.",
		"set -e",
		`flutter test ${FLUTTER_TEST_DIR}`,
		"if find src -name '*.test.ts' -o -name '*.test.tsx' | grep -q .; then",
		"  bun test src/",
		"fi",
		"",
	].join("\n"),
	".gitignore": [
		"# Flutter and Android build output",
		".dart_tool/",
		"build/",
		".flutter-plugins-dependencies",
		"android/.gradle/",
		"android/local.properties",
		"android/app/.cxx/",
		"# The server",
		"node_modules/",
		"dist/",
		"",
	].join("\n"),
};

const BASE_FILES: Readonly<Record<string, string>> = {
	...FLUTTER_FILES,
	...BACKEND_FILES,
	"package.json": `${JSON.stringify(FLUTTER_SERVER_PACKAGE, null, 2)}\n`,
	"tsconfig.json": `${JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "bundler",
				lib: ["ES2022", "DOM", "DOM.Iterable"],
				types: ["bun"],
				strict: true,
				skipLibCheck: true,
				noEmit: true,
			},
			include: ["src", "test", "caddie"],
		},
		null,
		2,
	)}\n`,
};

/** The scaffold without its lockfiles: the refresh script's input. */
export const FLUTTER_SCAFFOLD_BASE_FILES = BASE_FILES;

/** The recipe's commands (never hand-copied), plus the dependencies step before the verified bun install. */
export const FLUTTER_SCAFFOLD_COMMANDS = {
	install: recipe.install,
	/** Run as one command before runVerifiedInstall installs the server's packages. */
	appSetup: recipe.install.filter((command) => !command.startsWith("bun ")).join(" && "),
	test: recipe.test,
	build: recipe.build,
	start: recipe.start,
} as const;

/** Where the release APK lands (one phone type: arm64, what current Android phones use). */
export const FLUTTER_APK_PATH = "build/app/outputs/flutter-apk/app-release.apk";

/**
 * The release APK build. `apiBase` is the address the installed app calls
 * (the published app, or a preview address); it must be https. Refuses
 * anything else, since it is spliced into a shell command.
 */
export function flutterApkCommand(apiBase: string): string {
	const url = new URL(apiBase);
	if (url.protocol !== "https:" || url.username || url.password || !/^[A-Za-z0-9.:/_-]+$/.test(url.href)) {
		throw new Error("the APK's server address must be a plain https address");
	}
	const base = url.href.replace(/\/+$/, "");
	return `flutter build apk --release --target-platform android-arm64 --dart-define=CADDIE_API_BASE=${base}`;
}

/**
 * The files written into a fresh Flutter workspace. The two lockfiles come
 * from scripts/refresh-flutter-scaffold-lock.ts, so `bun install
 * --frozen-lockfile` and `flutter pub get --enforce-lockfile` install exactly
 * the versions (and, for pub, the content hashes) the scaffold was verified with.
 */
export const FLUTTER_SCAFFOLD_FILES: Readonly<Record<string, string>> =
	FLUTTER_BUN_LOCK && FLUTTER_PUBSPEC_LOCK
		? { ...BASE_FILES, "bun.lock": FLUTTER_BUN_LOCK, "pubspec.lock": FLUTTER_PUBSPEC_LOCK }
		: BASE_FILES;
