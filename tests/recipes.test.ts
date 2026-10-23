import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { LEAFLET_INTEGRITY, LEAFLET_VERSION, RECIPES } from '../stacks/react-hono/recipe.ts';
import { SCAFFOLD_LOCKFILE } from '../stacks/react-hono/scaffold-lock.ts';
import { BUILD_RECIPE_INSTRUCTION } from '../apps/app/src/agents/specialists.ts';
import { materializeFeatureApp, runFeatureTest, type FeatureApp } from './support/feature-app.ts';

/**
 * Part O recipes (plan part O, lane 1 writes the recipes).
 *
 * Each recipe is a short block in stacks/react-hono/recipe.ts giving the ONE
 * supported way to do a thing in this starter, and the build specialists get
 * them through BUILD_RECIPE_INSTRUCTION. These tests pin:
 *   - that every recipe is present and reaches the builder;
 *   - that Search is written as FTS5 + MATCH (the one the starter supports),
 *     proven by a real MATCH query on bun:sqlite — the starter's test DB — and
 *     by a real FTS5 search route built in the materialised starter;
 *   - that exactly one Leaflet release is pinned, and the pin matches the
 *     generated starter lock.
 * LOCAL VERIFIED.
 */

describe('part O: the recipes reach the builder', () => {
	const topics = ['Search', 'Charts', 'Maps', 'Location', 'Refreshing data', 'Admin pages', 'Teams'];

	test('every recipe is present in RECIPES', () => {
		for (const topic of topics) expect(RECIPES).toContain(`- ${topic}:`);
		// Seven recipes, one per line, plus the header line.
		expect(RECIPES.split('\n').filter((line) => line.startsWith('- ')).length).toBe(topics.length);
	});

	test('the build specialists receive the recipes verbatim', () => {
		expect(BUILD_RECIPE_INSTRUCTION).toContain(RECIPES);
		for (const topic of topics) expect(BUILD_RECIPE_INSTRUCTION).toContain(`- ${topic}:`);
	});

	test('Search is FTS5 + MATCH, not LIKE', () => {
		const search = RECIPES.split('\n').find((line) => line.startsWith('- Search:')) ?? '';
		expect(search).toContain('fts5(');
		expect(search).toContain('MATCH');
		// The starter supports FTS5, so the recipe commits to it and does not
		// offer the LIKE fallback as a supported way.
		expect(search).not.toContain('LIKE');
	});

	test('Charts and Refreshing data point at the shipped protected files, add no library', () => {
		const charts = RECIPES.split('\n').find((line) => line.startsWith('- Charts:')) ?? '';
		const refresh = RECIPES.split('\n').find((line) => line.startsWith('- Refreshing data:')) ?? '';
		expect(charts).toContain('../caddie/charts');
		expect(charts).toContain('add no library');
		expect(refresh).toContain('../caddie/poll');
		expect(refresh).toContain('usePolling(load, 5000)');
	});

	test('Maps uses pinned Leaflet + OpenStreetMap with attribution; Location has a fallback', () => {
		const maps = RECIPES.split('\n').find((line) => line.startsWith('- Maps:')) ?? '';
		const location = RECIPES.split('\n').find((line) => line.startsWith('- Location:')) ?? '';
		expect(maps).toContain('Leaflet');
		expect(maps).toContain('tile.openstreetmap.org');
		expect(maps).toContain('attribution');
		expect(location).toContain('navigator.geolocation');
		expect(location).toContain('type a place');
	});

	test('Admin and Teams cover the access gate and part K invites', () => {
		const admin = RECIPES.split('\n').find((line) => line.startsWith('- Admin pages:')) ?? '';
		const teams = RECIPES.split('\n').find((line) => line.startsWith('- Teams:')) ?? '';
		expect(admin).toContain('Add admin');
		expect(teams).toContain('invites');
		expect(teams).toContain('accepts');
		expect(teams).toContain('switcher');
	});
});

