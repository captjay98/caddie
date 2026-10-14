import { describe, test, expect } from "bun:test";
import { safeParse } from "valibot";
import {
	ImageInputPartSchema,
	FileInputPartSchema,
	InputAttachmentSchema,
	UserMessageInputSchema,
	ModelCapabilitySchema,
	MAX_IMAGE_BYTES,
	MAX_FILE_BYTES,
} from "@caddie/contracts";

/**
 * Stage 1 (multimodal input contract): the parts the Composer builds and the
 * send path carries must parse valid payloads and REJECT malformed ones — a
 * body-supplied field can never ride through, an oversize/unknown MIME is
 * refused, and an empty message with no attachment is not a message.
 */

describe("image input part", () => {
	test("accepts a well-formed PNG attachment", () => {
		const r = safeParse(ImageInputPartSchema, {
			kind: "image",
			mediaType: "image/png",
			url: "blob:https://app/abc",
			filename: "screenshot.png",
			sizeBytes: 1234,
		});
		expect(r.success).toBe(true);
	});

	test("rejects an unsupported image MIME", () => {
		const r = safeParse(ImageInputPartSchema, {
			kind: "image",
			mediaType: "image/tiff",
			url: "blob:x",
			filename: "x.tiff",
			sizeBytes: 10,
		});
		expect(r.success).toBe(false);
	});

	test("rejects an oversize image (over MAX_IMAGE_BYTES)", () => {
		const r = safeParse(ImageInputPartSchema, {
			kind: "image",
			mediaType: "image/jpeg",
			url: "blob:x",
			filename: "big.jpg",
			sizeBytes: MAX_IMAGE_BYTES + 1,
		});
		expect(r.success).toBe(false);
	});

	test("rejects a zero-byte image", () => {
		const r = safeParse(ImageInputPartSchema, {
			kind: "image",
			mediaType: "image/png",
			url: "blob:x",
			filename: "empty.png",
			sizeBytes: 0,
		});
		expect(r.success).toBe(false);
	});

	test("rejects an unknown extra key (no authority field rides through)", () => {
		const r = safeParse(ImageInputPartSchema, {
			kind: "image",
			mediaType: "image/png",
			url: "blob:x",
			filename: "x.png",
			sizeBytes: 10,
			actorId: "attacker",
		});
		expect(r.success).toBe(false);
	});
});

describe("file input part", () => {
	test("accepts a well-formed PDF attachment", () => {
		const r = safeParse(FileInputPartSchema, {
			kind: "file",
			mediaType: "application/pdf",
			url: "blob:https://app/doc",
			filename: "rules.pdf",
			sizeBytes: 50_000,
		});
		expect(r.success).toBe(true);
	});

	test("rejects an executable/binary MIME", () => {
		const r = safeParse(FileInputPartSchema, {
			kind: "file",
			mediaType: "application/octet-stream",
			url: "blob:x",
			filename: "x.bin",
			sizeBytes: 10,
		});
		expect(r.success).toBe(false);
	});

	test("rejects an oversize file (over MAX_FILE_BYTES)", () => {
		const r = safeParse(FileInputPartSchema, {
			kind: "file",
			mediaType: "text/plain",
			url: "blob:x",
			filename: "big.txt",
			sizeBytes: MAX_FILE_BYTES + 1,
		});
		expect(r.success).toBe(false);
	});
});

describe("input attachment variant", () => {
	test("discriminates image vs file by kind", () => {
		const img = safeParse(InputAttachmentSchema, {
			kind: "image",
			mediaType: "image/webp",
			url: "blob:x",
			filename: "a.webp",
			sizeBytes: 10,
		});
		const file = safeParse(InputAttachmentSchema, {
			kind: "file",
			mediaType: "text/markdown",
			url: "blob:x",
			filename: "a.md",
			sizeBytes: 10,
		});
		expect(img.success).toBe(true);
		expect(file.success).toBe(true);
	});

	test("rejects an unknown kind", () => {
		const r = safeParse(InputAttachmentSchema, {
			kind: "audio",
			mediaType: "audio/wav",
			url: "blob:x",
			filename: "a.wav",
			sizeBytes: 10,
		});
		expect(r.success).toBe(false);
	});
});

describe("user message input", () => {
	test("accepts text with no attachments", () => {
		const r = safeParse(UserMessageInputSchema, { text: "find me a hackathon", attachments: [] });
		expect(r.success).toBe(true);
	});

	test("accepts an attachment with empty text", () => {
		const r = safeParse(UserMessageInputSchema, {
			text: "",
			attachments: [
				{ kind: "image", mediaType: "image/png", url: "blob:x", filename: "a.png", sizeBytes: 10 },
			],
		});
		expect(r.success).toBe(true);
	});

	test("rejects an empty message with no attachments (not a message)", () => {
		const r = safeParse(UserMessageInputSchema, { text: "   ", attachments: [] });
		expect(r.success).toBe(false);
	});
});

describe("model capability", () => {
	test("a vision route declares the image modality", () => {
		const r = safeParse(ModelCapabilitySchema, {
			routeId: "nemotron-vision",
			inputModalities: ["text", "image"],
		});
		expect(r.success).toBe(true);
	});

	test("rejects an unknown modality", () => {
		const r = safeParse(ModelCapabilitySchema, {
			routeId: "x",
			inputModalities: ["text", "audio"],
		});
		expect(r.success).toBe(false);
	});
});
