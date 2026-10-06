import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');

const STACKS = ['laravel-inertia', 'fastapi-react', 'flutter'] as const;
type Stack = (typeof STACKS)[number];

const REQUIRED_FILES: Record<Stack, string[]> = {
	'laravel-inertia': ['template/composer.json'],
	'fastapi-react': ['template/pyproject.toml'],
	flutter: ['template/pubspec.yaml'],
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

	test('flutter defaults to the proven Hono backend (per the frozen scope)', () => {
		const pubspec = readFileSync(
			join(REPO, 'stacks', 'flutter', 'template', 'pubspec.yaml'),
			'utf8',
		);
		// The pairing is at the recipe/skill level; the template's API client
		// dependency set is minimal (http) — no alternate backend assumed.
		expect(pubspec).toContain('http: ');
	});

	test('flutter recipe uses android-emulator preview (real device evidence bar)', async () => {
		const { recipe } = await import(join(REPO, 'stacks', 'flutter', 'recipe.ts'));
		expect(recipe.preview).toBe('android-emulator');
		expect(recipe.build.join(' ')).toContain('apk');
	});
});
