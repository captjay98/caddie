/**
 * Plain-language compression for blocked-build reports (owner 2026-10-25:
 * "this should never show up like this — it will only confuse non technical
 * users", and "use a model to translate the technical report" — the model
 * pipeline lands server-side; until then this deterministic extractor keeps
 * every surface honest without the wall of coordinator jargon).
 *
 * Human-written details (a user stop, short pointers) pass through untouched.
 * A raw coordinator report is compressed to its first meaningful statement,
 * stripped of code identifiers; the FULL report stays available behind each
 * surface's Details / Technical-report disclosure.
 */
const STOP_SENTINEL = 'Stop requested.';

export function plainBlockingSummary(raw: string | null | undefined): string | null {
	if (!raw) return null;
	if (raw.startsWith(STOP_SENTINEL) || raw.length <= 200) return null; // caller keeps as-is
	// The coordinator reports lead with the actual blocker sentence; later
	// sentences are repair attempts and internal plumbing.
	const firstSentence = raw.split(/(?<=\.)\s+/)[0] ?? raw;
	const stripped = firstSentence
		.replace(/`[^`]*`/g, 'the blocked step')
		.replace(/\s+/g, ' ')
		.trim();
	if (!stripped) return null;
	const capped = stripped.length > 180 ? `${stripped.slice(0, 177).trimEnd()}…` : stripped;
	return `${capped} The full technical report is in Details.`;
}
