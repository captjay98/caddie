import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLISHED_ENTRY_SOURCE } from '../apps/app/src/server/publish.ts';

/**
 * The published Worker's entry module (publish.ts), loaded as real ES modules
 * beside a stand-in app.js. SIMULATED: Bun, not workerd; the dispatch Worker's
 * props reach it as `ctx.props` the way Cloudflare documents for dynamic
 * dispatch, which only the live check can confirm.
 */

const dir = mkdtempSync(join(tmpdir(), 'caddie-published-entry-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
	join(dir, 'app.js'),
	'export default { async fetch(request, env, ctx) { return Response.json({ path: new URL(request.url).pathname, db: env.DB ?? null, key: env.WEATHER_KEY ?? null, caddie: env.CADDIE ? await env.CADDIE.ai({ messages: [] }) : null, sameCtx: ctx?.marker ?? null }); } };\n',
);
writeFileSync(join(dir, 'index.js'), PUBLISHED_ENTRY_SOURCE);

describe('the published entry', () => {
	test("hands the app env.CADDIE from the dispatch Worker's props and passes everything else through", async () => {
		const entry = (await import(join(dir, 'index.js'))).default as { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };
		const env = { DB: 'd1-binding', WEATHER_KEY: 'w-1' };
		const platform = { ai: async () => ({ ok: true, text: 'from Caddie' }) };
		const withPlatform = await entry.fetch(new Request('https://farm.caddieapps.com/api/ask'), env, { props: { CADDIE: platform }, marker: 'ctx-1' });
		expect(await withPlatform.json()).toEqual({ path: '/api/ask', db: 'd1-binding', key: 'w-1', caddie: { ok: true, text: 'from Caddie' }, sameCtx: 'ctx-1' });
		// The Worker's own env object is never changed.
		expect(env).toEqual({ DB: 'd1-binding', WEATHER_KEY: 'w-1' });
		const without = await entry.fetch(new Request('https://farm.caddieapps.com/api/ask'), env, {});
		expect(((await without.json()) as { caddie: unknown }).caddie).toBeNull();
	});
});
