import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { sqliteD1 } from './fixtures/sqlite-d1.ts';
import { helperModelCompletion } from '../apps/app/src/server/helper-model-call.ts';
import { inspectCandidates, digestCandidate } from '../apps/app/src/server/candidate-inspection.ts';
import { findModelRouteForRole } from '../apps/app/src/agents/providers.ts';

const originalFetch = globalThis.fetch;
let sqlite: Database | undefined;
afterEach(() => { globalThis.fetch = originalFetch; sqlite?.close(); sqlite = undefined; });
function database() { sqlite = new Database(':memory:'); sqlite.exec(readFileSync(new URL('../apps/app/migrations/0046_model_call_usage.sql', import.meta.url), 'utf8')); return sqliteD1(sqlite); }
function rows() { return sqlite!.query('select * from model_call_usage order by rowid').all() as Record<string, unknown>[]; }
function request() { return { role: 'helperRules' as const, url: 'https://api.tokenfactory.nebius.com/v1/chat/completions', request: { method: 'POST', body: JSON.stringify({ model: findModelRouteForRole('helperRules').modelId, messages: [{ role: 'user', content: 'private rules excerpt' }] }) } }; }

test('helpers persist actual provider token counts, role, response model and version without content', async () => {
	const db = database();
	globalThis.fetch = (async () => Response.json({ model: 'provider-nano-id', usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 }, choices: [{ message: { content: '{"items":[]}' } }] })) as unknown as typeof fetch;
	await helperModelCompletion({ ...request(), accounting: { db, projectId: 'project' } });
	const [row] = rows();
	expect(row).toMatchObject({ selectedRole: 'helperRules', selectionReason: 'rules_extraction', inputTokens: 1000, outputTokens: 2000, totalTokens: 3000, responseModel: 'provider-nano-id', catalogCostMicros: 540, isError: 0, cacheReadTokens: null, cacheWriteTokens: null });
	expect(JSON.stringify(row)).not.toContain('private rules');
});

test('HTTP failure and network timeout are issued calls with unknown usage, not free work', async () => {
	const db = database();
	globalThis.fetch = (async () => new Response('rate limit', { status: 429 })) as unknown as typeof fetch;
	const refused = await helperModelCompletion({ ...request(), accounting: { db } });
	expect(refused.status).toBe(429);
	globalThis.fetch = (async () => { throw new Error('timeout'); }) as unknown as typeof fetch;
	await expect(helperModelCompletion({ ...request(), accounting: { db } })).rejects.toThrow('timeout');
	expect(rows()).toHaveLength(2);
	for (const row of rows()) expect(row).toMatchObject({ inputTokens: null, outputTokens: null, catalogCostMicros: null, isError: 1 });
});

test('rejects a mismatched role/model before issuing a request or false receipt', async () => {
	const db = database(); let calls = 0;
	globalThis.fetch = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
	const input = request(); input.request.body = JSON.stringify({ model: 'unregistered-model' });
	await expect(helperModelCompletion({ ...input, accounting: { db } })).rejects.toThrow('does not match');
	expect(calls).toBe(0); expect(rows()).toHaveLength(0);
});

test('ranking and summary services feed separate actual request receipts to the shared ledger', async () => {
	const db = database();
	const candidate = { id: 'candidate', url: 'https://event.test', title: 'Event', summary: 'Build a useful thing' };
	let calls = 0;
	globalThis.fetch = (async () => { calls++; return Response.json({ usage: { prompt_tokens: calls, completion_tokens: calls }, choices: [{ message: { content: calls === 1 ? '{"items":[]}' : '{}' } }] }); }) as unknown as typeof fetch;
	await inspectCandidates({ apiKey: 'test-only', profile: {}, candidates: [candidate], accounting: { db } });
	await digestCandidate({ apiKey: 'test-only', profile: {}, candidate, accounting: { db } });
	expect(rows().map(row => [row.selectedRole, row.selectionReason, row.inputTokens])).toEqual([['helperRanking', 'candidate_ranking', 1], ['helperSummary', 'candidate_summary', 2]]);
	expect(rows().every(row => row.totalTokens === null)).toBe(true); // No invented totals.
});
