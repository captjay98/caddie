#!/usr/bin/env bun
/**
 * Journey runner for the P09 React+Hono proof — the REAL local journey.
 *
 * Executes the acceptance manifest phases (tests/acceptance/manifest.json —
 * the immutable evaluator; its hash is taken before and after the run) inside
 * the LIVE contree sandbox via tests/fixtures/journey-sandbox.ts, the
 * LIVE-VERIFIED contree CLI path:
 *
 *   seed        upload the fixture into /work/forge-task-tracker, verify per-file sha256
 *   install     bun install --frozen-lockfile          (manifest phase, expect exit 0)
 *   seeded-test bun test src/                          (manifest phase, expect exit 0)
 *   build       bun run build                          (manifest phase, expect exit 0)
 *   red         flip the seeded expectation 2→3, bun test src/routes.test.ts
 *                                                      (manifest deliberate-red, expect nonzero)
 *   repair      restore the file, re-run to exit 0 within the repair budget (3)
 *   server      bun run start + poll GET /api/health   (expect HTTP 200 within 10s, in-sandbox)
 *   artifact    copy the sandbox-built dist/main.js out, hash both sides
 *   browser     Playwright UI assertions against the exported artifact
 *               (tests/browser/forge-journey.spec.ts on this host)
 *
 * Honesty rules:
 *   - Requires CADDIE_LIVE_AUTHORIZED=1 in the process env — authorization is
 *     an explicit owner act and is NEVER read from .dev.vars. Credential
 *     VALUES are loaded from .dev.vars (gitignored) or the process env and
 *     are never printed.
 *   - Without the gate the runner prints BLOCKED and exits nonzero — it never
 *     fabricates a run (tests/p09-local.test.ts pins this).
 *   - A phase that fails records FAILED; nothing substitutes command exit
 *     codes and browser assertions for success.
 *   - The model-driven agent loop (brief→plan→specialists) is NOT part of
 *     this runner: it needs the Flue DO runtime (dev-server integration) and
 *     is recorded as a limitation, not simulated.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JourneySandbox } from '../tests/fixtures/journey-sandbox.ts';

const REPO = join(import.meta.dir, '..');
const MANIFEST_PATH = join(REPO, 'tests', 'acceptance', 'manifest.json');
const FIXTURE_DIR = join(REPO, 'tests', 'fixtures', 'forge-task-tracker');
const TEMPLATE_DIR = join(REPO, 'stacks', 'react-hono', 'template');
const DEV_VARS_CANDIDATES = [
	join(REPO, '.dev.vars'),
	// Gitignored, so worktree checkouts do not have it — fall back to the main
	// checkout root where the owner provisions it.
	join(REPO, '..', '.dev.vars'),
	join(REPO, '..', '..', '.dev.vars'),
];
const BROWSER_SPEC = join(REPO, 'tests', 'browser', 'forge-journey.spec.ts');

const SESSION_KEY = 'p09-journey';
const WORKSPACE = '/work/forge-task-tracker';
const REPAIR_BUDGET = 3; // manifest.repairPolicy.maxAttemptsPerIssue
const SERVER_PORT = 8791; // host-side port for the browser phase

/** Every seeded fixture file — the tamper-checked seed set. */
const FIXTURE_FILES = [
	'package.json',
	'bun.lock',
	'tsconfig.json',
	'public/index.html',
	'src/app.ts',
	'src/routes.test.ts',
	'src/server.ts',
	'src/main.tsx',
];

interface PhaseEvidence {
	id: string;
	command: string;
	exitCode: number | null;
	expected: string;
	outcome: 'PASS' | 'FAIL';
	durationMs: number;
	receipt: string;
}

interface Evidence {
	packet: 'P09';
	status: 'PASS' | 'FAILED' | 'BLOCKED';
	manifestSha256: string;
	fixtureFiles: Record<string, string>;
	sandboxSession: string;
	sandboxImage: string;
	workspace: string;
	phases: PhaseEvidence[];
	repairAttempts: number;
	artifact: { path: string; sha256: string } | null;
	limitations: string[];
}

// --- helpers -----------------------------------------------------------------

function sha256(data: string | Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

function manifestHash(): string {
	return sha256(readFileSync(MANIFEST_PATH));
}

function fixtureFileHashes(): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const file of FIXTURE_FILES) {
		hashes[file] = sha256(readFileSync(join(FIXTURE_DIR, file)));
	}
	return hashes;
}

