import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	checkMigrations,
	checkProductionBuild,
	checkProductionConfig,
	checkProductionValues,
	knownKeys,
	keysCutByHash,
	parseJsonc,
	parseSecretsFile,
	REQUIRED_KEYS,
	type Finding,
	type ProductionTarget,
	type WorkerConfig,
} from '../scripts/deploy-preflight.ts';

/**
 * S10 production preflight (scripts/deploy-preflight.ts). Everything here is
 * local: the committed Worker config, fixture values and temporary build trees.
 * No Cloudflare call is made and no real secret is read.
 */

const ROOT = join(import.meta.dir, '..');
const APP_DIR = join(ROOT, 'apps', 'app');
const NOW = new Date('2026-10-19T12:00:00Z');
const DB_ID = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const HOST = 'caddie.example.com';
// The address this repo actually deploys to (apps/app/wrangler.jsonc).
const COMMITTED_HOST = 'caddie.jamalibrahim.dev';

function committedConfig(): WorkerConfig {
	return parseJsonc(readFileSync(join(APP_DIR, 'wrangler.jsonc'), 'utf8')) as WorkerConfig;
}

/** The committed config normalized to the custom-domain shape (workers.dev off). */
function filledConfig(): WorkerConfig {
	const config = committedConfig();
	const prod = config.env!.production!;
	prod.d1_databases = prod.d1_databases!.map((db) => ({ ...db, database_id: DB_ID }));
	prod.routes = [{ pattern: HOST, custom_domain: true }];
	prod.workers_dev = false;
	return config;
}

const fails = (findings: readonly Finding[]) => findings.filter((f) => f.level === 'FAIL').map((f) => f.detail);
const warns = (findings: readonly Finding[]) => findings.filter((f) => f.level === 'WARN').map((f) => f.detail);

const TARGET: ProductionTarget = { hosts: [HOST], workersDev: false, d1DatabaseId: DB_ID, migrationsDir: join(APP_DIR, 'migrations') };

/** A complete, valid production values set. Every value is unique so leaks are detectable. */
function goodValues(): Map<string, string> {
	return new Map([
		['BETTER_AUTH_SECRET', 'prod-secret-marker-0123456789abcdefghijkl'],
		['BETTER_AUTH_URL', `https://${HOST}`],
		['INVITE_ALLOWLIST', 'owner@example.com, helper@example.com'],
		['OPERATOR_EMAILS', 'owner@example.com'],
		['NEBIUS_API_KEY', 'prod-nebius-marker'],
		['TAVILY_API_KEY', 'prod-tavily-marker'],
		['CONTREE_BASE_URL', 'https://sandbox.example.net'],
		['CONTREE_API_TOKEN', 'prod-contree-marker'],
		['CONTREE_PROJECT_ID', 'prod-project-marker'],
		['APP_SECRETS_KEYS', `k1:${Buffer.alloc(32, 7).toString('base64')}`],
		['JUDGE_ACCESS_CODE', 'judge-code-marker-1234'],
		['JUDGE_ACCESS_UNTIL', '2026-12-16'],
		['GITHUB_CLIENT_ID', 'prod-github-id-marker'],
		['GITHUB_CLIENT_SECRET', 'prod-github-secret-marker'],
	]);
}

const LOCAL = new Map([
	['BETTER_AUTH_SECRET', 'local-secret-marker-0123456789abcdefghijkl'],
	['GITHUB_CLIENT_ID', 'local-github-id-marker'],
	['GITHUB_CLIENT_SECRET', 'local-github-secret-marker'],
	['GOOGLE_CLIENT_ID', 'local-google-id-marker'],
	['GOOGLE_CLIENT_SECRET', 'local-google-secret-marker'],
	['NEBIUS_API_KEY', 'local-nebius-marker'],
]);

async function check(values: Map<string, string>, local: Map<string, string> = LOCAL, target = TARGET): Promise<Finding[]> {
	return checkProductionValues(values, { target, local, now: NOW });
}

