import { afterEach, describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { researchForActor } from '../apps/app/src/server/coordinator-context.ts';
import { createWorkspace, createProject } from '../apps/app/src/server/projects.ts';

/**
 * Stage 5 — the Tavily-powered chat research service (researchForActor), tested
 * over real production services + migrations on SQLite, with a STUBBED global
 * fetch (no real network). Covers:
 *   - search mode: cited findings (each carries its source url) + an honest gap;
 *   - extract mode (url given): reads one page's clean content;
 *   - NO KEY: findings [] with a gap telling the model research is off (never
 *     a silent empty, never an invented answer);
 *   - request failure: findings [] with an honest failure gap;
 *   - empty search: honest "no results, may need rephrasing" gap.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => { body: unknown; ok?: boolean; status?: number }): void {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = typeof input === 'string' ? input : input.toString();
		const r = handler(url);
		return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body } as Response;
	}) as typeof fetch;
}

async function world() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys=ON');
	for (const name of ['0001_product.sql', '0004_evidence.sql', '0008_profile.sql', '0009_discovery.sql', '0011_home_project.sql', '0013_discovery_saved.sql', '0015_plan_decisions.sql', '0017_profile_preferences.sql']) {
		sqlite.exec(readFileSync(new URL(`../apps/app/migrations/${name}`, import.meta.url), 'utf8'));
	}
	const db = {
		prepare(sql: string) {
			const stmt = sqlite.prepare(sql);
			return { bind(...args: never[]) { return {
				async all() { return { results: stmt.all(...args) }; },
				async run() { return stmt.run(...args); },
			}; } };
		},
		async batch(statements: { run(): unknown }[]) { return Promise.all(statements.map((stmt) => stmt.run())); },
	} as unknown as D1Database;
	sqlite.prepare('insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)')
		.run('alice', 'alice', 'alice@example.com', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z');
	const workspace = await createWorkspace(db, 'alice', { name: 'Alice workspace' });
	const project = await createProject(db, { actorId: 'alice', workspaceId: workspace.id }, { workspaceId: workspace.id, name: 'Todo', description: 'A todo app' });
	const scope: Scope = { actorId: 'alice', workspaceId: workspace.id, projectId: project.id };
	return { db, sqlite, scope };
}

describe('researchForActor (Tavily research, real scope + stubbed fetch)', () => {
	test('no key -> findings [] with an honest "research unavailable" gap, never an invented answer', async () => {
		const { db, sqlite, scope } = await world();
		try {
			const result = await researchForActor(db, scope, { query: 'AI agent hackathons in Africa' }, {});
			expect(result.findings).toEqual([]);
			expect(result.gaps.join(' ').toLowerCase()).toContain('tavily_api_key is not configured');
		} finally { sqlite.close(); }
	});

	test('search mode returns cited findings (each with a source url) + an honest gap', async () => {
		const { db, sqlite, scope } = await world();
		try {
			stubFetch(() => ({ body: { results: [
				{ url: 'https://devfolio.co/x', title: 'X Hack', content: 'An African AI event.', score: 0.9 },
				{ url: 'https://mlh.io/y', title: 'Y Hack', content: 'Another one.', score: 0.7 },
			] } }));
			const result = await researchForActor(db, scope, { query: 'AI agent hackathons in Africa' }, { tavilyApiKey: 'k' });
			expect(result.mode).toBe('search');
			expect(result.findings.map((f) => f.url)).toEqual(['https://devfolio.co/x', 'https://mlh.io/y']);
			expect(result.findings.every((f) => f.url.length > 0)).toBe(true); // every finding is citable
			expect(result.gaps.length).toBeGreaterThan(0);
		} finally { sqlite.close(); }
	});

	test('extract mode (url given) reads one page cleanly', async () => {
		const { db, sqlite, scope } = await world();
		try {
			stubFetch(() => ({ body: { results: [
				{ url: 'https://mlh.io/seasons/2026/events', title: '2026 Season', raw_content: '![logo](x.svg)\n\nSeason schedule content.' },
			] } }));
			const result = await researchForActor(db, scope, { url: 'https://mlh.io/seasons/2026/events' }, { tavilyApiKey: 'k' });
			expect(result.mode).toBe('extract');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]?.url).toBe('https://mlh.io/seasons/2026/events');
			expect(result.findings[0]?.excerpt).toContain('Season schedule content.');
			expect(result.findings[0]?.excerpt).not.toContain('![logo]');
		} finally { sqlite.close(); }
	});

	test('a failed Tavily request -> findings [] with an honest failure gap', async () => {
		const { db, sqlite, scope } = await world();
		try {
			stubFetch(() => ({ body: {}, ok: false, status: 500 }));
			const result = await researchForActor(db, scope, { query: 'anything' }, { tavilyApiKey: 'k' });
			expect(result.findings).toEqual([]);
			expect(result.gaps.join(' ').toLowerCase()).toContain('failed');
		} finally { sqlite.close(); }
	});

	test('empty search results -> honest "no results" gap, never a fabricated finding', async () => {
		const { db, sqlite, scope } = await world();
		try {
			stubFetch(() => ({ body: { results: [] } }));
			const result = await researchForActor(db, scope, { query: 'zxqw no such thing' }, { tavilyApiKey: 'k' });
			expect(result.findings).toEqual([]);
			expect(result.gaps.join(' ').toLowerCase()).toContain('no web results');
		} finally { sqlite.close(); }
	});
});
