/**
 * P10 — deterministic evidence identity.
 *
 * Evidence is a READING of a snapshot, not an event (HackSteward
 * domain/evidence.py derive_evidence_id): re-reading a snapshot that has not
 * changed must land on the record already stored, so extraction can be
 * repeated — retry, re-import, a second pass — without accumulating duplicate
 * rows that all say the same thing.
 *
 * Hashing rather than concatenating: the full natural key (project + snapshot
 * + locator + quote + claim type) is far longer than an id column, and a
 * truncated concatenation would silently drop the distinguishing tail.
 *
 * The \x1f separator cannot occur inside a well-formed part, so no combination
 * of parts can re-split into a different tuple that hashes the same way;
 * caller-supplied parts have the separator neutralized before hashing.
 */

const PART_SEPARATOR = '\x1f';

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A deterministic id for an evidence record, derived entirely from its
 * natural key. Pure with respect to its inputs — no ambient identity to
 * inject, no way for a caller to make it non-reproducible.
 */
export async function deriveEvidenceId(prefix: string, ...parts: string[]): Promise<string> {
	if (!prefix.trim()) {
		throw new Error('evidence id prefix must not be blank');
	}
	const joined = parts.map((part) => part.replaceAll(PART_SEPARATOR, ' ')).join(PART_SEPARATOR);
	const digest = await sha256Hex(joined);
	return `${prefix}_${digest}`.slice(0, 64);
}
