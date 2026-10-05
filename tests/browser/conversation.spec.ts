import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Conversation surface acceptance for the composed build (P05/P06 shared).
 *
 * The transport behind the Channel is P05's live acceptance (reconnect and
 * duplicate-send against a real agent need credentials — see
 * tests/live/flue-lifecycle.spec.ts). What IS testable here without a
 * provider: the honest standby channel, the composer draft lifecycle with
 * idempotency keys, and the settlement banner rule (stop never becomes
 * success) via the ChannelSource seam.
 *
 * Auth is stubbed the same way workspace.spec.ts stubs it: the composed build
 * has real fail-closed auth and no seeded accounts, so UI-state proofs drive
 * /api/auth/* deterministically. This is a UI-state proof, not auth evidence.
 */

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
	return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubSession(context: BrowserContext) {
	await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
	await context.route('**/api/auth/get-session', (route) =>
		json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Test', email: 't@caddie.test' } }),
	);
	await context.route('**/api/projects/**', (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [] });
		if (path.endsWith('/artifacts')) return json(route, 200, { artifacts: [] });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [], latest: null });
		return json(route, 200, {});
	});
}

async function stubProjectList(context: BrowserContext, body: unknown) {
	await context.route('**/api/projects', (route) => {
		if (route.request().method() !== 'GET') return json(route, 405, { error: 'method_not_allowed' });
		return json(route, 200, body);
	});
}

const PROJECT = {
	id: 'proj_conversation',
	workspaceId: 'ws_conversation',
	name: 'Conversation Test',
	description: null,
	contestId: null,
	contestUrl: null,
	status: 'active',
	createdAt: '2026-10-05T00:00:00.000Z',
	updatedAt: '2026-10-05T00:00:00.000Z',
};

async function openProjectPage(page: Page) {
	await page.goto('/app/?project=proj_conversation');
	await expect(page.getByTestId('channel')).toBeVisible();
}

test.describe('P05/P06 conversation surface', () => {
	test('channel renders the honest standby state with no transport', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		await openProjectPage(page);
		// No transport is wired yet: an explicit standby, never fake messages.
		await expect(page.getByTestId('channel-transcript')).toContainText(/Channel standby/i);
		await expect(page.locator('[data-testid="msg-user"], [data-testid="msg-assistant"]')).toHaveCount(0);
		await context.close();
	});

	test('composer keeps a draft with a stable idempotency key across retry', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		await openProjectPage(page);

		const composer = page.getByTestId('composer-input');
		await composer.fill('build me a todo app');
		await page.keyboard.press('Enter');
		const draft = page.getByTestId('draft-row');
		await expect(draft).toBeVisible();

		// The draft's key lives in sessionStorage scoped to the actor+project;
		// retry must keep the SAME key: one logical submission, never two.
		const readKeys = () =>
			page.evaluate(() => {
				const keys = Object.keys(sessionStorage).filter((k) => k.includes('draft'));
				const all = keys.flatMap((k) => JSON.parse(sessionStorage.getItem(k) ?? '[]') as { idempotencyKey: string }[]);
				return all.map((d) => d.idempotencyKey);
			});
		const before = await readKeys();
		expect(before).toHaveLength(1);
		await page.getByTestId('draft-retry').click();
		await expect(page.getByTestId('draft-row')).toBeVisible();
		const after = await readKeys();
		expect(after).toEqual(before);

		// discard marks the draft cancelled — kept for reference, never sent
		await page.getByTestId('draft-discard').click();
		const cancelled = page.getByTestId('draft-row');
		await expect(cancelled).toHaveAttribute('data-state', 'cancelled');
		await expect(cancelled).toContainText('cancelled — kept for reference');
		await context.close();
	});

	test('drafts survive a page reload', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		await openProjectPage(page);
		await page.getByTestId('composer-input').fill('survives reload');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('draft-row')).toContainText('survives reload');
		await page.reload();
		await expect(page.getByTestId('draft-row')).toContainText('survives reload');
		await context.close();
	});
});
