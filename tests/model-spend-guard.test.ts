import { describe, expect, test } from 'bun:test';
import { migratedDatabase } from './fixtures/sqlite-d1.ts';
import {
	assertModelSpendAllowed,
	capMicros,
	DEFAULT_DAILY_CAP_USD,
	DEFAULT_PROJECT_CAP_USD,
	ModelSpendCapError,
	pauseForSpendCap,
	SPEND_CAP_DETAIL,
} from '../apps/app/src/server/model-spend-guard.ts';
import { makeSpendInstrumentation } from '../apps/app/src/server/spend-instrument.ts';

/**
 * The hard spending ceiling (owner 2026-10-29, after a $58.84 bill). Against a
 * real migrated D1 (bun:sqlite). LOCAL VERIFIED; no model is called.
 */

const NOW = Date.parse('2026-10-29T21:00:00.000Z');

function receipt(sqlite: ReturnType<typeof migratedDatabase>['sqlite'], id: string, instanceId: string, usd: number, at = NOW - 60_000) {
	sqlite
		.prepare('insert into model_call_usage (turnId,instanceId,purpose,providerId,requestedModel,selectionReason,isError,catalogCostMicros,createdAt) values (?,?,?,?,?,?,0,?,?)')
		.run(id, instanceId, 'agent', 'nebius', 'm', 'x', Math.round(usd * 1_000_000), new Date(at).toISOString());
}

function workflow(sqlite: ReturnType<typeof migratedDatabase>['sqlite'], projectId: string, conversationId: string, phase = 'building') {
	sqlite.exec('pragma foreign_keys = off');
	sqlite
		.prepare("insert into build_workflows (projectId,runId,conversationId,intakeKey,brief,phase,updatedAt) values (?,?,?,?,'brief',?,?)")
		.run(projectId, `run-${projectId}`, conversationId, `intake:${projectId}`, phase, new Date(NOW).toISOString());
}

async function refusal(promise: Promise<void>): Promise<ModelSpendCapError | null> {
	try { await promise; return null; } catch (error) { if (error instanceof ModelSpendCapError) return error; throw error; }
}

describe('the account-wide daily ceiling', () => {
	test('refuses once today’s recorded spend reaches the cap; yesterday does not count', async () => {
		const { db, sqlite } = migratedDatabase();
		try {
			receipt(sqlite, 'yesterday', 'conv-a', 50, NOW - 24 * 60 * 60_000);
			receipt(sqlite, 'today-1', 'conv-a', DEFAULT_DAILY_CAP_USD - 0.01);
			expect(await refusal(assertModelSpendAllowed(db, {}, { nowMs: NOW }))).toBeNull();
			receipt(sqlite, 'today-2', 'conv-b', 0.01);
			const refused = await refusal(assertModelSpendAllowed(db, {}, { nowMs: NOW }));
			expect(refused?.scope).toBe('day');
			expect(refused?.message).toContain('MODEL_SPEND_CAP');
		} finally { sqlite.close(); }
	});

	test('AI inside generated apps counts toward the day', async () => {
		const { db, sqlite } = migratedDatabase();
		try {
			sqlite.exec('pragma foreign_keys = off');
			sqlite
				.prepare("insert into app_ai_usage (id,projectId,mode,month,status,routeId,reservedMicros,costMicros,createdAt,updatedAt) values ('a1','p1','preview','2026-10','settled','r',0,?,?,?)")
				.run(DEFAULT_DAILY_CAP_USD * 1_000_000, new Date(NOW - 1000).toISOString(), new Date(NOW).toISOString());
			expect((await refusal(assertModelSpendAllowed(db, {}, { nowMs: NOW })))?.scope).toBe('day');
		} finally { sqlite.close(); }
	});

	test('the env raises, lifts ("off") or closes ("0") the cap', async () => {
		const { db, sqlite } = migratedDatabase();
		try {
			receipt(sqlite, 'big', 'conv-a', 5);
			expect(await refusal(assertModelSpendAllowed(db, { MODEL_SPEND_DAILY_CAP_USD: '10' }, { nowMs: NOW }))).toBeNull();
			expect(await refusal(assertModelSpendAllowed(db, { MODEL_SPEND_DAILY_CAP_USD: 'off' }, { nowMs: NOW }))).toBeNull();
			const { db: empty, sqlite: emptySqlite } = migratedDatabase();
			try {
				expect((await refusal(assertModelSpendAllowed(empty, { MODEL_SPEND_DAILY_CAP_USD: '0' }, { nowMs: NOW })))?.scope).toBe('day');
			} finally { emptySqlite.close(); }
		} finally { sqlite.close(); }
		expect(capMicros({ MODEL_SPEND_DAILY_CAP_USD: 'nonsense' }, 'MODEL_SPEND_DAILY_CAP_USD', 3)).toBe(3_000_000);
	});
});

