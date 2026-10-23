import { describe, expect, test } from 'bun:test';
import {
	builtBindings,
	lastDeployedCommit,
	latestP17ReceiptId,
	parseAppliedMigrations,
	parseLatestDeploymentId,
	parsePendingMigrations,
	parseVersionId,
	productionDoTags,
	productionHost,
	resolveSwitchReport,
	runDeploy,
	type DeployDeps,
	type DeployOptions,
	type RunOptions,
	type RunResult,
	type WranglerConfig,
} from '../scripts/deploy.ts';

/**
 * P17 one-command deploy (scripts/deploy.ts). Everything here runs through a
 * FAKE runner that records the commands it is asked to run and returns canned
 * output — no Cloudflare call, no git write, no network. A matching fake
 * filesystem supplies the authored and built wrangler configs and the
 * receipts file. Each test asserts the safety contract the runbook names.
 */

const REPO = '/repo';
const APP = '/repo/apps/app';
const PROD_D1 = 'f6315eae-99da-4afc-93d0-356afcd511a0';
const HOST = 'caddie.example.com';
const ROLLBACK_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const NEW_VERSION_ID = 'bbbbbbbb-2222-4333-8444-555555555555';
const LIVE_JS = 'index-ABC123.js';

/** env.production block with the given DO migration tags. */
function authoredConfig(doTags: string[] = ['v1', 'v2', 'v3', 'v4']): WranglerConfig {
	return {
		env: {
			production: {
				routes: [{ pattern: HOST }],
				d1_databases: [{ binding: 'DB', database_id: PROD_D1 }],
				durable_objects: { bindings: [{ name: 'PREVIEW_DB', class_name: 'PreviewDatabase' }] },
				worker_loaders: [{ binding: 'LOADER' }],
				migrations: doTags.map((tag) => ({ tag, new_sqlite_classes: [`Cls_${tag}`] })),
			},
		},
	};
}

/** The BUILT (flattened) config the compose step would write. */
function builtConfig(): WranglerConfig {
	return {
		routes: [{ pattern: HOST }],
		d1_databases: [{ binding: 'DB', database_id: PROD_D1 }],
		worker_loaders: [{ binding: 'LOADER' }],
		durable_objects: {
			bindings: [
				{ name: 'PREVIEW_DB', class_name: 'PreviewDatabase' },
				{ name: 'HELLO', class_name: 'FlueHelloAgent' },
				{ name: 'COORD', class_name: 'FlueCoordinatorAgent' },
				{ name: 'MODULE', class_name: 'FlueModuleBuilderAgent' },
			],
		},
		migrations: [{ tag: 'v1' }, { tag: 'v2' }, { tag: 'v3' }, { tag: 'v4' }],
	};
}

const DRY_RUN_OK = [
	'Your Worker has access to the following bindings:',
	'- D1 Databases: DB (caddie)',
	'- Worker Loaders: LOADER',
	'- Durable Objects: PREVIEW_DB (PreviewDatabase), HELLO (FlueHelloAgent), COORD (FlueCoordinatorAgent), MODULE (FlueModuleBuilderAgent)',
].join('\n');

const MIGRATIONS_LIST_NONE = 'Migrations to be applied:\n(none)\n';
const DEPLOYMENTS_LIST = [
	'Created:     2026-10-20T11:53:24.217Z',
	'Author:      captjay98@gmail.com',
	'Source:      Unknown (deployment)',
	`Version(s):  (100%) ${ROLLBACK_ID}`,
	'                 Created:  2026-10-20T11:53:21.499Z',
	'                     Tag:  -',
	'',
	'Created:     2026-10-20T10:33:08.546Z',
	'Version(s):  (100%) bbbbbbbb-2222-4333-8444-555555555555',
].join('\n');
const DEPLOY_OUTPUT = `Total Upload: 1 KiB\nDeployed caddie-app\nCurrent Version ID: ${NEW_VERSION_ID}\n`;
const SWITCHES_OUTPUT = `key               value\nteam_mode         off\nbig_apps          off\napp_features      off\nspend_enforcement on\npublish_safety    on\n`;

