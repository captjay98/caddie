#!/usr/bin/env bun
/**
 * Owner review item 3 (2026-10-19): ONE live session on the PRODUCTION base
 * image, to prove the CURRENT template app still installs and builds there.
 *
 * WHY: the scaffold's `bun.lock` was regenerated for Bun 1.4.0 and now declares
 * `lockfileVersion: 2`. If the base image ships an older Bun, the recipe's own
 * `bun install --frozen-lockfile` cannot read that lock — and that breaks every
 * new app, not just this probe. react-dom unpacking is the other known hazard.
 *
 * WHAT ACTUALLY RUNS: the real `SandboxDriver` against the real contree service,
 * the real base image, and the real 26-file scaffold imported from
 * `stacks/react-hono/scaffold.ts`. The install and build commands are the
 * recipe's own (`SCAFFOLD_COMMANDS`), and the PATH is production's
 * (`BUILD_RUNTIME_ENV` — tt-base installs Bun outside a non-login shell's
 * default PATH). Nothing here is copied, retyped or mocked.
 *
 * FIRST RUN FAILED: `bun install --frozen-lockfile` on tag:tt-base:1 exited 1
 * with `error: Fail extracting tarball from react-dom` on Bun 1.4.2, and the
 * build then could not resolve `react-dom/client`. A single failure cannot say
 * WHY, so when the install fails the probe now separates the three possible
 * causes — an unreadable lock, a package that cannot be extracted, or an
 * unreachable registry — because each has a different fix. It reports rather
 * than guesses. `CADDIE_LIVE_AUTHORIZED=1` is required; without it this refuses
 * and spends nothing. Values from `.dev.vars` are never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemorySandboxPersistence, SandboxDriver } from '../apps/app/src/server/adapters/sandbox.ts';
import { BUILD_RUNTIME_ENV, DEFAULT_BASE_IMAGE } from '../apps/app/src/server/build-sandbox.ts';
import { VERIFIED_INSTALL_COMMAND, runVerifiedInstall } from '../apps/app/src/server/verified-install.ts';
import { SCAFFOLD_COMMANDS, SCAFFOLD_FILES } from '../stacks/react-hono/scaffold.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMAND_TIMEOUT_MS = 15 * 60_000;

if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error(
		'probe-sandbox-scaffold: BLOCKED — a live sandbox session requires explicit authorization. ' +
			'Set CADDIE_LIVE_AUTHORIZED=1 with owner-approved budget/environment.',
	);
	process.exit(1);
}

// --- credentials (parsed, never printed) ------------------------------------

{
	const devVarsPath = join(REPO_ROOT, '.dev.vars');
	if (existsSync(devVarsPath)) {
		for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
			const match = /^([A-Z_a-z][A-Z0-9_a-z]*)=(.*)$/.exec(line);
			if (match && process.env[match[1]] === undefined && match[2].trim() !== '') {
				process.env[match[1]] = match[2];
			}
		}
	}
}

const BASE_URL = process.env.CONTREE_BASE_URL ?? '';
const API_TOKEN = process.env.CONTREE_API_TOKEN ?? '';
const PROJECT_ID = process.env.CONTREE_PROJECT_ID ?? '';
const IMAGE = process.env.CONTREE_IMAGE ?? DEFAULT_BASE_IMAGE;
if (!BASE_URL || !API_TOKEN || !PROJECT_ID) {
	console.error(
		'probe-sandbox-scaffold: BLOCKED — CONTREE_BASE_URL/CONTREE_API_TOKEN/CONTREE_PROJECT_ID are not set ' +
			'(checked env and .dev.vars).',
	);
	process.exit(1);
}

const RUN_ID = `scaffold-probe-${Date.now()}`;
const APP_DIR = 'app';
const lockfileVersion = /lockfileVersion[^0-9]*([0-9]+)/.exec(SCAFFOLD_FILES['bun.lock'] ?? '')?.[1] ?? '(none)';

function tail(text: string, max = 1200): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

const driver = new SandboxDriver(
	{
		contree: { baseUrl: BASE_URL, apiToken: API_TOKEN, platformProjectId: PROJECT_ID },
		quotas: { maxCommandTimeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: 5 * 1024 * 1024, maxUploadBytes: 20 * 1024 * 1024 },
		workspaceRoot: '/workspace',
		pollIntervalMs: 250,
		dispatchTimeoutMs: 30_000,
	},
	new InMemorySandboxPersistence(),
);

const failures: string[] = [];

/** Print a step's own receipt and record it when it failed. */
function report(
	label: string,
	commandLine: string,
	result: { exitCode: number | null; stdout: string; stderr: string; ms: number },
	verdict: (result: { exitCode: number | null; stdout: string; stderr: string; ms: number }) => { ok: boolean; note?: string },
): boolean {
	const { ok, note } = verdict(result);
	console.log(`\n=== ${label}: ${ok ? 'PASS' : 'FAIL'} (exit ${result.exitCode}, ${result.ms}ms) ===`);
	console.log(`  $ ${commandLine}`);
	if (result.stdout.trim()) console.log(`  stdout: ${tail(result.stdout, 2000)}`);
	if (result.stderr.trim()) console.log(`  stderr: ${tail(result.stderr, 2000)}`);
	if (note) console.log(`  → ${note}`);
	if (!ok) failures.push(label);
	return ok;
}