/** Digest of the frozen stack template dir: sha256 over sorted `path hash` lines. */
function templateDigest(): string {
	const lines: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		for (const entry of Array.from(new Bun.Glob('**/*').scanSync({ cwd: dir, onlyFiles: true })).sort()) {
			lines.push(`${prefix}${entry} ${sha256(readFileSync(join(dir, entry)))}`);
		}
	};
	walk(TEMPLATE_DIR, '');
	return `sha256:${sha256(lines.join('\n'))}`;
}

/**
 * Parse the first existing .dev.vars (KEY=VALUE lines). Values are returned
 * for use and are NEVER logged, echoed, or embedded in evidence.
 */
function loadDevVars(): Record<string, string> {
	const values: Record<string, string> = {};
	const path = DEV_VARS_CANDIDATES.find((candidate) => existsSync(candidate));
	if (!path) return values;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '' || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq <= 0) continue;
		values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return values;
}

/** Presence-only disclosure: secret VALUES are never echoed, even in part. */
function redact(value: string | undefined): string {
	return value ? 'present' : 'absent';
}

/** Remove ANSI escapes so receipt regexes see plain text. */
function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Resolve a package's pinned version from bun.lock (v2 text format):
 * `"react-dom": ["react-dom@19.3.0", …` → `19.3.0`.
 */
function lockVersionFor(pkg: string, lockText: string): string | null {
	const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = new RegExp(`"${escaped}":\\s*\\["${escaped}@([^"]+)"`).exec(lockText);
	return match?.[1] ?? null;
}

// --- gate ---------------------------------------------------------------------

function gate(): { ok: true; env: Record<string, string> } | { ok: false; reason: string; seed: Evidence | null } {
	if (!existsSync(MANIFEST_PATH)) {
		return { ok: false, reason: 'acceptance manifest missing', seed: null };
	}
	const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1';
	const devVars = loadDevVars();
	const env = { ...process.env, ...devVars } as Record<string, string>;
	const hasSandbox = Boolean(env.CONTREE_BASE_URL && env.CONTREE_API_TOKEN);
	const hasModel = Boolean(env.NEBIUS_API_KEY);

	const seed: Evidence = {
		packet: 'P09',
		status: 'BLOCKED',
		manifestSha256: manifestHash(),
		fixtureFiles: fixtureFileHashes(),
		sandboxSession: SESSION_KEY,
		sandboxImage: 'tag:tt-base:1',
		workspace: WORKSPACE,
		phases: [],
		repairAttempts: 0,
		artifact: null,
		limitations: [],
	};

	if (!authorized || !hasSandbox || !hasModel) {
		const missing = [
			!authorized && 'CADDIE_LIVE_AUTHORIZED=1 (explicit authorization, never from .dev.vars)',
			!hasSandbox && 'CONTREE_BASE_URL/CONTREE_API_TOKEN (sandbox credentials)',
			!hasModel && 'NEBIUS_API_KEY (model credentials)',
		].filter(Boolean);
		return {
			ok: false,
			reason: `BLOCKED — the live journey requires explicit authorization and owner credentials. Missing: ${missing.join('; ')}.`,
			seed,
		};
	}
	return { ok: true, env };
}

// --- journey --------------------------------------------------------------------