interface HarnessOverrides {
	/** Override the RunResult for the first command whose joined argv contains the key. */
	readonly responses?: Record<string, Partial<RunResult>>;
	/** The DO tags the LAST deployed commit (git show) carried. */
	readonly priorDoTags?: string[];
	/** The DO tags env.production carries at HEAD. */
	readonly headDoTags?: string[];
	/** Whether .prod.vars has a JUDGE_ACCESS_CODE line. */
	readonly hasJudgeCode?: boolean;
	/** Local migration filenames present under apps/app/migrations. */
	readonly localMigrations?: string[];
	/** The receipts file content; overrides the default P17 receipt. */
	readonly receiptsText?: string;
	/** Omit docs/live-receipts.json entirely (fileExists -> false). */
	readonly noReceiptsFile?: boolean;
	/** Override ONLY the real `wrangler deploy` output (not the dry-run). */
	readonly deployOutput?: string;
}

interface Harness {
	deps: DeployDeps;
	commands: string[][];
	logs: string[];
	/** Every (path, text) the script appended — the real fs is never touched. */
	appends: { path: string; text: string }[];
	/** Every per-step log the script wrote: relative path -> text. */
	writtenLogs: { path: string; text: string }[];
}

function ok(stdout = ''): RunResult {
	return { exitCode: 0, stdout, stderr: '' };
}

