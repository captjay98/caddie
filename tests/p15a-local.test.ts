import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');

describe('P15a local scaffolding', () => {
	test('template structure is complete', () => {
		const template = join(REPO, 'stacks', 'tanstack-start', 'template');
		for (const file of [
			'package.json',
			'vite.config.ts',
			'src/routes/__root.tsx',
			'src/routes/index.tsx',
			'src/router.tsx',
			'src/server.test.tsx',
		]) {
			expect(existsSync(join(template, file)), file).toBe(true);
		}
	});

	test('recipe validates against the frozen contract, availability unverified', async () => {
		const { recipe } = await import(join(REPO, 'stacks', 'tanstack-start', 'recipe.ts'));
		const { StackRecipeSchema } = await import('@caddie/contracts');
		const { parse } = await import('valibot');
		const validated = parse(StackRecipeSchema, recipe);
		expect(validated.id).toBe('tanstack-start');
		expect(validated.preview).toBe('server');
		expect(validated.availability).toBe('unverified');
	});

	test('skill exists and is non-trivial', () => {
		const skill = readFileSync(
			join(REPO, 'apps', 'app', 'src', 'agents', 'skills', 'tanstack-start', 'SKILL.md'),
			'utf8',
		);
		expect(skill.length).toBeGreaterThan(200);
		expect(skill).toContain('server functions');
	});
});
