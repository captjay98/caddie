import { readdirSync, readFileSync } from 'node:fs';
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

let combined: string | undefined;

/**
 * Every migration's SQL in apply order. Harnesses that used to read one named
 * file use this instead: fold points rename files (58 files became 4 on
 * 2026-10-28), so a hardcoded name is a time bomb. Reading the whole schema is
 * safe for in-memory harnesses — the folds are cumulative.
 */
export function allMigrationSql(): string {
	combined ??= allMigrationPaths()
		.map((path) => readFileSync(path, 'utf8'))
		.join('\n');
	return combined;
}

/** The CREATE TABLE statement text for one table, from the full schema. */
export function createTableSql(table: string): string {
	const match = new RegExp(`create table (?:if not exists )?"?${table}"?[\\s\\S]*?\\);`, 'i').exec(
		allMigrationSql(),
	);
	if (!match) throw new Error(`no create table for ${table}`);
	return match[0];
}

interface SqliteLike {
	exec(sql: string): unknown;
	query(sql: string): { all(): unknown[] };
}

/**
 * Apply the whole schema to an in-memory database, tolerating minimal parent
 * tables a harness pre-created (projects, build_workflows, user, …). When a
 * table already exists, the columns the folded definition adds are appended
 * with ALTER TABLE, so the fixture keeps its hand-shaped rows while the app
 * still sees every final column. Folded files carry final definitions only —
 * the original ALTERs are merged into each CREATE — which is why the append
 * step is needed at all.
 */
export function applyFinalSchema(sqlite: SqliteLike): void {
	for (const statement of splitStatements(allMigrationSql())) {
		try {
			sqlite.exec(statement);
		} catch (error) {
			const existing = /\btable "?([A-Za-z0-9_]+)"? already exists\b/.exec(String((error as Error)?.message));
			if (!existing) throw error;
			addMissingColumns(sqlite, existing[1]!);
		}
	}
}

/** One statement per entry: CREATE TRIGGER bodies contain semicolons, so they
 * run from their CREATE line through the closing `end;` line. */
function splitStatements(sql: string): string[] {
	const out: string[] = [];
	let buffer: string[] = [];
	let inTrigger = false;
	for (const line of sql.split('\n')) {
		if (!inTrigger && /^create\s+trigger\b/i.test(line.trim())) inTrigger = true;
		buffer.push(line);
		if (inTrigger) {
			if (/^end;\s*$/i.test(line.trim())) {
				out.push(buffer.join('\n'));
				buffer = [];
				inTrigger = false;
			}
		} else if (/;\s*$/.test(line)) {
			out.push(buffer.join('\n'));
			buffer = [];
		}
	}
	const rest = buffer.join('\n').trim();
	if (rest) out.push(rest);
	return out.map((statement) => statement.trim()).filter(Boolean);
}

function addMissingColumns(sqlite: SqliteLike, table: string): void {
	const definition = createTableSql(table);
	const body = definition.slice(definition.indexOf('(') + 1, definition.lastIndexOf(')'));
	const present = new Set(
		(sqlite.query(`pragma table_info("${table}")`).all() as { name: string }[]).map((column) =>
			column.name.toLowerCase(),
		),
	);
	for (const part of splitTopLevel(body)) {
		const name = /^"?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(part.trim())?.[1];
		if (!name || present.has(name.toLowerCase())) continue;
		if (/^(primary|unique|check|foreign|constraint)\b/i.test(part.trim())) continue;
		sqlite.exec(`alter table "${table}" add column ${addableColumn(part.trim())}`);
	}
}

function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const char of body) {
		if (char === '(') depth++;
		if (char === ')') depth--;
		if (char === ',' && depth === 0) {
			parts.push(current);
			current = '';
		} else current += char;
	}
	if (current.trim()) parts.push(current);
	return parts;
}

/** SQLite refuses ADD COLUMN with PRIMARY KEY/UNIQUE, a NOT NULL that has no
 * default, or a CHECK — keep the type and default, which is what fixtures read. */
function addableColumn(part: string): string {
	const name = /^"?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(part)?.[1] ?? part;
	const type = /^"?[A-Za-z_][A-Za-z0-9_]*"?\s+([A-Za-z]+)/.exec(part)?.[1] ?? 'text';
	const fallback = /\bdefault\s+('(?:[^']|'')*'|[^\s,]+)/i.exec(part)?.[1];
	return `"${name}" ${type}${fallback ? ` default ${fallback}` : ''}`;
}

/**
 * Fixture seam for harnesses that write plan documents directly (publish,
 * activity, versions, seeded example apps…): they model a project created
 * BEFORE the default-on quality policy existed, so its drafts were never
 * subject to quality-v1's review. Inserting a legacy policy row claims that
 * history honestly: the project is admitted, just not under quality-v1, so
 * the publication guard (migration 0058) stays silent while the real gate
 * keeps guarding every quality-v1 project. Never use this in app code.
 */
export function fixtureLegacyQualityPolicy(
	sqlite: { prepare(sql: string): { run(...args: unknown[]): unknown } },
	projectId: string,
): void {
	// Replace, not ignore: project creation auto-admits quality-v1 (default-on),
	// and this helper re-models that same project as a pre-gate one.
	sqlite
		.prepare(
			"insert or replace into quality_projects (projectId,policyVersion,authorRouteId,createdAt) values (?,'fixture-legacy-v0','fixture', '2026-10-01T00:00:00.000Z')",
		)
		.run(projectId);
}