function makeHarness(over: HarnessOverrides = {}): Harness {
	const commands: string[][] = [];
	const logs: string[] = [];
	const appends: { path: string; text: string }[] = [];
	const writtenLogs: { path: string; text: string }[] = [];
	const headDoTags = over.headDoTags ?? ['v1', 'v2', 'v3', 'v4'];
	const priorDoTags = over.priorDoTags ?? ['v1', 'v2', 'v3', 'v4'];
	const localMigrations = over.localMigrations ?? ['0001_a.sql', '0002_b.sql'];

	const authored = authoredConfig(headDoTags);
	const built = builtConfig();

	const files: Record<string, string> = {
		[`${APP}/wrangler.jsonc`]: JSON.stringify(authored),
		[`${APP}/dist/caddie_app/wrangler.json`]: JSON.stringify(built),
		[`${APP}/dist/caddie_app/app/index.html`]: `<script src="/assets/${LIVE_JS}"></script>`,
		[`${APP}/.prod.vars`]: over.hasJudgeCode ? 'JUDGE_ACCESS_CODE=xxxxxxxxxxxxxxxx\n' : 'BETTER_AUTH_SECRET=x\n',
	};
	if (!over.noReceiptsFile) {
		files[`${REPO}/docs/live-receipts.json`] = over.receiptsText ?? JSON.stringify([
			{ packet: 'P17', id: 'lr_deadbeefcafef00d', commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', at: '2026-10-22T11:00:00Z' },
		]);
	}

	const dirFiles: Record<string, string[]> = {
		[`${APP}/migrations`]: localMigrations,
	};
	// Expose migrations dir to the require('node:fs').readdirSync call in deploy.ts.
	// The script reads the real fs for the migrations dir; to keep the test
	// hermetic we instead rely on parsePendingMigrations returning [] (no drift)
	// in the happy path, so dirFiles is only used by tests that force drift via
	// the migrations-list response.
	void dirFiles;

	const matchResponse = (joined: string): Partial<RunResult> | undefined => {
		for (const [key, value] of Object.entries(over.responses ?? {})) {
			if (joined.includes(key)) return value;
		}
		return undefined;
	};

	const run = (argv: readonly string[], _options?: RunOptions): RunResult => {
		commands.push([...argv]);
		const joined = argv.join(' ');
		const override = matchResponse(joined);

		let base: RunResult;
		if (joined.startsWith('git rev-parse --abbrev-ref')) base = ok('main\n');
		else if (joined.startsWith('git status --porcelain')) base = ok('');
		else if (joined.startsWith('git rev-parse HEAD')) base = ok('c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff\n');
		else if (joined.includes('git show') && joined.includes(':apps/app/wrangler.jsonc')) {
			base = ok(JSON.stringify(authoredConfig(priorDoTags)));
		} else if (joined.includes('scripts/release-check.ts')) base = ok('[BLOCKED] deployment authorization\nrelease-check: 49 PASS\n');
		else if (joined === 'bun run build') base = ok('compose-assets: composed\n');
		else if (joined.includes('deploy-preflight.ts')) base = ok('[PASS] config\n[WARN] values: reused keys\ndeploy-preflight: 18 PASS, 2 WARN, 0 FAIL\n');
		else if (joined.includes('deploy --dry-run')) base = ok(DRY_RUN_OK);
		else if (joined.includes('d1 execute') && joined.includes('d1_migrations')) base = ok('name\n0001_a.sql\n0002_b.sql\n');
		else if (joined.includes('d1 migrations list')) base = ok(MIGRATIONS_LIST_NONE);
		else if (joined.includes('deployments list')) base = ok(DEPLOYMENTS_LIST);
		else if (joined.includes('d1 migrations apply')) base = ok('Migrations applied\n');
		else if (joined.includes('wrangler deploy')) base = ok(over.deployOutput ?? DEPLOY_OUTPUT);
		else if (joined.includes('test:live')) base = ok('P17 live 5/5 PASS\n');
		else if (joined.startsWith('curl')) base = ok(`<script src="/assets/${LIVE_JS}"></script>`);
		else if (joined.includes('d1 execute')) base = ok(SWITCHES_OUTPUT);
		else base = ok('');

		return { ...base, ...override };
	};

	const deps: DeployDeps = {
		run,
		repoRoot: REPO,
		readFile: (path: string) => {
			if (files[path] !== undefined) return files[path]!;
			throw new Error(`fake readFile: no such file ${path}`);
		},
		fileExists: (path: string) => files[path] !== undefined || path === `${APP}/migrations`,
		listDir: (path: string) => (path === `${APP}/migrations` ? localMigrations : []),
		appendFile: (path: string, text: string) => appends.push({ path, text }),
		writeLog: (path: string, text: string) => writtenLogs.push({ path, text }),
		now: () => new Date('2026-10-23T00:00:00Z'),
		log: (line: string) => logs.push(line),
	};
	return { deps, commands, logs, appends, writtenLogs };
}

const REHEARSAL: DeployOptions = { yes: false, withSecrets: false, acceptDoMigration: false };
const DEPLOY: DeployOptions = { yes: true, withSecrets: false, acceptDoMigration: false };

const joinAll = (commands: string[][]): string[] => commands.map((c) => c.join(' '));
const indexOfCmd = (commands: string[][], needle: string): number =>
	joinAll(commands).findIndex((c) => c.includes(needle));

// ---------------------------------------------------------------------------

describe('deploy.ts — pure parsers', () => {
	test('parseVersionId reads the Current Version ID', () => {
		expect(parseVersionId(DEPLOY_OUTPUT)).toBe(NEW_VERSION_ID);
		expect(parseVersionId('no id here')).toBeNull();
	});

	test('parseLatestDeploymentId reads the version id', () => {
		expect(parseLatestDeploymentId(DEPLOYMENTS_LIST)).toBe(ROLLBACK_ID);
	});

	test('parsePendingMigrations reads migration filenames', () => {
		const out = 'Migrations to be applied:\n│ 0040_team_mode.sql │\n│ 0041_x.sql │\n';
		expect(parsePendingMigrations(out)).toEqual(['0040_team_mode.sql', '0041_x.sql']);
		expect(parsePendingMigrations(MIGRATIONS_LIST_NONE)).toEqual([]);
	});

	test('productionDoTags / builtBindings / productionHost / lastDeployedCommit', () => {
		expect(productionDoTags(authoredConfig(['v1', 'v2']))).toEqual(['v1', 'v2']);
		expect(builtBindings(builtConfig()).doClasses).toContain('FlueModuleBuilderAgent');
		expect(productionHost(authoredConfig())).toBe(HOST);
		expect(
			lastDeployedCommit(JSON.stringify([
				{ packet: 'P17', commit: 'old', at: '2026-10-01T00:00:00Z' },
				{ packet: 'P17', commit: 'new', at: '2026-10-22T00:00:00Z' },
				{ packet: 'P04', commit: 'other', at: '2026-10-25T00:00:00Z' },
			])),
		).toBe('new');
	});

	test('resolveSwitchReport applies platform-switch defaults', () => {
		const report = resolveSwitchReport('team_mode on\n');
		expect(report).toContain('team_mode = on (set)');
		expect(report).toContain('spend_enforcement = on (env-default)');
		expect(report.length).toBe(5);
	});
});

describe('deploy.ts — rehearsal (no --yes)', () => {
	test('runs every check and the two remote READS, then stops with NO remote write', () => {
		const h = makeHarness();
		const result = runDeploy(REHEARSAL, h.deps);
		expect(result.ok).toBe(true);
		expect(result.wroteRemote).toBe(false);
		const all = joinAll(h.commands);
		// reads happened
		expect(all.some((c) => c.includes('d1 migrations list'))).toBe(true);
		expect(all.some((c) => c.includes('deployments list'))).toBe(true);
		// writes did NOT
		expect(all.some((c) => c.includes('d1 migrations apply'))).toBe(false);
		expect(all.some((c) => /\bwrangler deploy\b/.test(c) && !c.includes('--dry-run'))).toBe(false);
		expect(all.some((c) => c.includes('test:live'))).toBe(false);
	});

	test('no remote-WRITE command appears without --yes (contract)', () => {
		const h = makeHarness();
		runDeploy(REHEARSAL, h.deps);
		for (const c of joinAll(h.commands)) {
			expect(c.includes('migrations apply')).toBe(false);
			expect(c.includes('secret put')).toBe(false);
		}
	});
});

describe('deploy.ts — order & remote writes (--yes)', () => {
	test('migrations apply runs strictly BEFORE wrangler deploy', () => {
		const h = makeHarness();
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(true);
		expect(result.wroteRemote).toBe(true);
		const applyIdx = indexOfCmd(h.commands, 'd1 migrations apply');
		const deployIdx = joinAll(h.commands).findIndex((c) => /\bwrangler deploy\b/.test(c) && !c.includes('--dry-run'));
		expect(applyIdx).toBeGreaterThanOrEqual(0);
		expect(deployIdx).toBeGreaterThanOrEqual(0);
		expect(applyIdx).toBeLessThan(deployIdx);
	});

	test('the Version ID is parsed out of the deploy output', () => {
		const h = makeHarness();
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.versionId).toBe(NEW_VERSION_ID);
		expect(result.rollbackId).toBe(ROLLBACK_ID);
	});

	test('no command ever contains "secret put"', () => {
		const h = makeHarness();
		runDeploy({ ...DEPLOY, withSecrets: true }, h.deps);
		for (const c of joinAll(h.commands)) expect(c.includes('secret put')).toBe(false);
	});

	test('no command uses `deploy --env` or `migrations ... --local`', () => {
		const h = makeHarness();
		runDeploy(DEPLOY, h.deps);
		for (const c of joinAll(h.commands)) {
			expect(/deploy .*--env/.test(c)).toBe(false);
			expect(/migrations .*--local/.test(c)).toBe(false);
		}
	});
});

