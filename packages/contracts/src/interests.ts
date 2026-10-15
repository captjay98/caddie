/**
 * Profile interests shared by the client picker and the server.
 *
 * "Open to anything" is a REAL answer (the user chose breadth), not the same
 * as skipping the question. It is stored in `freeTextInterests` like any other
 * pick so Caddie and the fit model can read it, but it must never become a
 * search term: interests are matched as whole phrases against event text and
 * fed to the Tavily queries, where "open to anything" would only add noise.
 */
export const OPEN_TO_ANYTHING_INTEREST = 'Open to anything';

const isMarker = (item: string): boolean => item.trim().toLowerCase() === OPEN_TO_ANYTHING_INTEREST.toLowerCase();

/** True when the stored interests say "open to anything". */
export function isOpenToAnything(interests: readonly string[]): boolean {
	return interests.some(isMarker);
}

/**
 * The search / matching terms an interest list stands for: the marker is
 * dropped, and a compound pick is split into its parts ("AI & agents" →
 * "AI", "agents"; "AR / VR" → "AR", "VR"), because discovery matches each
 * term as a whole phrase against event text and "AI & agents" never appears
 * there verbatim. Order-preserving and de-duplicated (case-insensitive).
 */
export function searchableInterests(interests: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of interests) {
		if (isMarker(item)) continue;
		for (const part of item.split(/\s*(?:&|\/|,|\band\b)\s*/i)) {
			const term = part.trim();
			const key = term.toLowerCase();
			if (term.length < 2 || seen.has(key)) continue;
			seen.add(key);
			out.push(term);
		}
	}
	return out;
}
