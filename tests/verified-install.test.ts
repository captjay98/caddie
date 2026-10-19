import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SandboxExecuteInput, SandboxExecuteResult } from '../apps/app/src/server/adapters/sandbox.ts';
import {
	VERIFIED_INSTALL_COMMAND,
	VERIFIED_INSTALL_SCRIPT,
	runVerifiedInstall,
	verifiedInstallPreflightCommand,
} from '../apps/app/src/server/verified-install.ts';

/**
 * The verified install step (owner review item 3): every tarball bun.lock pins
 * is downloaded, checked against its sha512 BEFORE it is unpacked, and
 * unpacked with tar into the folder its lock key names; only then does the
 * frozen install run.
 *
 * LOCAL VERIFIED: the script that ships (VERIFIED_INSTALL_SCRIPT, imported
 * from a temp file and also run as a file through the preflight's own
 * here-document) against a registry served on 127.0.0.1 with real gzip
 * tarballs, and the host step's ordering against a recording driver. The real
 * sandbox and the real npm registry are the live probe's job
 * (scripts/probe-sandbox-scaffold.ts), not this file's.
 */

interface Placed { key: string; dir: string; name: string; version: string; integrity: string }
interface Parsed { packages: Placed[]; leftToBun: string[]; otherPlatform: string[]; missingIntegrity: string[]; parseError?: string }
interface Script {
	MARKER: string;
	installDirFor(key: string): string | null;
	platformMatches(meta: unknown, platform: string, arch: string): boolean;
	parseLockPackages(lockText: string, platform: string, arch: string): Parsed;
	stripTrailingCommas(text: string): string;
	tarballUrlFor(name: string, version: string, registryBase?: string): string;
	verifyIntegrity(expected: string, actualBase64: string): boolean;
	main(cwd: string, env: Record<string, string | undefined>, platform: string, arch: string): Promise<number>;
}

const scratch = mkdtempSync(join(tmpdir(), 'verified-install-'));
const scriptPath = join(scratch, 'verified-install.mjs');
let script: Script;

/** Tarballs by registry path, and every path the registry was asked for. */
const tarballs = new Map<string, Uint8Array>();
const requested: string[] = [];
let registry: ReturnType<typeof Bun.serve>;
let registryUrl = '';

const sha512 = (bytes: Uint8Array) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** A real npm-style tarball: gzip'd tar with everything under `package/`. */
function packTarball(name: string, version: string, extra: Record<string, string> = {}): Uint8Array {
	const root = mkdtempSync(join(scratch, 'pack-'));
	const files: Record<string, string> = {
		'package.json': JSON.stringify({ name, version, main: 'index.js' }),
		'index.js': `module.exports = ${JSON.stringify(`${name}@${version}`)};\n`,
		...extra,
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, 'package', path)), { recursive: true });
		writeFileSync(join(root, 'package', path), text);
	}
	const out = join(root, 'out.tgz');
	const tar = Bun.spawnSync(['tar', '-czf', out, '-C', root, 'package']);
	if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
	return new Uint8Array(readFileSync(out));
}

/** Publish name@version to the local registry; returns the bytes it serves. */
function publish(name: string, version: string, extra: Record<string, string> = {}): Uint8Array {
	const bytes = packTarball(name, version, extra);
	tarballs.set(new URL(script.tarballUrlFor(name, version, registryUrl)).pathname, bytes);
	return bytes;
}

/** A bun.lock in Bun's own JSONC shape (trailing commas included). */
function lockText(packages: Record<string, unknown[]>): string {
	const body = Object.entries(packages)
		.map(([key, value]) => `    ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
		.join('\n\n');
	return `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "caddie-project",\n    },\n  },\n  "packages": {\n${body}\n  }\n}\n`;
}

function appWith(lock: string | null): string {
	const app = mkdtempSync(join(scratch, 'app-'));
	writeFileSync(join(app, 'package.json'), '{ "name": "caddie-project" }\n');
	if (lock !== null) writeFileSync(join(app, 'bun.lock'), lock);
	return app;
}

/** Run the shipped script's main() with the registry pointed at the local one, capturing its output. */
async function run(app: string, platform = 'linux', arch = 'x64') {
	const out: string[] = [];
	const err: string[] = [];
	const { log, error } = console;
	console.log = (...args: unknown[]) => void out.push(args.join(' '));
	console.error = (...args: unknown[]) => void err.push(args.join(' '));
	try {
		const code = await script.main(app, { CADDIE_NPM_REGISTRY: registryUrl }, platform, arch);
		return { code, stdout: out.join('\n'), stderr: err.join('\n') };
	} finally {
		console.log = log;
		console.error = error;
	}
}

const read = (app: string, path: string) => readFileSync(join(app, path), 'utf8');

beforeAll(async () => {
	writeFileSync(scriptPath, VERIFIED_INSTALL_SCRIPT);
	script = (await import(scriptPath)) as Script;
	registry = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			requested.push(path);
			const bytes = tarballs.get(path);
			return bytes ? new Response(new Blob([bytes as Uint8Array<ArrayBuffer>])) : new Response('not found', { status: 404 });
		},
	});
	registryUrl = `http://127.0.0.1:${registry.port}`;
});

