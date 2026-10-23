import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ArchitectureBlock } from '@caddie/contracts';
import { appFeatureFiles } from '../apps/app/src/server/app-feature-files.ts';
import { availableFeatures, checkArchitecture } from '../apps/app/src/server/architecture-gate.ts';
import { isProtectedPath } from '../apps/app/src/agents/permissions.ts';
import { BUILD_RECIPE_INSTRUCTION } from '../apps/app/src/agents/specialists.ts';
import { NOTES_BLOCK } from './fixtures/contract/notes-apps.ts';

/**
 * Lead wiring for lane 9 (parts J and L) and the plan gate for test-mode
 * features. LOCAL VERIFIED: pure functions over the approved block, the
 * protected-path rule and the builders' recipe text.
 */

const PAYMENTS = { currency: 'USD', plans: [], locked: [] } as unknown as NonNullable<ArchitectureBlock['payments']>;
const withPayments: ArchitectureBlock = { ...NOTES_BLOCK, payments: PAYMENTS };
const withPhoto: ArchitectureBlock = {
	...NOTES_BLOCK,
	tables: NOTES_BLOCK.tables.map((t) => ({ ...t, fields: [...t.fields, { name: 'photo', type: 'file' as const, references: null }] })),
};
const withEmail: ArchitectureBlock = { ...NOTES_BLOCK, emails: [{ id: 'welcome' } as unknown as ArchitectureBlock['emails'][number]] };
const withJob: ArchitectureBlock = { ...NOTES_BLOCK, jobs: [{ id: 'nightly' } as unknown as ArchitectureBlock['jobs'][number]] };

const featureRules = (block: ArchitectureBlock, appFeatures: boolean) =>
	checkArchitecture(block, { kind: 'small', available: availableFeatures(appFeatures) })
		.map((i) => i.rule)
		.filter((rule) => rule.startsWith('feature.'));

describe('the generated payments and upload files reach the apps that declare them', () => {
	test('a block with payments gets the payments files; one with a file field gets the upload files', () => {
		const pay = appFeatureFiles(withPayments, { appFeatures: true });
		expect(Object.keys(pay).sort()).toEqual(['caddie/Billing.tsx', 'caddie/payments.ts', 'migrations/0000_caddie_payments.sql']);
		const files = appFeatureFiles(withPhoto, { appFeatures: true });
		expect(Object.keys(files).sort()).toEqual(['caddie/files.ts', 'caddie/upload.ts', 'migrations/0000_caddie_files.sql']);
	});

	test('nothing is added without app features, or when the block declares neither', () => {
		// MUTATION PROOF: ignore appFeatures and a judge's app (stamped off) gets them.
		expect(appFeatureFiles(withPayments, { appFeatures: false })).toEqual({});
		expect(appFeatureFiles(withPhoto, { appFeatures: false })).toEqual({});
		expect(appFeatureFiles(NOTES_BLOCK, { appFeatures: true })).toEqual({});
	});

	test("the generated migrations are protected like Caddie's other runtime files", () => {
		expect(isProtectedPath('migrations/0000_caddie_payments.sql')).toBe(true);
		expect(isProtectedPath('migrations/0000_caddie_files.sql')).toBe(true);
		expect(isProtectedPath('migrations/0001_schema.sql')).toBe(false);
	});

	test('the builders are told how to mount them', () => {
		expect(BUILD_RECIPE_INSTRUCTION).toContain('mountPayments(app');
		expect(BUILD_RECIPE_INSTRUCTION).toContain('planAccess(c');
		expect(BUILD_RECIPE_INSTRUCTION).toContain('mountFiles(app)');
		expect(BUILD_RECIPE_INSTRUCTION).toContain('uploadFile(');
	});
});

describe('the plan gate refuses test-mode features that are not available', () => {
	test('payments and file fields pass only with app features on', () => {
		expect(featureRules(withPayments, false)).toEqual(['feature.payments']);
		expect(featureRules(withPhoto, false)).toEqual(['feature.files']);
		expect(featureRules(withPayments, true)).toEqual([]);
		expect(featureRules(withPhoto, true)).toEqual([]);
	});

	test('emails and scheduled jobs come with app features (lane 10 landed)', () => {
		// MUTATION PROOF: set emails/jobs back to false in availableFeatures and
		// the "on" cases below start reporting feature.emails / feature.jobs again.
		expect(featureRules(withEmail, false)).toEqual(['feature.emails']);
		expect(featureRules(withJob, false)).toEqual(['feature.jobs']);
		expect(featureRules(withEmail, true)).toEqual([]);
		expect(featureRules(withJob, true)).toEqual([]);
	});

	test('the refusals are plain sentences, and nothing changes when no availability is given', () => {
		const messages = checkArchitecture(withEmail, { kind: 'small', available: availableFeatures(false) })
			.filter((i) => i.rule.startsWith('feature.'))
			.map((i) => i.message);
		expect(messages[0]).toContain("isn't available yet");
		expect(
			checkArchitecture(withPayments, { kind: 'small' })
				.map((i) => i.rule)
				.filter((rule) => rule.startsWith('feature.')),
		).toEqual([]);
	});
});

describe('the glue: where the host and the approval use these (source guards)', () => {
	const read = (path: string) => readFileSync(new URL(`../apps/app/src/server/${path}`, import.meta.url), 'utf8');

	test('the host writes the feature files with the contract files', () => {
		// MUTATION PROOF: drop the spread and no app ever gets payments or uploads.
		expect(read('coordinator-host.ts')).toContain('...appFeatureFiles(block, { appFeatures })');
	});

	test('the design approval passes what this project can run to the gate', () => {
		// MUTATION PROOF: drop it and a plan with emails or jobs is approved.
		expect(read('build-workflow.ts')).toContain('available: availableFeatures(await isAppFeaturesWorkflow(db, scope.projectId))');
	});
});