async function run(
	sessionId: string,
	label: string,
	command: string,
	cwd: string | undefined,
	verdict: (result: { exitCode: number | null; stdout: string; stderr: string; ms: number }) => { ok: boolean; note?: string },
): Promise<boolean> {
	const startedAt = Date.now();
	const result = await driver.execute({
		sessionId,
		command,
		cwd,
		env: BUILD_RUNTIME_ENV,
		operationKey: `${RUN_ID}:${label}`,
		timeoutMs: COMMAND_TIMEOUT_MS,
	});
	return report(label, command + (cwd ? `   (cwd ${cwd})` : ''), { ...result, ms: Date.now() - startedAt }, verdict);
}

const { sessionId } = await driver.ensureSession({ sessionKey: `session:${RUN_ID}`, image: IMAGE, projectId: 'caddie-live-probe', runId: RUN_ID });
console.log(`probe-sandbox-scaffold: session ${sessionId} on image ${IMAGE}`);
console.log(`  scaffold: ${Object.keys(SCAFFOLD_FILES).length} files, bun.lock lockfileVersion ${lockfileVersion}`);
console.log(`  install step: sha512-verify + GNU-tar extract every pinned tarball, then "${VERIFIED_INSTALL_COMMAND}"; build: ${SCAFFOLD_COMMANDS.build.join(' && ')}`);

// 1. The environment facts the diagnosis needs: the base image's Bun, its disk,
//    its memory, its OS. All free, and none of them guesswork.
await run(
	sessionId,
	'environment',
	'bun --version && echo "--- disk ---" && df -h / && echo "--- mem ---" && (free -m 2>/dev/null || echo "free: unavailable") && echo "--- os ---" && head -2 /etc/os-release',
	undefined,
	(r) => ({ ok: r.exitCode === 0 }),
);

// 2. Upload the CURRENT scaffold (imported, not retyped).
const uploaded = await driver.uploadFiles(
	sessionId,
	Object.entries(SCAFFOLD_FILES).map(([path, content]) => ({
		path: `${APP_DIR}/${path}`,
		contentBase64: Buffer.from(content, 'utf8').toString('base64'),
	})),
);
console.log(`\nuploaded ${uploaded.saved} scaffold files under ${APP_DIR}/`);

// 3. THE shared verified install step — the exact function every production
//    install path calls. It fetches each tarball pinned in bun.lock, checks
//    its sha512 BEFORE extracting, extracts with GNU tar, and only then runs
//    the recipe's frozen install. A failure here is the step's own diagnosis
//    (a broken lock, an unverifiable package, or an unreachable registry),
//    not a guess.
const installStartedAt = Date.now();
const installResult = await runVerifiedInstall(driver, {
	sessionId,
	cwd: APP_DIR,
	env: BUILD_RUNTIME_ENV,
	operationKey: `${RUN_ID}:install`,
	timeoutMs: COMMAND_TIMEOUT_MS,
});
const installOk = report(
	'install',
	`verified step: pre-extract pinned tarballs (sha512-checked) then "${VERIFIED_INSTALL_COMMAND}"`,
	{ ...installResult, ms: Date.now() - installStartedAt },
	(r) => {
		const text = `${r.stdout}${r.stderr}`;
		return {
			ok: r.exitCode === 0,
			note: /lockfileVersion|Unrecognized lockfile|expected a lockfile/i.test(text)
				? 'the LOCK itself was rejected (lockfileVersion problem)'
				: /Fail extracting tarball from (\S+)/.exec(text)
					? `a tarball could not be extracted: ${/Fail extracting tarball from (\S+)/.exec(text)![1]}`
					: /verified-install: .*failed|no sha512|could not be read|no bun\.lock/.test(text)
						? 'the verified step refused a package before extracting it (its own message is above)'
						: undefined,
		};
	},
);

