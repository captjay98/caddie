import { describe, expect, test } from 'bun:test';
import { ICON_FILES, ICON_PALETTE, appIconFiles, iconColor, iconLetter } from '../apps/app/src/server/app-icons.ts';

/**
 * Plan step 2.4: every published app gets its own home-screen icons (a letter
 * in a colour picked for the app). The PNGs are decoded here with an
 * independent reader (own CRC, own unfilter), so a broken encoder cannot
 * vouch for itself.
 */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(new Response(bytes).body!.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
}

interface Decoded {
	width: number;
	height: number;
	pixel(x: number, y: number): [number, number, number, number];
}

async function decodePng(png: Uint8Array): Promise<Decoded> {
	expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let offset = 8;
	let width = 0;
	let height = 0;
	const idat: Uint8Array[] = [];
	const types: string[] = [];
	while (offset < png.length) {
		const length = view.getUint32(offset);
		const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
		const data = png.subarray(offset + 8, offset + 8 + length);
		expect(view.getUint32(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
		types.push(type);
		if (type === 'IHDR') {
			width = view.getUint32(offset + 8);
			height = view.getUint32(offset + 12);
			expect([...data.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace
		}
		if (type === 'IDAT') idat.push(data);
		offset += 12 + length;
	}
	expect(types[0]).toBe('IHDR');
	expect(types.at(-1)).toBe('IEND');
	const joined = new Uint8Array(idat.reduce((n, part) => n + part.length, 0));
	let at = 0;
	for (const part of idat) {
		joined.set(part, at);
		at += part.length;
	}
	const raw = await inflate(joined);
	const stride = width * 4;
	expect(raw.length).toBe(height * (stride + 1));
	const pixels = new Uint8Array(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		for (let i = 0; i < stride; i++) {
			const value = raw[y * (stride + 1) + 1 + i]!;
			const a = i >= 4 ? pixels[y * stride + i - 4]! : 0;
			const b = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
			const c = i >= 4 && y > 0 ? pixels[(y - 1) * stride + i - 4]! : 0;
			let predicted = 0;
			if (filter === 1) predicted = a;
			else if (filter === 2) predicted = b;
			else if (filter === 3) predicted = (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			} else expect(filter).toBe(0);
			pixels[y * stride + i] = (value + predicted) & 0xff;
		}
	}
	return {
		width,
		height,
		pixel(x, y) {
			const i = y * stride + x * 4;
			return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
		},
	};
}

function luminance(hex: string): number {
	const channel = (i: number) => {
		const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

const isWhite = ([r, g, b, a]: [number, number, number, number]) => a === 255 && r > 235 && g > 235 && b > 235;

describe('which letter and colour an app gets', () => {
	test('the first Latin letter or digit of the name, accents removed', () => {
		expect(iconLetter('farm log')).toBe('F');
		expect(iconLetter('élan')).toBe('E');
		expect(iconLetter('  123 go')).toBe('1');
		expect(iconLetter('农场 Farm')).toBe('F');
	});

	test('no letter when the name has none, so the icon falls back to a plain mark', () => {
		expect(iconLetter('农场')).toBeNull();
		expect(iconLetter('   ')).toBeNull();
		expect(iconLetter('')).toBeNull();
	});

	test('the colour depends only on the seed, and seeds spread over the palette', () => {
		expect(iconColor('proj-1')).toBe(iconColor('proj-1'));
		const seen = new Set(Array.from({ length: 64 }, (_, i) => iconColor(`proj-${i}`)));
		expect(seen.size).toBeGreaterThanOrEqual(6);
		for (const colour of seen) expect(ICON_PALETTE as readonly string[]).toContain(colour);
	});

	test('white letters are readable on every palette colour (WCAG 4.5:1)', () => {
		for (const hex of ICON_PALETTE) expect((1.05 / (luminance(hex) + 0.05))).toBeGreaterThanOrEqual(4.5);
	});
});

describe('the icon files', async () => {
	const files = await appIconFiles({ name: 'Farm Log', seed: 'proj-farm' });
	const byPath = new Map(files.map((f) => [f.path, f]));

	test('four PNGs: 192 and 512 for any use, a maskable 512 and the 180 Apple touch icon', () => {
		expect(files.map((f) => f.path)).toEqual(ICON_FILES.map((f) => f.path));
		expect(ICON_FILES.map((f) => [f.path, f.size, f.purpose])).toEqual([
			['/icon-192.png', 192, 'any'],
			['/icon-512.png', 512, 'any'],
			['/icon-maskable-512.png', 512, 'maskable'],
			['/apple-touch-icon.png', 180, 'apple'],
		]);
		for (const file of files) expect(file.contentType).toBe('image/png');
	});

	test('each decodes at its own size', async () => {
		for (const { path, size } of ICON_FILES) {
			const png = await decodePng(byPath.get(path)!.bytes);
			expect([png.width, png.height]).toEqual([size, size]);
		}
	});

	test('the any-purpose icons have rounded, see-through corners and an opaque edge', async () => {
		for (const path of ['/icon-192.png', '/icon-512.png']) {
			const png = await decodePng(byPath.get(path)!.bytes);
			const last = png.width - 1;
			for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]] as const) expect(png.pixel(x, y)[3]).toBe(0);
			expect(png.pixel(png.width >> 1, 1)[3]).toBe(255);
			expect(png.pixel(1, png.height >> 1)[3]).toBe(255);
		}
	});

	test('the maskable and Apple icons fill the whole square (the phone cuts its own shape)', async () => {
		for (const path of ['/icon-maskable-512.png', '/apple-touch-icon.png']) {
			const png = await decodePng(byPath.get(path)!.bytes);
			const last = png.width - 1;
			for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]] as const) expect(png.pixel(x, y)[3]).toBe(255);
		}
	});

	test('the background is the app colour and the letter is drawn in white', async () => {
		const png = await decodePng(byPath.get('/icon-512.png')!.bytes);
		const hex = iconColor('proj-farm');
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
		const [pr, pg, pb] = png.pixel(256, 40); // above the letter, mid-height of the gradient's top
		for (const [got, want] of [[pr, r], [pg, g], [pb, b]] as const) expect(Math.abs(got! - want!)).toBeLessThanOrEqual(40);
		let white = 0;
		for (let y = 0; y < png.height; y += 2) for (let x = 0; x < png.width; x += 2) if (isWhite(png.pixel(x, y))) white++;
		expect(white / ((png.width / 2) * (png.height / 2))).toBeGreaterThan(0.03);
	});

	test('in the maskable icon the letter stays inside the 80% safe circle', async () => {
		for (const name of ['Farm Log', 'Wild Meadow', 'Money Map', '农场']) {
			const icon = (await appIconFiles({ name, seed: 'proj-safe' })).find((f) => f.path === '/icon-maskable-512.png')!;
			const png = await decodePng(icon.bytes);
			const radius = png.width * 0.4;
			let white = 0;
			let farthest = 0;
			for (let y = 0; y < png.height; y++) {
				for (let x = 0; x < png.width; x++) {
					if (!isWhite(png.pixel(x, y))) continue;
					white++;
					farthest = Math.max(farthest, Math.hypot(x + 0.5 - png.width / 2, y + 0.5 - png.height / 2));
				}
			}
			expect(farthest).toBeLessThan(radius);
			expect(white).toBeGreaterThan(1000);
		}
	});

	test('a name with no Latin letter still gets a mark, different from a letter icon', async () => {
		const plain = (await appIconFiles({ name: '农场', seed: 'proj-farm' }))[1]!.bytes;
		const lettered = files[1]!.bytes;
		expect(Buffer.from(plain).equals(Buffer.from(lettered))).toBe(false);
	});

	test('the same app always gets byte-identical icons (uploads dedupe across publishes)', async () => {
		const again = await appIconFiles({ name: 'Farm Log', seed: 'proj-farm' });
		for (let i = 0; i < files.length; i++) expect(Buffer.from(again[i]!.bytes).equals(Buffer.from(files[i]!.bytes))).toBe(true);
	});
});