describe('S10 preflight: the committed production environment', () => {
	test('restates every binding, and the committed owner inputs are real', () => {
		const { findings, target } = checkProductionConfig(committedConfig(), APP_DIR);
		expect(findings.some((f) => f.level === 'PASS' && f.detail.startsWith('env.production restates every binding'))).toBe(true);
		expect(fails(findings)).toEqual([]);
		expect(warns(findings)).toEqual([]);
		expect(target.workersDev).toBe(false);
		expect(target.hosts).toEqual([COMMITTED_HOST]);
		expect(target.d1DatabaseId).toMatch(/^[0-9a-f][0-9a-f-]{35}$/);
	});

	test('a config that still has the placeholders fails, naming both owner inputs', () => {
		const config = filledConfig();
		config.env!.production!.d1_databases![0]!.database_id = 'local-dev-placeholder';
		config.env!.production!.routes = [{ pattern: '<CADDIE_DOMAIN>', custom_domain: true }];
		const open = fails(checkProductionConfig(config, APP_DIR).findings);
		expect(open).toHaveLength(2);
		expect(open.some((detail) => detail.includes('D1 database_id'))).toBe(true);
		expect(open.some((detail) => detail.includes('<CADDIE_DOMAIN>'))).toBe(true);
	});

	test('with the D1 id and domain filled in, nothing fails', () => {
		const { findings, target } = checkProductionConfig(filledConfig(), APP_DIR);
		expect(fails(findings)).toEqual([]);
		expect(target).toEqual({ hosts: [HOST], workersDev: false, d1DatabaseId: DB_ID, migrationsDir: join(APP_DIR, 'migrations') });
	});

	test('a binding added at the top but not to env.production fails, by name', () => {
		const config = filledConfig();
		config.kv_namespaces = [{ binding: 'CACHE' }];
		delete config.env!.production!.worker_loaders;
		const detail = fails(checkProductionConfig(config, APP_DIR).findings).join(' | ');
		expect(detail).toContain('worker_loaders LOADER');
		expect(detail).toContain('kv_namespaces CACHE');
	});

	test('workers.dev instead of a domain passes; no address at all fails', () => {
		const config = filledConfig();
		delete config.env!.production!.routes;
		config.env!.production!.workers_dev = true;
		expect(fails(checkProductionConfig(config, APP_DIR).findings)).toEqual([]);
		config.env!.production!.workers_dev = false;
		expect(fails(checkProductionConfig(config, APP_DIR).findings).join(' ')).toContain('no public address');
	});
});

describe('S10 preflight: reading the values file the way wrangler uploads it', () => {
	test('dotenv rules: comments, inline comments, quotes, export, escaped newlines', () => {
		const values = parseSecretsFile(
			[
				'# a comment line',
				'# JUDGE_MAX_PROJECTS=3',
				'BETTER_AUTH_URL=https://caddie.example.com   # trailing comment',
				'export NEBIUS_API_KEY=abc123',
				"RESEND_FROM='Caddie <mail@example.com>'",
				'GITHUB_APP_PRIVATE_KEY="-----BEGIN KEY-----\\nline\\n-----END KEY-----"',
				'JUDGE_ACCESS_ENABLED=',
			].join('\n'),
		);
		expect(Object.fromEntries(values)).toEqual({
			BETTER_AUTH_URL: 'https://caddie.example.com',
			NEBIUS_API_KEY: 'abc123',
			RESEND_FROM: 'Caddie <mail@example.com>',
			GITHUB_APP_PRIVATE_KEY: '-----BEGIN KEY-----\nline\n-----END KEY-----',
			JUDGE_ACCESS_ENABLED: '',
		});
	});

	test('a JSON file is read as JSON, as wrangler does', () => {
		expect(Object.fromEntries(parseSecretsFile('{"NEBIUS_API_KEY":"x","JUDGE_MAX_PROJECTS":3}'))).toEqual({
			NEBIUS_API_KEY: 'x',
			JUDGE_MAX_PROJECTS: '3',
		});
	});

	test('a # glued into an unquoted value is caught (dotenv would cut it there)', () => {
		expect(keysCutByHash('A=abc#def\nB="abc#def"\nC=abc # comment\nD=   # empty\n# E=x#y')).toEqual(['A']);
	});
});