if (installOk) {
	// 3b. The same step again, as every later check runs it: each folder's
	//     marker matches its lock entry, so nothing is downloaded twice.
	const againStartedAt = Date.now();
	const again = await runVerifiedInstall(driver, {
		sessionId,
		cwd: APP_DIR,
		env: BUILD_RUNTIME_ENV,
		operationKey: `${RUN_ID}:install-again`,
		timeoutMs: COMMAND_TIMEOUT_MS,
	});
	report('install-again', 'the verified step a second time, as every later check runs it', { ...again, ms: Date.now() - againStartedAt }, (r) => ({
		ok: r.exitCode === 0 && /\(0 downloaded and checked/.test(r.stdout),
		note: /\(0 downloaded and checked/.test(r.stdout) ? 'nothing downloaded again' : 'the second run downloaded packages again',
	}));
	// 3c. The template's own example tests on that tree (DOM, Testing Library,
	//     sign-in, AI). Not `bun run test`: that is `bun test src/`, which fails
	//     on a bare scaffold by design (the gate needs the builder's tests).
	await run(sessionId, 'example-tests', 'bun test test/examples', APP_DIR, (r) => ({
		ok: r.exitCode === 0 && /[1-9]\d* pass/.test(`${r.stdout}\n${r.stderr}`) && !/[1-9]\d* fail/.test(`${r.stdout}\n${r.stderr}`),
	}));
}

if (!installOk) {
	// Three causes, three different fixes. Run them all and let the evidence
	// pick, instead of guessing in the report.
	await run(sessionId, 'state-after-failure', 'ls node_modules 2>/dev/null | wc -l && (ls node_modules/react-dom 2>/dev/null || echo "react-dom: absent")', APP_DIR, (r) => ({ ok: true, note: `partial node_modules: ${r.stdout.trim().split('\n')[0]} entries` }));

	// (a) Is it the LOCK? A clean cache + a plain, lock-ignoring install says so.
	await run(sessionId, 'retry-frozen-clean-cache', 'rm -rf node_modules /root/.bun/install/cache && bun install --frozen-lockfile', APP_DIR, (r) => ({ ok: r.exitCode === 0, note: r.exitCode === 0 ? 'transient: the frozen install works on a retry' : 'deterministic so far: the same frozen install fails again' }));
	await run(sessionId, 'install-unfrozen', 'rm -rf node_modules && bun install', APP_DIR, (r) => ({ ok: r.exitCode === 0, note: r.exitCode === 0 ? 'the LOCK is not the problem: resolution ignores it and succeeds' : 'not lock-specific: a plain install fails too' }));

	// (b) Is it the PACKAGE/REGISTRY? Fetch the exact tarball and extract it
	//     with tar, which shares no code with Bun's extractor.
	await run(
		sessionId,
		'react-dom-tarball',
		'curl -sS -o /tmp/react-dom.tgz -w "http %{http_code}, %{size_download} bytes\\n" https://registry.npmjs.org/react-dom/-/react-dom-19.2.0.tgz && echo "--- tar listing ---" && tar tzf /tmp/react-dom.tgz | head -3 && echo "--- tar extract ---" && mkdir -p /tmp/tar-check && tar xzf /tmp/react-dom.tgz -C /tmp/tar-check && ls /tmp/tar-check/package | head -5',
		undefined,
		(r) => ({ ok: r.exitCode === 0, note: r.exitCode === 0 ? 'the tarball downloads AND untars: the registry and the archive are fine, so the failure is inside Bun' : 'the tarball could not be fetched/untarred: registry or archive problem' }),
	);
	// (c) Is it Bun's extractor, a mirror the image is configured with, or
	//     react-dom alone? Three cheap commands separate them.
	await run(sessionId, 'react-vs-react-dom', 'ls node_modules/react/package.json 2>/dev/null || echo "react: absent"; echo "--- registry config ---"; for f in /root/.npmrc /etc/npmrc bunfig.toml /root/.bunfig.toml; do [ -f "$f" ] && echo "$f:" && sed -E "s#(_authToken|token|_auth)=.*#\\1=<redacted>#" "$f"; done; echo "--- end config ---"', APP_DIR, (r) => ({ ok: true }));
	await run(sessionId, 'install-via-npmjs-direct', 'rm -rf node_modules && bun install --frozen-lockfile --registry https://registry.npmjs.org', APP_DIR, (r) => ({ ok: r.exitCode === 0, note: r.exitCode === 0 ? 'a registry override FIXES it: the image is pointed at a broken mirror' : 'the registry is not the variable: Bun itself cannot extract react-dom' }));
	await run(
		sessionId,
		'isolate-react-dom',
		'mkdir -p /tmp/rd && cd /tmp/rd && printf \'%s\' \'{"name":"t","dependencies":{"react-dom":"19.2.0"}}\' > package.json && bun install 2>&1 | tail -6',
		undefined,
		(r) => ({ ok: r.exitCode === 0, note: 'no lock, no scaffold, one dependency — isolates the package from everything else' }),
	);
}

// 4. The recipe's own build — the real end-to-end proof the tree is usable.
await run(sessionId, 'build', SCAFFOLD_COMMANDS.build.join(' && '), APP_DIR, (r) => ({ ok: r.exitCode === 0 }));

// 5. A receipt that ties the claim to real files on the real filesystem.
const built = await driver.statFile(sessionId, `${APP_DIR}/dist/server.js`).catch(() => null);
const modules = await driver.listDir(sessionId, `${APP_DIR}/node_modules/react-dom`).catch((): string[] => []);
console.log(`\n  dist/server.js: ${built?.isFile ? `${built.size} bytes` : 'MISSING'}`);
console.log(`  node_modules/react-dom unpacked: ${modules.includes('package.json') ? 'yes' : 'no'}`);

await driver.dispose(sessionId);

console.log(`\n=== SUMMARY ===`);
console.log(`  ${failures.length === 0 ? 'PASS' : `FAIL — failing steps: ${failures.join(', ')}`}`);
console.log(`  image ${IMAGE}; lockfileVersion ${lockfileVersion}; scaffold ${Object.keys(SCAFFOLD_FILES).length} files`);
process.exit(failures.length === 0 ? 0 : 1);
