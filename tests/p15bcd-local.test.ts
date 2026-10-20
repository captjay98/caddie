import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');

const STACKS = ['laravel-inertia', 'fastapi-react', 'flutter'] as const;
type Stack = (typeof STACKS)[number];

const REQUIRED_FILES: Record<Stack, string[]> = {
	'laravel-inertia': ['template/composer.json'],
	'fastapi-react': ['template/pyproject.toml'],
	// Track 3 replaced the placeholder template folder with a scaffold module
	// (stacks/flutter/scaffold.ts) and its lockfiles.
	flutter: ['scaffold.ts', 'scaffold-lock.ts'],
};

const SKILL_ASSERTS: Record<Stack, string> = {
	'laravel-inertia': 'disposable test database',
	'fastapi-react': 'uv sync --frozen',
	flutter: 'never a web-render screenshot',
};

describe('P15b/c/d local scaffolding', () => {
	for (const stack of STACKS) {
		test(`${stack}: recipe validates against the frozen contract, availability unverified`, async () => {
			const { recipe } = await import(join(REPO, 'stacks', stack, 'recipe.ts'));
			const { StackRecipeSchema } = await import('@caddie/contracts');
			const { parse } = await import('valibot');
			const validated = parse(StackRecipeSchema, recipe);
			expect(validated.id).toBe(stack);
			expect(validated.availability).toBe('unverified');
		});

		test(`${stack}: template manifest exists`, () => {
			for (const file of REQUIRED_FILES[stack]) {
				expect(existsSync(join(REPO, 'stacks', stack, file)), file).toBe(true);
			}
		});

		test(`${stack}: skill exists and carries its discipline`, () => {
			const skill = readFileSync(
				join(REPO, 'apps', 'app', 'src', 'agents', 'skills', stack, 'SKILL.md'),
				'utf8',
			);
			expect(skill.length).toBeGreaterThan(200);
			expect(skill).toContain(SKILL_ASSERTS[stack]);
		});
	}

	test('flutter defaults to the proven Hono backend (per the frozen scope)', async () => {
		const { FLUTTER_SCAFFOLD_FILES } = await import(join(REPO, 'stacks', 'flutter', 'scaffold.ts'));
		// The app's API client is plain http, and the scaffold ships the same
		// Hono server every react-hono app gets.
		expect(FLUTTER_SCAFFOLD_FILES['pubspec.yaml']).toContain('http: ');
		expect(FLUTTER_SCAFFOLD_FILES['src/server.ts']).toContain('new Hono');
	});

	test('flutter previews its web build and exports a release APK at verify time (Track 3)', async () => {
		const { recipe } = await import(join(REPO, 'stacks', 'flutter', 'recipe.ts'));
		const { flutterApkCommand } = await import(join(REPO, 'stacks', 'flutter', 'scaffold.ts'));
		// Before Track 3 the placeholder previewed only on an emulator. Now the
		// web build (with the app's server) is the in-Caddie preview, the APK is
		// built once the app's address is known, and real-device evidence stays
		// the bar for marking the stack verified (the skill and P15d live spec).
		expect(recipe.preview).toBe('server');
		expect(recipe.build.join(' ')).toContain('flutter build web');
		expect(flutterApkCommand('https://app.example.com')).toContain('flutter build apk --release');
	});
});
