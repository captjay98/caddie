#!/usr/bin/env bun
/**
 * One-command production deploy (roadmap item 1, docs/runbooks/
 * deployment-explained.md). Runs the eight runbook steps in the one correct
 * order, stops at the first failure, and records its own evidence.
 *
 *   bun run deploy          REHEARSAL: every check + two remote READS, then
 *                           prints exactly what `--yes` would write and STOPS.
 *                           No remote WRITE happens.
 *   bun run deploy --yes    the owner's deployment authorization: also runs
 *                           migrations apply (BEFORE the code), the deploy,
 *                           the hosted smoke and the switch report.
 *
 * Flags beyond --yes:
 *   --with-secrets          deploy with `--secrets-file .prod.vars`. A plain
 *                           --yes deploy leaves secrets alone, because a
 *                           re-upload would undo values set later with
 *                           `wrangler secret put`.
 *   --accept-do-migration   acknowledge a new Durable Object `migrations` tag
 *                           (rollback past it is refused by Cloudflare).
 *
 * Safety contract (enforced here AND proven by tests/deploy-script.test.ts):
 *   - migrations apply runs strictly BEFORE wrangler deploy;
 *   - no command that writes the remote runs without --yes;
 *   - the run stops at the first failing step;
 *   - a dirty tree or a non-main branch is refused;
 *   - --secrets-file appears only with --with-secrets;
 *   - a new DO tag needs --accept-do-migration as well as --yes;
 *   - `wrangler secret put`, `deploy --env` and `migrations ... --local` are
 *     never issued;
 *   - docs/live-receipts.json is never written here (the smoke run owns it).
 *
 * Every command goes through an injected runner, so the tests drive the whole
 * script with a fake runner that records commands and returns canned output,
 * and no test ever touches the network.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Injected runner + environment
// ---------------------------------------------------------------------------

export interface RunResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface RunOptions {
	readonly cwd?: string;
	readonly env?: Record<string, string | undefined>;
}

/** Runs one command. The test supplies a fake; main() supplies Bun.spawnSync. */
export type Runner = (argv: readonly string[], options?: RunOptions) => RunResult;

/** Everything the orchestrator reads, so a test can supply all of it. */
export interface DeployDeps {
	readonly run: Runner;
	/** Repo root; the two app-dir commands run under repoRoot/apps/app. */
	readonly repoRoot: string;
	/** Reads a UTF-8 file; defaults to node:fs. */
	readonly readFile?: (path: string) => string;
	/** Whether a path exists; defaults to node:fs. */
	readonly fileExists?: (path: string) => boolean;
	/** Lists a directory's entries; defaults to node:fs readdirSync. */
	readonly listDir?: (path: string) => string[];
	/** The wall clock, so the evidence row is deterministic in tests. */
	readonly now?: () => Date;
	/** Sink for progress lines (default: console.log). */
	readonly log?: (line: string) => void;
}

