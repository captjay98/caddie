// Integration harness for part E's contract check (tests/contract-checks.test.ts).
//
// It materialises the REAL react-hono starter once, then for each fixture:
//   - writes the GENERATED caddie/ files + test/setup/d1-file.ts from the block
//     (apps/app/src/server/contract-files.ts) — exactly what the host writes;
//   - drops in the fixture's builder-written src/server.ts, screen and migration;
//   - runs the generated caddie/contract.test.ts in phases (create, read,
//     privacy-screen) in SEPARATE `bun test` processes, against ONE database
//     file — so create (process 1) and read (process 2) really cross a restart.
//
// This is the real contract check running against real apps, not a stub. No
// paid calls, no sandbox. Classification: LOCAL VERIFIED.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCAFFOLD_BASE_FILES } from '../../stacks/react-hono/scaffold.ts';
import { SCAFFOLD_LOCKFILE } from '../../stacks/react-hono/scaffold-lock.ts';
import { generateContractFiles } from '../../apps/app/src/server/contract-files.ts';
import { NOTES_BLOCK, type ContractFixture } from '../fixtures/contract/notes-apps.ts';
import type { ArchitectureBlock } from '@caddie/contracts';

const bun = process.execPath;

/** The generated contract files for the notes block — written at materialise. */
const GENERATED = generateContractFiles(NOTES_BLOCK, { kind: 'small' }).files;

export interface FixtureApp {
	dir: string;
	dbFile: string;
	cleanup(): void;
}

function write(dir: string, path: string, text: string): void {
	const full = join(dir, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/** Materialise the starter + the generated contract files, and install once. */
export function materializeFixtureApp(): FixtureApp {
	if (!SCAFFOLD_LOCKFILE) throw new Error('scaffold-lock.ts is empty; run scripts/refresh-scaffold-lock.ts first');
	const dir = mkdtempSync(join(tmpdir(), 'caddie-contract-'));
	for (const [path, text] of Object.entries(SCAFFOLD_BASE_FILES)) write(dir, path, text);
	write(dir, 'bun.lock', SCAFFOLD_LOCKFILE);
	for (const [path, text] of Object.entries(GENERATED)) write(dir, path, text);

	const install = spawnSync(bun, ['install', '--frozen-lockfile'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
	if ((install.status ?? 1) !== 0) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(`bun install --frozen-lockfile failed:\n${install.stdout}\n${install.stderr}`);
	}
	return {
		dir,
		dbFile: join(dir, 'contract.sqlite'),
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Put a fixture's builder files into the app, replacing any previous fixture's,
 * and (re)write the GENERATED caddie/ files for this fixture's block — exactly
 * what the host writes before a check run. The block defaults to NOTES_BLOCK.
 */
export function applyFixture(app: FixtureApp, fixture: ContractFixture, block: ArchitectureBlock = NOTES_BLOCK): void {
	// Remove a previous fixture's extra migration / screen / app / server so they
	// don't linger across fixtures (notes and team apps use different file names).
	for (const stale of [
		'migrations/0001_notes.sql',
		'migrations/0001_schema.sql',
		'src/NotesScreen.tsx',
		'src/LogsScreen.tsx',
		'src/App.tsx',
		'src/server.ts',
	]) {
		const full = join(app.dir, stale);
		if (existsSync(full)) rmSync(full, { force: true });
	}
	// The generated contract files for THIS fixture's block (contract.ts and
	// contract.test.ts differ per block), overwriting the materialise-time set.
	// A fixture that names its built features gets the feature-scoped test, as
	// the host writes it during a build.
	const generated = generateContractFiles(block, { kind: 'small', ...(fixture.features ? { features: fixture.features } : {}) });
	for (const [path, text] of Object.entries(generated.files)) write(app.dir, path, text);
	for (const [path, text] of Object.entries(fixture.files)) write(app.dir, path, text);
	// Fresh database file for each fixture run.
	for (const suffix of ['', '-wal', '-shm', '.handoff.json']) {
		const f = app.dbFile + suffix;
		if (existsSync(f)) rmSync(f, { force: true });
	}
}

export interface PhaseRun {
	ok: boolean;
	passed: number;
	failed: number;
	out: string;
}

/** Run the generated contract test in one phase (a fresh process). */
export function runPhase(app: FixtureApp, phase: 'create' | 'read' | 'privacy-screen' | 'test-mode'): PhaseRun {
	const result = spawnSync(bun, ['test', 'caddie/contract.test.ts'], {
		cwd: app.dir,
		encoding: 'utf8',
		env: { ...process.env, NO_COLOR: '1', CADDIE_TEST_DB_FILE: app.dbFile, CADDIE_CONTRACT_PHASE: phase },
	});
	const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	const pass = /^\s*(\d+)\s+pass\s*$/m.exec(out);
	const fail = /^\s*(\d+)\s+fail\s*$/m.exec(out);
	return { ok: (result.status ?? 1) === 0, passed: Number(pass?.[1] ?? 0), failed: Number(fail?.[1] ?? 0), out };
}
