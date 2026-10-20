import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bytesToBase64 } from '../../../apps/app/src/server/adapters/contree.ts';
import { flutterPreviewDocument, readFlutterWebBuild } from '../../../apps/app/src/server/flutter-preview.ts';
import { FLUTTER_SCAFFOLD_FILES } from '../../../stacks/flutter/scaffold.ts';

/**
 * A real Flutter web build of a tiny probe app, made from the Flutter scaffold
 * (Track 3) and turned into the exact preview page verify_build stores. The
 * probe asks its server GET /api/health on start, then reports what it got
 * with GET /api/seen?health=ok|failed, so a test can tell the Dart code ran,
 * the request crossed the preview's bridge, and the answer came back.
 *
 * Needs a Flutter SDK: `flutter` on PATH (or FLUTTER=<path to flutter>).
 * Without one this returns `blocked`, and the spec skips with that reason.
 */
const PROBE_MAIN = `import 'dart:convert';

import 'package:caddie_app/api.dart';
import 'package:flutter/material.dart';

void main() => runApp(const ProbeApp());

class ProbeApp extends StatefulWidget {
  const ProbeApp({super.key});

  @override
  State<ProbeApp> createState() => _ProbeAppState();
}

class _ProbeAppState extends State<ProbeApp> {
  String status = 'Server: checking';

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    final client = createClient();
    var ok = false;
    try {
      final response = await client.get(apiUri('/api/health'));
      ok = response.statusCode == 200 && (jsonDecode(response.body) as Map<String, dynamic>)['ok'] == true;
    } catch (_) {}
    setState(() => status = ok ? 'Server: ok' : 'Server: not answering');
    await client.get(apiUri('/api/seen?health=\${ok ? 'ok' : 'failed'}'));
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        home: Scaffold(
          backgroundColor: const Color(0xFF3949AB),
          body: Center(child: Text(status, style: const TextStyle(fontSize: 28, color: Colors.white))),
        ),
      );
}
`;

type Probe = { page: string; blocked: null } | { page: ''; blocked: string };
let cached: Probe | null = null;

export async function flutterProbePage(): Promise<Probe> {
	if (cached) return cached;
	const flutter = process.env.FLUTTER || 'flutter';
	const dart = process.env.FLUTTER ? join(dirname(process.env.FLUTTER), 'dart') : 'dart';
	if (spawnSync(flutter, ['--version'], { encoding: 'utf8' }).status !== 0) {
		return (cached = { page: '', blocked: 'BLOCKED: needs a Flutter SDK (flutter on PATH, or FLUTTER=<path>) to build the probe app' });
	}
	const dir = mkdtempSync(join(tmpdir(), 'caddie-flutter-probe-'));
	for (const [path, text] of Object.entries({ ...FLUTTER_SCAFFOLD_FILES, 'lib/main.dart': PROBE_MAIN })) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	const env = { ...process.env, FLUTTER_SUPPRESS_ANALYTICS: 'true', CI: 'true' };
	for (const [command, args] of [[dart, ['caddie/setup.dart']], [flutter, ['pub', 'get', '--enforce-lockfile']], [flutter, ['build', 'web', '--release']]] as const) {
		const result = spawnSync(command, [...args], { cwd: dir, encoding: 'utf8', env, timeout: 300_000 });
		if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${(result.stdout + result.stderr).slice(-2000)}`);
	}
	// The same reader verify_build uses, over this folder instead of the sandbox.
	const local = {
		async readFile(_session: string, path: string) {
			const bytes = new Uint8Array(readFileSync(path));
			return { contentBase64: bytesToBase64(bytes), size: bytes.byteLength };
		},
		async pathExists(_session: string, path: string) {
			return existsSync(path);
		},
		async listEntries(_session: string, path: string) {
			return readdirSync(path).map((name) => {
				const stat = statSync(join(path, name));
				return { name, isFile: stat.isFile(), isDir: stat.isDirectory(), isSymlink: false, size: stat.size };
			});
		},
	} as never;
	return (cached = { page: flutterPreviewDocument(await readFlutterWebBuild(local, 'local', dir)), blocked: null });
}