describe('deploy.ts — stops at first failure', () => {
	test('a non-main branch is refused before anything else runs', () => {
		const h = makeHarness({ responses: { 'git rev-parse --abbrev-ref': ok('feature/x\n') } });
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('branch');
		// nothing beyond the branch read ran
		expect(joinAll(h.commands).some((c) => c.includes('release-check'))).toBe(false);
	});

	test('a dirty tree is refused', () => {
		const h = makeHarness({ responses: { 'git status --porcelain': ok(' M file.ts\n') } });
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('clean-tree');
	});

	test('release-check failing stops the run (nothing after it)', () => {
		const h = makeHarness({ responses: { 'scripts/release-check.ts': { exitCode: 1 } } });
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('release-check');
		expect(joinAll(h.commands).some((c) => c === 'bun run build')).toBe(false);
	});

	test('a failed smoke stops and prints the exact rollback command', () => {
		const h = makeHarness({ responses: { 'test:live': { exitCode: 1 } } });
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('smoke');
		expect(h.logs.some((l) => l.includes(`rollback ${ROLLBACK_ID}`))).toBe(true);
		// the switch report (platform_switches) never ran after the failure
		expect(joinAll(h.commands).some((c) => c.includes('platform_switches'))).toBe(false);
	});
});

describe('deploy.ts — the flag & drift rules', () => {
	test('--owner-only is added to preflight when .prod.vars has no JUDGE_ACCESS_CODE', () => {
		const h = makeHarness({ hasJudgeCode: false });
		runDeploy(REHEARSAL, h.deps);
		const preflight = joinAll(h.commands).find((c) => c.includes('deploy-preflight.ts'));
		expect(preflight).toContain('--owner-only');
	});

	test('--owner-only is NOT added when .prod.vars has JUDGE_ACCESS_CODE', () => {
		const h = makeHarness({ hasJudgeCode: true });
		runDeploy(REHEARSAL, h.deps);
		const preflight = joinAll(h.commands).find((c) => c.includes('deploy-preflight.ts'));
		expect(preflight).not.toContain('--owner-only');
	});

	test('--secrets-file appears ONLY with --with-secrets', () => {
		const without = makeHarness();
		runDeploy(DEPLOY, without.deps);
		expect(joinAll(without.commands).some((c) => c.includes('--secrets-file'))).toBe(false);

		const withSecrets = makeHarness();
		runDeploy({ ...DEPLOY, withSecrets: true }, withSecrets.deps);
		const deployCmd = joinAll(withSecrets.commands).find((c) => /\bwrangler deploy\b/.test(c) && !c.includes('--dry-run'));
		expect(deployCmd).toContain('--secrets-file .prod.vars');
	});

	test('a new DO migration tag needs --accept-do-migration as well as --yes', () => {
		// HEAD adds v5; the last deployed commit had only v1..v4.
		const blocked = makeHarness({ headDoTags: ['v1', 'v2', 'v3', 'v4', 'v5'], priorDoTags: ['v1', 'v2', 'v3', 'v4'] });
		const result = runDeploy(DEPLOY, blocked.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('do-migration-tags');
		expect(joinAll(blocked.commands).some((c) => c.includes('d1 migrations apply'))).toBe(false);

		// With the flag, it proceeds.
		const accepted = makeHarness({ headDoTags: ['v1', 'v2', 'v3', 'v4', 'v5'], priorDoTags: ['v1', 'v2', 'v3', 'v4'] });
		const okResult = runDeploy({ ...DEPLOY, acceptDoMigration: true }, accepted.deps);
		expect(okResult.ok).toBe(true);
		expect(accepted.logs.some((l) => l.includes('rollback') && l.toLowerCase().includes('refused'))).toBe(true);
	});

	test('drift — a remote APPLIED migration not in apps/app/migrations is refused (item B)', () => {
		const h = makeHarness({
			responses: { 'select name from d1_migrations': ok('name\n0001_a.sql\n9999_surprise.sql\n') },
			localMigrations: ['0001_a.sql'],
		});
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('migration-drift');
		expect(joinAll(h.commands).some((c) => c.includes('select name from d1_migrations'))).toBe(true);
		expect(joinAll(h.commands).some((c) => c.includes('d1 migrations apply'))).toBe(false);
	});

	test('no drift when every applied-remote migration is present locally (item B)', () => {
		const h = makeHarness({
			responses: { 'select name from d1_migrations': ok('name\n0001_a.sql\n0002_b.sql\n') },
			localMigrations: ['0001_a.sql', '0002_b.sql', '0003_c.sql'],
		});
		expect(runDeploy(DEPLOY, h.deps).ok).toBe(true);
	});

	test("an applied-migrations result with no readable names stops before any write (lead review)", () => {
		// The live database always has migrations applied; reading none means the
		// output was not understood, and the drift check would silently pass.
		const h = makeHarness({ responses: { 'select name from d1_migrations': ok('┌──────┐\n│ name │\n└──────┘\n') } });
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('migrations-applied');
		expect(joinAll(h.commands).some((c) => c.includes('d1 migrations apply'))).toBe(false);
		expect(result.wroteRemote).toBe(false);
	});
});

describe('deploy.ts — evidence (item G)', () => {
	test('an evidence section is APPENDED to docs/release-evidence.md; docs/live-receipts.json is never written', () => {
		const h = makeHarness();
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(true);
		expect(h.appends.length).toBe(1);
		expect(h.appends[0]!.path).toContain('docs/release-evidence.md');
		const text = h.appends[0]!.text;
		expect(text).toContain('## Production deploy (2026-10-23, bun run deploy)');
		expect(text).toContain(NEW_VERSION_ID);
		expect(text).toContain(HOST);
		expect(text).toContain(ROLLBACK_ID);
		expect(text).toContain('lr_deadbeefcafef00d');
		expect(text).toContain('== dist');
		// the manual commit command names both docs files
		expect(h.logs.some((l) => l.includes('git add docs/release-evidence.md docs/live-receipts.json'))).toBe(true);
		// the script never writes docs/live-receipts.json — not via a command, not via append
		for (const c of joinAll(h.commands)) {
			expect(c.includes('live-receipts.json')).toBe(false);
			expect(c.includes('release-evidence.md')).toBe(false);
		}
		for (const a of h.appends) expect(a.path).not.toContain('live-receipts.json');
	});

	test('the version reads (unparsed) in the evidence when the deploy has no Version ID (items E+G)', () => {
		const h = makeHarness({ deployOutput: 'Total Upload: 1 KiB\nDeployed caddie-app\n' });
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(true);
		expect(h.appends[0]!.text).toContain('(unparsed)');
	});

	test('a missing P17 receipt records (none) as the smoke receipt id', () => {
		const h = makeHarness({ noReceiptsFile: true });
		const result = runDeploy({ ...DEPLOY, acceptDoMigration: true }, h.deps);
		expect(result.ok).toBe(true);
		expect(h.appends[0]!.text).toContain('Smoke receipt | `(none)`');
	});

	test('latestP17ReceiptId reads the id of the newest P17 receipt', () => {
		const text = JSON.stringify([
			{ packet: 'P17', id: 'lr_old', at: '2026-10-01T00:00:00Z' },
			{ packet: 'P17', id: 'lr_new', at: '2026-10-22T00:00:00Z' },
			{ packet: 'P04', id: 'lr_other', at: '2026-10-25T00:00:00Z' },
		]);
		expect(latestP17ReceiptId(text)).toBe('lr_new');
		expect(latestP17ReceiptId('[]')).toBeNull();
		expect(latestP17ReceiptId('not json')).toBeNull();
	});
});

describe('deploy.ts — item A: listDir dep (no real filesystem read)', () => {
	test('the drift check reads apps/app/migrations through the injected listDir, never node:fs', () => {
		const seen: string[] = [];
		const h = makeHarness();
		const base = h.deps.listDir!;
		const deps: DeployDeps = {
			...h.deps,
			listDir: (path: string) => {
				seen.push(path);
				return base(path);
			},
		};
		const result = runDeploy(DEPLOY, deps);
		expect(result.ok).toBe(true);
		expect(seen.some((p) => p.endsWith('apps/app/migrations'))).toBe(true);
	});
});

describe('deploy.ts — item B: parseAppliedMigrations', () => {
	test('reads applied names from a d1_migrations result in table, loose and JSON shapes', () => {
		expect(parseAppliedMigrations('name\n0001_a.sql\n0002_b.sql\n')).toEqual(['0001_a.sql', '0002_b.sql']);
		expect(parseAppliedMigrations('│ name │\n│ 0040_team_mode.sql │\n')).toEqual(['0040_team_mode.sql']);
		expect(parseAppliedMigrations('[{"name":"0001_a.sql"},{"name":"0002_b.sql"}]')).toEqual(['0001_a.sql', '0002_b.sql']);
		expect(parseAppliedMigrations('no rows')).toEqual([]);
	});
});

describe('deploy.ts — item C: every d1 execute carries --config wrangler.jsonc', () => {
	test('the applied-migrations query and the switch report both pass --config wrangler.jsonc', () => {
		const h = makeHarness();
		runDeploy(DEPLOY, h.deps);
		const executes = joinAll(h.commands).filter((c) => c.includes('d1 execute'));
		expect(executes.length).toBeGreaterThanOrEqual(2);
		for (const c of executes) expect(c).toContain('--config wrangler.jsonc');
	});
});

describe('deploy.ts — item D: rollback handle must be parseable before a write', () => {
	test('with --yes, an unparseable live version id STOPS before any remote write', () => {
		const h = makeHarness({ responses: { 'deployments list': ok('Created: now\n(no version id here)\n') } });
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('rollback-handle');
		expect(result.wroteRemote).toBe(false);
		expect(joinAll(h.commands).some((c) => c.includes('d1 migrations apply'))).toBe(false);
		expect(joinAll(h.commands).some((c) => /\bwrangler deploy\b/.test(c) && !c.includes('--dry-run'))).toBe(false);
		expect(result.steps.at(-1)?.detail).toContain('nothing was changed');
		expect(result.steps.at(-1)?.detail).toContain('deployments list');
	});

	test('in a rehearsal, an unparseable live version id only WARNs (no write to protect)', () => {
		const h = makeHarness({ responses: { 'deployments list': ok('Created: now\n(no version id here)\n') } });
		const result = runDeploy(REHEARSAL, h.deps);
		expect(result.ok).toBe(true);
		expect(result.wroteRemote).toBe(false);
		expect(h.logs.some((l) => l.includes('WARN') && l.includes('deployments list'))).toBe(true);
	});
});

describe('deploy.ts — item E: unparsed Version ID warns, does not stop', () => {
	test('a deploy with no Version ID in its output still runs smoke and the switch report', () => {
		const h = makeHarness({ deployOutput: 'Total Upload: 1 KiB\nDeployed caddie-app\n' });
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(true);
		expect(result.versionId).toBeUndefined();
		expect(joinAll(h.commands).some((c) => c.includes('test:live'))).toBe(true);
		expect(joinAll(h.commands).some((c) => c.includes('platform_switches'))).toBe(true);
		expect(h.logs.some((l) => l.includes('WARN') && l.includes('Version ID'))).toBe(true);
	});
});

describe('deploy.ts — item F: unknown DO baseline counts every tag as new', () => {
	test('no P17 receipt means every HEAD DO tag is new, so --yes alone is refused', () => {
		const blocked = makeHarness({ noReceiptsFile: true });
		const result = runDeploy(DEPLOY, blocked.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('do-migration-tags');
		expect(joinAll(blocked.commands).some((c) => c.includes('d1 migrations apply'))).toBe(false);

		const accepted = makeHarness({ noReceiptsFile: true });
		expect(runDeploy({ ...DEPLOY, acceptDoMigration: true }, accepted.deps).ok).toBe(true);
	});

	test('an unreadable wrangler.jsonc at the last deployed commit counts every tag as new', () => {
		const blocked = makeHarness({ responses: { 'git show': { exitCode: 1 } } });
		const result = runDeploy(DEPLOY, blocked.deps);
		expect(result.ok).toBe(false);
		expect(result.steps.at(-1)?.name).toBe('do-migration-tags');
		expect(result.steps.at(-1)?.detail).toContain('unreadable');
	});
});

describe('deploy.ts — item I: running: line before each command', () => {
	test('every command the runner ran is echoed with a running: line', () => {
		const h = makeHarness();
		runDeploy(DEPLOY, h.deps);
		const running = h.logs.filter((l) => l.startsWith('running: '));
		expect(running.length).toBe(h.commands.length);
		expect(running.some((l) => l.includes('wrangler deploy'))).toBe(true);
	});
});

describe('deploy.ts — item H: per-step logs and failure-path log hint', () => {
	test('each step writes a .deploy-logs/<stamp>/NN-<step>.log with stdout and stderr', () => {
		const h = makeHarness();
		runDeploy(DEPLOY, h.deps);
		expect(h.writtenLogs.length).toBe(h.commands.length);
		for (const l of h.writtenLogs) {
			expect(l.path).toContain('.deploy-logs/');
			expect(/\.deploy-logs\/[^/]+\/\d{2}-[A-Za-z0-9-]+\.log$/.test(l.path)).toBe(true);
			expect(l.text).toContain('--- stdout ---');
			expect(l.text).toContain('--- stderr ---');
		}
	});

	test('a failing step prints the path of its log', () => {
		const h = makeHarness({ responses: { 'test:live': { exitCode: 1 } } });
		const result = runDeploy(DEPLOY, h.deps);
		expect(result.ok).toBe(false);
		expect(h.logs.some((l) => l.includes('log: ') && l.includes('.deploy-logs/'))).toBe(true);
	});
});