afterAll(() => {
	registry.stop(true);
	rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
	tarballs.clear();
	requested.length = 0;
});

describe('reading bun.lock', () => {
	test('each lock key names its own folder, nested and scoped ones included', () => {
		expect(script.installDirFor('react')).toBe('node_modules/react');
		expect(script.installDirFor('@better-auth/core')).toBe('node_modules/@better-auth/core');
		expect(script.installDirFor('bun-types/undici-types')).toBe('node_modules/bun-types/node_modules/undici-types');
		expect(script.installDirFor('@testing-library/jest-dom/dom-accessibility-api')).toBe(
			'node_modules/@testing-library/jest-dom/node_modules/dom-accessibility-api',
		);
		expect(script.installDirFor('@s/x/@t/y')).toBe('node_modules/@s/x/node_modules/@t/y');
	});

	test('a key that is not a plain package path names no folder, so nothing lands outside node_modules', () => {
		for (const key of ['', '.', '..', '../escape', 'a/../../escape', 'a//b', 'a/./b', '@s', '@s/..', '@../x', 'a b', 'a\\b']) {
			expect({ key, dir: script.installDirFor(key) }).toEqual({ key, dir: null });
		}
	});

	test('sorts every entry: placed here, left to Bun, another platform, or refused for having no sha512', () => {
		const good = 'sha512-' + 'A'.repeat(86) + '==';
		const parsed = script.parseLockPackages(
			lockText({
				react: ['react@19.2.0', '', {}, good],
				'@scope/beta': ['@scope/beta@1.0.0', '', { dependencies: { 'a,}': '1' } }, good],
				'alpha/gamma': ['gamma@2.0.0', '', {}, good],
				'my-alias': ['real-package@3.1.4', '', {}, good],
				'linux-only': ['linux-only@1.0.0', '', { os: 'linux', cpu: 'x64' }, good],
				'not-windows': ['not-windows@1.0.0', '', { os: ['!win32'] }, good],
				'darwin-only': ['darwin-only@1.0.0', '', { os: 'darwin', cpu: ['arm64'] }, good],
				'arm-only': ['arm-only@1.0.0', '', { cpu: ['arm64', 'arm'] }, good],
				workspace: ['workspace@workspace:packages/workspace'],
				fromgit: ['fromgit@github:octo/fromgit#abc123', {}, 'octo-fromgit-abc123'],
				private: ['private@1.0.0', 'https://npm.example.com/', {}, good],
				'../escape': ['escape@1.0.0', '', {}, good],
				oldhash: ['oldhash@1.0.0', '', {}, 'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA='],
				nohash: ['nohash@1.0.0', '', {}],
			}),
			'linux',
			'x64',
		);
		expect(parsed.parseError).toBeUndefined();
		expect(parsed.packages.map((p) => [p.key, p.name, p.version, p.dir])).toEqual([
			['react', 'react', '19.2.0', 'node_modules/react'],
			['@scope/beta', '@scope/beta', '1.0.0', 'node_modules/@scope/beta'],
			['alpha/gamma', 'gamma', '2.0.0', 'node_modules/alpha/node_modules/gamma'],
			['my-alias', 'real-package', '3.1.4', 'node_modules/my-alias'],
			['linux-only', 'linux-only', '1.0.0', 'node_modules/linux-only'],
			['not-windows', 'not-windows', '1.0.0', 'node_modules/not-windows'],
		]);
		expect(parsed.otherPlatform).toEqual(['darwin-only', 'arm-only']);
		expect(parsed.leftToBun).toEqual(['workspace', 'fromgit', 'private', '../escape']);
		expect(parsed.missingIntegrity).toEqual(['oldhash', 'nohash']);
	});

	test("Bun's JSONC is read without touching commas inside strings", () => {
		expect(JSON.parse(script.stripTrailingCommas('{"a": [1, 2,], "b": "x,}", "c": "q\\",]",}'))).toEqual({ a: [1, 2], b: 'x,}', c: 'q",]' });
		expect(script.parseLockPackages('{ not json', 'linux', 'x64').parseError).toBeString();
	});

	test('the template lock: every registry package is placed by the step, nested ones too', async () => {
		const { SCAFFOLD_LOCKFILE } = await import('../stacks/react-hono/scaffold-lock.ts');
		const parsed = script.parseLockPackages(SCAFFOLD_LOCKFILE, 'linux', 'x64');
		expect(parsed.parseError).toBeUndefined();
		expect(parsed.missingIntegrity).toEqual([]);
		expect(parsed.leftToBun).toEqual([]);
		expect(parsed.packages.length).toBe(Object.keys(JSON.parse(script.stripTrailingCommas(SCAFFOLD_LOCKFILE)).packages).length);
		expect(parsed.packages.find((p) => p.name === 'react-dom')).toMatchObject({ version: '19.2.0', dir: 'node_modules/react-dom' });
		expect(parsed.packages.find((p) => p.key === 'bun-types/undici-types')).toMatchObject({ dir: 'node_modules/bun-types/node_modules/undici-types' });
	});

	test('tarball addresses and the sha512 comparison', () => {
		expect(script.tarballUrlFor('react-dom', '19.2.0')).toBe('https://registry.npmjs.org/react-dom/-/react-dom-19.2.0.tgz');
		expect(script.tarballUrlFor('@better-auth/core', '1.7.10', 'http://127.0.0.1:9/')).toBe('http://127.0.0.1:9/@better-auth/core/-/core-1.7.10.tgz');
		const bytes = new TextEncoder().encode('tarball bytes');
		const integrity = sha512(bytes);
		const actual = integrity.slice('sha512-'.length);
		expect(script.verifyIntegrity(integrity, actual)).toBe(true);
		expect(script.verifyIntegrity(integrity, (actual[0] === 'A' ? 'B' : 'A') + actual.slice(1))).toBe(false);
		expect(script.verifyIntegrity(integrity, actual.slice(1))).toBe(false);
		expect(script.verifyIntegrity(`sha1-${actual}`, actual)).toBe(false);
	});
});

