import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { sqliteD1 } from './fixtures/sqlite-d1.ts';
import { applyFinalSchema } from './fixtures/migrations.ts';
import { bootModelUsageFixture } from '../apps/app/test-support/model-usage-harness.ts';
import { makeModelCallInstrumentation, modelCallRecord, persistModelCall } from '../apps/app/src/server/model-call-instrument.ts';
import { coordinatorModelSelection, findModelRouteForRole } from '../apps/app/src/agents/providers.ts';
import type { FlueEvent } from '../apps/app/test-support/spend-harness.ts';

type Turn = Extract<FlueEvent, { type: 'turn' }>;
const chat = findModelRouteForRole('chat');
function event(override: Partial<Turn> = {}): Turn {
	return { v: 3, eventIndex: 1, timestamp: '2026-10-24T12:00:00.000Z', type: 'turn', turnId: 'turn-1', purpose: 'agent', agentName: 'Coordinator',
		instanceId: 'instance', conversationId: 'conversation', submissionId: 'submission', durationMs: 10, isError: false,
		request: { providerId: chat.providerId, providerName: chat.providerId, requestedModel: chat.modelId, api: 'openai-completions' }, response: {}, ...override } as Turn;
}

describe('model call leaf accounting', () => {
	let sqlite: Database | undefined;
	let fixture: Awaited<ReturnType<typeof bootModelUsageFixture>> | undefined;
	afterEach(async () => { await fixture?.stop(); fixture = undefined; sqlite?.close(); sqlite = undefined; });
	function database() {
		sqlite = new Database(':memory:');
		// Read the committed schema, never maintain a divergent test schema.
		applyFinalSchema(sqlite);
		return sqliteD1(sqlite);
	}
	test('one project switches between Ultra ideation and Super status with real Flue calls and no run-label guess', async () => {
		const db = database();
		const errors: string[] = [];
		const writes: Promise<void>[] = [];
		fixture = await bootModelUsageFixture(makeModelCallInstrumentation({ resolve: () => db, defer: write => writes.push(write), onError: () => errors.push('write') }), [
			{ text: 'A focused project idea.', input: 10, output: 5 }, { text: 'The plan is ready.', input: 20, output: 8 },
		]);
		await fixture.client.read(await fixture.client.dispatch('Brainstorm app ideas'));
		await fixture.client.read(await fixture.client.dispatch('what is the status?'));
		await Promise.all(writes);
		const rows = sqlite!.query('select * from model_call_usage order by createdAt, rowid').all() as Record<string, unknown>[];
		expect(errors).toEqual([]); expect(rows).toHaveLength(2);
		expect(rows.map(row => [row.routeId, row.selectedRole, row.selectionReason])).toEqual([
			['nemotron-3-ultra', 'ideation', 'explicit_ideation'], ['nemotron-3.5-super-vl', 'chat', 'routine_status'],
		]);
		expect(rows.map(row => row.inputTokens)).toEqual([10, 20]);
		expect(rows.map(row => row.outputTokens)).toEqual([5, 8]);
		expect(rows.map(row => row.catalogCostMicros)).toEqual([25, 14]);
		expect(JSON.stringify(rows)).not.toContain('Brainstorm app ideas');
	});

	test('missing usage stays unknown; errored paid usage remains recorded; repeated turn is immutable', async () => {
		const db = database();
		const noUsage = modelCallRecord(event());
		expect(noUsage.inputTokens).toBeNull(); expect(noUsage.catalogCostMicros).toBeNull();
		await persistModelCall(db, noUsage);
		await persistModelCall(db, { ...noUsage, requestedModel: 'must-not-overwrite', catalogCostMicros: 100 });
		const row = sqlite!.query('select * from model_call_usage').get() as Record<string, unknown>;
		expect(row.requestedModel).toBe(chat.modelId); expect(row.catalogCostMicros).toBeNull();
		const paidError = modelCallRecord(event({ turnId: 'error-turn', isError: true, response: { responseModel: 'provider-reported', usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } } }));
		expect(paidError.isError).toBe(true); expect(paidError.catalogCostMicros).toBe(30000); expect(paidError.responseModel).toBe('provider-reported');
	});

	test('unknown model/provider and invalid measurements are not priced or replaced by intended route', () => {
		const row = modelCallRecord(event({ request: { providerId: 'other', providerName: 'other', requestedModel: chat.modelId, api: 'unknown' }, response: { usage: { input: NaN, output: -1, cacheRead: 0, cacheWrite: 0, totalTokens: Infinity, cost: { total: NaN } } } } as unknown as Partial<Turn>), { role: 'chat', reason: 'default_chat', routeId: chat.id });
		expect(row.routeId).toBeNull(); expect(row.pricingVersion).toBeNull(); expect(row.currency).toBeNull();
		expect(row.selectedRole).toBeNull(); expect(row.selectionReason).toBe('selection_model_mismatch');
		expect(row.inputTokens).toBeNull(); expect(row.outputTokens).toBeNull(); expect(row.totalTokens).toBeNull(); expect(row.catalogCostMicros).toBeNull();
	});

	test('routing reason matches routine/execution/vision/ideation selection without exposing input', () => {
		expect(coordinatorModelSelection({ isHome: false, ideationTurnsLeft: 2, request: 'continue building' })).toEqual({ role: 'chat', reason: 'execution_request' });
		expect(coordinatorModelSelection({ isHome: false, ideationTurnsLeft: 2, hasImage: true })).toEqual({ role: 'vision', reason: 'image_attachment' });
	});
});


test('completion metadata keeps actual stop reasons and tool-only output without storing thought text',()=>{
 const result=modelCallRecord(event({response:{finishReason:'maxTokens',providerFinishReason:'length',output:{role:'assistant',content:[{type:'thinking',thinking:'private thought'},{type:'toolCall',id:'call',name:'write_file',arguments:{}}]}}} as unknown as Partial<Turn>));
 expect(result.finishReason).toBe('maxTokens');expect(result.providerFinishReason).toBe('length');expect(result.outputKind).toBe('tool-only');
 expect(JSON.stringify(result)).not.toContain('private thought');
});
