import { afterEach, describe, expect, test } from 'bun:test';
import {
	tavilySearch,
	tavilyExtract,
	cleanContent,
	TavilyNotConfiguredError,
	TavilyRequestError,
} from '../apps/app/src/server/tavily.ts';

/**
 * Stage 5 — the shared Tavily client (apps/app/src/server/tavily.ts), unit
 * tested with a STUBBED global fetch. No real network. Covers the fail-loud /
 * honesty contract the discovery adapter and research tool both rely on:
 *   - no key -> TavilyNotConfiguredError (never a silent empty)
 *   - non-2xx -> TavilyRequestError carrying the status
 *   - results missing url/title are dropped (cannot be cited), never faked
 *   - search dedupes by url; include_domains is forwarded
 *   - extract prefers raw_content and cleans markdown image/asset noise
 */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubJson(body: unknown, opts: { ok?: boolean; status?: number } = {}): { lastBody: () => unknown } {
	let captured: unknown;
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		captured = init?.body ? JSON.parse(String(init.body)) : undefined;
		return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body } as Response;
	}) as typeof fetch;
	return { lastBody: () => captured };
}

describe('tavily client — fail-loud + honesty', () => {
	test('tavilySearch throws TavilyNotConfiguredError with no key', async () => {
		await expect(tavilySearch(undefined, 'anything')).rejects.toBeInstanceOf(TavilyNotConfiguredError);
	});

	test('tavilyExtract throws TavilyNotConfiguredError with no key', async () => {
		await expect(tavilyExtract(undefined, ['https://x.example'])).rejects.toBeInstanceOf(TavilyNotConfiguredError);
	});

	test('tavilySearch throws TavilyRequestError with the status on non-2xx', async () => {
		stubJson({}, { ok: false, status: 429 });
		await expect(tavilySearch('k', 'q')).rejects.toMatchObject({ name: 'TavilyRequestError', status: 429 });
	});

	test('tavilySearch forwards include_domains and dedupes by url', async () => {
		const stub = stubJson({
			results: [
				{ url: 'https://a.devpost.com', title: 'A', content: 'alpha', score: 0.9 },
				{ url: 'https://a.devpost.com', title: 'A dup', content: 'dup', score: 0.5 }, // dup url
				{ url: 'https://b.mlh.io', title: 'B', content: 'beta', score: 0.8 },
				{ title: 'no url dropped', content: 'x' }, // dropped: no url
				{ url: 'https://c.devfolio.co', content: 'no title dropped' }, // dropped: no title
			],
		});
		const results = await tavilySearch('k', 'open hackathons', { includeDomains: ['devpost.com', 'mlh.io'], maxResults: 5 });
		expect(results.map((r) => r.url)).toEqual(['https://a.devpost.com', 'https://b.mlh.io']);
		expect(stub.lastBody()).toMatchObject({ include_domains: ['devpost.com', 'mlh.io'], max_results: 5 });
		expect(results[0]?.score).toBe(0.9);
	});

	test('tavilyExtract prefers raw_content and cleans markdown image noise', async () => {
		stubJson({
			results: [
				{
					url: 'https://devpost.com/c/ai',
					title: 'AI hackathons',
					raw_content: '![logo](https://x/logo.svg)\n\nReal content here. [a link](https://y)',
				},
			],
		});
		const pages = await tavilyExtract('k', ['https://devpost.com/c/ai']);
		expect(pages).toHaveLength(1);
		expect(pages[0]?.content).toContain('Real content here.');
		expect(pages[0]?.content).toContain('a link'); // link text kept
		expect(pages[0]?.content).not.toContain('![logo]'); // image stripped
		expect(pages[0]?.content).not.toContain('logo.svg');
	});

	test('tavilyExtract throws on empty url list (never a silent no-op)', async () => {
		await expect(tavilyExtract('k', [])).rejects.toBeInstanceOf(TavilyRequestError);
	});

	test('cleanContent strips images, unwraps links, collapses blank lines', () => {
		const out = cleanContent('![x](a.png)\n\n\n\nHello  world [click](http://z)');
		expect(out).toBe('Hello world click');
	});
});
