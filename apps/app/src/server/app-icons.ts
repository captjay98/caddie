import { ICON_PALETTE, iconColor, iconLetter } from '@caddie/contracts';
import type { AppHostFile } from './app-host.ts';
import { GLYPHS, GLYPH_CANVAS, GLYPH_CAP } from './app-icon-glyphs.ts';

/**
 * Home-screen icons for published apps (plan step 2.4): the first letter or
 * digit of the app's name, white on a colour picked for the app, written as
 * PNGs when the app is published. Without them a phone shows a page
 * screenshot (iPhone) or a generic tile (Android).
 *
 * The letters come pre-drawn (app-icon-glyphs.ts, Inter Bold); this module
 * only scales them, so it needs no font engine, canvas or image library and
 * runs as-is in the Worker. Output is deterministic: the same app gets
 * byte-identical files on every publish, so uploads dedupe.
 *
 *   any       192 and 512: rounded square, transparent outside the corners
 *   maskable  512: full-bleed square, letter inside the central 80% circle
 *             (Android cuts its own shape and may crop to that circle)
 *   apple     180: full-bleed square (iOS rounds it, and would paint
 *             transparent corners black)
 */

/**
 * Eight clearly different hues, the letter rule and the colour rule now live in
 * @caddie/contracts (app-icon.ts), shared with the Projects card's tile (plan
 * 5.7); re-exported here for the renderer's callers.
 */
export { ICON_PALETTE, iconColor, iconLetter };

export type IconPurpose = 'any' | 'maskable' | 'apple';

export const ICON_FILES: readonly { path: string; size: number; purpose: IconPurpose }[] = [
	{ path: '/icon-192.png', size: 192, purpose: 'any' },
	{ path: '/icon-512.png', size: 512, purpose: 'any' },
	{ path: '/icon-maskable-512.png', size: 512, purpose: 'maskable' },
	{ path: '/apple-touch-icon.png', size: 180, purpose: 'apple' },
];

/** Capital height as a share of the icon; smaller in the maskable icon so a wide W stays in the safe circle. */
const CAP_SHARE: Record<IconPurpose, number> = { any: 0.44, maskable: 0.36, apple: 0.44 };
const CORNER_SHARE = 0.22;

export async function appIconFiles(app: { name: string; seed: string }): Promise<AppHostFile[]> {
	const letter = iconLetter(app.name);
	const color = iconColor(app.seed);
	const coverage = letter === null ? null : await glyphCoverage(letter);
	const files: AppHostFile[] = [];
	for (const { path, size, purpose } of ICON_FILES) {
		const rgba = drawIcon(size, purpose, color, letter === null ? null : { glyph: GLYPHS[letter]!, coverage: coverage! });
		files.push({ path, bytes: await encodePng(size, size, rgba), contentType: 'image/png' });
	}
	return files;
}

// --- drawing ----------------------------------------------------------------------

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
	return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** How much of pixel (x, y) the rounded square covers, anti-aliased at the corners. */
