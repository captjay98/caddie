import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P09 local contract tests — the fixture and manifest invariants that hold
 * without any live execution. The journey itself is tests/live/forge-react-hono.spec.ts
 * (BLOCKED on credentials).
 */

const REPO = join(import.meta.dir, '..');
const MANIFEST = join(REPO, 'tests', 'acceptance', 'manifest.json');
const FIXTURE = join(REPO, 'tests', 'fixtures', 'forge-task-tracker');
const RECIPE = join(REPO, 'stacks', 'react-hono', 'recipe.ts');

describe('P09 acceptance scaffolding (local invariants)', () => {
	test('the acceptance manifest exists and is valid JSON with protected paths', () => {
		expect(existsSync(MANIFEST)).toBe(true);
		const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
			manifestVersion: string;
			stack: string;
			phases: { id: string; commands?: string[] }[];
			protectedPaths: string[];
		};
		expect(manifest.manifestVersion).toBe('1');
		expect(manifest.stack).toBe('react-hono');
		const ids = manifest.phases.map((p) => p.id);
		expect(ids).toContain('install');
		expect(ids).toContain('deliberate-red');
		expect(ids).toContain('browser-check');
		expect(manifest.protectedPaths).toContain('tests/acceptance/');
	});

	test('the fixture app is complete and its tests pass locally', async () => {
		for (const file of [
			'package.json',
			'bun.lock',
			'tsconfig.json',
			'public/index.html',
			'src/app.ts',
			'src/routes.test.ts',
			'src/server.ts',
			'src/main.tsx',
		]) {
			expect(existsSync(join(FIXTURE, file)), file).toBe(true);
		}
		// The fixture is a standalone app: install its deps if missing (fresh
		// clone), then run its own tests as the seeded baseline.
		if (!existsSync(join(FIXTURE, 'node_modules'))) {
			const install = Bun.spawnSync(['bun', 'install'], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' });
			expect(install.exitCode, `${install.stdout}${install.stderr}`).toBe(0);
		}
		const proc = Bun.spawnSync(['bun', 'test', 'src/'], { cwd: FIXTURE, stdout: 'pipe', stderr: 'pipe' });
		const output = `${proc.stdout}${proc.stderr}`;
		expect(proc.exitCode).toBe(0);
		expect(output).toMatch(/\d+ pass/);
	});

	test('the stack recipe validates against the frozen contract', async () => {
		expect(existsSync(RECIPE)).toBe(true);
		// Import the recipe and validate it with the contract schema.
		const { recipe } = await import(join(RECIPE));
		const { StackRecipeSchema } = await import('@caddie/contracts');
		const { parse } = await import('valibot');
		const validated = parse(StackRecipeSchema, recipe);
		expect(validated.id).toBe('react-hono');
		// "verified" since the P09 journey (scripts/run-journey.ts) executed the
		// acceptance manifest in the live sandbox with exit 0 — see the P09
		// evidence record in docs/plans/2026-10-03-fresh-build/execution-ledger.md.
		expect(validated.availability).toBe('verified');
	});

	test('the journey runner fails honestly without credentials (never fakes a run)', () => {
		const proc = Bun.spawnSync(['bun', 'run', join(REPO, 'scripts', 'run-journey.ts')], {
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, CADDIE_LIVE_AUTHORIZED: undefined, CONTREE_BASE_URL: undefined, NEBIUS_API_KEY: undefined },
		});
		const output = `${proc.stdout}${proc.stderr}`;
		expect(proc.exitCode).not.toBe(0);
		expect(output).toContain('BLOCKED');
		expect(output).not.toContain('PASSED');
	});
});
