import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

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
	await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: '2026-01-01T00:00:00.000Z' }));
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
	// A PROJECT route binds the conversation to the selected project id; Home ("/")
	// binds it to the account/general scope, so the project-scoped draft tests use
	// the project surface here.
	await page.goto('/app/project?project=proj_conversation');
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
		await expect(page.getByTestId('channel-transcript')).toContainText(/what would you like to do next\?/i);
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

test.describe('U04 — unsent messages and restored drafts (v2 §3.6)', () => {
	test('a proposal Caddie wrote out instead of making shows a plain notice, and its button asks again (live finding, 2026-10-20)', async ({ browser }) => {
		const OFFSET = '0000000000000000_0000000000000001';
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		await context.route('**/api/projects/proj_conversation/run-bindings', (route) =>
			json(route, 200, {
				runBindings: [{
					runId: 'run-written', projectId: 'proj_conversation', conversationId: 'conv-written', submissionId: 's', planRevision: 'rev-0',
					stackId: 'react-hono', payerId: 'actor-test', modelRouteId: 'route', pricingVersion: 'v1', createdBy: 'actor-test', createdAt: '2026-10-20T00:00:00.000Z',
				}],
			}),
		);
		const written =
			'{"name": "FarmLog AI", "idea": "A daily logging app for Nigerian broiler and catfish farmers.", "brief": "FarmLog AI helps farmers log daily activities.", "hackathon": "Nebius x NVIDIA Global AI Hackathon", "track": "Personal AI Track"}';
		const reply = {
			id: 'm-written', role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: '2026-10-20T00:00:00.000Z',
			parts: [{ type: 'text', text: `${written}\n\n${written}`, state: 'done' }],
		};
		const sent: string[] = [];
		await context.route('**/agents/coordinator/**', async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() === 'POST') {
				sent.push(request.postData() ?? '');
				return json(route, 202, { streamUrl: url.href, offset: OFFSET, submissionId: 'sub-written', uid: 'uid-written' });
			}
			if (url.searchParams.get('view') === 'updates') {
				return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
			}
			return route.fulfill({
				contentType: 'application/json',
				headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' },
				body: JSON.stringify({ v: 1, conversationId: 'conv-written', offset: OFFSET, messages: [reply], settlements: [] }),
			});
		});
		const page = await context.newPage();
		await openProjectPage(page);

		const notice = page.getByTestId('msg-assistant').getByTestId('proposal-not-shown');
		await expect(notice).toBeVisible();
		await expect(notice).toContainText("Caddie tried to put this idea on a card, but it didn't come through.");
		await expect(page.getByTestId('channel-transcript')).not.toContainText('"idea"');
		await notice.getByRole('button', { name: 'Ask Caddie to try again' }).click();
		await expect.poll(() => sent.some((body) => body.includes('Please show that idea as a project card.'))).toBe(true);
		await context.close();
	});
	test('a reply streamed in pieces around its thinking reads as one paragraph, first word included (live finding, 2026-10-20)', async ({ browser }) => {
		const OFFSET = '0000000000000000_0000000000000001';
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		await context.route('**/api/projects/proj_conversation/run-bindings', (route) =>
			json(route, 200, {
				runBindings: [{
					runId: 'run-pieces', projectId: 'proj_conversation', conversationId: 'conv-pieces', submissionId: 's', planRevision: 'rev-0',
					stackId: 'react-hono', payerId: 'actor-test', modelRouteId: 'route', pricingVersion: 'v1', createdBy: 'actor-test', createdAt: '2026-10-20T00:00:00.000Z',
				}],
			}),
		);
		const reply = {
			id: 'm-pieces', role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: '2026-10-20T00:00:00.000Z',
			parts: [
				{ type: 'text', text: 'The', state: 'done' },
				{ type: 'reasoning', text: 'Checking the eligibility rules.', state: 'done' },
				{ type: 'text', text: ' Nebius x NVIDIA Global AI Hackathon is open to you.', state: 'done' },
			],
		};
		await context.route('**/agents/coordinator/**', async (route) => {
			const url = new URL(route.request().url());
			if (url.searchParams.get('view') === 'updates') {
				return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
			}
			return route.fulfill({
				contentType: 'application/json',
				headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' },
				body: JSON.stringify({ v: 1, conversationId: 'conv-pieces', offset: OFFSET, messages: [reply], settlements: [] }),
			});
		});
		const page = await context.newPage();
		await openProjectPage(page);

		const answer = page.getByTestId('msg-assistant').locator('.turn-answer');
		await expect(answer).toBeVisible();
		await expect(answer.locator('.md-body')).toHaveCount(1);
		await expect(answer.locator('.md-body p')).toHaveText(['The Nebius x NVIDIA Global AI Hackathon is open to you.']);
		await context.close();
	});
	test('mockups in a reply are drawn in the preview frame, a half-written one says so, and no raw HTML shows (plan 4.5)', async ({ browser }) => {
		const OFFSET = '0000000000000000_0000000000000001';
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		await context.route('**/api/projects/proj_conversation/run-bindings', (route) =>
			json(route, 200, {
				runBindings: [{
					runId: 'run-mock', projectId: 'proj_conversation', conversationId: 'conv-mock', submissionId: 's', planRevision: 'rev-0',
					stackId: 'react-hono', payerId: 'actor-test', modelRouteId: 'route', pricingVersion: 'v1', createdBy: 'actor-test', createdAt: '2026-10-20T00:00:00.000Z',
				}],
			}),
		);
		const screen = '<main class="screen">\n  <h1>Herd today</h1>\n  <p>3 goats need a look</p>\n</main>';
		const done = {
			id: 'm-mock', role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: '2026-10-20T00:00:00.000Z',
			parts: [{
				type: 'text', state: 'done',
				text: `Here is the home screen.\n\n${screen}\n\nAnd when nothing is logged yet:\n\n\`\`\`html-mock Home · empty\n<main><p>No animals yet</p></main>\n\`\`\`\n\nTell me what to change.`,
			}],
		};
		const writing = {
			id: 'm-mock-2', role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: '2026-10-20T00:00:01.000Z',
			parts: [{ type: 'text', state: 'streaming', text: 'One more screen.\n\n```html-mock Add entry\n<main><h1>New ent' }],
		};
		await context.route('**/agents/coordinator/**', async (route) => {
			const url = new URL(route.request().url());
			if (url.searchParams.get('view') === 'updates') {
				return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
			}
			return route.fulfill({
				contentType: 'application/json',
				headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' },
				body: JSON.stringify({ v: 1, conversationId: 'conv-mock', offset: OFFSET, messages: [done, writing], settlements: [] }),
			});
		});
		const page = await context.newPage();
		await openProjectPage(page);

		const transcript = page.getByTestId('channel-transcript');
		const preview = transcript.getByTestId('design-mock-preview');
		await expect(preview).toHaveCount(1);
		await expect(preview.getByTestId('design-mock-screens').getByRole('button')).toHaveText(['Screen 1', 'Home · empty']);
		await expect(preview.getByTestId('design-mock-frame').locator('iframe')).toHaveAttribute('srcdoc', /script-src 'none'/);
		await expect(preview.getByTestId('design-mock-frame').frameLocator('iframe').getByRole('heading', { name: 'Herd today' })).toBeVisible();
		await expect(transcript).toContainText('Here is the home screen.');
		await expect(transcript).toContainText('Tell me what to change.');
		await expect(transcript.getByTestId('mock-drawing')).toHaveText('Drawing a mockup…');
		for (const raw of ['<main', '</main>', 'html-mock', 'New ent', '```']) await expect(transcript).not.toContainText(raw);
		await context.close();
	});
	test('a message on its way says "Sending…" with no buttons, and goes once Caddie has it (live finding, 2026-10-20)', async ({ browser }) => {
		// Live, every message showed "Not sent · key … — resends reuse it" with
		// Send again / Edit / Discard until the server admitted it.
		const OFFSET = '0000000000000000_0000000000000001';
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		await context.route('**/api/projects/proj_conversation/runs', (route) =>
			json(route, 200, {
				run: {
					runId: 'run-sending', projectId: 'proj_conversation', conversationId: 'conv-sending', submissionId: 's', planRevision: 'rev-0',
					stackId: 'react-hono', payerId: 'actor-test', modelRouteId: 'route', pricingVersion: 'v1', createdBy: 'actor-test', createdAt: '2026-10-20T00:00:00.000Z',
				},
			}),
		);
		let admit = () => {};
		const admitted = new Promise<void>((resolve) => {
			admit = resolve;
		});
		await context.route('**/agents/coordinator/**', async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() === 'POST') {
				await admitted;
				return json(route, 202, { streamUrl: url.href, offset: OFFSET, submissionId: 'sub-sending', uid: 'uid-sending' });
			}
			if (url.searchParams.get('view') === 'updates') {
				return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
			}
			return route.fulfill({
				contentType: 'application/json',
				headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' },
				body: JSON.stringify({ v: 1, conversationId: 'conv-sending', offset: OFFSET, messages: [], settlements: [] }),
			});
		});
		const page = await context.newPage();
		await openProjectPage(page);

		await page.getByTestId('composer-input').fill('is this on its way?');
		await page.keyboard.press('Enter');
		const row = page.getByTestId('draft-row');
		await expect(row).toHaveAttribute('data-state', 'sending');
		await expect(row).toContainText('Sending…');
		await expect(row).toContainText('is this on its way?');
		await expect(row).not.toContainText('Not sent');
		await expect(row).not.toContainText('resends reuse it');
		await expect(row.getByTestId('draft-retry')).toHaveCount(0);
		await expect(row.getByTestId('draft-edit')).toHaveCount(0);
		await expect(row.getByTestId('draft-discard')).toHaveCount(0);

		admit();
		await expect(page.getByTestId('draft-row')).toHaveCount(0);
		await context.close();
	});

	test('in a conversation that already exists, a message on its way shows once, not twice (live finding, 2026-10-20)', async ({ browser }) => {
		// With a run already bound, Flue shows its own copy of the message the
		// moment it is sent; the draft row must not repeat it underneath.
		const OFFSET = '0000000000000000_0000000000000001';
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		await context.route('**/api/projects/proj_conversation/run-bindings', (route) =>
			json(route, 200, {
				runBindings: [{
					runId: 'run-existing', projectId: 'proj_conversation', conversationId: 'conv-existing', submissionId: 's', planRevision: 'rev-0',
					stackId: 'react-hono', payerId: 'actor-test', modelRouteId: 'route', pricingVersion: 'v1', createdBy: 'actor-test', createdAt: '2026-10-20T00:00:00.000Z',
				}],
			}),
		);
		let admit = () => {};
		const admitted = new Promise<void>((resolve) => {
			admit = resolve;
		});
		await context.route('**/agents/coordinator/**', async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() === 'POST') {
				await admitted;
				return json(route, 202, { streamUrl: url.href, offset: OFFSET, submissionId: 'sub-existing', uid: 'uid-existing' });
			}
			if (url.searchParams.get('view') === 'updates') {
				return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
			}
			return route.fulfill({
				contentType: 'application/json',
				headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' },
				body: JSON.stringify({ v: 1, conversationId: 'conv-existing', offset: OFFSET, messages: [], settlements: [] }),
			});
		});
		const page = await context.newPage();
		await openProjectPage(page);

		await page.getByTestId('composer-input').fill('only once, please');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('msg-user').filter({ hasText: 'only once, please' })).toHaveCount(1);
		await expect(page.getByText('only once, please', { exact: true })).toHaveCount(1);
		await expect(page.getByTestId('draft-row')).toHaveCount(0);

		admit();
		await expect(page.getByText('only once, please', { exact: true })).toHaveCount(1);
		await context.close();
	});

	test('in a conversation that already exists, a failed message shows once, as "Not sent" with Send again (live finding, 2026-10-20)', async ({ browser }) => {
		const OFFSET = '0000000000000000_0000000000000001';
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		await context.route('**/api/projects/proj_conversation/run-bindings', (route) =>
			json(route, 200, {
				runBindings: [{
					runId: 'run-existing', projectId: 'proj_conversation', conversationId: 'conv-existing', submissionId: 's', planRevision: 'rev-0',
					stackId: 'react-hono', payerId: 'actor-test', modelRouteId: 'route', pricingVersion: 'v1', createdBy: 'actor-test', createdAt: '2026-10-20T00:00:00.000Z',
				}],
			}),
		);
		await context.route('**/agents/coordinator/**', async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() === 'POST') return json(route, 503, { error: 'unavailable', message: 'refused in this spec' });
			if (url.searchParams.get('view') === 'updates') {
				return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
			}
			return route.fulfill({
				contentType: 'application/json',
				headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' },
				body: JSON.stringify({ v: 1, conversationId: 'conv-existing', offset: OFFSET, messages: [], settlements: [] }),
			});
		});
		const page = await context.newPage();
		await openProjectPage(page);

		await page.getByTestId('composer-input').fill('this one fails');
		await page.keyboard.press('Enter');
		const row = page.getByTestId('draft-row');
		await expect(row).toHaveAttribute('data-state', 'unsent');
		await expect(row.getByTestId('draft-retry')).toBeVisible();
		await expect(page.getByText('this one fails', { exact: true })).toHaveCount(1);
		await expect(page.getByTestId('msg-user').filter({ hasText: 'this one fails' })).toHaveCount(0);
		await context.close();
	});
	test('an unsent message offers Send again · Edit · Discard; Edit returns the text to the composer', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		await context.route('**/api/projects/proj_conversation/runs', (route) =>
			json(route, 503, { error: 'run_transport_unavailable', message: 'refused in this spec' }),
		);
		const page = await context.newPage();
		await openProjectPage(page);

		await page.getByTestId('composer-input').fill('can the reminder show a preview first?');
		await page.keyboard.press('Enter');
		const row = page.getByTestId('draft-row');
		await expect(row).toBeVisible();
		await expect(row).toContainText('Not sent');
		await expect(row).not.toContainText('resends reuse it');
		await expect(row.getByTestId('draft-retry')).toContainText('Send again');

		// Edit: the failed row disappears and its text is back in the composer,
		// ready to reword and send as a NEW submission (fresh idempotency key).
		await row.getByTestId('draft-edit').click();
		await expect(page.getByTestId('draft-row')).toHaveCount(0);
		await expect(page.getByTestId('composer-input')).toHaveValue('can the reminder show a preview first?');

		// Sending the edited text produces exactly one draft with a NEW key.
		// (Focus returned to the Edit button, so click into the composer first.)
		await page.getByTestId('composer-input').click();
		await page.keyboard.press('Enter');
		const keys = await page.evaluate(() => {
			const all: string[] = [];
			for (const k of Object.keys(sessionStorage)) {
				// Only the failed-draft records carry idempotency keys; the composer
				// key stores plain text and must not be parsed as JSON.
				if (!k.includes('channel-drafts')) continue;
				for (const d of JSON.parse(sessionStorage.getItem(k) ?? '[]') as { idempotencyKey: string }[]) all.push(d.idempotencyKey);
			}
			return all;
		});
		expect(keys).toHaveLength(1);
		await context.close();
	});

	test('leftover typing restored from an earlier visit is labelled "Draft from earlier"', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		await openProjectPage(page);

		// Type and reload without sending: the composer restores the text and
		// labels it as a draft from earlier until it is sent or cleared.
		await page.getByTestId('composer-input').fill('still thinking about this');
		await page.reload();
		await expect(page.getByTestId('composer-input')).toHaveValue('still thinking about this');
		await expect(page.locator('.composer-hint.draft-note')).toContainText('Draft from earlier · not sent yet');

		// Typing retires the restored-draft note (the plain hint returns).
		await page.getByTestId('composer-input').fill('');
		await page.getByTestId('composer-input').fill('new text');
		await expect(page.locator('.composer-hint')).not.toHaveClass(/draft-note/);
		await expect(page.locator('.composer-hint')).toContainText('Enter to send');
		await context.close();
	});
});

