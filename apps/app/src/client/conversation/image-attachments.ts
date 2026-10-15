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

/** Text-family types decoded in the browser; mirrors server/attachments.ts DECODABLE_TEXT. */
const DECODABLE_TEXT: ReadonlySet<string> = new Set(['text/plain', 'text/markdown', 'text/csv']);

/** Per-file cap on characters sent to the model (a 20 MB csv must not become one prompt). */
export const MAX_FILE_TEXT_CHARS = 60_000;

/** Opening marker of an attached-file block; the chat view strips these blocks
 *  from the user's own bubble (the file chip shows the attachment instead). */
export const ATTACHED_FILE_MARKER = '[Attached file:';

/**
 * Turn the composer's text-file attachments into a block appended to the
 * message body, so Caddie actually reads them: decoded text inside a fence,
 * truncated past {@link MAX_FILE_TEXT_CHARS} with the cut stated. A PDF is NOT
 * extracted in this build; it becomes an explicit "could not read" line so
 * Caddie asks for pasted text instead of pretending it read the file.
 */
export async function toAttachedFileText(
	attachments: readonly InputAttachment[],
	read: (url: string) => Promise<Uint8Array> = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
): Promise<string> {
	const blocks: string[] = [];
	for (const attachment of attachments) {
		if (attachment.kind !== 'file') continue;
		const name = attachment.filename || 'file';
		if (!DECODABLE_TEXT.has(attachment.mediaType)) {
			blocks.push(`${ATTACHED_FILE_MARKER} ${name} (${attachment.mediaType})] Caddie could not read this file: its text is not extracted in this build. Ask the user to paste the key text or attach a .txt/.md export.`);
			continue;
		}
		const decoded = new TextDecoder('utf-8', { fatal: false }).decode(await read(attachment.url));
		const truncated = decoded.length > MAX_FILE_TEXT_CHARS;
		const body = truncated ? decoded.slice(0, MAX_FILE_TEXT_CHARS) : decoded;
		// A fence longer than any backtick run in the content cannot be closed early.
		const longestRun = Math.max(2, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length));
		const fence = '`'.repeat(longestRun + 1);
		const note = truncated
			? ` (only the first ${MAX_FILE_TEXT_CHARS.toLocaleString('en-US')} of ${decoded.length.toLocaleString('en-US')} characters are included)`
			: '';
		blocks.push(`${ATTACHED_FILE_MARKER} ${name} (${attachment.mediaType})]${note}\n${fence}\n${body}\n${fence}`);
	}
	return blocks.join('\n\n');
}

/** The text the user typed, without appended attached-file blocks (for their own bubble). */
export function stripAttachedFileText(text: string): string {
	// A file-only message starts with a block: nothing was typed.
	if (text.startsWith(ATTACHED_FILE_MARKER)) return '';
	const at = text.indexOf(`\n\n${ATTACHED_FILE_MARKER}`);
	return at >= 0 ? text.slice(0, at) : text;
}

/** File names of the attached-file blocks in a message body, in order. */
export function attachedFileNames(text: string): string[] {
	const names: string[] = [];
	const pattern = /(?:^|\n\n)\[Attached file: (.+?) \((?:text|application)\/[\w.+-]+\)\]/g;
	for (const match of text.matchAll(pattern)) names.push(match[1]!);
	return names;
}
