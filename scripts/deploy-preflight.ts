#!/usr/bin/env bun
/**
 * Production deploy preflight (S10; the procedure is
 * docs/runbooks/production-deploy.md).
 *
 * Local and read-only. It reads apps/app/wrangler.jsonc (env.production), the
 * gitignored production values file that `wrangler deploy --secrets-file`
 * uploads (apps/app/.prod.vars), the production build in apps/app/dist and the
 * migrations folder. It makes no network call and never prints a value: every
 * finding names a key, a file or a count.
 *
 *   bun scripts/deploy-preflight.ts                # everything
 *   bun scripts/deploy-preflight.ts --skip-build   # before building
 *   bun scripts/deploy-preflight.ts --vars <file>  # another values file
 *
 * Exits 1 when anything FAILs. WARN lines are decisions to read, not blockers.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeAccessUntilMs } from '../apps/app/src/server/judge-access.ts';
import { parseKeyring } from '../apps/app/src/server/secret-box.ts';

export type Level = 'PASS' | 'WARN' | 'FAIL';

export interface Finding {
	readonly level: Level;
	readonly check: string;
	readonly detail: string;
}

/** Production cannot run what judges use without these. */
export const REQUIRED_KEYS = [
	'BETTER_AUTH_SECRET',
	'BETTER_AUTH_URL',
	'INVITE_ALLOWLIST',
	'OPERATOR_EMAILS',
	'NEBIUS_API_KEY',
	'TAVILY_API_KEY',
	'CONTREE_BASE_URL',
	'CONTREE_API_TOKEN',
	'CONTREE_PROJECT_ID',
	'APP_SECRETS_KEYS',
	'JUDGE_ACCESS_CODE',
	'JUDGE_ACCESS_UNTIL',
] as const;

/** The owner's own sign-in: at least one complete pair (judges need neither). */
export const SIGN_IN_PAIRS = {
	Google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
	GitHub: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
} as const;

/** Features that switch on only when every key of the group is set. */
export const GROUPS = {
	'emails (Resend)': ['RESEND_API_KEY', 'RESEND_FROM'],
	'GitHub App': ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'],
	publishing: [
		'CLOUDFLARE_API_TOKEN',
		'CLOUDFLARE_ACCOUNT_ID',
		'CLOUDFLARE_DISPATCH_NAMESPACE',
		'CLOUDFLARE_ROUTES_KV_ID',
		'CLOUDFLARE_APPS_ZONE_ID',
		'APPS_DOMAIN',
	],
} as const;

/** Optional on their own; each has a documented default (docs/setup/owner-inputs.md). */
export const OPTIONAL_KEYS = [
	'JUDGE_ACCESS_MAX_ACCOUNTS',
	'JUDGE_ACCESS_ENABLED',
	'JUDGE_MAX_PROJECTS',
	'JUDGE_MAX_BUILDS_PER_DAY',
	'JUDGE_MAX_MESSAGES_PER_DAY',
	'JUDGE_MAX_DISCOVERY_PER_DAY',
	'JUDGE_EXAMPLE_PROJECT_ID',
	'APP_AI_MONTHLY_LIMIT_CENTS',
	'CONTREE_IMAGE',
	'EGRESS_DENY_HOSTS',
	'ABUSE_INBOX',
	'WEB_RISK_API_KEY',
	'GITHUB_APP_SLUG',
	'GITHUB_WEBHOOK_SECRET',
] as const;

/** Test-only switches: in production they would stub sign-in or point Caddie at a fake service. */
export const FORBIDDEN_KEYS = [
	'AUTH_TEST_MODE',
	'AUTH_STUB_BASE_URL',
	'AUTH_SESSION_TTL_SECONDS',
	'GITHUB_API_BASE_URL',
	'CLOUDFLARE_API_BASE',
	'CADDIE_NPM_REGISTRY',
] as const;

/** Allowed, but nothing in the product needs them. */
export const DISCOURAGED_KEYS: Readonly<Record<string, string>> = {
	CADDIE_LIVE_AUTHORIZED: 'it only lets the evidence API fetch any public URL, and no screen uses that route',
};

