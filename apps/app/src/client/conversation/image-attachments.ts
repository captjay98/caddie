import type { InputAttachment } from '@caddie/contracts';

/**
 * Flue's delivered image part (pi-ai ImageContent + optional filename):
 * `{ type: 'image', data: base64, mimeType }`. Declared locally because the
 * client must not import the server-only runtime package.
 */
export interface DeliveredImagePart {
	readonly type: 'image';
	readonly data: string;
	readonly mimeType: string;
	readonly filename?: string;
}

/** Base64 without a stack-blowing spread over large buffers. */
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Turn the composer's image attachments (object URLs) into the inline image
 * parts the coordinator receives. Only images ride this path: the coordinator
 * routes an image turn to the vision model. Text files are not delivered yet
 * and are returned in `skipped` so the caller can say so honestly instead of
 * implying Caddie read them.
 */
export async function toDeliveredImages(
	attachments: readonly InputAttachment[],
	read: (url: string) => Promise<Uint8Array> = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
): Promise<{ images: DeliveredImagePart[]; skipped: string[] }> {
	const images: DeliveredImagePart[] = [];
	const skipped: string[] = [];
	for (const attachment of attachments) {
		if (attachment.kind !== 'image') {
			skipped.push(attachment.filename || 'file');
			continue;
		}
		const data = bytesToBase64(await read(attachment.url));
		images.push({
			type: 'image',
			data,
			mimeType: attachment.mediaType,
			...(attachment.filename ? { filename: attachment.filename } : {}),
		});
	}
	return { images, skipped };
}
