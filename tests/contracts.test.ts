import { describe, expect, test } from 'bun:test';
import { parse, safeParse } from 'valibot';
import type { ApprovalIntent } from '@caddie/contracts';
import {
	ApprovalIntentSchema,
	ApprovalRecordSchema,
	DecisionCardSchema,
	ExternalOperationSchema,
	RunBindingSchema,
	ScopeSchema,
	STACK_IDS,
	StackId,
	StackRecipeSchema,
	approvalIntentHash,
} from '@caddie/contracts';
import type { StackId as StackIdType } from '@caddie/contracts';

/**
 * Frozen boundary contracts from docs/plans/2026-10-03-fresh-build/contracts.md.
 * These schemas are the shared serialization language between the D1-backed
 * product services, the Flue DO runtime, and the React client.
 */

const ALL_STACK_IDS: StackIdType[] = [
	'react-hono',
	'tanstack-start',
	'laravel-inertia',
	'fastapi-react',
	'flutter',
];

describe('P00 scope contract', () => {
	test('parses a scope triple from verified session+membership', () => {
		const scope = parse(ScopeSchema, {
			actorId: 'user_1',
			workspaceId: 'ws_1',
			projectId: 'proj_1',
		});
		expect(scope.actorId).toBe('user_1');
	});

	test('rejects missing and extra scope fields (strict)', () => {
		expect(() =>
			parse(ScopeSchema, { actorId: 'user_1', workspaceId: 'ws_1' }),
		).toThrow();
		expect(() =>
			parse(ScopeSchema, {
				actorId: 'user_1',
				workspaceId: 'ws_1',
				projectId: 'proj_1',
				// body-supplied actor overrides must never parse
				role: 'owner',
			}),
		).toThrow();
	});
});

describe('P00 stack identity contract', () => {
	test('exactly five supported stack IDs', () => {
		expect([...STACK_IDS]).toEqual(ALL_STACK_IDS);
	});

	test('rejects unsupported stack identifiers', () => {
		for (const bogus of ['react', 'nextjs', 'flutteR', '']) {
			expect(safeParse(StackId, bogus).success).toBe(false);
		}
	});
});

describe('P00 run binding contract', () => {
	test('run binding carries immutable stored scope for delayed work', () => {
		const binding = parse(RunBindingSchema, {
			runId: 'run_1',
			projectId: 'proj_1',
			conversationId: 'conv_1',
			submissionId: 'sub_1',
			planRevision: 'rev_1',
			stackId: 'react-hono',
			payerId: 'payer_1',
			modelRouteId: 'route_1',
			pricingVersion: '2026-10-03',
		});
		expect(binding.stackId).toBe('react-hono');
		expect(() =>
			parse(RunBindingSchema, { ...binding, stackId: 'nginx' }),
		).toThrow();
	});
});

describe('P00 approval contract', () => {
	const intent: ApprovalIntent = {
		projectId: 'proj_1',
		action: 'deploy-production',
		resourceId: 'res_1',
		revisionHash: 'sha-a',
		policyVersion: '1',
	};

	test('intent hash is deterministic and revision-sensitive', async () => {
		const a = await approvalIntentHash(intent);
		const b = await approvalIntentHash({ ...intent });
		expect(a).toBe(b);
		expect(a).not.toBe(await approvalIntentHash({ ...intent, revisionHash: 'sha-b' }));
		expect(a).not.toBe(await approvalIntentHash({ ...intent, policyVersion: '2' }));
		// canonical serialization: key order must not change the hash
		expect(a).toBe(
			await approvalIntentHash({
				policyVersion: '1',
				revisionHash: 'sha-a',
				resourceId: 'res_1',
				action: 'deploy-production',
				projectId: 'proj_1',
			}),
		);
	});

	test('bare intent parses; record covers the full status vocabulary', async () => {
		expect(parse(ApprovalIntentSchema, intent).action).toBe(
			'deploy-production',
		);
		const record = {
			...intent,
			id: 'apr_1',
			intentHash: await approvalIntentHash(intent),
			decidedBy: null,
			status: 'pending',
			expiresAt: '2026-10-04T00:00:00.000Z',
		};
		expect(parse(ApprovalRecordSchema, record).status).toBe('pending');
		for (const status of [
			'approved',
			'rejected',
			'revoked',
			'expired',
			'superseded',
		] as const) {
			expect(parse(ApprovalRecordSchema, { ...record, status }).status).toBe(
				status,
			);
		}
		expect(() =>
			parse(ApprovalRecordSchema, { ...record, status: 'granted' }),
		).toThrow();
		// a bare intent is not a record: record-only fields must not parse
		expect(() => parse(ApprovalRecordSchema, intent)).toThrow();
	});
});