test.describe('Stage 3/4 — image/file attach + voice dictation composer states', () => {
	test('the attach button is present and an attachment chip appears then removes', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		await openProjectPage(page);

		// Attach / mic / camera now live behind one "+" toggle; open it to reach
		// the "Upload media" item, which triggers the hidden file input.
		await page.getByTestId('composer-tools-toggle').click();
		await expect(page.getByTestId('composer-attach')).toBeVisible();

		// Set a small text file on the hidden input; the preview chip must appear
		// labelled as a file (not an image) and be removable.
		await page.setInputFiles('[data-testid="composer-file-input"]', {
			name: 'notes.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('my plan notes'),
		});
		// Close the "+" menu (in the real flow, picking "Upload media" closes it
		// before the OS picker opens; the test sets the input directly, so close
		// it explicitly) so its items don't overlap the chip's remove button.
		await page.keyboard.press('Escape');
		const chip = page.getByTestId('attachment-chip');
		await expect(chip).toBeVisible();
		await expect(chip).toHaveAttribute('data-kind', 'file');
		await expect(chip).toContainText('notes.txt');

		await page.getByTestId('attachment-remove').click();
		await expect(page.getByTestId('attachment-chip')).toHaveCount(0);
		await context.close();
	});

	test('an image file produces an image-kind chip', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		await openProjectPage(page);
		await page.setInputFiles('[data-testid="composer-file-input"]', {
			name: 'shot.png',
			mimeType: 'image/png',
			buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
		});
		const chip = page.getByTestId('attachment-chip');
		await expect(chip).toBeVisible();
		await expect(chip).toHaveAttribute('data-kind', 'image');
		await context.close();
	});

	test('an unsupported file type is refused with a visible error, no chip', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		await openProjectPage(page);
		await page.setInputFiles('[data-testid="composer-file-input"]', {
			name: 'malware.exe',
			mimeType: 'application/octet-stream',
			buffer: Buffer.from([0x4d, 0x5a]),
		});
		await expect(page.getByTestId('composer-attach-error')).toBeVisible();
		await expect(page.getByTestId('attachment-chip')).toHaveCount(0);
		await context.close();
	});

	test('the mic button shows when SpeechRecognition is available and toggles a listening state', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		// Inject a controllable SpeechRecognition BEFORE the app loads so the
		// mic button renders deterministically regardless of the test browser.
		await page.addInitScript(() => {
			class FakeRecognition {
				lang = '';
				continuous = false;
				interimResults = false;
				onresult: ((e: unknown) => void) | null = null;
				onerror: ((e: unknown) => void) | null = null;
				onend: (() => void) | null = null;
				start() {/* listening */}
				stop() { this.onend?.(); }
				abort() {}
			}
			(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
		});
		await openProjectPage(page);

		// Mic lives in the "+" menu now. Open it, start dictation (the menu
		// closes on pick), confirm the listening indicator, then reopen the menu
		// and pick the mic item again to stop.
		await page.getByTestId('composer-tools-toggle').click();
		const mic = page.getByTestId('composer-mic');
		await expect(mic).toBeVisible();
		await expect(mic).toHaveAttribute('data-listening', 'false');
		await mic.click();
		await expect(page.getByTestId('composer-dictation')).toContainText(/listening/i);
		await page.getByTestId('composer-tools-toggle').click();
		await expect(page.getByTestId('composer-mic')).toHaveAttribute('data-listening', 'true');
		await page.getByTestId('composer-mic').click();
		await expect(page.getByTestId('composer-dictation')).toHaveCount(0);
		await context.close();
	});

	test('the mic button is hidden when SpeechRecognition is unavailable (graceful fallback)', async ({ browser }) => {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		await page.addInitScript(() => {
			// Ensure neither global exists (some engines ship webkit-prefixed).
			delete (window as unknown as Record<string, unknown>).SpeechRecognition;
			delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
		});
		await openProjectPage(page);
		// Open the "+" menu: Upload media is always there, but with no
		// SpeechRecognition the Dictate (mic) item is not rendered.
		await page.getByTestId('composer-tools-toggle').click();
		await expect(page.getByTestId('composer-attach')).toBeVisible();
		await expect(page.getByTestId('composer-mic')).toHaveCount(0);
		await context.close();
	});

	test('reduced-motion disables the listening pulse animation', async ({ browser }) => {
		const context = await browser.newContext({ reducedMotion: 'reduce' });
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		const page = await context.newPage();
		await page.addInitScript(() => {
			class FakeRecognition {
				lang = ''; continuous = false; interimResults = false;
				onresult: ((e: unknown) => void) | null = null;
				onerror: ((e: unknown) => void) | null = null;
				onend: (() => void) | null = null;
				start() {} stop() { this.onend?.(); } abort() {}
			}
			(window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
		});
		await openProjectPage(page);
		// Start dictation through the "+" menu, then assert the live "Listening…"
		// indicator's pulse is suppressed under reduced-motion (the dot carries
		// the animation now that the mic is a menu item, not a pulsing button).
		await page.getByTestId('composer-tools-toggle').click();
		await page.getByTestId('composer-mic').click();
		const animation = await page
			.getByTestId('composer-dictation')
			.locator('.composer-dictation-dot')
			.evaluate((el) => getComputedStyle(el).animationName);
		// Under reduced-motion the pulse keyframes are suppressed → 'none'.
		expect(animation === 'none' || animation === '').toBeTruthy();
		await context.close();
	});
});