describe('S10 preflight: the production values', () => {
	test('a complete production set passes', async () => {
		const findings = await check(goodValues());
		expect(fails(findings)).toEqual([]);
		expect(warns(findings)).toEqual([]);
	});

	test('no finding ever contains a value, on any failing or warning branch', async () => {
		// Each scenario drives different branches; every value is a distinct marker.
		const scenarios: [string, string][][] = [
			[['BETTER_AUTH_URL', 'https://wrong-host-marker.example.org']],
			[['BETTER_AUTH_URL', 'https://caddie.example.com/trailing-marker/']],
			[['BETTER_AUTH_URL', 'http://plain-http-marker.example.com']],
			[['BETTER_AUTH_SECRET', 'short-secret-marker']],
			[['BETTER_AUTH_SECRET', LOCAL.get('BETTER_AUTH_SECRET')!]],
			[['JUDGE_ACCESS_CODE', 'shortcode']],
			[['JUDGE_ACCESS_UNTIL', '2026-01-02']],
			[['JUDGE_ACCESS_UNTIL', 'never-date-marker']],
			[['JUDGE_MAX_PROJECTS', 'three-marker'], ['JUDGE_MAX_BUILDS_PER_DAY', '0'], ['JUDGE_ACCESS_ENABLED', '0']],
			[['APP_SECRETS_KEYS', `k1:${Buffer.alloc(16, 9).toString('base64')}`]],
			[['APP_SECRETS_KEYS', 'no-colon-keyring-marker']],
			[['INVITE_ALLOWLIST', 'owner@example.com, broken-address-marker'], ['OPERATOR_EMAILS', 'other-operator@example.com']],
			[['GITHUB_CLIENT_ID', LOCAL.get('GITHUB_CLIENT_ID')!], ['GOOGLE_CLIENT_ID', LOCAL.get('GOOGLE_CLIENT_ID')!], ['GOOGLE_CLIENT_SECRET', 'google-secret-marker']],
			[['GOOGLE_CLIENT_ID', 'half-google-marker']],
			[['RESEND_API_KEY', 'half-resend-marker'], ['CLOUDFLARE_API_TOKEN', 'half-cloudflare-marker']],
			[['NEBIUS_API_KEY', LOCAL.get('NEBIUS_API_KEY')!]],
			[['AUTH_STUB_BASE_URL', 'http://stub-marker.local'], ['CADDIE_LIVE_AUTHORIZED', '1'], ['MYSTERY_KEY', 'mystery-marker']],
			[['CONTREE_BASE_URL', 'ftp://sandbox-marker.example.net'], ['EGRESS_DENY_HOSTS', '']],
		];
		for (const changes of scenarios) {
			const values = goodValues();
			for (const [key, value] of changes) values.set(key, value);
			const text = [...values].map(([key, value]) => `${key}=${value}`).join('\n');
			const findings = await checkProductionValues(values, { target: TARGET, local: LOCAL, now: NOW, text });
			expect(fails(findings).length + warns(findings).length).toBeGreaterThan(0);
			const details = findings.map((f) => f.detail).join('\n');
			for (const value of values.values()) {
				if (value.length >= 6) expect(details).not.toContain(value);
			}
		}
	});

	test('each required value is named when missing', async () => {
		const findings = await check(new Map([['JUDGE_ACCESS_UNTIL', '2026-12-16']]));
		const detail = fails(findings).find((d) => d.startsWith('missing:'))!;
		for (const key of REQUIRED_KEYS.filter((k) => k !== 'JUDGE_ACCESS_UNTIL')) expect(detail).toContain(key);
		expect(fails(findings).join(' ')).toContain('no owner sign-in');
	});

	test('owner-only: the judge keys are not required, and a judge code present fails', async () => {
		const values = goodValues();
		values.delete('JUDGE_ACCESS_CODE');
		values.delete('JUDGE_ACCESS_UNTIL');
		const ownerOnly = await checkProductionValues(values, { target: TARGET, local: LOCAL, now: NOW, ownerOnly: true });
		expect(fails(ownerOnly)).toEqual([]);
		expect(ownerOnly.some((f) => f.level === 'PASS' && f.detail.includes('judge access: off'))).toBe(true);
		expect(fails(await check(values)).join(' ')).toContain('JUDGE_ACCESS_CODE');
		const withCode = await checkProductionValues(goodValues(), { target: TARGET, local: LOCAL, now: NOW, ownerOnly: true });
		expect(fails(withCode).join(' ')).toContain('--owner-only, but JUDGE_ACCESS_CODE is set');
	});

	test('test-only switches fail; the live-fetch switch warns', async () => {
		const values = goodValues();
		values.set('AUTH_TEST_MODE', '1');
		values.set('GITHUB_API_BASE_URL', 'http://127.0.0.1:9999');
		values.set('CADDIE_LIVE_AUTHORIZED', '1');
		const findings = await check(values);
		expect(fails(findings).join(' ')).toContain('AUTH_TEST_MODE, GITHUB_API_BASE_URL');
		expect(warns(findings).join(' ')).toContain('CADDIE_LIVE_AUTHORIZED');
	});

	test('BETTER_AUTH_URL must be the bare https production origin', async () => {
		for (const [url, expected] of [
			['http://caddie.example.com', 'https:// origin'],
			['https://caddie.example.com/', 'bare origin'],
			['https://other.example.com', 'not the production address'],
		] as const) {
			const values = goodValues();
			values.set('BETTER_AUTH_URL', url);
			expect(fails(await check(values)).join(' ')).toContain(expected);
		}
		const values = goodValues();
		values.set('BETTER_AUTH_URL', 'https://caddie-app.someone.workers.dev');
		const workersDev: ProductionTarget = { ...TARGET, hosts: [], workersDev: true };
		expect(fails(await check(values, LOCAL, workersDev))).toEqual([]);
	});

	test('local values: the auth secret and the GitHub app must differ; the Google client and keys warn', async () => {
		const values = goodValues();
		values.set('BETTER_AUTH_SECRET', LOCAL.get('BETTER_AUTH_SECRET')!);
		values.set('GITHUB_CLIENT_ID', LOCAL.get('GITHUB_CLIENT_ID')!);
		values.set('GOOGLE_CLIENT_ID', LOCAL.get('GOOGLE_CLIENT_ID')!);
		values.set('GOOGLE_CLIENT_SECRET', LOCAL.get('GOOGLE_CLIENT_SECRET')!);
		values.set('NEBIUS_API_KEY', LOCAL.get('NEBIUS_API_KEY')!);
		const findings = await check(values);
		const failed = fails(findings).join(' | ');
		expect(failed).toContain('BETTER_AUTH_SECRET is the same as the local one');
		expect(failed).toContain('GITHUB_CLIENT_ID is the local OAuth app');
		const warned = warns(findings).join(' | ');
		expect(warned).toContain('GOOGLE_CLIENT_ID is the local OAuth client');
		expect(warned).toContain('same as local: NEBIUS_API_KEY');
	});

	test('sign-in pairs and feature groups are all or nothing', async () => {
		const values = goodValues();
		values.delete('GITHUB_CLIENT_SECRET');
		values.set('RESEND_API_KEY', 're_x');
		values.set('CLOUDFLARE_API_TOKEN', 'cf_x');
		const failed = fails(await check(values)).join(' | ');
		expect(failed).toContain('GitHub sign-in is half set');
		expect(failed).toContain('emails (Resend) is half set: missing RESEND_FROM');
		expect(failed).toContain('publishing is half set');
	});

	test('operators must be invited, and addresses must be addresses', async () => {
		const values = goodValues();
		values.set('OPERATOR_EMAILS', 'owner@example.com, ops@example.com');
		values.set('INVITE_ALLOWLIST', 'owner@example.com, not-an-address');
		const failed = fails(await check(values)).join(' | ');
		expect(failed).toContain('1 operator address(es) are not in INVITE_ALLOWLIST');
		expect(failed).toContain('INVITE_ALLOWLIST must be comma-separated email addresses (1 entry is not)');
	});

	test('judge settings: short code, past date and non-numbers fail; zeros and the kill switch warn', async () => {
		const values = goodValues();
		values.set('JUDGE_ACCESS_CODE', 'short');
		values.set('JUDGE_ACCESS_UNTIL', '2026-10-01');
		values.set('JUDGE_MAX_PROJECTS', '3o');
		values.set('JUDGE_MAX_BUILDS_PER_DAY', '0');
		values.set('JUDGE_ACCESS_ENABLED', '0');
		const findings = await check(values);
		const failed = fails(findings).join(' | ');
		expect(failed).toContain('JUDGE_ACCESS_CODE is shorter than 16');
		expect(failed).toContain('JUDGE_ACCESS_UNTIL is already past');
		expect(failed).toContain('JUDGE_MAX_PROJECTS must be a whole number');
		const warned = warns(findings).join(' | ');
		expect(warned).toContain('JUDGE_MAX_BUILDS_PER_DAY=0 means none');
		expect(warned).toContain('new judge starts are switched off');
	});

	test('the app-keys keyring is checked by the same parser the Worker uses', async () => {
		const values = goodValues();
		values.set('APP_SECRETS_KEYS', `k1:${Buffer.alloc(16, 1).toString('base64')}`);
		expect(fails(await check(values)).join(' ')).toContain('must be exactly 32 bytes');
	});

	test('unknown keys warn (a typo would otherwise be silent)', async () => {
		const values = goodValues();
		values.set('JUDGE_ACCES_CODE', 'x'.repeat(20));
		expect(warns(await check(values)).join(' ')).toContain('JUDGE_ACCES_CODE');
	});
});