describe('P00 external operation contract', () => {
	test('operation statuses include reconciliation-required', () => {
		const base = {
			id: 'op_1',
			projectId: 'proj_1',
			runId: 'run_1',
			operationKey: 'key_1',
			provider: 'github',
			remoteId: null,
			status: 'prepared',
			receiptId: null,
		};
		for (const status of [
			'dispatched',
			'succeeded',
			'failed',
			'cancel-requested',
			'cancelled',
			'reconciliation-required',
		] as const) {
			expect(parse(ExternalOperationSchema, { ...base, status }).status).toBe(
				status,
			);
		}
		expect(() =>
			parse(ExternalOperationSchema, { ...base, status: 'sent' }),
		).toThrow();
	});
});

describe('P00 decision card contract', () => {
	test('parses a needs-you approval card', () => {
		const card = parse(DecisionCardSchema, {
			id: 'card_1',
			projectId: 'proj_1',
			runId: 'run_1',
			kind: 'approval',
			headline: 'Design review ready',
			summary: 'Plan revision rev_2 awaits design approval.',
			evidenceIds: ['ev_1'],
			status: 'needs-you',
			updatedAt: '2026-10-03T12:00:00.000Z',
			primaryAction: { label: 'Review', kind: 'review', targetId: 'apr_1' },
		});
		expect(card.primaryAction.kind).toBe('review');
	});

	test('rejects unknown kinds, statuses and action kinds', () => {
		const base = {
			id: 'card_1',
			projectId: 'proj_1',
			kind: 'approval',
			headline: 'h',
			summary: 's',
			evidenceIds: [],
			status: 'needs-you',
			updatedAt: '2026-10-03T12:00:00.000Z',
			primaryAction: { label: 'Review', kind: 'review', targetId: 'apr_1' },
		};
		expect(() => parse(DecisionCardSchema, { ...base, kind: 'widget' })).toThrow();
		expect(() => parse(DecisionCardSchema, { ...base, status: 'fine' })).toThrow();
		expect(() =>
			parse(DecisionCardSchema, {
				...base,
				primaryAction: { ...base.primaryAction, kind: 'execute' },
			}),
		).toThrow();
		expect(() =>
			parse(DecisionCardSchema, { ...base, evidenceIds: 'ev_1' }),
		).toThrow();
	});
});

describe('P00 stack recipe contract', () => {
	test('recipe validates commands, preview mode and availability', () => {
		const recipe = parse(StackRecipeSchema, {
			id: 'react-hono',
			version: '1',
			imageDigest: 'sha256:abc',
			install: ['bun install'],
			test: ['bun test'],
			build: ['bun run build'],
			start: ['bun run start'],
			requiredCapabilities: ['node'],
			artifacts: ['dist/'],
			preview: 'server',
			availability: 'unverified',
		});
		expect(recipe.availability).toBe('unverified');
		expect(() =>
			parse(StackRecipeSchema, { ...recipe, preview: 'deployment' }),
		).toThrow();
		expect(() =>
			parse(StackRecipeSchema, { ...recipe, availability: 'maybe' }),
		).toThrow();
		expect(() =>
			parse(StackRecipeSchema, { ...recipe, id: 'react' }),
		).toThrow();
	});
});