export interface DeployOptions {
	readonly yes: boolean;
	readonly withSecrets: boolean;
	readonly acceptDoMigration: boolean;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface StepRecord {
	readonly name: string;
	readonly ok: boolean;
	/** The command that ran, if this step ran one. */
	readonly command?: readonly string[];
	readonly detail: string;
}

export interface DeployResult {
	readonly ok: boolean;
	/** True once a remote WRITE was issued (migrations apply / deploy). */
	readonly wroteRemote: boolean;
	readonly steps: readonly StepRecord[];
	/** The version id parsed out of `wrangler deploy` (only with --yes). */
	readonly versionId?: string;
	/** The pre-deploy live version id — the rollback handle. */
	readonly rollbackId?: string;
	/** Every command the runner was asked to run, in order. */
	readonly commands: readonly (readonly string[])[];
	/** The evidence row the run would append (printed, never written here). */
	readonly evidenceRow?: string;
}

const WRANGLER = 'bunx';
const APP = 'wrangler';

// ---------------------------------------------------------------------------
// Parsing helpers (exported so tests pin them directly)
// ---------------------------------------------------------------------------

export interface WranglerConfig {
	migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
	durable_objects?: { bindings?: { name: string; class_name: string }[] };
	d1_databases?: { binding: string; database_id?: string }[];
	worker_loaders?: { binding?: string; name?: string }[];
	routes?: ({ pattern: string } | string)[];
	env?: Record<string, WranglerConfig>;
}

/** The `migrations` tags in a wrangler config's env.production (DO migration tags). */
export function productionDoTags(config: WranglerConfig): string[] {
	return (config.env?.production?.migrations ?? config.migrations ?? []).map((entry) => entry.tag);
}

/** The DO class names + binding names the BUILT config carries (what dry-run lists). */
export function builtBindings(built: WranglerConfig): { doClasses: string[]; bindings: string[] } {
	const doClasses = (built.durable_objects?.bindings ?? []).map((b) => b.class_name);
	const bindings = [
		...(built.d1_databases ?? []).map((d) => d.binding),
		...(built.worker_loaders ?? []).map((l) => l.binding ?? l.name ?? ''),
		...(built.durable_objects?.bindings ?? []).map((b) => b.name),
	].filter(Boolean);
	return { doClasses, bindings };
}

/** Parse the Version ID out of `wrangler deploy` output. */
export function parseVersionId(output: string): string | null {
	const match = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(output) ?? /Version ID:\s*([0-9a-f-]{36})/i.exec(output);
	return match ? match[1]! : null;
}

/** Parse the newest (top) version id out of `wrangler deployments list` output. */
export function parseLatestDeploymentId(output: string): string | null {
	const match = /(?:Version ID|Deployment ID):\s*([0-9a-f-]{36})/i.exec(output);
	return match ? match[1]! : null;
}

/** Pending (unapplied) migration names from `wrangler d1 migrations list`. */
export function parsePendingMigrations(output: string): string[] {
	const names: string[] = [];
	for (const raw of output.split('\n')) {
		const line = raw.trim().replace(/^[│|]\s*/, '').replace(/\s*[│|]$/, '').trim();
		const match = /^(\d{4}_[A-Za-z0-9_.-]+\.sql)\b/.exec(line);
		if (match) names.push(match[1]!);
	}
	return names;
}

/** The production route hostname from the authored or built config. */
export function productionHost(config: WranglerConfig): string | null {
	const routes = config.env?.production?.routes ?? config.routes ?? [];
	for (const route of routes) {
		const pattern = typeof route === 'string' ? route : route.pattern;
		if (pattern && !/[<>]/.test(pattern)) return pattern.split('/')[0]!;
	}
	return null;
}

/** The newest P17 receipt's commit — the last deployed commit. */
export function lastDeployedCommit(receiptsText: string): string | null {
	try {
		const parsed: unknown = JSON.parse(receiptsText);
		if (!Array.isArray(parsed)) return null;
		const p17 = (parsed as { packet?: string; commit?: string; at?: string }[])
			.filter((r) => r.packet === 'P17' && typeof r.commit === 'string')
			.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
		return p17[0]?.commit ?? null;
	} catch {
		return null;
	}
}

/** The migrations tags a wrangler.jsonc held at a given commit (via git show). */
export function doTagsAtCommit(deps: DeployDeps, commit: string): string[] | null {
	const show = deps.run(['git', 'show', `${commit}:apps/app/wrangler.jsonc`], { cwd: deps.repoRoot });
	if (show.exitCode !== 0) return null;
	try {
		const config = parseJsoncLoose(show.stdout) as WranglerConfig;
		return productionDoTags(config);
	} catch {
		return null;
	}
}

/** JSONC parse via Bun.JSONC, falling back to comment-stripping JSON.parse. */
export function parseJsoncLoose(text: string): unknown {
	const bun = (globalThis as { Bun?: { JSONC?: { parse(input: string): unknown } } }).Bun;
	if (bun?.JSONC) return bun.JSONC.parse(text);
	const stripped = text
		.split('\n')
		.map((line) => (/^\s*\/\//.test(line) ? '' : line))
		.join('\n');
	return JSON.parse(stripped);
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function runDeploy(options: DeployOptions, deps: DeployDeps): DeployResult {
	const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
	const fileExists = deps.fileExists ?? ((path: string) => existsSync(path));
	const listDir = deps.listDir ?? ((path: string) => readdirSync(path));
	const log = deps.log ?? ((line: string) => console.log(line));
	const now = deps.now ?? (() => new Date());
	const appDir = join(deps.repoRoot, 'apps', 'app');

	const steps: StepRecord[] = [];
	const commands: (readonly string[])[] = [];
	let wroteRemote = false;
	let versionId: string | undefined;
	let rollbackId: string | undefined;
	let evidenceRow: string | undefined;

	/** Run a command through the injected runner, recording it. */
	const run = (argv: readonly string[], opts?: RunOptions): RunResult => {
		commands.push(argv);
		return deps.run(argv, opts);
	};

	/** Record a step and print its one line. */
	const record = (step: StepRecord): StepRecord => {
		steps.push(step);
		log(`[${step.ok ? 'OK' : 'FAIL'}] ${step.name} — ${step.detail}`);
		return step;
	};

	const finish = (): DeployResult => ({
		ok: steps.length > 0 && steps.every((s) => s.ok),
		wroteRemote,
		steps,
		versionId,
		rollbackId,
		commands,
		evidenceRow,
	});

	const stop = (step: StepRecord): DeployResult => {
		record(step);
		return finish();
	};

	// --- Step 1: on main, clean tree, record HEAD ---------------------------
	const branch = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: deps.repoRoot });
	const branchName = branch.stdout.trim();
	if (branchName !== 'main') {
		return stop({ name: 'branch', ok: false, command: ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], detail: `must deploy from main, on ${branchName || '(unknown)'}` });
	}
	const status = run(['git', 'status', '--porcelain'], { cwd: deps.repoRoot });
	if (status.stdout.trim() !== '') {
		return stop({ name: 'clean-tree', ok: false, command: ['git', 'status', '--porcelain'], detail: 'uncommitted changes: a deploy must match a commit' });
	}
	const headRes = run(['git', 'rev-parse', 'HEAD'], { cwd: deps.repoRoot });
	const head = headRes.stdout.trim();
	record({ name: 'branch+tree', ok: true, detail: `main, clean, HEAD ${head.slice(0, 12)}` });

	// --- Step 2: release-check exits 0 (its [BLOCKED] auth line is expected) -
	const releaseCheck = run(['bun', 'scripts/release-check.ts'], { cwd: deps.repoRoot });
	if (releaseCheck.exitCode !== 0) {
		return stop({ name: 'release-check', ok: false, command: ['bun', 'scripts/release-check.ts'], detail: `exit ${releaseCheck.exitCode} — fix failing checks` });
	}
	record({ name: 'release-check', ok: true, command: ['bun', 'scripts/release-check.ts'], detail: 'exit 0 ([BLOCKED] deployment authorization is expected)' });

	// --- Step 3: production build, then confirm the built config is prod -----
	const build = run(['bun', 'run', 'build'], { cwd: deps.repoRoot, env: { CLOUDFLARE_ENV: 'production' } });
	if (build.exitCode !== 0) {
		return stop({ name: 'build', ok: false, command: ['bun', 'run', 'build'], detail: `exit ${build.exitCode} — production build failed` });
	}
	const builtConfigPath = join(appDir, 'dist', 'caddie_app', 'wrangler.json');
	const authoredPath = join(appDir, 'wrangler.jsonc');
	const authored = parseJsoncLoose(readFile(authoredPath)) as WranglerConfig;
	const wantedD1 = authored.env?.production?.d1_databases?.find((d) => d.binding === 'DB')?.database_id ?? null;
	if (!fileExists(builtConfigPath)) {
		return stop({ name: 'build-is-production', ok: false, detail: 'no built Worker config: the build did not produce dist/caddie_app/wrangler.json' });
	}
	const built = JSON.parse(readFile(builtConfigPath)) as WranglerConfig;
	const builtD1 = built.d1_databases?.find((d) => d.binding === 'DB')?.database_id ?? null;
	if ('legacy_env' in (built as Record<string, unknown>)) {
		return stop({ name: 'build-is-production', ok: false, detail: 'the built config still carries legacy_env: rebuild' });
	}
	if (!wantedD1 || !UUID.test(wantedD1) || builtD1 !== wantedD1) {
		return stop({ name: 'build-is-production', ok: false, detail: `built D1 id ${builtD1 ?? 'missing'} is not env.production's (${wantedD1 ?? 'missing'}): wrong-env build` });
	}
	record({ name: 'build-is-production', ok: true, command: ['bun', 'run', 'build'], detail: `CLOUDFLARE_ENV=production; built D1 id matches env.production` });

	// --- Step 4: preflight, --owner-only when no JUDGE_ACCESS_CODE line ------
	const prodVarsPath = join(appDir, '.prod.vars');
	const hasJudgeCode =
		fileExists(prodVarsPath) && /^\s*JUDGE_ACCESS_CODE\s*=/m.test(readFile(prodVarsPath));
	const preflightArgv = hasJudgeCode
		? ['bun', 'scripts/deploy-preflight.ts']
		: ['bun', 'scripts/deploy-preflight.ts', '--owner-only'];
	const preflight = run(preflightArgv, { cwd: deps.repoRoot });
	for (const line of preflight.stdout.split('\n')) {
		if (line.includes('[WARN]')) log(`    ${line.trim()}`);
	}
	if (preflight.exitCode !== 0) {
		return stop({ name: 'preflight', ok: false, command: preflightArgv, detail: `exit ${preflight.exitCode} — preflight FAILs; nothing uploaded` });
	}
	record({ name: 'preflight', ok: true, command: preflightArgv, detail: `exit 0${hasJudgeCode ? '' : ' (--owner-only)'}; WARNs printed above` });

	// --- Step 5: dry run must list DB, LOADER, PREVIEW_DB and every DO class -
	const dryRun = run([WRANGLER, APP, 'deploy', '--dry-run'], { cwd: appDir });
	if (dryRun.exitCode !== 0) {
		return stop({ name: 'dry-run', ok: false, command: [WRANGLER, APP, 'deploy', '--dry-run'], detail: `exit ${dryRun.exitCode}` });
	}
	const { doClasses, bindings } = builtBindings(built);
	const expectedBindings = ['DB', 'LOADER', 'PREVIEW_DB'];
	const missingBindings = expectedBindings.filter((b) => !bindings.includes(b) || !dryRun.stdout.includes(b));
	const missingClasses = doClasses.filter((c) => !dryRun.stdout.includes(c));
	if (missingBindings.length > 0 || missingClasses.length > 0) {
		return stop({
			name: 'dry-run',
			ok: false,
			command: [WRANGLER, APP, 'deploy', '--dry-run'],
			detail: `dry-run output is missing ${[...missingBindings, ...missingClasses].join(', ')}`,
		});
	}
	record({ name: 'dry-run', ok: true, command: [WRANGLER, APP, 'deploy', '--dry-run'], detail: `lists ${expectedBindings.join(', ')} and DO classes ${doClasses.join(', ')}` });

	// --- Step 6: remote READS (always safe) ----------------------------------
	const migrationsListArgv = [WRANGLER, APP, 'd1', 'migrations', 'list', 'caddie', '--remote', '--config', 'wrangler.jsonc', '--env', 'production'];
	const migList = run(migrationsListArgv, { cwd: appDir });
	if (migList.exitCode !== 0) {
		return stop({ name: 'migrations-list', ok: false, command: migrationsListArgv, detail: `exit ${migList.exitCode}` });
	}
	const pending = parsePendingMigrations(migList.stdout);
	// Drift: a pending remote migration that is not in apps/app/migrations.
	const localMigrations = new Set<string>();
	const migrationsDir = join(appDir, 'migrations');
	if (fileExists(migrationsDir)) {
		try {
			for (const name of listDir(migrationsDir)) if (name.endsWith('.sql')) localMigrations.add(name);
		} catch {
			/* ignore */
		}
	}
	const drift = pending.filter((name) => !localMigrations.has(name));
	if (drift.length > 0) {
		return stop({ name: 'migration-drift', ok: false, command: migrationsListArgv, detail: `remote has migration(s) not in apps/app/migrations: ${drift.join(', ')} — refusing` });
	}
	record({ name: 'migrations-list', ok: true, command: migrationsListArgv, detail: pending.length > 0 ? `pending: ${pending.join(', ')}` : 'no pending migrations' });

	const deploymentsArgv = [WRANGLER, APP, 'deployments', 'list'];
	const deployments = run(deploymentsArgv, { cwd: appDir });
	if (deployments.exitCode !== 0) {
		return stop({ name: 'deployments-list', ok: false, command: deploymentsArgv, detail: `exit ${deployments.exitCode}` });
	}
	rollbackId = parseLatestDeploymentId(deployments.stdout) ?? undefined;
	record({ name: 'deployments-list', ok: true, command: deploymentsArgv, detail: `live/rollback version id: ${rollbackId ?? '(none parsed)'}` });

	// --- Step 7: compare DO migration tags HEAD vs last deployed commit ------
	const headTags = productionDoTags(authored);
	const receiptsPath = join(deps.repoRoot, 'docs', 'live-receipts.json');
	const lastCommit = fileExists(receiptsPath) ? lastDeployedCommit(readFile(receiptsPath)) : null;
	let newDoTags: string[] = [];
	if (lastCommit) {
		const priorTags = doTagsAtCommit(deps, lastCommit) ?? [];
		newDoTags = headTags.filter((tag) => !priorTags.includes(tag));
	}
	if (newDoTags.length > 0) {
		log(`    WARN: new Durable Object migration tag(s): ${newDoTags.join(', ')} — rollback PAST this boundary is refused by Cloudflare`);
		if (options.yes && !options.acceptDoMigration) {
			return stop({ name: 'do-migration-tags', ok: false, detail: `new DO tag(s) ${newDoTags.join(', ')} need --accept-do-migration as well as --yes` });
		}
	}
	record({
		name: 'do-migration-tags',
		ok: true,
		detail: newDoTags.length > 0 ? `new DO tag(s): ${newDoTags.join(', ')} (accepted)` : `no new DO tag since ${lastCommit ? lastCommit.slice(0, 12) : 'unknown'}`,
	});

	// --- REHEARSAL boundary: without --yes, print the plan and STOP ----------
	if (!options.yes) {
		const host = productionHost(authored) ?? '(no host)';
		const plan = [
			`would run (in apps/app), in order:`,
			`  1. ${[WRANGLER, APP, 'd1', 'migrations', 'apply', 'caddie', '--remote', '--config', 'wrangler.jsonc', '--env', 'production'].join(' ')}`,
			`  2. ${[WRANGLER, APP, 'deploy', ...(options.withSecrets ? ['--secrets-file', '.prod.vars'] : [])].join(' ')}`,
			`  then: hosted smoke against https://${host}, and a read-only switch report`,
			newDoTags.length > 0 ? `  NOTE: new DO tag(s) ${newDoTags.join(', ')} — re-run with --yes --accept-do-migration` : '',
		].filter(Boolean);
		for (const line of plan) log(`    ${line}`);
		record({ name: 'rehearsal', ok: true, detail: 'checks passed; no remote write (pass --yes to deploy)' });
		return finish();
	}

	// --- Step 8: migrations apply STRICTLY BEFORE deploy (remote writes) -----
	const applyArgv = [WRANGLER, APP, 'd1', 'migrations', 'apply', 'caddie', '--remote', '--config', 'wrangler.jsonc', '--env', 'production'];
	wroteRemote = true;
	const apply = run(applyArgv, { cwd: appDir });
	if (apply.exitCode !== 0) {
		return stop({ name: 'migrations-apply', ok: false, command: applyArgv, detail: `exit ${apply.exitCode} — migrations failed; code NOT deployed` });
	}
	record({ name: 'migrations-apply', ok: true, command: applyArgv, detail: 'applied before the code' });

	const deployArgv = options.withSecrets
		? [WRANGLER, APP, 'deploy', '--secrets-file', '.prod.vars']
		: [WRANGLER, APP, 'deploy'];
	const deploy = run(deployArgv, { cwd: appDir });
	if (deploy.exitCode !== 0) {
		return stop({ name: 'deploy', ok: false, command: deployArgv, detail: `exit ${deploy.exitCode} — deploy failed` });
	}
	versionId = parseVersionId(deploy.stdout) ?? undefined;
	if (!versionId) {
		return stop({ name: 'deploy', ok: false, command: deployArgv, detail: 'deploy succeeded but no Version ID in output' });
	}
	record({ name: 'deploy', ok: true, command: deployArgv, detail: `Version ID ${versionId}` });

	// --- Step 9: hosted smoke, then live hash == dist hash -------------------
	const host = productionHost(authored);
	if (!host) {
		return stop({ name: 'smoke', ok: false, detail: 'no production route host to smoke against' });
	}
	const releaseUrl = `https://${host}`;
	const smokeArgv = ['bun', 'run', 'test:live', '--', 'P17'];
	const smoke = run(smokeArgv, { cwd: deps.repoRoot, env: { CADDIE_LIVE_AUTHORIZED: '1', CADDIE_RELEASE_URL: releaseUrl } });
	let hashMatch = false;
	let liveHash = '';
	if (smoke.exitCode === 0) {
		// Fetch the live /app/ HTML and compare its hashed index-*.js to dist.
		const fetchArgv = ['curl', '-fsS', `${releaseUrl}/app/`];
		const liveHtml = run(fetchArgv, { cwd: deps.repoRoot });
		const live = /index-([A-Za-z0-9_-]+)\.js/.exec(liveHtml.stdout)?.[0] ?? '';
		const distAppHtmlPath = join(appDir, 'dist', 'caddie_app', 'app', 'index.html');
		const distHtml = fileExists(distAppHtmlPath) ? readFile(distAppHtmlPath) : '';
		const distJs = /index-([A-Za-z0-9_-]+)\.js/.exec(distHtml)?.[0] ?? '';
		liveHash = live;
		hashMatch = live !== '' && live === distJs;
	}
	if (smoke.exitCode !== 0 || !hashMatch) {
		// Step 11: print the exact rollback command on a failed smoke.
		if (rollbackId) {
			log(`    ROLLBACK: cd apps/app && ${WRANGLER} ${APP} rollback ${rollbackId}`);
			if (newDoTags.length > 0) log(`    (a DO migration crossed this boundary — rollback is refused; FIX FORWARD instead)`);
		}
		return stop({
			name: 'smoke',
			ok: false,
			command: smokeArgv,
			detail: smoke.exitCode !== 0 ? `smoke failed (exit ${smoke.exitCode})` : `live hash ${liveHash || '(none)'} != dist`,
		});
	}
	record({ name: 'smoke', ok: true, command: smokeArgv, detail: `P17 live 5/5; live hash ${liveHash} == dist` });

	// --- Step 10: read-only switch report ------------------------------------
	const switchesArgv = [WRANGLER, APP, 'd1', 'execute', 'caddie', '--remote', '--env', 'production', '--command', 'select key, value from platform_switches'];
	const switches = run(switchesArgv, { cwd: appDir });
	if (switches.exitCode !== 0) {
		return stop({ name: 'switches', ok: false, command: switchesArgv, detail: `exit ${switches.exitCode}` });
	}
	const effective = resolveSwitchReport(switches.stdout);
	for (const line of effective) log(`    switch ${line}`);
	record({ name: 'switches', ok: true, command: switchesArgv, detail: `${effective.length} effective switch value(s) (read-only)` });

	// --- Step 12: build the evidence row (printed, never committed) ----------
	const date = now().toISOString().slice(0, 10);
	const passCount = steps.filter((s) => s.ok).length;
	evidenceRow = [
		`| ${date}`,
		releaseUrl,
		`\`${versionId}\``,
		`\`${head.slice(0, 7)}\``,
		`${passCount} steps OK`,
		pending.length > 0 ? pending.join(' ') : 'none',
		headTags.join(' '),
		`P17 live 5/5`,
		`${liveHash} == dist |`,
	].join(' | ');
	log('    evidence row (NOT committed — commit it yourself):');
	log(`    ${evidenceRow}`);
	log(`    git add docs/release-evidence.md && git commit -m "release evidence: ${versionId}"`);
	record({ name: 'evidence', ok: true, detail: 'row printed; commit it yourself (this script never writes docs/release-evidence.md)' });

	return finish();
}

/** Resolve the 5 platform switches the way platform-switches.ts does. */
export function resolveSwitchReport(executeOutput: string): string[] {
	const defaults: Record<string, string> = {
		team_mode: 'off',
		big_apps: 'off',
		app_features: 'off',
		spend_enforcement: 'on',
		publish_safety: 'on',
	};
	const stored = new Map<string, string>();
	// wrangler d1 execute prints rows; capture "key value" pairs loosely.
	for (const raw of executeOutput.split('\n')) {
		const line = raw.replace(/[│|]/g, ' ').trim();
		const match = /\b(team_mode|big_apps|app_features|spend_enforcement|publish_safety)\b\s+(off|owner|on)\b/.exec(line);
		if (match) stored.set(match[1]!, match[2]!);
	}
	return Object.keys(defaults).map((key) => {
		const value = stored.get(key) ?? defaults[key]!;
		const source = stored.has(key) ? 'set' : 'env-default';
		return `${key} = ${value} (${source})`;
	});
}

// ---------------------------------------------------------------------------
// main() — wires the real runner
// ---------------------------------------------------------------------------

function realRunner(argv: readonly string[], options?: RunOptions): RunResult {
	const proc = Bun.spawnSync([...argv], {
		cwd: options?.cwd,
		env: options?.env ? { ...process.env, ...options.env } : process.env,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { exitCode: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes('--help') || args.includes('-h')) {
		console.log(
			[
				'bun scripts/deploy.ts            rehearsal: run every check + remote reads, print the plan, STOP',
				'bun scripts/deploy.ts --yes      also apply migrations (before code), deploy, smoke, switch report',
				'',
				'  --with-secrets          deploy with --secrets-file .prod.vars (re-uploads secrets)',
				'  --accept-do-migration   acknowledge a new Durable Object migration tag',
			].join('\n'),
		);
		return;
	}
	const options: DeployOptions = {
		yes: args.includes('--yes'),
		withSecrets: args.includes('--with-secrets'),
		acceptDoMigration: args.includes('--accept-do-migration'),
	};
	const repoRoot = fileURLToPath(new URL('..', import.meta.url));
	const result = runDeploy(options, { run: realRunner, repoRoot });
	if (!result.ok) {
		console.error(`\ndeploy: STOPPED at a failing step. Nothing further was attempted.`);
		process.exit(1);
	}
	console.log(
		result.wroteRemote
			? `\ndeploy: done — version ${result.versionId}. Append the evidence row above and commit it.`
			: `\ndeploy: rehearsal OK — re-run with --yes to deploy.`,
	);
}

if (import.meta.main) await main();
