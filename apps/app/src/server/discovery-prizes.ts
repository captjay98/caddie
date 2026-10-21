import type { CandidateDigest } from './candidate-inspection.ts';

/** A labelled award copied from an explicitly structured official-rules table.
 * Quantity is the number of awards, never a multiplier for the amount. */
export interface OfficialPrize {
	readonly label: string;
	readonly amount: string;
	readonly quantity: string;
	readonly eligibility: string;
}

function labelKey(label: string): string {
	return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Repeated labels cannot safely identify a single award, even if amounts agree. */
function uniqueByLabel<T extends { readonly label: string }>(rows: readonly T[]): Map<string, T> {
	const unique = new Map<string, T>();
	const duplicate = new Set<string>();
	for (const row of rows) {
		const key = labelKey(row.label);
		if (!key || duplicate.has(key)) continue;
		if (unique.has(key)) {
			unique.delete(key);
			duplicate.add(key);
		} else {
			unique.set(key, row);
		}
	}
	return unique;
}

/** Parse only labelled Markdown prize tables, not headings or nearby numbers.
 * Unknown layouts/ambiguous rows are omitted instead of assigning a reward to
 * the wrong prize. Source currency, hardware, conditions and quantities survive
 * verbatim apart from cell whitespace and one leading Markdown list marker. */
export function parseOfficialPrizes(text: string): OfficialPrize[] {
	let columns: { count: number; label: number; amount: number; quantity: number; eligibility: number } | null = null;
	const rows: OfficialPrize[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line.startsWith('|') || !line.endsWith('|')) {
			columns = null;
			continue;
		}
		const cells = line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
		// These are explicit header synonyms used by stored official rules, not
		// inferred award conditions. Canonicalize before duplicate detection.
		const keys = cells.map(cell => {
			const key = labelKey(cell);
			return key === 'qty' ? 'quantity' : key === 'eligible submissions' ? 'eligibility' : key;
		});
		if (keys.includes('prize name') && keys.includes('prize items')) {
			// Duplicate headers make column ownership ambiguous, so reject this table.
			columns = new Set(keys).size !== keys.length ? null : {
				count: cells.length,
				label: keys.indexOf('prize name'),
				amount: keys.indexOf('prize items'),
				quantity: keys.indexOf('quantity'),
				eligibility: keys.indexOf('eligibility'),
			};
			continue;
		}
		if (!columns || cells.length !== columns.count || cells.every(cell => /^:?-+:?$/.test(cell))) continue;
		const label = cells[columns.label] ?? '';
		const amount = (cells[columns.amount] ?? '').replace(/^\*\s+/, '');
		if (!label) continue;
		rows.push({
			label,
			amount,
			quantity: cells[columns.quantity] ?? '',
			eligibility: cells[columns.eligibility] ?? '',
		});
	}
	return [...uniqueByLabel(rows).values()].filter(row => row.amount.length > 0);
}

/** Correct cached amounts using exact award-label matches to official rows.
 * This is a local read-time overlay, not a new model call or an inference.
 * It also corrects wrong nonempty amounts, and never appends guessed awards. */
export function overlayOfficialPrizeAmounts(digest: CandidateDigest | null, rows: readonly OfficialPrize[]): CandidateDigest | null {
	if (!digest) return null;
	const official = uniqueByLabel(rows);
	const cached = uniqueByLabel(digest.prizes);
	let changed = false;
	const prizes = digest.prizes.map(prize => {
		const key = labelKey(prize.label);
		const source = cached.has(key) ? official.get(key) : undefined;
		if (!source?.amount.trim() || source.amount === prize.amount) return prize;
		changed = true;
		return { ...prize, amount: source.amount };
	});
	return changed ? { ...digest, prizes } : digest;
}
