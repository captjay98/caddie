/**
 * Country code → human display. The Discover eligibility chip and onboarding
 * both resolve a stored ISO alpha-2 code (e.g. "NG") to a readable name
 * ("Nigeria") and a flag emoji, so the UI never shows the raw code as if it
 * were debug output. Pure, no I/O.
 */

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** The display name for an ISO alpha-2 code, or the code itself if unknown. */
export function countryName(code: string | null | undefined): string | null {
	if (!code) return null;
	const upper = code.trim().toUpperCase();
	if (upper.length !== 2) return code;
	try {
		return regionNames.of(upper) ?? code;
	} catch {
		return code;
	}
}

/** The flag emoji for an ISO alpha-2 code (regional-indicator letters). */
export function countryFlag(code: string | null | undefined): string {
	if (!code) return '';
	const upper = code.trim().toUpperCase();
	if (upper.length !== 2 || !/^[A-Z]{2}$/.test(upper)) return '';
	const base = 0x1f1e6; // regional indicator 'A'
	return String.fromCodePoint(
		base + (upper.charCodeAt(0) - 65),
		base + (upper.charCodeAt(1) - 65),
	);
}