function shapeCoverage(x: number, y: number, size: number, radius: number): number {
	const cx = x + 0.5 < radius ? radius : x + 0.5 > size - radius ? size - radius : x + 0.5;
	const cy = y + 0.5 < radius ? radius : y + 0.5 > size - radius ? size - radius : y + 0.5;
	const outside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
	return outside <= -0.5 ? 1 : outside >= 0.5 ? 0 : 0.5 - outside;
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
	return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/**
 * Coverage of the letter (or, with no letter, a 2x2 grid of squares) in one
 * icon pixel: the canvas area under the pixel, box-filtered.
 */
function markSampler(size: number, purpose: IconPurpose, mark: { glyph: (typeof GLYPHS)[string]; coverage: Uint8Array } | null) {
	const scale = (CAP_SHARE[purpose] * size) / GLYPH_CAP; // icon pixels per canvas pixel
	const toCanvas = (v: number) => GLYPH_CANVAS / 2 + (v - size / 2) / scale;
	if (mark === null) {
		const box = CAP_SHARE[purpose] * size;
		const cell = box * 0.42;
		const start = (size - box) / 2;
		const cells = [start, start + box - cell];
		return (x: number, y: number) => {
			let covered = 0;
			for (const left of cells) for (const top of cells) covered += overlap(x, x + 1, left, left + cell) * overlap(y, y + 1, top, top + cell);
			return covered;
		};
	}
	const { glyph, coverage } = mark;
	return (x: number, y: number) => {
		const x0 = toCanvas(x) - glyph.x;
		const x1 = toCanvas(x + 1) - glyph.x;
		const y0 = toCanvas(y) - glyph.y;
		const y1 = toCanvas(y + 1) - glyph.y;
		if (x1 <= 0 || y1 <= 0 || x0 >= glyph.w || y0 >= glyph.h) return 0;
		let sum = 0;
		for (let gy = Math.max(0, Math.floor(y0)); gy < Math.min(glyph.h, Math.ceil(y1)); gy++) {
			const wy = overlap(y0, y1, gy, gy + 1);
			for (let gx = Math.max(0, Math.floor(x0)); gx < Math.min(glyph.w, Math.ceil(x1)); gx++) {
				sum += coverage[gy * glyph.w + gx]! * wy * overlap(x0, x1, gx, gx + 1);
			}
		}
		return sum / 255 / ((x1 - x0) * (y1 - y0));
	};
}

function drawIcon(size: number, purpose: IconPurpose, hex: string, mark: { glyph: (typeof GLYPHS)[string]; coverage: Uint8Array } | null): Uint8Array {
	const base = rgb(hex);
	const top = mix(base, [255, 255, 255], 0.1);
	const bottom = mix(base, [0, 0, 0], 0.12);
	const radius = purpose === 'any' ? size * CORNER_SHARE : 0;
	const sample = markSampler(size, purpose, mark);
	const out = new Uint8Array(size * size * 4);
	for (let y = 0; y < size; y++) {
		const row = mix(top, bottom, (y + 0.5) / size);
		for (let x = 0; x < size; x++) {
			const ink = Math.min(1, sample(x, y));
			const i = (y * size + x) * 4;
			out[i] = Math.round(row[0] + (255 - row[0]) * ink);
			out[i + 1] = Math.round(row[1] + (255 - row[1]) * ink);
			out[i + 2] = Math.round(row[2] + (255 - row[2]) * ink);
			out[i + 3] = radius > 0 ? Math.round(255 * shapeCoverage(x, y, size, radius)) : 255;
		}
	}
	return out;
}

// --- the pre-drawn letters --------------------------------------------------------------

const glyphCache = new Map<string, Promise<Uint8Array>>();

function glyphCoverage(letter: string): Promise<Uint8Array> {
	let pending = glyphCache.get(letter);
	if (!pending) {
		const packed = Uint8Array.from(atob(GLYPHS[letter]!.data), (c) => c.charCodeAt(0));
		pending = transform(packed, new DecompressionStream('deflate'));
		glyphCache.set(letter, pending);
	}
	return pending;
}

// --- PNG ------------------------------------------------------------------------------------

async function transform(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
	return new Uint8Array(await new Response(new Response(bytes).body!.pipeThrough(stream)).arrayBuffer());
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	let c = 0xffffffff;
	for (let i = 4; i < 8 + data.length; i++) c = CRC_TABLE[(c ^ out[i]!) & 0xff]! ^ (c >>> 8);
	view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
	return out;
}

/** 8-bit RGBA PNG, every row Sub-filtered (flat backgrounds turn into zeros). */
export async function encodePng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
	const stride = width * 4;
	const filtered = new Uint8Array(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		const row = y * (stride + 1);
		filtered[row] = 1;
		for (let i = 0; i < stride; i++) filtered[row + 1 + i] = (rgba[y * stride + i]! - (i >= 4 ? rgba[y * stride + i - 4]! : 0)) & 0xff;
	}
	const header = new Uint8Array(13);
	new DataView(header.buffer).setUint32(0, width);
	new DataView(header.buffer).setUint32(4, height);
	header.set([8, 6, 0, 0, 0], 8);
	const parts = [
		new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', await transform(filtered, new CompressionStream('deflate'))),
		chunk('IEND', new Uint8Array(0)),
	];
	const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		png.set(part, at);
		at += part.length;
	}
	return png;
}
