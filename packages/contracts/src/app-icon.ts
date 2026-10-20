/**
 * An app's letter and colour (plans 2.4, 5.7): the home-screen icon of a
 * published app and the tile on its Projects card use the same rule, so the
 * list looks like the apps you made. Pure and shared by the icon renderer
 * (server) and the card (client).
 */

/**
 * Eight clearly different hues (700 shades), so two apps on one home screen
 * rarely look alike; each passes WCAG 4.5:1 against the white letter.
 * indigo, sky, teal, green, amber, rose, fuchsia, slate.
 */
export const ICON_PALETTE = ['#4338ca', '#0369a1', '#0f766e', '#15803d', '#b45309', '#be123c', '#a21caf', '#334155'] as const;

/** The first Latin letter or digit in the name, accents removed; null when there is none. */
export function iconLetter(name: string): string | null {
	const plain = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
	for (const ch of plain) if (/^[A-Z0-9]$/.test(ch)) return ch;
	return null;
}

/** A palette colour chosen from the seed (the project id), so renaming the app keeps its colour. */
export function iconColor(seed: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return ICON_PALETTE[hash % ICON_PALETTE.length]!;
}
