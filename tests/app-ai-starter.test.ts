import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_FILES } from '../stacks/react-hono/server-files.ts';
import { AUTH_FILES } from '../stacks/react-hono/auth-files.ts';

/**
 * The react-hono STARTER's types for parts M (photos) and K (emails), lane 11.
 *
 * Two halves:
 *  - the generated `caddie/ai.ts` and `caddie/platform.ts` declare the new
 *    shapes a builder writes against (asserted on the generated source);
 *  - the generated `test/setup/caddie.ts` stand-in BEHAVES like the real
 *    platform's refusals — materialised and imported for real, so a photo or
 *    email call that the real platform would refuse also fails the app's own
 *    tests. No network, no cost.
 */

const aiSource = SERVER_FILES['caddie/ai.ts'] ?? '';
const platformSource = AUTH_FILES['caddie/platform.ts'] ?? '';
const stubSource = AUTH_FILES['test/setup/caddie.ts'] ?? '';

// Materialise the stand-in into a temp package and import it. Its type imports
// (`import type ...`) are erased at runtime, so only the stub body runs.
const dir = mkdtempSync(join(tmpdir(), 'caddie-starter-'));
mkdirSync(join(dir, 'caddie'), { recursive: true });
mkdirSync(join(dir, 'test', 'setup'), { recursive: true });
writeFileSync(join(dir, 'caddie', 'ai.ts'), aiSource);
writeFileSync(join(dir, 'caddie', 'platform.ts'), platformSource);
writeFileSync(join(dir, 'test', 'setup', 'caddie.ts'), stubSource);
const stub = (await import(join(dir, 'test', 'setup', 'caddie.ts'))) as {
	createTestCaddie: () => {
		ai(request: unknown): Promise<unknown>;
		email(request: unknown): Promise<unknown>;
		requests: unknown[];
		emails: { to: string; subject: string; text: string; template: string }[];
	};
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const image = (over: Record<string, unknown> = {}) => ({ type: 'image', mime: 'image/png', data: 'QUJD', ...over });

describe('starter caddie/ai.ts types (part M)', () => {
	test('a message content may be text or a list of parts', () => {
		expect(aiSource).toContain('CaddieAiContentPart');
		expect(aiSource).toContain('content: string | CaddieAiContentPart[];');
		expect(aiSource).toContain('CaddieAiImageMime');
		// The photo recipe is spelled out: super tier, readFile, the limits.
		expect(aiSource).toContain('readFile()');
		expect(aiSource).toContain('at most 4 photos per call, each under 1.5 MB, JPEG/PNG/WebP only');
	});

	test('the fake AI accepts a well-formed photo message on the super tier', async () => {
		const caddie = stub.createTestCaddie();
		const reply = await caddie.ai({ tier: 'super', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, image()] }] });
		expect(reply).toEqual({ ok: true, text: 'test reply' });
		expect(caddie.requests).toHaveLength(1);
	});

	test('the fake AI refuses a photo on the fast tier, like the real platform', async () => {
		const caddie = stub.createTestCaddie();
		expect(await caddie.ai({ tier: 'fast', messages: [{ role: 'user', content: [image()] }] }))
			.toEqual({ ok: false, reason: 'invalid_request', message: 'Looking at a photo needs tier "super".' });
	});

	test('the fake AI refuses a non-image type and more than four photos', async () => {
		const caddie = stub.createTestCaddie();
		expect(await caddie.ai({ tier: 'super', messages: [{ role: 'user', content: [image({ mime: 'image/gif' })] }] }))
			.toEqual({ ok: false, reason: 'invalid_request', message: 'Photos must be JPEG, PNG or WebP.' });
		expect(await caddie.ai({ tier: 'super', messages: [{ role: 'user', content: Array.from({ length: 5 }, () => image()) }] }))
			.toEqual({ ok: false, reason: 'too_long', message: 'Send at most 4 photos in one call.' });
	});
});

describe('starter caddie/platform.ts types (part K)', () => {
	test('env.CADDIE declares email() with the test-inbox reply', () => {
		expect(platformSource).toContain('email(request: CaddieEmailRequest): Promise<CaddieEmailReply>;');
		expect(platformSource).toContain('CaddieEmailRequest');
		expect(platformSource).toContain('delivered: "test-inbox"');
		// The four fields K names.
		for (const field of ['to:', 'subject:', 'text:', 'template:']) expect(platformSource).toContain(field);
	});

	test('the fake email lands in the test inbox and reports it', async () => {
		const caddie = stub.createTestCaddie();
		const reply = await caddie.email({ to: 'ada@example.com', subject: 'Join the farm', text: 'Tap the link.', template: 'invite' });
		expect(reply).toEqual({ ok: true, delivered: 'test-inbox' });
		expect(caddie.emails).toEqual([{ to: 'ada@example.com', subject: 'Join the farm', text: 'Tap the link.', template: 'invite' }]);
	});

	test('the fake email enforces the K limits', async () => {
		const caddie = stub.createTestCaddie();
		const good = { to: 'ada@example.com', subject: 's', text: 't', template: 'invite' };
		expect(await caddie.email({ ...good, to: 'not-an-email' })).toMatchObject({ ok: false, reason: 'invalid_request' });
		expect(await caddie.email({ ...good, subject: 'x'.repeat(151) })).toEqual({ ok: false, reason: 'too_long', message: 'Keep the subject under 150 characters.' });
		expect(await caddie.email({ ...good, text: 'x'.repeat(5001) })).toEqual({ ok: false, reason: 'too_long', message: 'Keep the email under 5,000 characters.' });
		// A refused email is never stored.
		expect(caddie.emails).toHaveLength(0);
	});
});
