/**
 * Lane 8, step 3 (live seam) — the REAL read-only D1 query, through the dev
 * server's own bundled wrangler.
 *
 * It mirrors scripts/migrate-local.ts exactly: resolve the wrangler bundled
 * under @cloudflare/vite-plugin (NOT the top-level CLI, whose newer miniflare
 * rewrites `_cf_ALARM` and breaks the dev runtime), then
 * `d1 execute DB --local --persist-to <apps/app/.wrangler/state> --json
 * --command <SELECT>`.
 *
 * SAFETY: it REFUSES any statement that is not a single SELECT — no INSERT,
 * UPDATE, DELETE, DROP, PRAGMA or semicolon-chained statement ever reaches
 * wrangler. It never passes `--remote`. This file is reached only behind the
 * live gate; the reader's logic is tested with a fake seam, never this.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { D1Query } from './d1-reader.ts';

/** Reject anything that is not exactly one read-only SELECT. */
export function assertSelectOnly(sql: string): void {
	const trimmed = sql.trim().replace(/;$/, '');
	if (/;/.test(trimmed)) throw new Error('read-only D1 seam: no statement chaining');
	if (!/^select\s/i.test(trimmed)) throw new Error(`read-only D1 seam: only SELECT is allowed, got: ${trimmed.slice(0, 40)}…`);
	if (/\b(insert|update|delete|drop|alter|create|replace|attach|pragma|vacuum|reindex)\b/i.test(trimmed))
		throw new Error('read-only D1 seam: a write/DDL keyword appeared in a SELECT');
}

/**
 * Build the live D1 query seam against the local dev DB. `appDir` defaults to
 * `apps/app` under the repo root. Parameters are inlined by the reader (ids
 * only), so this seam takes just a SQL string; it still asserts SELECT-only.
 */
export function wranglerD1Query(repoRoot: string): D1Query {
	const appDir = join(repoRoot, 'apps', 'app');
	const persistTo = join(appDir, '.wrangler', 'state');
	const wranglerBin = devServerWranglerBin(appDir);

	return async (sql: string) => {
		assertSelectOnly(sql);
		const res = spawnSync(
			process.execPath,
			[wranglerBin, 'd1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--json', '--command', sql],
			{ cwd: appDir, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
		);
		if (res.status !== 0) {
			throw new Error(`d1 read failed (wrangler exit ${res.status ?? 'signal ' + res.signal}): ${res.stderr?.slice(0, 300) ?? ''}`);
		}
		// `--json` prints an array of result objects; the rows are under `results`.
		const parsed = JSON.parse(res.stdout) as Array<{ results?: Array<Record<string, unknown>> }>;
		return parsed[0]?.results ?? [];
	};
}

function devServerWranglerBin(appDir: string): string {
	const pluginEntry = Bun.resolveSync('@cloudflare/vite-plugin', appDir);
	const wranglerPkg = Bun.resolveSync('wrangler/package.json', dirname(pluginEntry));
	const bin = join(dirname(wranglerPkg), 'bin', 'wrangler.js');
	if (!existsSync(bin)) throw new Error(`could not locate the dev server's wrangler bin at ${bin}`);
	return bin;
}