test.describe('memory learns: the chat offers what Caddie can remember (plan 6.2)', () => {
	async function offersPage(browser: Browser, offers: { id: string; content: string }[]) {
		const context = await browser.newContext();
		await stubSession(context);
		await stubProjectList(context, { projects: [PROJECT] });
		let waiting = [...offers];
		const actions: string[] = [];
		await context.route('**/api/memory/offers?**', (route) => {
			expect(new URL(route.request().url()).searchParams.get('projectId')).toBe('proj_conversation');
			return json(route, 200, { offers: waiting });
		});
		await context.route('**/api/memory/*/confirm', (route) => {
			const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
			actions.push(`confirm ${id}`);
			waiting = waiting.filter((offer) => offer.id !== id);
			return json(route, 200, { fact: { id, status: 'confirmed' } });
		});
		await context.route('**/api/memory/*/retract', (route) => {
			const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
			actions.push(`retract ${id}`);
			waiting = waiting.filter((offer) => offer.id !== id);
			return json(route, 200, { fact: { id, status: 'retracted' } });
		});
		const page = await context.newPage();
		await openProjectPage(page);
		return { context, page, actions };
	}

	test('a waiting memory shows in the chat in plain words; Remember it keeps it and the offer goes', async ({ browser }) => {
		const { context, page, actions } = await offersPage(browser, [{ id: 'mem_stated', content: 'Always use TypeScript.' }]);
		const offer = page.getByTestId('memory-offer');
		// The quote marks are drawn by the browser around <q>, so the text has none.
		await expect(offer.locator('.memory-offer-text')).toHaveText('Caddie can remember this for next time: Always use TypeScript.');
		await expect(offer.locator('q')).toHaveText('Always use TypeScript.');
		await offer.getByRole('button', { name: 'Remember it' }).click();
		await expect(page.getByTestId('memory-offer')).toHaveCount(0);
		expect(actions).toEqual(['confirm mem_stated']);
		await context.close();
	});

	test('No thanks declines it; nothing is kept', async ({ browser }) => {
		const { context, page, actions } = await offersPage(browser, [
			{ id: 'mem_a', content: 'Never use emojis.' },
			{ id: 'mem_b', content: 'Builds apps for goat farmers' },
		]);
		await expect(page.getByTestId('memory-offer')).toHaveCount(2);
		await page.getByTestId('memory-offer').first().getByRole('button', { name: 'No thanks' }).click();
		await expect(page.getByTestId('memory-offer')).toHaveCount(1);
		await expect(page.getByTestId('memory-offer')).toContainText('Builds apps for goat farmers');
		expect(actions).toEqual(['retract mem_a']);
		await context.close();
	});
});
