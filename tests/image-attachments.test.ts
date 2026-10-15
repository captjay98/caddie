import { describe, expect, test } from 'bun:test';
import type { InputAttachment } from '@caddie/contracts';
import { bytesToBase64, toDeliveredImages } from '../apps/app/src/client/conversation/image-attachments.ts';

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