describe('part O: exactly one Leaflet release is pinned in the starter lock', () => {
	test('LEAFLET_VERSION is one exact version and LEAFLET_INTEGRITY is a sha512', () => {
		expect(LEAFLET_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(LEAFLET_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
	});

	test('the generated starter lock pins exactly that Leaflet version and integrity', () => {
		const lock = SCAFFOLD_LOCKFILE ?? '';
		expect(lock).toContain(`"leaflet@${LEAFLET_VERSION}"`);
		expect(lock).toContain(LEAFLET_INTEGRITY);
		// One Leaflet, not a floating range or a second copy.
		expect([...lock.matchAll(/"leaflet@([^"]+)"/g)].map((m) => m[1])).toEqual([LEAFLET_VERSION]);
	});
});

describe('part O: FTS5 MATCH really works on the starter SQLite (the Search recipe)', () => {
	test('a virtual FTS5 table answers a MATCH query on bun:sqlite', () => {
		// bun:sqlite backs the starter's test D1 (test/setup/d1.ts). This proves
		// the recipe chose the mode the starter supports, directly.
		const db = new Database(':memory:');
		try {
			db.run('CREATE VIRTUAL TABLE notes USING fts5(title, body)');
			db.run("INSERT INTO notes(title, body) VALUES ('Hay delivery', 'fresh hay for the herd')");
			db.run("INSERT INTO notes(title, body) VALUES ('Grain order', 'grain and feed supplies')");
			const rows = db.query('SELECT title FROM notes WHERE notes MATCH ? ORDER BY rank').all('hay') as { title: string }[];
			expect(rows.map((r) => r.title)).toEqual(['Hay delivery']);
		} finally {
			db.close();
		}
	});
});

// --- behavioural: the Search recipe built in the REAL starter ----------------

const SEARCH_MIGRATION = [
	'CREATE TABLE note (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);',
	'CREATE VIRTUAL TABLE note_fts USING fts5(title, body);',
].join('\n');

const SEARCH_SERVER = [
	'import { Hono } from "hono";',
	'import type { D1Database } from "../caddie/d1";',
	'type Env = { DB: D1Database };',
	'export const app = new Hono<{ Bindings: Env }>().basePath("/api");',
	'app.post("/notes", async (c) => {',
	'  const { title, body } = await c.req.json();',
	'  // Keep the FTS5 index filled from the same write (the recipe\'s way).',
	'  const result = await c.env.DB.prepare("INSERT INTO note (title, body) VALUES (?, ?)").bind(title, body).run();',
	'  await c.env.DB.prepare("INSERT INTO note_fts (rowid, title, body) VALUES (?, ?, ?)").bind(result.meta.last_row_id, title, body).run();',
	'  return c.json({ ok: true });',
	'});',
	'app.get("/search", async (c) => {',
	'  const q = c.req.query("q") ?? "";',
	'  const rows = await c.env.DB.prepare("SELECT note.id, note.title FROM note_fts JOIN note ON note.id = note_fts.rowid WHERE note_fts MATCH ? ORDER BY rank").bind(q).all();',
	'  return c.json(rows.results);',
	'});',
	'export default app;',
	'',
].join('\n');

const SEARCH_TEST = [
	'import { describe, expect, test } from "bun:test";',
	'import app from "./search-server";',
	'import { createTestEnv } from "../test/setup/d1";',
	'',
	'describe("FTS5 search recipe", () => {',
	'  test("a MATCH query finds the row and skips the others", async () => {',
	'    const env = createTestEnv();',
	'    for (const note of [',
	'      { title: "Hay delivery", body: "fresh hay for the herd" },',
	'      { title: "Grain order", body: "grain and feed supplies" },',
	'    ]) {',
	'      const res = await app.request("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(note) }, env);',
	'      expect(res.status).toBe(200);',
	'    }',
	'    const res = await app.request("/api/search?q=hay", {}, env);',
	'    expect(res.status).toBe(200);',
	'    const rows = await res.json();',
	'    expect(rows.map((r) => r.title)).toEqual(["Hay delivery"]);',
	'  });',
	'});',
	'',
].join('\n');

describe('part O: the Search recipe runs as an FTS5 route in the materialised starter', () => {
	let featureApp: FeatureApp;

	beforeAll(() => {
		featureApp = materializeFeatureApp([], {
			'migrations/0001_notes.sql': SEARCH_MIGRATION,
			'src/search-server.ts': SEARCH_SERVER,
			'src/search.test.ts': SEARCH_TEST,
		});
	}, 240_000);

	afterAll(() => {
		featureApp?.cleanup();
	});

	test(
		'the FTS5 MATCH route returns only the matching note',
		() => {
			const result = runFeatureTest(featureApp, 'src/search.test.ts');
			expect(result.ok, result.out).toBe(true);
			expect(/\b1 pass\b/.test(result.out), result.out).toBe(true);
			expect(/\b0 fail\b/.test(result.out), result.out).toBe(true);
		},
		240_000,
	);
});
