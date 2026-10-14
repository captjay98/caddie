import * as v from 'valibot';
import {
	InputAttachmentSchema,
	type InputAttachment,
	type ImageInputPart,
	type FileInputPart,
	MAX_IMAGE_BYTES,
	MAX_FILE_BYTES,
} from '@caddie/contracts';
import { routeAcceptsImage, MODEL_ROLES } from '../agents/providers.ts';

/**
 * Stage 3 — server-side attachment ingest.
 *
 * The client Composer builds InputAttachment parts, but the SERVER is the
 * authority: a client cannot assert "this is a safe 2MB PNG" and have it
 * believed. Every attachment is RE-VALIDATED here against the same frozen
 * contract (strict Valibot: unknown MIME, oversize, zero-byte, extra key all
 * refused), then dispatched:
 *
 *   - image  → carried to the VISION model route (routeAcceptsImage), which the
 *     runtime admits because that route declares image input. A non-image route
 *     can never receive an image part (fail closed).
 *   - file   → text is EXTRACTED and fed to the model as text. Text-family
 *     MIME types (plain/markdown/csv) decode directly. PDF extraction needs a
 *     parser dependency and is HONESTLY DEFERRED to the live stage — a PDF part
 *     is accepted but returns a visible "not yet extracted" note rather than
 *     silently dropping it or pretending to read it.
 *
 * Pure + dependency-free (decoding uses the platform TextDecoder), so it is
 * unit-testable with no model, no network and no DB.
 */

/** The decoded, model-ready form of one attachment. */
export type IngestedAttachment =
	| { readonly kind: 'image'; readonly url: string; readonly mediaType: ImageInputPart['mediaType']; readonly filename: string }
	| { readonly kind: 'file-text'; readonly filename: string; readonly text: string }
	| { readonly kind: 'file-deferred'; readonly filename: string; readonly reason: string };

export interface AttachmentIngestResult {
	readonly accepted: readonly IngestedAttachment[];
	/** True when any accepted attachment is an image (→ route to the vision model). */
	readonly needsVision: boolean;
	/** The model route id to use: the vision route when an image is present. */
	readonly modelRouteId: string;
	/** Honest limitations the model MUST surface (e.g. a deferred PDF). */
	readonly notes: readonly string[];
}

export class AttachmentError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'AttachmentError';
	}
}

const MAX_ATTACHMENTS = 6;

/** Text-family MIME types we can decode WITHOUT a parser dependency. */
const DECODABLE_TEXT: ReadonlySet<string> = new Set(['text/plain', 'text/markdown', 'text/csv']);

/** Re-validate ONE attachment against the frozen contract (server authority). */
export function validateAttachment(raw: unknown): InputAttachment {
	const parsed = v.safeParse(InputAttachmentSchema, raw);
	if (!parsed.success) {
		throw new AttachmentError('invalid_attachment', 'attachment does not match the input contract (bad kind/MIME/size or extra field)');
	}
	// Defence in depth: the schema already bounds size, but re-assert the ceiling
	// against the kind so a future schema loosening cannot slip an oversize part.
	const a = parsed.output;
	const ceiling = a.kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
	if (a.sizeBytes > ceiling) {
		throw new AttachmentError('attachment_too_large', `attachment ${a.filename} exceeds the ${a.kind} size ceiling`);
	}
	return a;
}

/** Decode a text-family file's bytes to a string. Caller supplies the bytes it
 *  already fetched from the attachment url (this module never does I/O). */
export function decodeFileText(part: FileInputPart, bytes: Uint8Array): IngestedAttachment {
	if (part.mediaType === 'application/pdf') {
		return {
			kind: 'file-deferred',
			filename: part.filename,
			reason: 'PDF text extraction is not available in this build; ask the user to paste the key text, or attach a .txt/.md export.',
		};
	}
	if (!DECODABLE_TEXT.has(part.mediaType)) {
		return {
			kind: 'file-deferred',
			filename: part.filename,
			reason: `files of type ${part.mediaType} are not extracted in this build.`,
		};
	}
	const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	return { kind: 'file-text', filename: part.filename, text };
}

/**
 * Ingest a batch of attachments. `fetchBytes` is supplied by the caller to read
 * a file part's bytes from its url (so this stays pure/testable — the caller
 * owns the actual fetch). Images are NOT fetched here: their url is carried to
 * the vision model, which fetches/encodes per the provider's image protocol.
 */
export async function ingestAttachments(
	rawAttachments: readonly unknown[],
	fetchBytes: (part: FileInputPart) => Promise<Uint8Array>,
): Promise<AttachmentIngestResult> {
	if (rawAttachments.length > MAX_ATTACHMENTS) {
		throw new AttachmentError('too_many_attachments', `at most ${MAX_ATTACHMENTS} attachments per message`);
	}
	const accepted: IngestedAttachment[] = [];
	const notes: string[] = [];
	let needsVision = false;

	for (const raw of rawAttachments) {
		const part = validateAttachment(raw);
		if (part.kind === 'image') {
			needsVision = true;
			accepted.push({ kind: 'image', url: part.url, mediaType: part.mediaType, filename: part.filename });
			continue;
		}
		// file
		const bytes = await fetchBytes(part);
		const ingested = decodeFileText(part, bytes);
		accepted.push(ingested);
		if (ingested.kind === 'file-deferred') notes.push(`${ingested.filename}: ${ingested.reason}`);
	}

	const visionRoute = MODEL_ROLES.vision;
	// Fail closed: if we think we need vision but the resolved route is not
	// image-capable, that is a wiring bug — never silently send an image to a
	// text-only model (it would be dropped or error server-side).
	if (needsVision && !routeAcceptsImage(visionRoute)) {
		throw new AttachmentError('no_vision_route', 'an image was attached but no vision-capable model route is configured');
	}

	return {
		accepted,
		needsVision,
		modelRouteId: needsVision ? visionRoute : MODEL_ROLES.chat,
		notes,
	};
}
