import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The ONE source of migration paths for every test harness.
 *
 * Previously each harness hand-maintained its own ordered list of migration
 * files. Those lists drifted: a new migration (e.g. 0018_build_workflow.sql)
 * was added to the app but not to a harness's list, so a route reading the new
 * table failed at test time with "no such table" — and a migration like
 * 0021_project_proposals.sql was referenced by zero harnesses even though live
 * code reads it. Deriving the list from the migrations directory makes a
 * forgotten entry impossible: a committed migration is ALWAYS applied in tests.
 *
 * Migrations are append-only and numerically prefixed (NNNN_name.sql), so
 * lexical sort IS apply order. This returns absolute paths for the full set;
 * `applyMigrations` tolerates re-applying tables that already exist within a
 * single harness, so applying the whole set is safe and drift-proof.
 */

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'apps', 'app', 'migrations');

/** Every committed migration, absolute paths, in apply order (lexical = numeric). */
export function allMigrationPaths(): string[] {
	return readdirSync(MIGRATIONS_DIR)
		.filter((name) => /^\d{4}_.*\.sql$/.test(name))
		.sort()
		.map((name) => join(MIGRATIONS_DIR, name));
}

/** The migrations directory itself, for harnesses that resolve their own names. */
export const migrationsDir = MIGRATIONS_DIR;
