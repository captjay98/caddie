import { OPEN_TO_ANYTHING_INTEREST } from '@caddie/contracts';

/**
 * The topics the interest picker offers, so a nontechnical builder can PICK
 * rather than type. `POPULAR` shows by default (short on mobile); `TOPIC_GROUPS`
 * opens with "Show all topics" or as soon as the user searches. Labels are
 * stored verbatim in the profile; discovery splits compound labels into
 * matchable terms (see searchableInterests in @caddie/contracts).
 */
export const POPULAR_TOPICS: readonly string[] = [
	'AI & agents', 'Education', 'Health', 'Climate & energy', 'Finance', 'Developer tools',
	'Games', 'Accessibility', 'Social impact', 'Creative tools', 'Productivity', 'Web3',
];

export const TOPIC_GROUPS: readonly { readonly label: string; readonly topics: readonly string[] }[] = [
	{ label: 'Tech', topics: ['Web apps', 'Mobile apps', 'Data & analytics', 'Security & privacy', 'AR / VR', 'Hardware & IoT', 'Robotics', 'Cloud & DevOps', 'Open source'] },
	{ label: 'People & society', topics: ['Civic tech', 'Community', 'Nonprofits', 'Jobs & careers', 'Mental health', 'Fitness & wellness'] },
	{ label: 'Industries', topics: ['E-commerce', 'Agriculture', 'Food', 'Travel', 'Transport', 'Legal', 'Media & news', 'Music & audio', 'Art & design', 'Sports', 'Fashion'] },
	{ label: 'Planet', topics: ['Sustainability', 'Water', 'Disaster response'] },
];

export const MAX_INTERESTS = 12;
export const MAX_INTEREST_LENGTH = 60;
export { OPEN_TO_ANYTHING_INTEREST };

const ALL_TOPICS: readonly string[] = [...POPULAR_TOPICS, ...TOPIC_GROUPS.flatMap((g) => g.topics)];
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const isMarker = (item: string): boolean => same(item, OPEN_TO_ANYTHING_INTEREST);

/**
 * Toggle one pick. "Open to anything" is exclusive: choosing it replaces every
 * other pick, and choosing any topic while it is set replaces the marker (no
 * dead, disabled state). A new pick past the cap is ignored.
 */
export function toggleInterest(selected: readonly string[], item: string, max = MAX_INTERESTS): string[] {
	if (selected.some((s) => same(s, item))) return selected.filter((s) => !same(s, item));
	if (isMarker(item)) return [OPEN_TO_ANYTHING_INTEREST];
	const base = selected.filter((s) => !isMarker(s));
	if (base.length >= max) return [...selected];
	return [...base, item];
}

/** Add a typed interest (trimmed, capped) — same exclusivity and cap as a toggle; duplicates are a no-op. */
export function addCustomInterest(selected: readonly string[], raw: string, max = MAX_INTERESTS): string[] {
	const item = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_INTEREST_LENGTH);
	if (!item || selected.some((s) => same(s, item))) return [...selected];
	return toggleInterest(selected, item, max);
}

/** Topics matching a search query (case-insensitive substring), grouped; popular first. */
export function matchTopics(query: string): { label: string | null; topics: string[] }[] {
	const q = query.trim().toLowerCase();
	const keep = (list: readonly string[]) => (q ? list.filter((t) => t.toLowerCase().includes(q)) : [...list]);
	return [
		{ label: null, topics: keep(POPULAR_TOPICS) },
		...TOPIC_GROUPS.map((g) => ({ label: g.label, topics: keep(g.topics) })),
	].filter((g) => g.topics.length > 0);
}

/** Picks that are not catalog topics (typed by the user), in pick order. */
export function customPicks(selected: readonly string[]): string[] {
	return selected.filter((s) => !isMarker(s) && !ALL_TOPICS.some((t) => same(t, s)));
}

/** Whether "+ Add …" should be offered for this query: non-empty, not a catalog topic, not already picked. */
export function canAddCustom(query: string, selected: readonly string[]): boolean {
	const q = query.trim();
	return q.length > 0 && !isMarker(q) && !ALL_TOPICS.some((t) => same(t, q)) && !selected.some((s) => same(s, q));
}
