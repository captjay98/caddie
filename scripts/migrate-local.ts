/**
 * Local dev D1 migrator.
 *
 *   bun run db:migrate:local
 *
 * Applies apps/app/migrations/*.sql IN NUMERIC ORDER to the LOCAL miniflare D1
 * that `bun run dev` reads (the default `.wrangler/state` persistence the
 * cloudflare vite plugin uses when `persistState: true`).
 *
 * Why this exists: the app never applies the product/identity migrations at
 * runtime — only the test harnesses do, test-side, via each fixture worker's
 * `/__test/ddl` endpoint. So after a local-state reset the real dev D1 is empty
 * and Better Auth returns a schema-mismatch 500. This script is the supported
 * way to (re)seed the dev DB.
 *
 * Honesty / safety:
 *   - LOCAL ONLY. Hard-refuses --remote style use; delegates to
 *     `wrangler d1 execute --local`, which never touches a deployed DB.
 *   - Idempotent-friendly: migration files use `create table if not exists`
 *     where the project already does; a statement that fails stops the run with
 *     the offending file named (never a silent partial apply).
 *   - No deploy, no network, no secrets printed.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const appDir = join(repoRoot, 'apps', 'app');
const migrationsDir = join(appDir, 'migrations');
const DB_BINDING = 'DB';
const PERSIST_TO = join(appDir, '.wrangler', 'state');

/**
 * Resolve the EXACT wrangler the dev server uses — the one bundled under
 * @cloudflare/vite-plugin — not the top-level `wrangler` devDependency.
 *
 * This matters: the local D1 file carries miniflare's internal `_cf_ALARM`
 * table, whose column count changed between miniflare releases. The vite dev
 * server embeds one miniflare version; the top-level `wrangler` CLI pins a
 * NEWER one. Migrating with the newer CLI writes a `_cf_ALARM` the dev server's
 * older miniflare then refuses ("3 columns but 2 values"), aborting the Worker
 * runtime at startup. Using the vite plugin's own wrangler keeps the on-disk
 * D1 schema consistent with the runtime that reads it.
 */
function devServerWranglerBin(): string {
	const pluginEntry = Bun.resolveSync('@cloudflare/vite-plugin', appDir);
	const wranglerPkg = Bun.resolveSync('wrangler/package.json', dirname(pluginEntry));
	const bin = join(dirname(wranglerPkg), 'bin', 'wrangler.js');
	if (!existsSync(bin)) {
		throw new Error(`could not locate the dev server's wrangler bin at ${bin}`);
	}
	return bin;
}

const WRANGLER_BIN = devServerWranglerBin();

function orderedMigrationFiles(): string[] {
	return readdirSync(migrationsDir)
		.filter((f) => /^\d+_.*\.sql$/.test(f))
		.sort((a, b) => {
			const na = Number.parseInt(a.split('_', 1)[0] ?? '0', 10);
			const nb = Number.parseInt(b.split('_', 1)[0] ?? '0', 10);
			return na - nb;
		});
}

function applyFile(file: string): void {
	const full = join(migrationsDir, file);
	const res = spawnSync(
		process.execPath,
		[
			WRANGLER_BIN,
			'd1',
			'execute',
			DB_BINDING,
			'--local',
			'--persist-to',
			PERSIST_TO,
			'--yes',
			'--file',
			full,
		],
		{ cwd: appDir, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
	);
	if (res.status !== 0) {
		throw new Error(`migration FAILED at ${file} (wrangler exit ${res.status ?? 'signal ' + res.signal})`);
	}
}

function main(): void {
	const files = orderedMigrationFiles();
	if (files.length === 0) {
		throw new Error(`no migration files found in ${migrationsDir}`);
	}
	console.log(`Using dev-server wrangler: ${WRANGLER_BIN}`);
	console.log(`Applying ${files.length} migration(s) to LOCAL D1 (${PERSIST_TO}):`);
	for (const file of files) {
		console.log(`  → ${file}`);
		applyFile(file);
	}
	console.log(`\n✅ Local D1 migrated: ${files.length} file(s) applied in order.`);
}

main();