async function runJourney(env: Record<string, string>): Promise<Evidence> {
	const { recipe } = await import(join(REPO, 'stacks', 'react-hono', 'recipe.ts'));
	const manifestBefore = manifestHash();
	const localHashes = fixtureFileHashes();
	const phases: PhaseEvidence[] = [];
	let repairAttempts = 0;
	let artifact: Evidence['artifact'] = null;
	const limitations: string[] = [];

	const record = (
		id: string,
		command: string,
		expected: string,
		started: number,
		result: { exitCode: number | null; receipt: string },
	): PhaseEvidence => {
		const phase: PhaseEvidence = {
			id,
			command,
			exitCode: result.exitCode,
			expected,
			outcome: result.exitCode !== null && result.exitCode === 0 ? 'PASS' : 'FAIL',
			durationMs: Date.now() - started,
			receipt: result.receipt,
		};
		phases.push(phase);
		return phase;
	};

	// Freeze check: the runner refuses to start when the stack template no
	// longer matches the digest frozen in the recipe.
	const digest = templateDigest();
	if (digest !== recipe.imageDigest) {
		throw new Error(
			`stack template digest ${digest} does not match the frozen recipe imageDigest ${recipe.imageDigest} — refreeze the recipe before running the journey`,
		);
	}

	const sandbox = new JourneySandbox(SESSION_KEY);
	await sandbox.init();
	const seedStart = Date.now();
	for (const file of FIXTURE_FILES) {
		await sandbox.writeFile(
			`${WORKSPACE}/${file}`,
			readFileSync(join(FIXTURE_DIR, file), 'utf8'),
		);
	}
	// Per-file integrity proof: sandbox sha256sum must equal the local seed.
	const verifyScript = `cd ${WORKSPACE} && sha256sum ${FIXTURE_FILES.join(' ')}`;
	const seedVerify = await sandbox.exec(verifyScript, { timeoutMs: 120_000 });
	const sandboxLines = new Map<string, string>();
	for (const line of seedVerify.stdout.split('\n')) {
		const [hash, ...pathParts] = line.trim().split(/\s+/);
		if (hash && pathParts.length > 0) sandboxLines.set(pathParts.join(' '), hash);
	}
	const seedMismatches = FIXTURE_FILES.filter((f) => sandboxLines.get(f) !== localHashes[f]);
	record(
		'seed',
		`contree file cp ×${FIXTURE_FILES.length} + ${verifyScript}`,
		'every seeded file hash matches in the sandbox',
		seedStart,
		{
			exitCode: seedMismatches.length === 0 ? 0 : 1,
			receipt:
				seedMismatches.length === 0
					? `${FIXTURE_FILES.length} files uploaded and sha256-verified in ${WORKSPACE}`
					: `hash mismatch: ${seedMismatches.join(', ')}`,
		},
	);

	// --- manifest phase: install --------------------------------------------------
	{
		const start = Date.now();
		// Fresh install every run — a no-op "no changes" proves nothing.
		await sandbox.exec(`cd ${WORKSPACE} && rm -rf node_modules`, { timeoutMs: 60_000 });
		let r = await sandbox.exec(`cd ${WORKSPACE} && bun install --frozen-lockfile`, {
			timeoutMs: 300_000,
		});
		const recoveries: string[] = [];
		if (r.exitCode !== 0) {
			// KNOWN SANDBOX LIMITATION (diagnosed at the P09 execution window):
			// bun cannot extract the react-dom tarball under this sandbox
			// isolation — reproduced across bun 1.4.0/1.4.2, both install
			// backends, and relocated caches, while GNU tar extracts the same
			// tarball fine and the same bun version extracts it fine off-sandbox
			// (root cause inside bun's extractor × sandbox syscall layer; not
			// fully diagnosed). framework_recovery (uncounted per the manifest
			// repairPolicy): fetch the failing tarballs from the registry
			// IN-SANDBOX and extract them with GNU tar, then let the frozen
			// install verify the whole tree.
			const broken = [
				...new Set(
					[...(r.stdout + r.stderr).matchAll(/Fail extracting tarball from ([\w@./-]+)/g)].map(
						(m) => m[1],
					),
				),
			];
			if (broken.length > 0) {
				for (const pkg of broken) {
					const version = lockVersionFor(pkg, readFileSync(join(FIXTURE_DIR, 'bun.lock'), 'utf8'));
					if (!version) {
						recoveries.push(`${pkg}: version not found in bun.lock — not recovered`);
						continue;
					}
					const name = pkg.includes('/') ? pkg.split('/')[1] : pkg;
					const scopeDir = pkg.includes('/')
						? `${WORKSPACE}/node_modules/${pkg.split('/')[0]}`
						: `${WORKSPACE}/node_modules`;
					const recovered = await sandbox.exec(
						`mkdir -p ${scopeDir}/${name} && curl -fsSL -o /tmp/.p09-pkg.tgz ` +
							`https://registry.npmjs.org/${pkg}/-/${name}-${version}.tgz && ` +
							`tar -xzf /tmp/.p09-pkg.tgz -C ${scopeDir}/${name} --strip-components=1`,
						{ timeoutMs: 180_000 },
					);
					recoveries.push(
						recovered.exitCode === 0
							? `${pkg}@${version} fetched from the registry in-sandbox and extracted via GNU tar (bun's extractor fails on this tarball under the sandbox isolation)`
							: `${pkg}@${version}: tar recovery FAILED (exit ${recovered.exitCode})`,
					);
				}
				r = await sandbox.exec(`cd ${WORKSPACE} && bun install --frozen-lockfile`, {
					timeoutMs: 300_000,
				});
			}
		}
		const tail = (r.stdout + '\n' + r.stderr).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 200);
		record('install', 'bun install --frozen-lockfile', 'exit 0', start, {
			exitCode: r.exitCode,
			receipt:
				`fresh install (node_modules removed first) — ${tail}` +
				(recoveries.length > 0 ? `; framework_recovery: ${recoveries.join('; ')}` : ''),
		});
	}

	// --- manifest phase: seeded-tests-green ---------------------------------------
	{
		const start = Date.now();
		const r = await sandbox.exec(`cd ${WORKSPACE} && bun test src/`, { timeoutMs: 180_000 });
		// bun test prints its summary on stderr — parse the combined output.
		const clean = stripAnsi(r.stdout + '\n' + r.stderr);
		const pass = /(\d+) pass/.exec(clean)?.[1] ?? '0';
		const fail = /(\d+) fail/.exec(clean)?.[1] ?? '?';
		record('seeded-tests-green', 'bun test src/', 'exit 0', start, {
			exitCode: r.exitCode,
			receipt: `${pass} test(s) pass, ${fail} fail on the seeded baseline`,
		});
	}

	// --- manifest phase: build ------------------------------------------------------
	{
		const start = Date.now();
		const r = await sandbox.exec(`cd ${WORKSPACE} && bun run build`, { timeoutMs: 180_000 });
		let exists = false;
		if (r.exitCode === 0) {
			const ls = await sandbox.exec(`cd ${WORKSPACE} && test -f dist/main.js`, { timeoutMs: 60_000 });
			exists = ls.exitCode === 0;
		}
		record('build', 'bun run build', 'exit 0, dist/main.js exists', start, {
			exitCode: r.exitCode === 0 && exists ? 0 : (r.exitCode || 1),
			receipt: exists ? 'React client bundle built at dist/main.js' : r.stderr.slice(0, 200),
		});
	}

	// --- manifest phase: deliberate-red + repair -----------------------------------
	const originalRoutesTest = readFileSync(join(FIXTURE_DIR, 'src/routes.test.ts'), 'utf8');
	{
		const start = Date.now();
		const flip = await sandbox.exec(
			`cd ${WORKSPACE} && sed -i 's/toHaveLength(2)/toHaveLength(3)/' src/routes.test.ts`,
			{ timeoutMs: 60_000 },
		);
		const red = flip.exitCode === 0
			? await sandbox.exec(`cd ${WORKSPACE} && bun test src/routes.test.ts`, { timeoutMs: 180_000 })
			: { exitCode: 1, stdout: '', stderr: 'flip sed failed' };
		const redFails = /(\d+) fail/.exec(stripAnsi(red.stdout + '\n' + red.stderr))?.[1] ?? '?';

		// Repair within budget: restore the seeded file, re-run to green.
		let greenExit: number | null = null;
		let greenReceipt = '';
		if (red.exitCode !== 0) {
			for (let attempt = 1; attempt <= REPAIR_BUDGET; attempt++) {
				repairAttempts = attempt;
				await sandbox.writeFile(`${WORKSPACE}/src/routes.test.ts`, originalRoutesTest);
				const rerun = await sandbox.exec(`cd ${WORKSPACE} && bun test src/routes.test.ts`, {
					timeoutMs: 180_000,
				});
				if (rerun.exitCode === 0) {
					greenExit = 0;
					greenReceipt = `repair attempt ${attempt}: file restored, ${
						/(\d+) pass/.exec(stripAnsi(rerun.stdout + '\n' + rerun.stderr))?.[1] ?? '?'
					} test(s) pass`;
					break;
				}
				greenReceipt = `repair attempt ${attempt} still failing (exit ${rerun.exitCode})`;
			}
		}
		// Repair integrity: the restored file must match the seed byte-for-byte.
		if (greenExit === 0) {
			const restored = await sandbox.readFile(`${WORKSPACE}/src/routes.test.ts`);
			if (restored !== originalRoutesTest) {
				greenExit = 1;
				greenReceipt += '; repaired file DIFFERS from the seed — repair integrity fails';
			} else {
				greenReceipt += '; repaired file sha-verified against the seed';
			}
		}
		const repaired = greenExit === 0;
		phases.push({
			id: 'deliberate-red',
			command: "sed flip 2→3 + bun test src/routes.test.ts (red), restore + re-run (repair)",
			exitCode: repaired ? 0 : (red.exitCode ?? 1),
			expected: `exit nonzero on the red, repaired to exit 0 within ${REPAIR_BUDGET} attempts`,
			outcome: red.exitCode !== 0 && repaired ? 'PASS' : 'FAIL',
			durationMs: Date.now() - start,
			receipt: `red exit ${red.exitCode} with ${redFails} failing test(s); ${greenReceipt || 'no repair attempted (red did not fail)'}`,
		});
	}

	// --- manifest phase: server-start (in-sandbox HTTP probe) ----------------------
	{
		const start = Date.now();
		const script =
			`cd ${WORKSPACE} && (bun run start >/tmp/p09-server.log 2>&1 & echo $! >/tmp/p09-server.pid); ` +
			`code=000; for i in $(seq 1 20); do ` +
			`code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/health || true); ` +
			`[ "$code" = "200" ] && break; sleep 0.5; done; ` +
			`echo "HTTP_CODE:$code"; kill $(cat /tmp/p09-server.pid) 2>/dev/null; true`;
		const r = await sandbox.exec(script, { timeoutMs: 90_000 });
		const code = /HTTP_CODE:(\d{3})/.exec(r.stdout)?.[1] ?? '000';
		record('server-start', 'bun run start (in-sandbox) + curl /api/health', 'HTTP 200 within 10s', start, {
			exitCode: code === '200' ? 0 : 1,
			receipt: `/api/health responded HTTP ${code} from the sandboxed server`,
		});
	}

	// --- artifact export (sandbox-built bundle → host) ------------------------------
	const artifactsDir = join(tmpdir(), `p09-journey-artifacts-${Date.now()}`);
	mkdirSync(artifactsDir, { recursive: true });
	{
		const start = Date.now();
		const localPath = join(artifactsDir, 'main.js');
		let localSha: string | null = null;
		let remoteSha: string | null = null;
		try {
			localSha = await sandbox.copyFromImage(`${WORKSPACE}/dist/main.js`, localPath);
			const remote = await sandbox.exec(`cd ${WORKSPACE} && sha256sum dist/main.js`, { timeoutMs: 60_000 });
			remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? null;
		} catch (error) {
			record('artifact', 'contree cp /work/forge-task-tracker/dist/main.js → host', 'copy + hash equality', start, {
				exitCode: 1,
				receipt: error instanceof Error ? error.message : String(error),
			});
		}
		if (localSha && remoteSha) {
			artifact = { path: localPath, sha256: localSha };
			record('artifact', 'contree cp /work/forge-task-tracker/dist/main.js → host', 'copy + hash equality', start, {
				exitCode: localSha === remoteSha ? 0 : 1,
				receipt: `sha256 ${localSha.slice(0, 16)}… ${localSha === remoteSha ? 'matches' : 'DIFFERS from'} the sandbox copy`,
			});
		}
	}

	// --- manifest phase: browser-check (host Playwright against the exported build) --
	{
		const start = Date.now();
		if (!artifact) {
			record('browser-check', 'bunx playwright test tests/browser/forge-journey.spec.ts', 'all assertions pass', start, {
				exitCode: 1,
				receipt: 'skipped — no exported sandbox artifact to serve',
			});
		} else {
			// Serve the SANDBOX-built bundle: copy it into the local fixture's
			// dist/ (gitignored) and start the fixture server from that directory.
			const localDist = join(FIXTURE_DIR, 'dist');
			mkdirSync(localDist, { recursive: true });
			const localBundle = join(localDist, 'main.js');
			rmSync(localBundle, { force: true });
			writeFileSync(localBundle, readFileSync(artifact.path));

			const serverEnv: Record<string, string> = { ...env, PORT: String(SERVER_PORT) };
			delete serverEnv.CADDIE_LIVE_AUTHORIZED; // the fixture server needs no live gate
			const server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
				cwd: FIXTURE_DIR,
				env: serverEnv,
				stdout: 'pipe',
				stderr: 'pipe',
			});
			try {
				let up = false;
				for (let i = 0; i < 40 && !up; i++) {
					await new Promise((r) => setTimeout(r, 250));
					up = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`)
						.then((r) => r.ok)
						.catch(() => false);
				}
				if (!up) {
					record('browser-check', 'bunx playwright test tests/browser/forge-journey.spec.ts', 'all assertions pass', start, {
						exitCode: 1,
						receipt: `fixture server failed to come up on 127.0.0.1:${SERVER_PORT}`,
					});
				} else {
					const playwright = Bun.spawnSync(
						[
							'bunx',
							'playwright',
							'test',
							'--config',
							'tests/browser/forge-journey.config.ts',
							'tests/browser/forge-journey.spec.ts',
						],
						{
							cwd: REPO,
							stdout: 'pipe',
							stderr: 'pipe',
							env: { ...env, JOURNEY_BASE_URL: `http://127.0.0.1:${SERVER_PORT}` },
						},
					);
					const output = `${playwright.stdout}${playwright.stderr}`;
					const passed = /(\d+) passed/.exec(output)?.[1] ?? '0';
					record('browser-check', 'bunx playwright test tests/browser/forge-journey.spec.ts', 'all assertions pass', start, {
						exitCode: playwright.exitCode ?? 1,
						receipt: `${passed} browser assertion(s) passed against the sandbox-built bundle on 127.0.0.1:${SERVER_PORT}`,
					});
				}
			} finally {
				server.kill();
			}
		}
	}

	// --- post-run integrity ----------------------------------------------------------
	const manifestAfter = manifestHash();
	if (manifestAfter !== manifestBefore) {
		phases.push({
			id: 'manifest-integrity',
			command: 'sha256(tests/acceptance/manifest.json) after == before',
			exitCode: 1,
			expected: 'the evaluator is unchanged by the run',
			outcome: 'FAIL',
			durationMs: 0,
			receipt: 'manifest hash CHANGED during the run — evidence is void',
		});
	}

	const allPass = phases.length > 0 && phases.every((p) => p.outcome === 'PASS');
	const evidence: Evidence = {
		packet: 'P09',
		status: allPass ? 'PASS' : 'FAILED',
		manifestSha256: manifestBefore,
		fixtureFiles: localHashes,
		sandboxSession: SESSION_KEY,
		sandboxImage: 'tag:tt-base:1',
		workspace: WORKSPACE,
		phases,
		repairAttempts,
		artifact: artifact ? { path: '(host tmp; sha256 recorded)', sha256: artifact.sha256 } : null,
		limitations: [
			'model-driven coordinator phases (brief→plan→specialists) are NOT part of this runner: they need the Flue DO runtime (dev-server integration). The acceptance manifest phases do not require the model; nothing model-driven was simulated.',
			'browser-check runs on the HOST against the exported sandbox-built bundle (contree provides no host→sandbox port forwarding); server-start separately proves the same server answers HTTP 200 in-sandbox.',
			'install applied framework_recovery (uncounted per manifest repairPolicy): bun cannot extract the react-dom tarball under this sandbox isolation (reproduced on bun 1.4.0/1.4.2, both backends, relocated caches; GNU tar extracts the same tarball fine), so the failing tarball was fetched from the registry in-sandbox and extracted with tar before the frozen install verified the tree.',
		],
	};
	return evidence;
}

