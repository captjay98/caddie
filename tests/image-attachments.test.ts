import { describe, expect, test } from 'bun:test';
import type { InputAttachment } from '@caddie/contracts';
import {
	MAX_FILE_TEXT_CHARS,
	attachedFileNames,
	bytesToBase64,
	stripAttachedFileText,
	toAttachedFileText,
	toDeliveredImages,
} from '../apps/app/src/client/conversation/image-attachments.ts';

/**
 * Regression (2026-10-15): the composer passed attachments as a third send
 * argument the transport never read, so an attached image never reached the
 * coordinator (and never the vision model). These pin the conversion the
 * transport now performs before sending.
 */
describe('image attachments -> delivered image parts', () => {
	test('base64 encodes exactly, including buffers larger than one chunk', () => {
		expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
		const big = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 251);
		expect(Buffer.from(bytesToBase64(big), 'base64').equals(Buffer.from(big))).toBe(true);
	});

	test('images become inline image parts; text files are reported as skipped, not delivered', async () => {
		const attachments: InputAttachment[] = [
			{ kind: 'image', mediaType: 'image/png', url: 'blob:a', filename: 'mock.png', sizeBytes: 2 },
			{ kind: 'file', mediaType: 'text/csv', url: 'blob:b', filename: 'feed.csv', sizeBytes: 3 },
		];
		const read = async (url: string) => (url === 'blob:a' ? new Uint8Array([104, 105]) : new Uint8Array([1, 2, 3]));
		const result = await toDeliveredImages(attachments, read);
		expect(result.images).toEqual([{ type: 'image', data: 'aGk=', mimeType: 'image/png', filename: 'mock.png' }]);
		expect(result.skipped).toEqual(['feed.csv']);
	});

	test('no attachments sends no image parts', async () => {
		expect(await toDeliveredImages([])).toEqual({ images: [], skipped: [] });
	});
});

describe('text-file attachments -> message body blocks', () => {
	const enc = (s: string) => new TextEncoder().encode(s);
	const file = (filename: string, mediaType: 'text/csv' | 'text/plain' | 'text/markdown' | 'application/pdf', url: string): InputAttachment =>
		({ kind: 'file', mediaType, url, filename, sizeBytes: 10 });

	test('a csv is decoded into a fenced block Caddie can read; images are ignored here', async () => {
		const text = await toAttachedFileText(
			[file('feed.csv', 'text/csv', 'blob:c'), { kind: 'image', mediaType: 'image/png', url: 'blob:i', filename: 'a.png', sizeBytes: 2 }],
			async () => enc('day,feed_kg\n1,10\n'),
		);
		expect(text).toBe('[Attached file: feed.csv (text/csv)]\n```\nday,feed_kg\n1,10\n\n```');
	});

	test('a PDF is never pretended-read: it becomes an explicit could-not-read line', async () => {
		const text = await toAttachedFileText([file('rules.pdf', 'application/pdf', 'blob:p')], async () => {
			throw new Error('a PDF must not be fetched');
		});
		expect(text).toContain('[Attached file: rules.pdf (application/pdf)] Caddie could not read this file');
	});

	test('oversized text is truncated with the cut stated', async () => {
		const text = await toAttachedFileText([file('big.txt', 'text/plain', 'blob:b')], async () => enc('x'.repeat(MAX_FILE_TEXT_CHARS + 5)));
		expect(text).toContain(`only the first ${MAX_FILE_TEXT_CHARS.toLocaleString('en-US')} of ${(MAX_FILE_TEXT_CHARS + 5).toLocaleString('en-US')} characters`);
		expect(text.split('\n')[2]!.length).toBe(MAX_FILE_TEXT_CHARS);
	});

	test('content containing ``` cannot close the fence early', async () => {
		const text = await toAttachedFileText([file('notes.md', 'text/markdown', 'blob:m')], async () => enc('before\n```js\ncode\n```\nafter'));
		expect(text.split('\n')[1]).toBe('````');
		expect(text.endsWith('\n````')).toBe(true);
	});

	test("the user's bubble shows what they typed plus file names, not the dump", async () => {
		const blocks = await toAttachedFileText([file('feed.csv', 'text/csv', 'blob:c'), file('rules.pdf', 'application/pdf', 'blob:p')], async () => enc('a,b'));
		const body = `What is my FCR?\n\n${blocks}`;
		expect(stripAttachedFileText(body)).toBe('What is my FCR?');
		expect(attachedFileNames(body)).toEqual(['feed.csv', 'rules.pdf']);
		// file-only message: nothing typed
		expect(stripAttachedFileText(blocks)).toBe('');
		expect(attachedFileNames(blocks)).toEqual(['feed.csv', 'rules.pdf']);
		// ordinary text is untouched
		expect(stripAttachedFileText('just a question')).toBe('just a question');
	});
});
