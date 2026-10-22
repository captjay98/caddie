import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { APP_AI_LIMITS, appAiDepsFromEnv, getAppAiUsage, runAppAi, type AppAiDeps } from '../apps/app/src/server/app-ai.ts';
import { findModelRouteForRole } from '../apps/app/src/agents/providers.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * AI inside apps against a stand-in for the model provider: no network, no
 * cost. SIMULATED for the provider; the allowance, rate cap and usage records
 * run against the real migrations.
 */

const route = findModelRouteForRole('app');
const superRoute = findModelRouteForRole('appSuper');
const NOW = new Date('2026-10-18T12:00:00.000Z');

interface Call { url: string; auth: string | null; body: { model: string; messages: { role: string; content: unknown }[]; max_tokens: number } }

function provider(reply: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetch = async (request: Request) => {
		const call = { url: request.url, auth: request.headers.get('authorization'), body: (await request.json()) as Call['body'] };
		calls.push(call);
		return reply(call);
	};
	return { calls, fetch };
}

const answer = (content: string, usage: { prompt_tokens: number; completion_tokens: number } | null = { prompt_tokens: 120, completion_tokens: 40 }) =>
	Response.json({ choices: [{ message: { content } }], ...(usage ? { usage } : {}) });

const ask = (content: string, extra: Record<string, unknown> = {}) => ({ messages: [{ role: 'user', content }], ...extra });