// --- main ------------------------------------------------------------------------

async function main(): Promise<number> {
	const gateResult = gate();
	if (!gateResult.ok) {
		console.error(`run-journey: ${gateResult.reason}`);
		if (gateResult.seed) {
			console.error(
				`Seed state for the journey (recorded, not executed): ${JSON.stringify(
					{
						manifestSha256: gateResult.seed.manifestSha256,
						fixtureFiles: gateResult.seed.fixtureFiles,
					},
					null,
					2,
				)}`,
			);
		}
		return 1;
	}
	const env = gateResult.env;
	console.error(
		`run-journey: gate open — session ${SESSION_KEY}, image tag:tt-base:1, ` +
			`CONTREE_BASE_URL ${env.CONTREE_BASE_URL}, CONTREE_API_TOKEN ${redact(env.CONTREE_API_TOKEN)}, ` +
			`NEBIUS_API_KEY ${redact(env.NEBIUS_API_KEY)}. No secret values are printed.`,
	);

	let evidence: Evidence;
	try {
		evidence = await runJourney(env);
	} catch (error) {
		console.error(
			`run-journey: FAILED — ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}

	console.error('\n=== P09 journey phases ===');
	for (const phase of evidence.phases) {
		console.error(
			`[${phase.outcome}] ${phase.id} — ${phase.command} (exit ${phase.exitCode}, ${phase.durationMs}ms)\n` +
				`        expected: ${phase.expected}\n        receipt: ${phase.receipt}`,
		);
	}
	console.error(`\nrepair attempts used: ${evidence.repairAttempts}/${REPAIR_BUDGET}`);
	console.error(JSON.stringify(evidence, null, 2));
	console.error(
		evidence.status === 'PASS'
			? 'run-journey: PASS — every manifest phase has machine-checked evidence.'
			: 'run-journey: FAILED — at least one manifest phase lacks a passing receipt.',
	);
	return evidence.status === 'PASS' ? 0 : 1;
}

process.exit(await main());
