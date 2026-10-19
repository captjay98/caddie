import { inflateSync } from 'node:zlib';

/**
 * Decode an 8-bit RGB/RGBA, non-interlaced PNG (what Playwright screenshots
 * are) into pixels, so a spec can check what was actually drawn.
 */
export function decodePng(png: Buffer): { width: number; height: number; pixel(x: number, y: number): [number, number, number] } {
	let offset = 8;
	let width = 0;
	let height = 0;
	let channels = 4;
	const idat: Buffer[] = [];
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString('latin1', offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			if (data[8] !== 8 || data[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs');
			channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
			if (!channels) throw new Error('only RGB or RGBA PNGs');
		}
		if (type === 'IDAT') idat.push(data);
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = new Uint8Array(height * stride);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!;
		for (let i = 0; i < stride; i++) {
			const value = raw[y * (stride + 1) + 1 + i]!;
			const a = i >= channels ? out[y * stride + i - channels]! : 0;
			const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
			const c = i >= channels && y > 0 ? out[(y - 1) * stride + i - channels]! : 0;
			const p = a + b - c;
			const predicted = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c) : 0;
			out[y * stride + i] = (value + predicted) & 0xff;
		}
	}
	return {
		width,
		height,
		pixel(x, y) {
			const i = y * stride + x * channels;
			return [out[i]!, out[i + 1]!, out[i + 2]!];
		},
	};
}