describe('the script against a local registry', () => {
	function threePackages() {
		const alpha = publish('alpha', '1.0.0');
		const beta = publish('@scope/beta', '1.0.0');
		const gamma = publish('gamma', '2.0.0');
		return {
			bytes: { alpha, beta, gamma },
			lock: lockText({
				alpha: ['alpha@1.0.0', '', { dependencies: { gamma: '2.0.0' } }, sha512(alpha)],
				'@scope/beta': ['@scope/beta@1.0.0', '', {}, sha512(beta)],
				'alpha/gamma': ['gamma@2.0.0', '', {}, sha512(gamma)],
			}),
		};
	}

	test('downloads, checks and unpacks every pinned package into its own folder', async () => {
		const { lock, bytes } = threePackages();
		const app = appWith(lock);
		const result = await run(app);
		expect(result).toMatchObject({ code: 0, stderr: '' });
		expect(result.stdout).toContain('3 pinned package(s) match bun.lock (3 downloaded and checked, 0 already checked)');
		expect(read(app, 'node_modules/alpha/index.js')).toContain('alpha@1.0.0');
		expect(read(app, 'node_modules/@scope/beta/index.js')).toContain('@scope/beta@1.0.0');
		expect(read(app, 'node_modules/alpha/node_modules/gamma/index.js')).toContain('gamma@2.0.0');
		// The archive's top "package/" folder is dropped, and the marker holds the integrity it matched.
		expect(existsSync(join(app, 'node_modules/alpha/package'))).toBe(false);
		expect(read(app, `node_modules/@scope/beta/${script.MARKER}`)).toBe(sha512(bytes.beta));
		expect(requested.sort()).toEqual(['/@scope/beta/-/beta-1.0.0.tgz', '/alpha/-/alpha-1.0.0.tgz', '/gamma/-/gamma-2.0.0.tgz']);
	});

	test('a second run downloads nothing: each folder already holds the bytes its lock entry names', async () => {
		const { lock } = threePackages();
		const app = appWith(lock);
		expect((await run(app)).code).toBe(0);
		requested.length = 0;
		const again = await run(app);
		expect(again.code).toBe(0);
		expect(again.stdout).toContain('(0 downloaded and checked, 3 already checked)');
		expect(requested).toEqual([]);
	});

	test('a tarball that does not match its sha512 is refused and never unpacked, and the hash is never printed', async () => {
		const { lock, bytes } = threePackages();
		// The registry now serves different bytes for beta than the lock pinned.
		const swapped = packTarball('@scope/beta', '1.0.0', { 'index.js': 'module.exports = "swapped";\n' });
		tarballs.set('/@scope/beta/-/beta-1.0.0.tgz', swapped);
		const app = appWith(lock);
		const result = await run(app);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('@scope/beta@1.0.0: the downloaded tarball does not match the sha512 in bun.lock, so it was not unpacked');
		expect(existsSync(join(app, 'node_modules/@scope/beta'))).toBe(false);
		for (const hash of [sha512(bytes.beta), sha512(swapped)]) {
			expect(result.stderr).not.toContain(hash.slice('sha512-'.length, 40));
		}
		expect(result.stderr).not.toContain('sha512-');
	});

	test('an older copy in a folder is replaced, and the folder keeps its own nested packages', async () => {
		const { lock } = threePackages();
		const app = appWith(lock);
		mkdirSync(join(app, 'node_modules/alpha/node_modules/gamma'), { recursive: true });
		writeFileSync(join(app, 'node_modules/alpha/stale.js'), 'old');
		writeFileSync(join(app, `node_modules/alpha/${script.MARKER}`), 'sha512-somethingelse');
		writeFileSync(join(app, 'node_modules/alpha/package.json'), '{"name":"alpha","version":"0.9.0"}');
		writeFileSync(join(app, 'node_modules/alpha/node_modules/gamma/keep.txt'), 'nested');
		const result = await run(app);
		expect(result.code).toBe(0);
		expect(existsSync(join(app, 'node_modules/alpha/stale.js'))).toBe(false);
		expect(JSON.parse(read(app, 'node_modules/alpha/package.json')).version).toBe('1.0.0');
		expect(read(app, 'node_modules/alpha/node_modules/gamma/index.js')).toContain('gamma@2.0.0');
	});

	test('an entry with no sha512 stops everything before a single download', async () => {
		const { bytes } = threePackages();
		const app = appWith(lockText({ alpha: ['alpha@1.0.0', '', {}, sha512(bytes.alpha)], nohash: ['nohash@1.0.0', '', {}] }));
		const result = await run(app);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no sha512 to check against, so nothing was installed: nohash');
		expect(requested).toEqual([]);
		expect(existsSync(join(app, 'node_modules'))).toBe(false);
	});

	test('no bun.lock, an unreadable lock, or a package the registry does not have: the step fails, naming it', async () => {
		expect((await run(appWith(null))).stderr).toContain('there is no bun.lock');
		expect((await run(appWith('{ "packages": '))).stderr).toContain('bun.lock could not be read');
		const missing = await run(appWith(lockText({ ghost: ['ghost@1.0.0', '', {}, sha512(new Uint8Array([1]))] })));
		expect(missing).toMatchObject({ code: 1 });
		expect(missing.stderr).toContain('ghost@1.0.0: the registry answered HTTP 404');
	});

	test('a lock key that is not a plain package path is left to Bun and nothing is written outside the app', async () => {
		const evil = publish('escape', '1.0.0');
		const app = appWith(lockText({ '../../escape': ['escape@1.0.0', '', {}, sha512(evil)] }));
		const before = readdirSync(dirname(app)).sort();
		const result = await run(app);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('0 pinned package(s) match bun.lock (0 downloaded and checked, 0 already checked); 1 left to bun');
		expect(readdirSync(dirname(app)).sort()).toEqual(before);
		expect(requested).toEqual([]);
	});

	test('a package for another platform is skipped, as Bun would', async () => {
		const linux = publish('native-linux', '1.0.0');
		const app = appWith(
			lockText({
				'native-linux': ['native-linux@1.0.0', '', { os: 'linux', cpu: 'x64' }, sha512(linux)],
				'native-darwin': ['native-darwin@1.0.0', '', { os: 'darwin', cpu: 'arm64' }, sha512(new Uint8Array([2]))],
			}),
		);
		const result = await run(app, 'linux', 'x64');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('1 for another platform skipped');
		expect(existsSync(join(app, 'node_modules/native-darwin'))).toBe(false);
		expect(read(app, 'node_modules/native-linux/index.js')).toContain('native-linux@1.0.0');
	});

	test("the preflight command's here-document writes the script intact and runs it with bun, exit code included", async () => {
		const { lock } = threePackages();
		const good = appWith(lock);
		const target = join(scratch, 'from-heredoc.mjs');
		const command = verifiedInstallPreflightCommand().replaceAll('/tmp/caddie-verified-install.mjs', target);
		const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, CADDIE_NPM_REGISTRY: registryUrl, TMPDIR: scratch };
		// Async: the registry the child downloads from is served by this process.
		const shell = async (cwd: string) => {
			const child = Bun.spawn(['sh', '-c', command], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
			const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
			return { exit, stderr };
		};
		expect(await shell(good)).toEqual({ exit: 0, stderr: '' });
		expect(readFileSync(target, 'utf8')).toBe(VERIFIED_INSTALL_SCRIPT + '\n');
		expect(read(good, 'node_modules/alpha/node_modules/gamma/index.js')).toContain('gamma@2.0.0');

		const refused = await shell(appWith(lockText({ nohash: ['nohash@1.0.0', '', {}] })));
		expect(refused.exit).toBe(1);
		expect(refused.stderr).toContain('nohash');
	}, 20_000);
});