describe('AI inside apps', () => {
	let sqlite: Database;
	let db: D1Database;
	let projectId: string;
	let deps: AppAiDeps;

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		projectId = (await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Recipes', description: 'x' })).id;
		deps = { apiKey: 'nebius-test-key', monthlyLimitCents: 100, appFeatures: false, now: () => NOW };
	});

	afterEach(() => sqlite.close());

	const usageRows = () => sqlite.query('select mode, month, status, routeId, reservedMicros, costMicros, inputTokens, outputTokens, outcome from app_ai_usage order by rowid').all() as Record<string, unknown>[];

	test("answers with Caddie's model and records the tokens and cost against this month", async () => {
		const p = provider(() => answer('Try a lentil soup.'));
		const reply = await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('What can I cook with lentils?') });
		expect(reply).toEqual({ ok: true, text: 'Try a lentil soup.' });
		expect(p.calls).toHaveLength(1);
		expect(p.calls[0]!.url).toBe('https://api.tokenfactory.nebius.com/v1/chat/completions');
		expect(p.calls[0]!.auth).toBe('Bearer nebius-test-key');
		expect(p.calls[0]!.body).toMatchObject({ model: route.modelId, max_tokens: route.maxTokens, messages: [{ role: 'user', content: 'What can I cook with lentils?' }] });
		expect(usageRows()).toEqual([
			expect.objectContaining({
				mode: 'preview', month: '2026-10', status: 'settled', routeId: route.id,
				inputTokens: 120, outputTokens: 40, outcome: null,
				costMicros: 120 * route.inputPriceMinorUnits + 40 * route.outputPriceMinorUnits,
			}),
		]);
		const scope = await projectScopeForUser(db, 'owner-1', projectId);
		expect(await getAppAiUsage(db, deps, scope)).toMatchObject({ available: true, month: '2026-10', calls: 1, usedPercent: 0, limitReached: false, renewsOn: '2026-11-01' });
	});

	test('the default and "fast" both use the cheap Lightning tier', async () => {
		const p = provider(() => answer('ok'));
		expect((await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('hi') })).ok).toBe(true);
		expect((await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('hi', { tier: 'fast' }) })).ok).toBe(true);
		expect(p.calls.map((call) => call.body.model)).toEqual([route.modelId, route.modelId]);
		expect(usageRows().map((row) => row.routeId)).toEqual([route.id, route.id]);
	});

	test('"super" calls Super-VL, capped at 4,096 output tokens, and records the route it used', async () => {
		const p = provider(() => answer('ok'));
		expect((await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('hi', { tier: 'super' }) })).ok).toBe(true);
		// The cap is deliberate and tighter than the route's own default.
		expect(superRoute.maxTokens).toBeGreaterThan(4096);
		expect(p.calls[0]!.body).toMatchObject({ model: superRoute.modelId, max_tokens: 4096 });
		expect(usageRows()).toEqual([
			expect.objectContaining({ status: 'settled', routeId: 'nemotron-3.5-super-vl', inputTokens: 120, outputTokens: 40 }),
		]);
	});

	test('an unknown tier is refused with the exact wording, before any model call', async () => {
		const p = provider(() => answer('ok'));
		const refused = await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('hi', { tier: 'deeper' }) });
		expect(refused).toEqual({ ok: false, reason: 'invalid_request', message: 'Choose tier "fast" or "super".' });
		expect(p.calls).toHaveLength(0);
		expect(usageRows()).toHaveLength(0);
	});

	test('a super call reserves about 3.75× what the same call reserves on the cheap tier', async () => {
		const p = provider(() => answer('ok'));
		expect((await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('hi') })).ok).toBe(true);
		expect((await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('hi', { tier: 'super' }) })).ok).toBe(true);
		const [fast, deep] = usageRows();
		// The deep tier's output rate is exactly 3.75× the cheap tier's, and both
		// reserve the same 4,096-token cap, so the allowance drains 3.75× faster.
		expect(superRoute.outputPriceMinorUnits).toBe(route.outputPriceMinorUnits * 3.75);
		const ratio = Number(deep!.reservedMicros) / Number(fast!.reservedMicros);
		expect(ratio).toBeGreaterThan(3.7);
		expect(ratio).toBeLessThan(3.8);
	});

	test('stops at the monthly allowance and says when it renews; the next month starts fresh', async () => {
		const p = provider(() => answer('ok'));
		// Already spent all but a sliver of the allowance this month.
		sqlite
			.prepare("insert into app_ai_usage (id, projectId, mode, month, status, routeId, reservedMicros, costMicros, createdAt, updatedAt) values ('old', ?, 'live', '2026-10', 'settled', ?, 0, ?, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')")
			.run(projectId, route.id, 100 * 1_000_000 - 1_000);
		const refused = await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('hi') });
		expect(refused).toEqual({ ok: false, reason: 'limit_reached', message: 'This app has used its AI allowance for the month. It renews on 2026-11-01.' });
		expect(p.calls).toHaveLength(0);
		const scope = await projectScopeForUser(db, 'owner-1', projectId);
		expect(await getAppAiUsage(db, deps, scope)).toMatchObject({ usedPercent: 99, limitReached: true });

		const november = { ...deps, fetch: p.fetch, now: () => new Date('2026-11-01T00:00:01.000Z') };
		expect((await runAppAi(db, november, { projectId, mode: 'preview', request: ask('hi') })).ok).toBe(true);
	});

	test('caps calls per minute for each project', async () => {
		const p = provider(() => answer('ok'));
		for (let i = 0; i < APP_AI_LIMITS.callsPerMinute.preview; i++) {
			expect((await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask(`q${i}`) })).ok).toBe(true);
		}
		expect(await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('one more') })).toMatchObject({ ok: false, reason: 'busy' });
		const aMinuteLater = { ...deps, fetch: p.fetch, now: () => new Date(NOW.getTime() + 61_000) };
		expect((await runAppAi(db, aMinuteLater, { projectId, mode: 'preview', request: ask('later') })).ok).toBe(true);
	});

	test('bad or oversized requests are refused before any cost, with words the app can show', async () => {
		const p = provider(() => answer('ok'));
		const run = (request: unknown) => runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request });
		expect(await run(null)).toMatchObject({ ok: false, reason: 'invalid_request' });
		expect(await run({ messages: [] })).toMatchObject({ ok: false, reason: 'invalid_request' });
		expect(await run({ messages: [{ role: 'tool', content: 'x' }] })).toMatchObject({ ok: false, reason: 'invalid_request' });
		expect(await run({ messages: [{ role: 'user', content: 42 }] })).toMatchObject({ ok: false, reason: 'invalid_request' });
		expect(await run(ask('x'.repeat(APP_AI_LIMITS.maxChars + 1)))).toMatchObject({ ok: false, reason: 'too_long' });
		expect(await run({ messages: Array.from({ length: APP_AI_LIMITS.maxMessages + 1 }, () => ({ role: 'user', content: 'x' })) })).toMatchObject({ ok: false, reason: 'too_long' });
		expect(p.calls).toHaveLength(0);
		expect(usageRows()).toHaveLength(0);
		// No key on this server: unavailable, never a crash.
		expect(await runAppAi(db, { ...deps, apiKey: null, fetch: p.fetch }, { projectId, mode: 'preview', request: ask('hi') })).toMatchObject({ ok: false, reason: 'unavailable' });
	});

	test("provider refusals cost nothing; a timed-out call keeps its worst case; replies never carry the model's thinking", async () => {
		const busy = provider(() => new Response('slow down', { status: 429 }));
		expect(await runAppAi(db, { ...deps, fetch: busy.fetch }, { projectId, mode: 'preview', request: ask('a') })).toMatchObject({ ok: false, reason: 'busy' });
		const broken = provider(() => new Response('oops', { status: 500 }));
		expect(await runAppAi(db, { ...deps, fetch: broken.fetch }, { projectId, mode: 'preview', request: ask('b') })).toMatchObject({ ok: false, reason: 'failed' });
		const slow = { ...deps, fetch: async () => { throw new DOMException('timed out', 'TimeoutError'); } };
		expect(await runAppAi(db, slow, { projectId, mode: 'preview', request: ask('c') })).toEqual({ ok: false, reason: 'failed', message: 'The AI took too long to answer. Try again.' });
		const thinking = provider(() => answer('<think>The user wants soup.</think>\nLentil soup.'));
		expect(await runAppAi(db, { ...deps, fetch: thinking.fetch }, { projectId, mode: 'preview', request: ask('d') })).toEqual({ ok: true, text: 'Lentil soup.' });

		const rows = usageRows();
		expect(rows.map((r) => [r.status, r.costMicros === 0, r.outcome])).toEqual([
			['failed', true, 'provider 429'],
			['failed', true, 'provider 500'],
			['settled', false, 'timeout'],
			['settled', false, null],
		]);
		expect(rows[2]!.costMicros).toBe(rows[2]!.reservedMicros);
	});

	test('json: true asks for one JSON object and returns only that object', async () => {
		const p = provider(() => answer('Here you go:\n```json\n{"dish":"soup","minutes":30}\n```'));
		const reply = await runAppAi(db, { ...deps, fetch: p.fetch }, {
			projectId, mode: 'preview',
			request: { messages: [{ role: 'system', content: 'You plan meals.' }, { role: 'user', content: 'Dinner?' }], json: true },
		});
		expect(reply).toEqual({ ok: true, text: '{"dish":"soup","minutes":30}' });
		expect(p.calls[0]!.body.messages[0]).toEqual({ role: 'system', content: 'You plan meals.\n\nReply with one JSON object and nothing else.' });
		const notJson = provider(() => answer('Soup, probably.'));
		expect(await runAppAi(db, { ...deps, fetch: notJson.fetch }, { projectId, mode: 'preview', request: ask('Dinner?', { json: true }) })).toMatchObject({ ok: false, reason: 'failed' });
	});

	test("a published app's AI works only while the app is live", async () => {
		const p = provider(() => answer('ok'));
		const live = (request: unknown) => runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'live', request });
		expect(await live(ask('hi'))).toMatchObject({ ok: false, reason: 'unavailable', message: "This app isn't published right now." });
		sqlite
			.prepare("insert into app_publications (projectId, slug, script, status, createdAt, updatedAt) values (?, 'recipes', 'app-x-1', 'live', ?, ?)")
			.run(projectId, NOW.toISOString(), NOW.toISOString());
		expect(await live(ask('hi'))).toEqual({ ok: true, text: 'ok' });
		sqlite.prepare("update app_publications set status = 'blocked'").run();
		expect(await live(ask('hi'))).toMatchObject({ ok: false, reason: 'unavailable' });
		expect(usageRows().map((r) => r.mode)).toEqual(['live']);
	});

	test('the allowance comes from the server settings, with a safe default', () => {
		expect(appAiDepsFromEnv({ NEBIUS_API_KEY: ' k ', APP_AI_MONTHLY_LIMIT_CENTS: '250' })).toEqual({ apiKey: 'k', monthlyLimitCents: 250, appFeatures: false });
		expect(appAiDepsFromEnv({ APP_AI_MONTHLY_LIMIT_CENTS: 'lots' })).toEqual({ apiKey: null, monthlyLimitCents: APP_AI_LIMITS.defaultMonthlyCents, appFeatures: false });
		// APP_FEATURES on/owner turns photo input on (part M); anything else is off.
		expect(appAiDepsFromEnv({ APP_FEATURES: 'on' })).toMatchObject({ appFeatures: true });
		expect(appAiDepsFromEnv({ APP_FEATURES: 'owner' })).toMatchObject({ appFeatures: true });
		expect(appAiDepsFromEnv({ APP_FEATURES: 'off' })).toMatchObject({ appFeatures: false });
	});

	// --- Part M: AI that can look at photos --------------------------------
	//
	// SIMULATED for the provider (no network, no cost). The outgoing request
	// body is asserted against a recorded shape; UNVERIFIED until S6 that Token
	// Factory accepts it for Super VL and what an image actually costs.
	describe('photos (part M)', () => {
		const withFeatures = (over: Partial<AppAiDeps> = {}) => ({ ...deps, appFeatures: true, ...over });
		// A tiny valid base64 blob (content is never decoded here; size is read
		// from the base64 length).
		const tinyImage = (bytes: number): string => 'A'.repeat(Math.ceil((bytes * 4) / 3));
		const imagePart = (over: Record<string, unknown> = {}) => ({ type: 'image', mime: 'image/png', data: tinyImage(1024), ...over });
		const askPhoto = (extra: Record<string, unknown> = {}, part: Record<string, unknown> = {}) => ({
			messages: [{ role: 'user', content: [{ type: 'text', text: 'What is in this photo?' }, imagePart(part)] }],
			tier: 'super',
			...extra,
		});

		test('a photo request needs the app_features switch on', async () => {
			const p = provider(() => answer('A cat.'));
			// Off: refused before any model call.
			expect(await runAppAi(db, { ...deps, fetch: p.fetch }, { projectId, mode: 'preview', request: askPhoto() }))
				.toEqual({ ok: false, reason: 'invalid_request', message: 'This app can\u2019t send photos to the AI.' });
			expect(p.calls).toHaveLength(0);
			expect(usageRows()).toHaveLength(0);
			// On: the call goes through.
			expect((await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: askPhoto() })).ok).toBe(true);
			expect(p.calls).toHaveLength(1);
		});

		test('photos need the super tier, before any model call', async () => {
			const p = provider(() => answer('ok'));
			const refused = await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: askPhoto({ tier: 'fast' }) });
			expect(refused).toEqual({ ok: false, reason: 'invalid_request', message: 'Looking at a photo needs tier "super".' });
			// Omitted tier defaults to fast, so it is refused too.
			expect(await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: askPhoto({ tier: undefined }) }))
				.toMatchObject({ ok: false, reason: 'invalid_request' });
			expect(p.calls).toHaveLength(0);
			expect(usageRows()).toHaveLength(0);
		});

		test('at most four photos per call', async () => {
			const p = provider(() => answer('ok'));
			const four = { messages: [{ role: 'user', content: [...Array.from({ length: 4 }, () => imagePart()), { type: 'text', text: 'describe' }] }], tier: 'super' };
			expect((await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: four })).ok).toBe(true);
			const five = { messages: [{ role: 'user', content: Array.from({ length: 5 }, () => imagePart()) }], tier: 'super' };
			expect(await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: five }))
				.toEqual({ ok: false, reason: 'too_long', message: 'Send at most 4 photos in one call.' });
			expect(p.calls).toHaveLength(1);
		});

		test('each photo must be under 1.5 MB (measured on the decoded bytes)', async () => {
			const p = provider(() => answer('ok'));
			// Just under the ceiling passes; just over is refused.
			expect((await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: askPhoto({}, { data: tinyImage(APP_AI_LIMITS.maxImageBytes) }) })).ok).toBe(true);
			expect(await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: askPhoto({}, { data: tinyImage(APP_AI_LIMITS.maxImageBytes + 4) }) }))
				.toEqual({ ok: false, reason: 'too_long', message: 'Each photo must be under 1.5 MB.' });
		});

		test('only JPEG, PNG and WebP; a bad part shape is refused', async () => {
			const p = provider(() => answer('ok'));
			expect(await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: askPhoto({}, { mime: 'image/gif' }) }))
				.toEqual({ ok: false, reason: 'invalid_request', message: 'Photos must be JPEG, PNG or WebP.' });
			expect(await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: askPhoto({}, { data: '' }) }))
				.toMatchObject({ ok: false, reason: 'invalid_request', message: 'An image part needs a mime type and base64 data.' });
			expect(await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: { messages: [{ role: 'user', content: [{ type: 'other' }] }], tier: 'super' } }))
				.toMatchObject({ ok: false, reason: 'invalid_request' });
			expect(p.calls).toHaveLength(0);
		});

		test('the outgoing request sends OpenAI-style image_url parts with a data URL', async () => {
			const p = provider(() => answer('A ginger cat on a mat.'));
			const reply = await runAppAi(db, withFeatures({ fetch: p.fetch }), {
				projectId, mode: 'preview',
				request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', mime: 'image/jpeg', data: 'QUJD' }] }], tier: 'super' },
			});
			expect(reply).toEqual({ ok: true, text: 'A ginger cat on a mat.' });
			// The wire body is a recorded fixture: text part verbatim, image as a data URL.
			expect(p.calls[0]!.body.model).toBe(superRoute.modelId);
			expect(p.calls[0]!.body.messages).toEqual([
				{ role: 'user', content: [
					{ type: 'text', text: 'What is this?' },
					{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
				] },
			]);
		});

		test('a plain-string message still goes out as a plain string beside a photo message', async () => {
			const p = provider(() => answer('ok'));
			await runAppAi(db, withFeatures({ fetch: p.fetch }), {
				projectId, mode: 'preview',
				request: { messages: [{ role: 'system', content: 'You describe photos.' }, { role: 'user', content: [{ type: 'image', mime: 'image/webp', data: 'QUJD' }] }], tier: 'super' },
			});
			expect(p.calls[0]!.body.messages[0]).toEqual({ role: 'system', content: 'You describe photos.' });
			expect(p.calls[0]!.body.messages[1]).toEqual({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,QUJD' } }] });
		});

		test('each photo adds a fixed input estimate to the reservation (until S6)', async () => {
			const p = provider(() => answer('ok'));
			// A super call with no photo, then the same with two photos: the second
			// reserves 2 × imageInputTokensEstimate × the route input rate more.
			await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: { messages: [{ role: 'user', content: 'hi' }], tier: 'super' } });
			await runAppAi(db, withFeatures({ fetch: p.fetch }), { projectId, mode: 'preview', request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, imagePart(), imagePart()] }], tier: 'super' } });
			const [noImage, twoImages] = usageRows();
			const expectedExtra = 2 * APP_AI_LIMITS.imageInputTokensEstimate * superRoute.inputPriceMinorUnits;
			expect(Number(twoImages!.reservedMicros) - Number(noImage!.reservedMicros)).toBe(expectedExtra);
		});
	});

	test('GET /projects/:id/ai-usage answers the card without caching; scope refusals keep their status', async () => {
		const { createAppAiRouter } = await import('../apps/app/src/server/routes/app-ai.ts');
		const { ScopeError } = await import('../apps/app/src/server/scope.ts');
		const router = createAppAiRouter({
			scopeFor: async (_env, request) => {
				if (request.headers.get('x-test-user') !== 'owner-1') throw new ScopeError(403, 'forbidden', 'Not your project.');
				return projectScopeForUser(db, 'owner-1', projectId);
			},
			depsFor: () => deps,
		});
		const env = { DB: db } as never;
		const ok = await router.request(`/projects/${projectId}/ai-usage`, { headers: { 'x-test-user': 'owner-1' } }, env);
		expect(ok.status).toBe(200);
		expect(ok.headers.get('cache-control')).toBe('no-store');
		expect(await ok.json()).toEqual({ available: true, month: '2026-10', calls: 0, usedPercent: 0, limitReached: false, renewsOn: '2026-11-01' });
		const refused = await router.request(`/projects/${projectId}/ai-usage`, {}, env);
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ error: 'forbidden', message: 'Not your project.' });
	});

	test('the entrypoints take the project and the mode from Caddie, never from the app', async () => {
		const { AppPlatform, PublishedAppPlatform } = await import('../apps/app/src/server/app-platform.ts');
		type Ctor = new (ctx: unknown, env: unknown) => { ai(...args: unknown[]): Promise<unknown> };
		// The published side is live mode: an app that isn't published gets a plain no, before any model call.
		const published = new (PublishedAppPlatform as unknown as Ctor)({}, { DB: db, NEBIUS_API_KEY: 'k' });
		expect(await published.ai(projectId, ask('hi'))).toEqual({ ok: false, reason: 'unavailable', message: "This app isn't published right now." });
		expect(await published.ai('', ask('hi'))).toMatchObject({ ok: false, reason: 'unavailable' });
		// The preview side reads the project from its props; without a key it says AI isn't set up.
		const preview = new (AppPlatform as unknown as Ctor)({ props: { projectId } }, { DB: db });
		expect(await preview.ai({ ...ask('hi'), projectId: 'someone-else' })).toEqual({ ok: false, reason: 'unavailable', message: "AI isn't available for apps on this Caddie server yet." });
		expect(usageRows()).toHaveLength(0);
	});
});
