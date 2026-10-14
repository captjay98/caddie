import { describe, test, expect } from "bun:test";
import {
	validateAttachment,
	decodeFileText,
	ingestAttachments,
	AttachmentError,
} from "../apps/app/src/server/attachments.ts";
import type { FileInputPart } from "@caddie/contracts";

/**
 * Stage 3 — server attachment ingest. The server is the authority: it
 * re-validates every attachment against the frozen contract, decodes text
 * files, routes images to the vision model, and HONESTLY defers PDF extraction
 * rather than pretending to read it.
 */

const img = {
	kind: "image" as const,
	mediaType: "image/png" as const,
	url: "blob:x",
	filename: "shot.png",
	sizeBytes: 1234,
};
const txt: FileInputPart = {
	kind: "file",
	mediaType: "text/plain",
	url: "blob:y",
	filename: "notes.txt",
	sizeBytes: 11,
};
const pdf: FileInputPart = {
	kind: "file",
	mediaType: "application/pdf",
	url: "blob:z",
	filename: "rules.pdf",
	sizeBytes: 9000,
};

const bytesOf = (s: string) => new TextEncoder().encode(s);

describe("validateAttachment (server re-validation)", () => {
	test("accepts a valid image part", () => {
		expect(validateAttachment(img).kind).toBe("image");
	});

	test("rejects an unknown MIME", () => {
		expect(() => validateAttachment({ ...img, mediaType: "image/tiff" })).toThrow(AttachmentError);
	});

	test("rejects an extra field (no authority rides through)", () => {
		expect(() => validateAttachment({ ...img, actorId: "x" })).toThrow(AttachmentError);
	});
});

describe("decodeFileText", () => {
	test("decodes a text/plain file to its text", () => {
		const r = decodeFileText(txt, bytesOf("hello world"));
		expect(r.kind).toBe("file-text");
		expect(r.kind === "file-text" && r.text).toBe("hello world");
	});

	test("decodes markdown and csv directly", () => {
		expect(decodeFileText({ ...txt, mediaType: "text/markdown" }, bytesOf("# Hi")).kind).toBe("file-text");
		expect(decodeFileText({ ...txt, mediaType: "text/csv" }, bytesOf("a,b")).kind).toBe("file-text");
	});

	test("defers a PDF honestly (not silently dropped, not faked)", () => {
		const r = decodeFileText(pdf, bytesOf("%PDF-1.7..."));
		expect(r.kind).toBe("file-deferred");
		expect(r.kind === "file-deferred" && r.reason).toContain("PDF");
	});
});

describe("ingestAttachments", () => {
	const noFetch = async (): Promise<Uint8Array> => {
		throw new Error("image parts must not be fetched for bytes");
	};

	test("an image sets needsVision and routes to the vision model", async () => {
		const r = await ingestAttachments([img], noFetch);
		expect(r.needsVision).toBe(true);
		expect(r.modelRouteId).toBe("qwen-vl");
		expect(r.accepted[0]!.kind).toBe("image");
	});

	test("a text file is decoded; no vision needed; chat route", async () => {
		const r = await ingestAttachments([txt], async () => bytesOf("plan contents"));
		expect(r.needsVision).toBe(false);
		expect(r.modelRouteId).toBe("nemotron-3-super");
		expect(r.accepted[0]!.kind).toBe("file-text");
	});

	test("a PDF produces a visible deferral note, still no fabricated text", async () => {
		const r = await ingestAttachments([pdf], async () => bytesOf("%PDF"));
		expect(r.accepted[0]!.kind).toBe("file-deferred");
		expect(r.notes.join(" ")).toContain("rules.pdf");
	});

	test("mixed image + text: vision route, both accepted", async () => {
		const r = await ingestAttachments([img, txt], async () => bytesOf("x"));
		expect(r.needsVision).toBe(true);
		expect(r.modelRouteId).toBe("qwen-vl");
		expect(r.accepted).toHaveLength(2);
	});

	test("rejects more than the attachment cap", async () => {
		const many = Array.from({ length: 7 }, () => img);
		await expect(ingestAttachments(many, noFetch)).rejects.toThrow(AttachmentError);
	});

	test("rejects an invalid attachment in the batch", async () => {
		await expect(ingestAttachments([{ ...img, mediaType: "image/tiff" }], noFetch)).rejects.toThrow(AttachmentError);
	});
});