describe('the per-project ceiling', () => {
	test('a project’s coordinator, helper and reviewer receipts add up; another project is untouched', async () => {
		const { db, sqlite } = migratedDatabase();
		try {
			workflow(sqlite, 'p1', 'conv-p1');
			workflow(sqlite, 'p2', 'conv-p2');
			const off = { MODEL_SPEND_DAILY_CAP_USD: 'off' };
			receipt(sqlite, 'coord', 'conv-p1', DEFAULT_PROJECT_CAP_USD - 0.5);
			receipt(sqlite, 'helper', 'p1', 0.25);
			expect(await refusal(assertModelSpendAllowed(db, off, { conversationIds: ['conv-p1'], nowMs: NOW }))).toBeNull();
			receipt(sqlite, 'review', 'p1', 0.25);
			expect((await refusal(assertModelSpendAllowed(db, off, { conversationIds: ['conv-p1'], nowMs: NOW })))?.scope).toBe('project');
			expect((await refusal(assertModelSpendAllowed(db, off, { projectId: 'p1', nowMs: NOW })))?.scope).toBe('project');
			expect(await refusal(assertModelSpendAllowed(db, off, { conversationIds: ['conv-p2'], nowMs: NOW }))).toBeNull();
		} finally { sqlite.close(); }
	});

	test('the active step pauses with the plain message; a finished app is left alone', async () => {
		const { db, sqlite } = migratedDatabase();
		try {
			workflow(sqlite, 'p1', 'conv-p1', 'looks');
			workflow(sqlite, 'p2', 'conv-p2', 'ready');
			const error = new ModelSpendCapError('project', 2_500_000, 2_600_000);
			await pauseForSpendCap(db, error, { conversationIds: ['conv-p1'] });
			await pauseForSpendCap(db, error, { conversationIds: ['conv-p2'] });
			const rows = sqlite.query('select projectId, phase, detail from build_workflows order by projectId').all() as { projectId: string; phase: string; detail: string | null }[];
			expect(rows[0]).toMatchObject({ phase: 'blocked', detail: SPEND_CAP_DETAIL.project });
			expect(rows[1]).toMatchObject({ phase: 'ready', detail: null });
		} finally { sqlite.close(); }
	});
});

describe('every agent call passes the ceiling first', () => {
	test('a chat call over the cap is refused before it reaches the provider, and its step pauses', async () => {
		const { db, sqlite } = migratedDatabase();
		try {
			workflow(sqlite, 'p1', 'conv-p1', 'planning');
			// The interceptor reads the real clock, so the receipt is stamped
			// from it too (a fixed NOW made this fail after midnight UTC).
			receipt(sqlite, 'spent', 'conv-p1', DEFAULT_DAILY_CAP_USD, Date.now() - 60_000);
			const instrumentation = makeSpendInstrumentation({ db, env: {} });
			let reachedProvider = false;
			await expect(
				instrumentation.interceptor!(
					{ type: 'model', turnId: 'turn-1' } as never,
					{ instanceId: 'conv-p1', conversationId: 'flue-internal', turnId: 'turn-1' } as never,
					async () => { reachedProvider = true; return null; },
				),
			).rejects.toThrow('MODEL_SPEND_CAP');
			expect(reachedProvider).toBe(false);
			const row = sqlite.query("select phase, detail from build_workflows where projectId='p1'").get() as { phase: string; detail: string };
			expect(row).toEqual({ phase: 'blocked', detail: SPEND_CAP_DETAIL.day });
		} finally { sqlite.close(); }
	});
});
