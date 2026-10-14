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
		await expect(page.getByTestId('channel-transcript')).toContainText(/your first message starts a run/i);
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

		await expect(page.getByTestId('composer-attach')).toBeVisible();

		// Set a small text file on the hidden input; the preview chip must appear
		// labelled as a file (not an image) and be removable.
		await page.setInputFiles('[data-testid="composer-file-input"]', {
			name: 'notes.txt',
			mimeType: 'text/plain',
			buffer: Buffer.from('my plan notes'),
		});
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

		const mic = page.getByTestId('composer-mic');
		await expect(mic).toBeVisible();
		await expect(mic).toHaveAttribute('data-listening', 'false');
		await mic.click();
		await expect(mic).toHaveAttribute('data-listening', 'true');
		await expect(page.getByTestId('composer-dictation')).toContainText(/listening/i);
		await mic.click();
		await expect(mic).toHaveAttribute('data-listening', 'false');
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
		await page.getByTestId('composer-mic').click();
		const animation = await page
			.getByTestId('composer-mic')
			.evaluate((el) => getComputedStyle(el).animationName);
		// Under reduced-motion the pulse keyframes are suppressed → 'none'.
		expect(animation === 'none' || animation === '').toBeTruthy();
		await context.close();
	});
});
