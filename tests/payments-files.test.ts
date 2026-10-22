import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	PAYMENTS_FILES,
	PAYING_TEST_CARD,
	DECLINED_TEST_CARD,
	TEST_MODE_BANNER,
	PLAN_REQUIRED_BODY,
} from '../stacks/react-hono/payments-files.ts';
import { materializeFeatureApp, runFeatureTest, type FeatureApp } from './support/feature-app.ts';

/**
 * Part J — payments and subscriptions in TEST MODE (plan part J, lane 9).
 *
 * The structural tests pin the invariants that make the mode SAFE and the mode
 * HONEST: the banner is on every billing screen and in the server, the locked-
 * route body is { reason: "plan_required" }, the migration keeps only the last
 * 4 digits (never a full card number column), and the routes live under
 * /api/caddie/. Each bites via a mutation proof (see docs in the report).
 *
 * The behavioural test materialises a real starter app that mounts the
 * generated mountPayments routes + a locked route guarded by planAccess, then
 * runs the real routes: D10's three cards, 402 before checkout then 200 after
 * paying then 402 again after End now, Cancel keeping access until the renewal
 * date, and — read from the real database — no stored column holds the full
 * card number. LOCAL VERIFIED.
 */

describe('part J: generated payments files — structure', () => {
	const migration = PAYMENTS_FILES['migrations/0000_caddie_payments.sql'] ?? '';
	const server = PAYMENTS_FILES['caddie/payments.ts'] ?? '';
	const billing = PAYMENTS_FILES['caddie/Billing.tsx'] ?? '';

	test('the three generated files exist', () => {
		expect(migration.length).toBeGreaterThan(0);
		expect(server.length).toBeGreaterThan(0);
		expect(billing.length).toBeGreaterThan(0);
	});

	test('the payments migration sorts after auth and before the generated schema', () => {
		// 0000_caddie_* sorts after 0000_caddie_auth.sql (payments > auth) and
		// before 0001_schema.sql — name order, which lane 9 confirms the runner
		// uses (see migration-order.test.ts).
		expect('migrations/0000_caddie_payments.sql' > 'migrations/0000_caddie_auth.sql').toBe(true);
		expect('migrations/0000_caddie_payments.sql' < 'migrations/0001_schema.sql').toBe(true);
	});

	test('the migration keeps only the last 4 digits — no full-card column', () => {
		expect(migration).toContain('cardLast4');
		// A column literally named for the full number would be a leak.
		expect(migration).not.toMatch(/cardNumber|card_number|fullCard|pan\b/i);
		expect(migration).toContain('create table caddie_subscriptions');
		expect(migration).toContain('create table caddie_payments');
	});

	test('the server mounts the four routes under /api/caddie/', () => {
		expect(server).toContain('/caddie/billing');
		expect(server).toContain('/caddie/checkout');
		expect(server).toContain('/caddie/cancel');
		expect(server).toContain('/caddie/end-now');
		// planAccess is what the generated access check calls for a locked route.
		expect(server).toContain('export async function planAccess');
	});

	test('the locked-route body is { reason: "plan_required" }', () => {
		expect(PLAN_REQUIRED_BODY).toEqual({ reason: 'plan_required' });
		expect(server).toContain('reason: "plan_required"');
		expect(server).toContain('402');
	});

	test('every billing screen carries the test-mode banner', () => {
		// The RENDERED banner: the generated const the <TestModeBanner /> shows,
		// not merely the phrase in a comment. Mutating this line must fail here.
		expect(billing).toContain(`export const TEST_MODE_BANNER = "${TEST_MODE_BANNER}";`);
		expect(billing).toContain('caddie-billing-banner');
		// The banner component is rendered on both the checkout and the current-plan views.
		expect(billing.match(/<TestModeBanner \/>/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	});

	test('the generated files are protected runtime files (do not edit)', () => {
		expect(migration).toContain('do not edit');
		expect(server).toContain('do not edit');
		expect(billing).toContain('do not edit');
	});

	test('the D10 test cards are the plan\'s cards', () => {
		expect(PAYING_TEST_CARD).toBe('4242424242424242');
		expect(DECLINED_TEST_CARD).toBe('4000000000000002');
		expect(server).toContain('4242424242424242');
		expect(server).toContain('4000000000000002');
	});
});

// --- behavioural: the real generated routes, in a materialised app ----------

// An app server that mounts the generated payments routes and ALSO declares a
// locked route guarded by the generated planAccess — exactly what the host
// generates for a block with payments.locked.
const APP_SERVER = [
	'import { Hono } from "hono";',
	'import type { D1Database } from "../caddie/d1";',
	'import type { CaddiePlatform } from "../caddie/platform";',
	'import { mountSignIn } from "../caddie/auth";',
	'import { mountPayments, planAccess } from "../caddie/payments";',
	'',
	'export type Env = { DB: D1Database; CADDIE: CaddiePlatform; CADDIE_AUTH_SECRET?: string };',
	'export const app = new Hono<{ Bindings: Env }>().basePath("/api");',
	'app.get("/health", (c) => c.json({ ok: true }));',
	'mountSignIn(app);',
	'mountPayments(app, { currency: "USD", plans: [{ id: "pro", priceMinor: 900, interval: "month" }] });',
	'',
	'// A locked route: the generated access check calls planAccess first.',
	'app.get("/reports/export", async (c) => {',
	'  const blocked = await planAccess(c, ["pro"]);',
	'  if (blocked) return blocked;',
	'  return c.json({ report: "ok" });',
	'});',
	'',
	'export default app;',
	'',
].join('\n');

const ROUTE_TEST = [
	'import { describe, expect, test } from "bun:test";',
	'import { app } from "../src/server";',
	'import { signInForTest } from "../test/setup/auth";',
	'import { createTestEnv } from "../test/setup/d1";',
	'',
	'const post = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });',
	'const pay = { cardNumber: "4242 4242 4242 4242", expiry: "12/34", cvc: "123" };',
	'',
	'describe("part J routes (test mode)", () => {',
	'  test("a locked route is 402 plan_required before checkout, 200 after paying, 402 after end-now", async () => {',
	'    const env = createTestEnv();',
	'    const { headers } = await signInForTest(app, env, "ada@example.com");',
	'    const before = await app.request("/api/reports/export", { headers }, env);',
	'    expect(before.status).toBe(402);',
	'    expect(await before.json()).toEqual({ reason: "plan_required" });',
	'    const checkout = await app.request("/api/caddie/checkout", post({ planId: "pro", ...pay }, headers), env);',
	'    expect(checkout.status).toBe(200);',
	'    expect(((await checkout.json())).outcome).toBe("paid");',
	'    const after = await app.request("/api/reports/export", { headers }, env);',
	'    expect(after.status).toBe(200);',
	'    expect(await after.json()).toEqual({ report: "ok" });',
	'    const ended = await app.request("/api/caddie/end-now", post({}, headers), env);',
	'    expect(ended.status).toBe(200);',
	'    const locked = await app.request("/api/reports/export", { headers }, env);',
	'    expect(locked.status).toBe(402);',
	'    expect(await locked.json()).toEqual({ reason: "plan_required" });',
	'  });',
	'',
	'  test("the declined card and an unknown card both leave the route locked", async () => {',
	'    const env = createTestEnv();',
	'    const { headers } = await signInForTest(app, env, "declined@example.com");',
	'    const declined = await app.request("/api/caddie/checkout", post({ planId: "pro", cardNumber: "4000 0000 0000 0002", expiry: "12/34", cvc: "123" }, headers), env);',
	'    expect(declined.status).toBe(402);',
	'    expect(((await declined.json())).outcome).toBe("declined");',
	'    expect((await app.request("/api/reports/export", { headers }, env)).status).toBe(402);',
	'    const refused = await app.request("/api/caddie/checkout", post({ planId: "pro", cardNumber: "1234 5678 9012 3456", expiry: "12/34", cvc: "123" }, headers), env);',
	'    expect(refused.status).toBe(402);',
	'    expect(((await refused.json())).outcome).toBe("refused");',
	'    expect((await app.request("/api/reports/export", { headers }, env)).status).toBe(402);',
	'  });',
	'',
	'  test("Cancel keeps access until the renewal date", async () => {',
	'    const env = createTestEnv();',
	'    const { headers } = await signInForTest(app, env, "cancel@example.com");',
	'    await app.request("/api/caddie/checkout", post({ planId: "pro", ...pay }, headers), env);',
	'    const cancelled = await app.request("/api/caddie/cancel", post({}, headers), env);',
	'    expect(cancelled.status).toBe(200);',
	'    expect(((await cancelled.json())).status).toBe("canceled");',
	'    // renewsAt is in the future, so a canceled plan still unlocks the route.',
	'    expect((await app.request("/api/reports/export", { headers }, env)).status).toBe(200);',
	'  });',
	'',
	'  test("after a checkout, no stored value is the full card number", async () => {',
	'    const env = createTestEnv();',
	'    const { headers } = await signInForTest(app, env, "leak@example.com");',
	'    await app.request("/api/caddie/checkout", post({ planId: "pro", ...pay }, headers), env);',
	'    const { results } = await env.DB.prepare("select * from caddie_payments").all();',
	'    expect(results.length).toBe(1);',
	'    const row = results[0];',
	'    expect(row.cardLast4).toBe("4242");',
	'    for (const value of Object.values(row)) {',
	'      expect(String(value)).not.toContain("4242424242424242");',
	'    }',
	'    // The CVC and expiry are never stored either.',
	'    expect(Object.keys(row)).not.toContain("cvc");',
	'    expect(Object.keys(row)).not.toContain("expiry");',
	'  });',
	'',
	'  test("billing shows the plan, its renewal date and the test-mode flag", async () => {',
	'    const env = createTestEnv();',
	'    const { headers } = await signInForTest(app, env, "show@example.com");',
	'    await app.request("/api/caddie/checkout", post({ planId: "pro", ...pay }, headers), env);',
	'    const billing = await (await app.request("/api/caddie/billing", { headers }, env)).json();',
	'    expect(billing.testMode).toBe(true);',
	'    expect(billing.currency).toBe("USD");',
	'    expect(billing.current.planId).toBe("pro");',
	'    expect(billing.current.status).toBe("active");',
	'    expect(typeof billing.current.renewsAt).toBe("string");',
	'  });',
	'});',
	'',
].join('\n');

describe('part J: generated payments routes run for real', () => {
	let featureApp: FeatureApp;

	beforeAll(() => {
		featureApp = materializeFeatureApp([PAYMENTS_FILES], {
			'src/server.ts': APP_SERVER,
			'src/payments-routes.test.ts': ROUTE_TEST,
		});
	}, 240_000);

	afterAll(() => {
		featureApp?.cleanup();
	});

	test(
		'the real routes pass D10, the 402->200->402 lifecycle, cancel and the no-leak check',
		() => {
			const result = runFeatureTest(featureApp, 'src/payments-routes.test.ts');
			expect(result.ok, result.out).toBe(true);
			expect(/\b5 pass\b/.test(result.out), result.out).toBe(true);
			expect(/\b0 fail\b/.test(result.out), result.out).toBe(true);
		},
		240_000,
	);
});
