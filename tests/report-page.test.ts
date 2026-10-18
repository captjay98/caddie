import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { listAbuseReports } from '../apps/app/src/server/abuse-reports.ts';
import { createReportRouter, reportRateLimitKey } from '../apps/app/src/server/routes/report.ts';
import { migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * The public "Report an app" page. LOCAL VERIFIED in-process (Hono router,
 * real migrations over SQLite). The abuse inbox is a recorder here; the real
 * mailer is covered by the notifications suites.
 */

const ORIGIN = 'https://caddie.example.com';

describe('report page', () => {
	let sqlite: Database;
	let db: D1Database;
	let inbox: string[];
	const env = (overrides: Record<string, unknown> = {}) => ({ DB: db, APPS_DOMAIN: 'caddieapps.com', BETTER_AUTH_SECRET: 'test-secret-0123456789', ...overrides }) as never;
	const router = createReportRouter({
		notifierFor: () => async (subject) => {
			inbox.push(subject);
			return true;
		},
	});
	const post = (fields: Record<string, string>, headers: Record<string, string> = {}, environment = env()) =>
		router.request(
			`${ORIGIN}/report`,
			{ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'cf-connecting-ip': '203.0.113.7', ...headers }, body: new URLSearchParams(fields).toString() },
			environment,
		);

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
		inbox = [];
	});

	afterEach(() => sqlite.close());

	test('the form is a plain page: the app address prefilled and escaped, no scripts allowed', async () => {
		const res = await router.request(`${ORIGIN}/report?app=farm-log`, {}, env());
		expect(res.status).toBe(200);
		expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
		expect(res.headers.get('cache-control')).toBe('no-store');
		const html = await res.text();
		expect(html).toContain('value="farm-log"');
		expect(html).toContain('<span>.caddieapps.com</span>');
		expect(html).not.toContain('<script');
		const hostile = await (await router.request(`${ORIGIN}/report?app=${encodeURIComponent('"><script>alert(1)</script>')}`, {}, env())).text();
		expect(hostile).not.toContain('<script>alert(1)');
		expect(hostile).toContain('&quot;&gt;&lt;script&gt;');
	});

	test('a report is stored, the inbox is told, and the visitor gets a thank-you', async () => {
		const res = await post({ app: 'Farm-Log', category: 'phishing', details: 'It asks for my bank PIN.', email: 'visitor@example.com', website: '' });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('Your report reached Caddie.');
		const reports = await listAbuseReports(db, { status: 'open' });
		expect(reports.map((r) => [r.slug, r.source, r.category, r.details, r.reporterEmail])).toEqual([['farm-log', 'visitor', 'phishing', 'It asks for my bank PIN.', 'visitor@example.com']]);
		expect(inbox).toEqual(['[Caddie abuse] phishing report for farm-log']);
		// Only a keyed hash of the visitor is kept, never the IP.
		expect(JSON.stringify(sqlite.prepare('select * from abuse_reports').all())).not.toContain('203.0.113.7');
	});

	test('mistakes come back on the same form with what was typed kept', async () => {
		const res = await post({ app: 'farm-log', category: 'not-a-category', details: 'Something odd <b>here</b>', email: '' });
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain('Pick what is wrong with the app.');
		expect(html).toContain('Something odd &lt;b&gt;here&lt;/b&gt;');
		const badEmail = await post({ app: 'farm-log', category: 'scam', details: 'A fake shop.', email: 'not-an-email' });
		expect(badEmail.status).toBe(400);
		expect(await listAbuseReports(db)).toEqual([]);
	});

	test('bots that fill the hidden field, other sites and floods are turned away', async () => {
		const bot = await post({ app: 'farm-log', category: 'other', details: 'spam spam', website: 'https://spam.example' });
		expect(bot.status).toBe(200);
		expect(await listAbuseReports(db)).toEqual([]);

		const crossSite = await post({ app: 'farm-log', category: 'other', details: 'from elsewhere' }, { origin: 'https://evil.example' });
		expect(crossSite.status).toBe(403);
		expect(await listAbuseReports(db)).toEqual([]);

		for (let i = 0; i < 5; i++) expect((await post({ app: 'farm-log', category: 'other', details: `report ${i}` })).status).toBe(200);
		const flood = await post({ app: 'farm-log', category: 'other', details: 'one too many' });
		expect(flood.status).toBe(429);
		expect(await flood.text()).toContain('Try again in an hour.');
		// A different visitor is not affected.
		expect((await post({ app: 'farm-log', category: 'other', details: 'someone else' }, { 'cf-connecting-ip': '198.51.100.9' })).status).toBe(200);
		expect((await listAbuseReports(db)).length).toBe(6);
	});

	test('the reporter key is purpose-bound to the report rate limit, never the bare secret', async () => {
		const secret = 'test-secret-0123456789';
		const key = await reportRateLimitKey(secret);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(key).not.toBe(secret);
		// Same secret, same label: the key is stable, and the default label is the report one.
		expect(await reportRateLimitKey(secret)).toBe(key);
		expect(await reportRateLimitKey(secret, 'caddie-report-ratelimit:v1')).toBe(key);
		// A different purpose label (the way appAuthSecret binds app sign-in) gives a different key.
		expect(await reportRateLimitKey(secret, 'caddie-app-auth:v1')).not.toBe(key);
		expect(await reportRateLimitKey(secret, 'caddie-judge-ratelimit:v1')).not.toBe(key);
		// Missing, blank or too-short secrets yield no key at all: no literal fallback.
		expect(await reportRateLimitKey(undefined)).toBeNull();
		expect(await reportRateLimitKey('')).toBeNull();
		expect(await reportRateLimitKey('   ')).toBeNull();
		expect(await reportRateLimitKey('short')).toBeNull();
	});

	test('the same visitor on the same day hashes to the same key; a different visitor does not', async () => {
		await post({ app: 'farm-log', category: 'other', details: 'first from this visitor' });
		await post({ app: 'farm-log', category: 'other', details: 'second from this visitor' });
		await post({ app: 'farm-log', category: 'other', details: 'another visitor entirely' }, { 'cf-connecting-ip': '198.51.100.9' });
		const hashes = (sqlite.prepare('select reporterHash from abuse_reports order by rowid').all() as Array<{ reporterHash: string }>).map((row) => row.reporterHash);
		expect(hashes[0]).toMatch(/^[0-9a-f]{32}$/);
		expect(hashes[1]).toBe(hashes[0]);
		expect(hashes[2]).not.toBe(hashes[0]);
	});

	test('without a usable master secret the report page says so and stores nothing', async () => {
		for (const secret of [undefined, '', 'short-secret']) {
			const res = await post({ app: 'farm-log', category: 'other', details: 'a report while the key is missing' }, {}, env({ BETTER_AUTH_SECRET: secret }));
			expect(res.status).toBe(503);
			expect(await res.text()).toContain("Caddie can't take reports right now.");
		}
		expect(await listAbuseReports(db)).toEqual([]);
		expect(inbox).toEqual([]);
	});
});