/** Whole numbers where a typo would silently fall back to the default. */
const COUNT_KEYS = [
	'JUDGE_ACCESS_MAX_ACCOUNTS',
	'JUDGE_MAX_PROJECTS',
	'JUDGE_MAX_BUILDS_PER_DAY',
	'JUDGE_MAX_MESSAGES_PER_DAY',
	'JUDGE_MAX_DISCOVERY_PER_DAY',
	'APP_AI_MONTHLY_LIMIT_CENTS',
] as const;

/** Must not be the local value: a shared value would make local tokens and codes work in production. */
const MUST_DIFFER_FROM_LOCAL = ['BETTER_AUTH_SECRET', 'JUDGE_ACCESS_CODE'] as const;

/** Better as separate keys: judging spend stays separate and can be revoked without breaking local work. */
const SHOULD_DIFFER_FROM_LOCAL = ['NEBIUS_API_KEY', 'TAVILY_API_KEY', 'CONTREE_API_TOKEN', 'RESEND_API_KEY'] as const;

/** Every key the template documents and the preflight knows. */
export function knownKeys(): string[] {
	return [
		...REQUIRED_KEYS,
		...Object.values(SIGN_IN_PAIRS).flat(),
		...Object.values(GROUPS).flat(),
		...OPTIONAL_KEYS,
	];
}

// --- reading the files ------------------------------------------------------------