describe('S10 preflight: the template and the ignore rule', () => {
	const template = readFileSync(join(APP_DIR, '.prod.vars.example'), 'utf8');

	test('apps/app/.prod.vars.example lists exactly the keys the preflight knows', () => {
		const listed = [...template.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!);
		expect(new Set(listed).size).toBe(listed.length);
		expect([...listed].sort()).toEqual([...knownKeys()].sort());
	});

	test('the template carries no values except the documented judge end date', () => {
		const filled = [...parseSecretsFile(template)].filter(([, value]) => value !== '');
		expect(filled).toEqual([['JUDGE_ACCESS_UNTIL', '2026-12-16']]);
	});

	test('git ignores apps/app/.prod.vars but tracks the example', () => {
		const ignored = (path: string) => Bun.spawnSync(['git', 'check-ignore', '-q', path], { cwd: ROOT }).exitCode === 0;
		expect(ignored('apps/app/.prod.vars')).toBe(true);
		expect(ignored('apps/app/.prod.vars.example')).toBe(false);
	});
});

describe('S10 preflight: the production build and the migrations', () => {
	function buildTree(builtConfig: WorkerConfig, extraAssets: string[] = []): string {
		const appDir = mkdtempSync(join(tmpdir(), 'caddie-preflight-'));
		mkdirSync(join(appDir, 'dist', 'caddie_app'), { recursive: true });
		mkdirSync(join(appDir, 'dist', 'client', 'app'), { recursive: true });
		writeFileSync(join(appDir, 'dist', 'caddie_app', 'wrangler.json'), JSON.stringify(builtConfig));
		writeFileSync(join(appDir, 'dist', 'client', 'index.html'), '<!doctype html>');
		writeFileSync(join(appDir, 'dist', 'client', 'app', 'index.html'), '<!doctype html>');
		for (const name of extraAssets) writeFileSync(join(appDir, 'dist', 'client', name), 'x');
		return appDir;
	}

	const productionBuild = (): WorkerConfig => ({
		name: 'caddie-app',
		routes: [{ pattern: HOST, custom_domain: true }],
		d1_databases: [{ binding: 'DB', database_id: DB_ID }],
		worker_loaders: [{ binding: 'LOADER' }],
		durable_objects: {
			bindings: [
				{ name: 'PREVIEW_DB', class_name: 'PreviewDatabase' },
				{ name: 'COORDINATOR', class_name: 'FlueCoordinatorAgent' },
			],
		},
		migrations: [{ tag: 'v1', new_sqlite_classes: ['FlueCoordinatorAgent'] }, { tag: 'v2', new_sqlite_classes: ['PreviewDatabase'] }],
		assets: { directory: '../client' },
	});

	test('a production build with nothing private in its assets passes', () => {
		expect(fails(checkProductionBuild(buildTree(productionBuild()), TARGET))).toEqual([]);
	});

	test('a vars or env file inside the public assets fails, by name', () => {
		const detail = fails(checkProductionBuild(buildTree(productionBuild(), ['.dev.vars', '.env.production']), TARGET)).join(' ');
		expect(detail).toContain('dist/client/.dev.vars');
		expect(detail).toContain('dist/client/.env.production');
	});

	test('a build that still has legacy_env fails (the repo\'s wrangler 4.113 refuses to deploy it)', () => {
		const withLegacy = { ...productionBuild(), legacy_env: true } as WorkerConfig;
		expect(fails(checkProductionBuild(buildTree(withLegacy), TARGET)).join(' ')).toContain('legacy_env');
	});

	test('a local build (placeholder D1 id) or an unbound Durable Object class fails', () => {
		const local = productionBuild();
		local.d1_databases = [{ binding: 'DB', database_id: 'local-dev-placeholder' }];
		expect(fails(checkProductionBuild(buildTree(local), TARGET)).join(' ')).toContain('not the production build');
		const unbound = productionBuild();
		unbound.migrations!.push({ tag: 'v3', new_sqlite_classes: ['FlueHelloAgent'] });
		expect(fails(checkProductionBuild(buildTree(unbound), TARGET)).join(' ')).toContain('FlueHelloAgent');
	});

	test('the real migrations are numbered without gaps; a gap fails', () => {
		const real = checkMigrations(join(APP_DIR, 'migrations'));
		expect(real[0]!.level).toBe('PASS');
		const dir = mkdtempSync(join(tmpdir(), 'caddie-migrations-'));
		for (const name of ['0001_a.sql', '0002_b.sql', '0004_d.sql']) writeFileSync(join(dir, name), '');
		expect(checkMigrations(dir)[0]!.detail).toContain('0004_d.sql');
	});
});

describe('S10 preflight: the command', () => {
	test('against the committed config and a matching values file it passes, and prints no value', () => {
		const dir = mkdtempSync(join(tmpdir(), 'caddie-prodvars-'));
		const path = join(dir, '.prod.vars');
		const values = goodValues();
		values.set('BETTER_AUTH_URL', `https://${COMMITTED_HOST}`);
		const lines = [...values].map(([key, value]) => `${key}="${value}"`);
		writeFileSync(path, `${lines.join('\n')}\n`);
		const run = Bun.spawnSync([process.execPath, 'scripts/deploy-preflight.ts', '--vars', path, '--skip-build'], { cwd: ROOT });
		const out = run.stdout.toString();
		expect(run.exitCode).toBe(0);
		expect(out).toContain(`serves ${COMMITTED_HOST}`);
		for (const value of values.values()) if (value.length >= 6) expect(out).not.toContain(value);
	});
});