describe('runVerifiedInstall, the host step', () => {
	function recordingDriver(outcomes: Array<Partial<SandboxExecuteResult>>) {
		const calls: SandboxExecuteInput[] = [];
		const driver = {
			async execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult> {
				calls.push(input);
				const next = outcomes.shift() ?? {};
				return { remoteId: `op-${calls.length}`, exitCode: 0, stdout: '', stderr: '', ...next };
			},
		};
		return { driver, calls };
	}
	const options = { sessionId: 'session-1', cwd: '/workspace/p1', env: { PATH: '/root/.bun/bin:/usr/bin' }, operationKey: 'checks:run-1:dependencies' };

	test('runs the check first, then the frozen install, in the same folder with the same env', async () => {
		const { driver, calls } = recordingDriver([
			{ stdout: 'verified-install: 63 pinned package(s) match bun.lock (63 downloaded and checked, 0 already checked)\n' },
			{ stdout: 'Checked 63 installs across 64 packages (no changes)' },
		]);
		const result = await runVerifiedInstall(driver, options);
		expect(calls.map((c) => [c.operationKey, c.command === verifiedInstallPreflightCommand() ? 'preflight' : c.command])).toEqual([
			['checks:run-1:dependencies:verify', 'preflight'],
			['checks:run-1:dependencies', VERIFIED_INSTALL_COMMAND],
		]);
		expect(VERIFIED_INSTALL_COMMAND).toBe('bun install --frozen-lockfile');
		for (const call of calls) expect(call).toMatchObject({ sessionId: 'session-1', cwd: '/workspace/p1', env: options.env, timeoutMs: 600_000 });
		// The frozen install's result, with the check's summary first for the activity log.
		expect(result.remoteId).toBe('op-2');
		expect(result.stdout).toBe('verified-install: 63 pinned package(s) match bun.lock (63 downloaded and checked, 0 already checked)\nChecked 63 installs across 64 packages (no changes)');
	});

	test('a failed check is returned as it is and the frozen install never runs', async () => {
		const refusal = { exitCode: 1, stderr: 'verified-install: 1 package(s) failed, so nothing more was installed:\n  - react-dom@19.2.0: the downloaded tarball does not match the sha512 in bun.lock, so it was not unpacked' };
		const { driver, calls } = recordingDriver([refusal]);
		const result = await runVerifiedInstall(driver, { ...options, timeoutMs: 1234 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ operationKey: 'checks:run-1:dependencies:verify', timeoutMs: 1234 });
		expect(result).toMatchObject({ remoteId: 'op-1', ...refusal });
	});
});