const DOTENV_LINE =
	/(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/**
 * The values `wrangler deploy --secrets-file` would upload. Wrangler tries
 * JSON first, then dotenv 16's parse; the dotenv branch is that parse
 * verbatim (wrangler-dist/cli.js, parse16), so this reads a file exactly as
 * the upload will.
 */
export function parseSecretsFile(text: string): Map<string, string> {
	const out = new Map<string, string>();
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			for (const [key, value] of Object.entries(parsed)) {
				if (value !== null && value !== undefined) out.set(key, String(value));
			}
			return out;
		}
	} catch {
		// Not JSON: dotenv, as wrangler does.
	}
	const lines = text.replace(/\r\n?/gm, '\n');
	for (const match of lines.matchAll(DOTENV_LINE)) {
		let value = (match[2] ?? '').trim();
		const quote = value[0];
		value = value.replace(/^(['"`])([\s\S]*)\1$/gm, '$2');
		if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
		out.set(match[1]!, value);
	}
	return out;
}

/** Keys whose unquoted value has a `#` glued to it: dotenv cuts the value there. */
export function keysCutByHash(text: string): string[] {
	const keys: string[] = [];
	for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
		const match = /^\s*(?:export\s+)?([\w.-]+)\s*=(.*)$/.exec(raw);
		if (!match) continue;
		const rest = match[2]!.trim();
		if (/^['"`]/.test(rest)) continue;
		if (/[^\s#]#/.test(rest)) keys.push(match[1]!);
	}
	return keys;
}

interface Route {
	pattern: string;
	custom_domain?: boolean;
	zone_name?: string;
}

interface Named {
	binding?: string;
	name?: string;
}

export interface WorkerConfig {
	name?: string;
	routes?: (Route | string)[];
	workers_dev?: boolean;
	preview_urls?: boolean;
	observability?: { enabled?: boolean };
	d1_databases?: { binding: string; database_name?: string; database_id?: string; migrations_dir?: string }[];
	worker_loaders?: Named[];
	durable_objects?: { bindings?: { name: string; class_name: string }[] };
	kv_namespaces?: Named[];
	r2_buckets?: Named[];
	services?: Named[];
	vars?: Record<string, unknown>;
	migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
	assets?: { directory?: string };
	env?: Record<string, WorkerConfig>;
}

export function parseJsonc(text: string): unknown {
	return (Bun as unknown as { JSONC: { parse(input: string): unknown } }).JSONC.parse(text);
}

// --- the production config ----------------------------------------------------------

export interface ProductionTarget {
	/** The hostnames the production routes serve; empty with workers.dev. */
	readonly hosts: readonly string[];
	readonly workersDev: boolean;
	readonly d1DatabaseId: string | null;
	readonly migrationsDir: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTNAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function bindingNames(config: WorkerConfig): Map<string, string[]> {
	const names = new Map<string, string[]>();
	const list = (key: string, items: Named[] | undefined) =>
		names.set(key, (items ?? []).map((item) => item.binding ?? item.name ?? '').filter(Boolean).sort());
	list('d1_databases', config.d1_databases);
	list('worker_loaders', config.worker_loaders);
	list('kv_namespaces', config.kv_namespaces);
	list('r2_buckets', config.r2_buckets);
	list('services', config.services);
	list('durable_objects', config.durable_objects?.bindings);
	names.set('vars', Object.keys(config.vars ?? {}).sort());
	return names;
}

function routeHost(route: Route | string): string {
	const pattern = typeof route === 'string' ? route : route.pattern;
	return pattern.split('/')[0]!.replace(/^\*\./, '').toLowerCase();
}

/** Check env.production in apps/app/wrangler.jsonc; also returns what the other checks compare against. */
export function checkProductionConfig(config: WorkerConfig, appDir: string): { findings: Finding[]; target: ProductionTarget } {
	const findings: Finding[] = [];
	const add = (level: Level, detail: string) => findings.push({ level, check: 'config', detail });
	const prod = config.env?.production;
	const empty: ProductionTarget = { hosts: [], workersDev: false, d1DatabaseId: null, migrationsDir: join(appDir, 'migrations') };
	if (!prod) {
		add('FAIL', 'apps/app/wrangler.jsonc has no env.production block');
		return { findings, target: empty };
	}

	const prodName = prod.name ?? `${config.name}-production`;
	if (prodName === config.name) add('PASS', `deploys as Worker "${prodName}" (the name the dispatch Worker binds to)`);
	else add('WARN', `deploys as Worker "${prodName}", but workers/dispatch binds to "${config.name}"`);

	const top = bindingNames(config);
	const own = bindingNames(prod);
	const missing: string[] = [];
	for (const [key, names] of top) {
		const restated = new Set(own.get(key) ?? []);
		for (const name of names) if (!restated.has(name)) missing.push(`${key} ${name}`);
	}
	if (missing.length > 0) add('FAIL', `env.production does not restate: ${missing.join(', ')} (bindings are not inherited)`);
	else add('PASS', `env.production restates every binding (${[...top.values()].flat().join(', ')})`);

	const db = (prod.d1_databases ?? []).find((entry) => entry.binding === 'DB');
	const d1DatabaseId = db?.database_id && UUID.test(db.database_id) ? db.database_id : null;
	if (!db) add('FAIL', 'env.production has no D1 binding named DB');
	else if (!d1DatabaseId) {
		add('FAIL', 'the production D1 database_id is not a real id yet: run `bunx wrangler d1 create caddie` and put the id it prints in env.production');
	} else add('PASS', `production D1 database "${db.database_name ?? '?'}" has a real id`);
	const migrationsDir = resolve(appDir, db?.migrations_dir ?? 'migrations');

	const routes = prod.routes ?? [];
	const placeholder = routes.some((route) => /[<>]/.test(typeof route === 'string' ? route : route.pattern));
	const hosts = placeholder ? [] : [...new Set(routes.map(routeHost))];
	const workersDev = prod.workers_dev === true;
	if (placeholder) {
		add('FAIL', 'the production route is still <CADDIE_DOMAIN>: put the hostname there (its zone must be on the same Cloudflare account), or remove routes and set workers_dev to true');
	} else if (hosts.length > 0) {
		const bad = hosts.filter((host) => !HOSTNAME.test(host));
		if (bad.length > 0) add('FAIL', `route hostnames that are not plain hostnames: ${bad.join(', ')}`);
		else add('PASS', `serves ${hosts.join(', ')}`);
		if (workersDev) add('WARN', 'workers_dev is also on: a second public address where sign-in cannot work (it only works on BETTER_AUTH_URL)');
	} else if (workersDev) {
		add('PASS', 'serves its workers.dev address (no custom domain)');
	} else {
		add('FAIL', 'env.production has no public address: add a route, or set workers_dev to true');
	}

	if (prod.preview_urls === false) add('PASS', 'preview URLs are off');
	else add('WARN', 'preview_urls is not false: every version would also get its own workers.dev address');
	if (prod.observability?.enabled === true) add('PASS', 'Workers Logs are on');
	else add('WARN', 'Workers Logs are off: production errors would leave no logs');

	return { findings, target: { hosts, workersDev, d1DatabaseId, migrationsDir } };
}

// --- the production values ----------------------------------------------------------

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

function emails(raw: string): string[] {
	return raw
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

function httpsOrigin(raw: string): URL | null {
	try {
		const url = new URL(raw);
		return url.protocol === 'https:' ? url : null;
	} catch {
		return null;
	}
}

export interface ValuesContext {
	readonly target: ProductionTarget;
	/** The local .dev.vars values, compared for equality only. */
	readonly local: ReadonlyMap<string, string>;
	readonly now: Date;
	/** The raw file, for the `#` check. */
	readonly text?: string;
}

/** Check the production values file. Findings name keys only, never values. */
export async function checkProductionValues(values: ReadonlyMap<string, string>, ctx: ValuesContext): Promise<Finding[]> {
	const findings: Finding[] = [];
	const add = (level: Level, detail: string) => findings.push({ level, check: 'values', detail });
	const has = (key: string) => (values.get(key) ?? '') !== '';
	const value = (key: string) => values.get(key) ?? '';
	const sameAsLocal = (key: string) => has(key) && ctx.local.get(key) === value(key);

	const emptyKeys = [...values].filter(([, v]) => v === '').map(([key]) => key);
	if (emptyKeys.length > 0) add('WARN', `empty lines would upload empty secrets; delete or fill them: ${emptyKeys.join(', ')}`);
	const cut = ctx.text ? keysCutByHash(ctx.text) : [];
	if (cut.length > 0) add('FAIL', `a # inside an unquoted value cuts it short; put these values in quotes: ${cut.join(', ')}`);

	const missing = REQUIRED_KEYS.filter((key) => !has(key));
	if (missing.length > 0) add('FAIL', `missing: ${missing.join(', ')}`);
	else add('PASS', `all ${REQUIRED_KEYS.length} required values are set`);

	const forbidden = FORBIDDEN_KEYS.filter((key) => values.has(key));
	if (forbidden.length > 0) add('FAIL', `test-only switches must not reach production: ${forbidden.join(', ')}`);
	for (const [key, why] of Object.entries(DISCOURAGED_KEYS)) {
		if (values.has(key)) add('WARN', `${key} is set; leave it out: ${why}`);
	}
	const known = new Set([...knownKeys(), ...FORBIDDEN_KEYS, ...Object.keys(DISCOURAGED_KEYS)]);
	const unknown = [...values.keys()].filter((key) => !known.has(key));
	if (unknown.length > 0) add('WARN', `keys Caddie does not read (a typo?): ${unknown.join(', ')}`);

	// Sign-in.
	if (has('BETTER_AUTH_URL')) {
		const url = httpsOrigin(value('BETTER_AUTH_URL'));
		const bare = url && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash && !value('BETTER_AUTH_URL').endsWith('/');
		const host = url?.hostname.toLowerCase() ?? '';
		const matches = ctx.target.hosts.length > 0 ? ctx.target.hosts.includes(host) : ctx.target.workersDev && host.endsWith('.workers.dev');
		if (!url) add('FAIL', 'BETTER_AUTH_URL must be an https:// origin');
		else if (!bare) add('FAIL', 'BETTER_AUTH_URL must be the bare origin (https://host, no path and no trailing slash)');
		else if (!matches) add('FAIL', 'BETTER_AUTH_URL is not the production address in env.production (sign-in redirects and cookies would point elsewhere)');
		else add('PASS', 'BETTER_AUTH_URL is the production address');
	}
	if (has('BETTER_AUTH_SECRET') && value('BETTER_AUTH_SECRET').length < 32) {
		add('FAIL', 'BETTER_AUTH_SECRET is shorter than 32 characters (use `openssl rand -base64 32`)');
	}
	for (const key of MUST_DIFFER_FROM_LOCAL) {
		if (sameAsLocal(key)) add('FAIL', `${key} is the same as the local one; production needs its own`);
	}
	const pairs = Object.entries(SIGN_IN_PAIRS).map(([provider, keys]) => ({ provider, keys, set: keys.filter(has) }));
	for (const pair of pairs) {
		if (pair.set.length === 1) add('FAIL', `${pair.provider} sign-in is half set: ${pair.keys.join(' and ')} go together`);
	}
	const complete = pairs.filter((pair) => pair.set.length === pair.keys.length);
	if (complete.length === 0) add('FAIL', 'no owner sign-in: set the Google or the GitHub pair (judges need neither, you do)');
	else add('PASS', `owner sign-in: ${complete.map((pair) => pair.provider).join(' and ')}`);
	if (sameAsLocal('GITHUB_CLIENT_ID')) {
		add('FAIL', 'GITHUB_CLIENT_ID is the local OAuth app, whose one callback URL is localhost: make a production OAuth app');
	}
	if (sameAsLocal('GOOGLE_CLIENT_ID')) {
		add('WARN', 'GOOGLE_CLIENT_ID is the local OAuth client: add the production callback URL to it and publish its consent screen, or make a production client');
	}
	const invited = new Set(has('INVITE_ALLOWLIST') ? emails(value('INVITE_ALLOWLIST')) : []);
	for (const key of ['INVITE_ALLOWLIST', 'OPERATOR_EMAILS', 'ABUSE_INBOX'] as const) {
		if (!has(key)) continue;
		const list = emails(value(key));
		const bad = list.filter((entry) => !EMAIL.test(entry)).length;
		if (list.length === 0 || bad > 0) add('FAIL', `${key} must be comma-separated email addresses (${bad} entr${bad === 1 ? 'y is' : 'ies are'} not)`);
	}
	if (has('OPERATOR_EMAILS')) {
		const outside = emails(value('OPERATOR_EMAILS')).filter((entry) => !invited.has(entry)).length;
		if (outside > 0) add('FAIL', `${outside} operator address(es) are not in INVITE_ALLOWLIST, so they could not sign in to /operator`);
	}

	// Judges.
	if (has('JUDGE_ACCESS_CODE') && value('JUDGE_ACCESS_CODE').length < 16) {
		add('FAIL', 'JUDGE_ACCESS_CODE is shorter than 16 characters, which keeps judge access off (use `openssl rand -base64 24`)');
	}
	if (has('JUDGE_ACCESS_UNTIL')) {
		const until = judgeAccessUntilMs(value('JUDGE_ACCESS_UNTIL'));
		if (until === null) add('FAIL', 'JUDGE_ACCESS_UNTIL is not a date (YYYY-MM-DD)');
		else if (until <= ctx.now.getTime()) add('FAIL', 'JUDGE_ACCESS_UNTIL is already past, so judge access is closed');
		else add('PASS', 'judge access window is open until JUDGE_ACCESS_UNTIL');
	}
	if (value('JUDGE_ACCESS_ENABLED') === '0') add('WARN', 'JUDGE_ACCESS_ENABLED=0: new judge starts are switched off');
	for (const key of COUNT_KEYS) {
		if (!has(key)) continue;
		if (!/^\d+$/.test(value(key).trim())) add('FAIL', `${key} must be a whole number; anything else silently means the default`);
		else if (Number(value(key)) === 0) add('WARN', `${key}=0 means none`);
	}

	// Services.
	for (const key of ['CONTREE_BASE_URL'] as const) {
		if (has(key) && !httpsOrigin(value(key))) add('FAIL', `${key} must be an https:// URL`);
	}
	if (has('APP_SECRETS_KEYS')) {
		try {
			await parseKeyring(value('APP_SECRETS_KEYS'));
			add('PASS', 'APP_SECRETS_KEYS is a usable keyring');
		} catch (error) {
			// parseKeyring's messages name the entry or key id, never key material.
			add('FAIL', error instanceof Error ? error.message : 'APP_SECRETS_KEYS is not a usable keyring');
		}
	}
	for (const [feature, keys] of Object.entries(GROUPS)) {
		const set = keys.filter(has);
		if (set.length > 0 && set.length < keys.length) {
			add('FAIL', `${feature} is half set: missing ${keys.filter((key) => !has(key)).join(', ')}`);
		} else if (set.length === 0) add('PASS', `${feature}: off (not set)`);
		else add('PASS', `${feature}: on`);
	}
	const reused = SHOULD_DIFFER_FROM_LOCAL.filter(sameAsLocal);
	if (reused.length > 0) {
		add('WARN', `same as local: ${reused.join(', ')}; separate production keys keep judging spend separate and revocable`);
	}
	return findings;
}

// --- the production build and the migrations ------------------------------------------

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...filesUnder(full));
		else out.push(full);
	}
	return out;
}

/** Check that apps/app/dist holds the PRODUCTION build and serves nothing private. */
export function checkProductionBuild(appDir: string, target: ProductionTarget): Finding[] {
	const findings: Finding[] = [];
	const add = (level: Level, detail: string) => findings.push({ level, check: 'build', detail });
	const configPath = join(appDir, 'dist', 'caddie_app', 'wrangler.json');
	if (!existsSync(configPath)) {
		add('FAIL', 'no build: run `CLOUDFLARE_ENV=production bun run build`');
		return findings;
	}
	const built = JSON.parse(readFileSync(configPath, 'utf8')) as WorkerConfig;
	const db = (built.d1_databases ?? []).find((entry) => entry.binding === 'DB');
	if (!target.d1DatabaseId || db?.database_id !== target.d1DatabaseId) {
		add('FAIL', 'apps/app/dist is not the production build (its D1 id is not env.production\'s): run `CLOUDFLARE_ENV=production bun run build`');
	} else add('PASS', 'apps/app/dist is the production build');

	const builtHosts = (built.routes ?? []).map(routeHost);
	if (target.hosts.some((host) => !builtHosts.includes(host))) add('FAIL', 'the build does not carry the production routes: rebuild');

	const bound = new Set((built.durable_objects?.bindings ?? []).map((binding) => binding.class_name));
	const classes = (built.migrations ?? []).flatMap((entry) => [...(entry.new_sqlite_classes ?? []), ...(entry.new_classes ?? [])]);
	const unbound = classes.filter((name) => !bound.has(name));
	if (unbound.length > 0) add('FAIL', `Durable Object classes without a binding in the build: ${unbound.join(', ')}`);
	else add('PASS', `every Durable Object class is bound (${classes.join(', ')})`);
	if (!(built.worker_loaders ?? []).some((loader) => loader.binding === 'LOADER')) add('FAIL', 'the build has no LOADER (Worker Loader) binding');

	const assetsDir = resolve(join(appDir, 'dist', 'caddie_app'), built.assets?.directory ?? '../client');
	if (!existsSync(join(assetsDir, 'index.html')) || !existsSync(join(assetsDir, 'app', 'index.html'))) {
		add('FAIL', 'the composed assets are missing the landing or the /app shell');
	} else {
		const files = filesUnder(assetsDir);
		const privateFiles = files.filter((file) => /^\.(dev\.vars|prod\.vars|env)/.test(file.split('/').at(-1) ?? ''));
		if (privateFiles.length > 0) {
			add('FAIL', `files that would be served publicly: ${privateFiles.map((file) => relative(appDir, file)).join(', ')}`);
		} else add('PASS', `${files.length} public asset files, none of them a vars or env file`);
	}
	return findings;
}

/** Check the D1 migrations are numbered 0001..N with no gap or repeat. */
export function checkMigrations(dir: string): Finding[] {
	if (!existsSync(dir)) return [{ level: 'FAIL', check: 'migrations', detail: `no migrations folder at ${dir}` }];
	const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
	const numbers = files.map((name) => Number(/^(\d{4})_/.exec(name)?.[1] ?? NaN));
	const problems: string[] = [];
	files.forEach((name, index) => {
		if (numbers[index] !== index + 1) problems.push(name);
	});
	if (files.length === 0 || problems.length > 0) {
		return [{ level: 'FAIL', check: 'migrations', detail: `not numbered 0001..${files.length} in order: ${problems.join(', ') || 'none found'}` }];
	}
	return [{ level: 'PASS', check: 'migrations', detail: `${files.length} migrations, 0001-${String(files.length).padStart(4, '0')}, no gap or repeat` }];
}

// --- the command ------------------------------------------------------------------------

function readValuesFile(path: string): { values: Map<string, string>; text: string } | null {
	if (!existsSync(path)) return null;
	const text = readFileSync(path, 'utf8');
	return { values: parseSecretsFile(text), text };
}

async function main(): Promise<void> {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const appDir = join(root, 'apps', 'app');
	const args = process.argv.slice(2);
	const varsIndex = args.indexOf('--vars');
	const varsPath = varsIndex >= 0 && args[varsIndex + 1] ? resolve(args[varsIndex + 1]!) : join(appDir, '.prod.vars');
	const skipBuild = args.includes('--skip-build');

	const findings: Finding[] = [];
	const git = (...argv: string[]) => Bun.spawnSync(['git', ...argv], { cwd: root }).stdout.toString().trim();
	const head = git('rev-parse', 'HEAD');
	const dirty = git('status', '--porcelain');
	findings.push(
		dirty
			? { level: 'WARN', check: 'git', detail: 'uncommitted changes: the deployed code would match no commit' }
			: { level: 'PASS', check: 'git', detail: `clean tree at ${head.slice(0, 12)}` },
	);

	const config = parseJsonc(readFileSync(join(appDir, 'wrangler.jsonc'), 'utf8')) as WorkerConfig;
	const { findings: configFindings, target } = checkProductionConfig(config, appDir);
	findings.push(...configFindings, ...checkMigrations(target.migrationsDir));

	const file = readValuesFile(varsPath);
	if (!file) {
		findings.push({
			level: 'FAIL',
			check: 'values',
			detail: `no production values file at ${relative(root, varsPath)}: copy apps/app/.prod.vars.example to it and fill it in`,
		});
	} else {
		const local = new Map<string, string>();
		for (const path of [join(root, '.dev.vars'), join(appDir, '.dev.vars')]) {
			for (const [key, value] of readValuesFile(path)?.values ?? []) local.set(key, value);
		}
		findings.push(...(await checkProductionValues(file.values, { target, local, now: new Date(), text: file.text })));
	}
	if (!skipBuild) findings.push(...checkProductionBuild(appDir, target));

	console.log(`deploy-preflight (S10) at ${head.slice(0, 12)}`);
	for (const finding of findings) console.log(`[${finding.level}] ${finding.check}: ${finding.detail}`);
	const count = (level: Level) => findings.filter((finding) => finding.level === level).length;
	console.log(`\ndeploy-preflight: ${count('PASS')} PASS, ${count('WARN')} WARN, ${count('FAIL')} FAIL${skipBuild ? ' (build not checked)' : ''}`);
	if (count('FAIL') > 0) {
		console.log('Not ready to deploy. Nothing was uploaded or changed.');
		process.exit(1);
	}
	console.log('Ready for the deploy steps in docs/runbooks/production-deploy.md. Nothing was uploaded or changed.');
}

if (import.meta.main) await main();
