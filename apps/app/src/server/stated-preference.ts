import type { D1Database } from './auth.ts';
import { proposeMemoryFact, type MemoryFact } from './memory.ts';

/**
 * Plan 6.2: memory learns. A lasting preference the person states in a
 * message ("Always use TypeScript.", "From now on keep replies short.", "I'd
 * rather you ask first.") is offered to remember even when Caddie itself
 * didn't call `remember`. It is a PROPOSAL about the person (kept with their
 * account), traced to the run as `stated:<runId>`; nothing reaches a future
 * conversation until they confirm it (memory.ts injects confirmed facts only).
 *
 * Deliberately narrow: an instruction that starts with always/never, "from
 * now on" / "going forward", or "I prefer" / "I'd rather". Questions, passing
 * remarks ("never mind"), anything about money, effects or permission, and
 * anything carrying a link, an email address or a long number are passed
 * over: memory never authorises an action and never stores private details
 * the person didn't mean to keep.
 */

export const STATED_SOURCE_PREFIX = 'stated:';

const MAX_PER_MESSAGE = 2;
const MAX_LENGTH = 300;

const LASTING: readonly RegExp[] = [
	/^(?:(?:please|and|also|so)\s+)?(?:always|never)\b/i,
	/\b(?:from now on|going forward)\b/i,
	/^(?:(?:and|also|so)\s+)?i(?:['\u2019]d|\s+would)?\s+(?:really\s+)?(?:prefer|rather)\b/i,
];

const PASS_OVER: readonly RegExp[] = [
	/^never\s*mind\b/i,
	// Money, effects and permission are explicit decisions, never memory.
	/\b(?:spend|spending|pay|paying|payment|purchase|buy|charge|deploy|deploying|publish|merge|delete|drop|approve|approval|permission|allowed|password|secret|token|api key)\b/i,
	// Private details: links, email addresses, long numbers.
	/https?:\/\/|www\./i,
	/\S+@\S+\.\S+/,
	/\d{6,}/,
];

function sentences(text: string): string[] {
	return text
		.split(/\n+|(?<=[.!?])\s+/)
		.map((part) => part.replace(/\s+/g, ' ').trim())
		.filter(Boolean);
}

/** Up to two lasting preferences stated in the text, word for word. */
export function statedPreferences(text: unknown): string[] {
	if (typeof text !== 'string') return [];
	const found: string[] = [];
	for (const sentence of sentences(text)) {
		if (found.length >= MAX_PER_MESSAGE) break;
		if (sentence.endsWith('?') || sentence.length > MAX_LENGTH || sentence.split(' ').length < 3) continue;
		if (!LASTING.some((pattern) => pattern.test(sentence))) continue;
		if (PASS_OVER.some((pattern) => pattern.test(sentence))) continue;
		if (!found.some((seen) => sameWords(seen, sentence))) found.push(sentence);
	}
	return found;
}

function words(text: string): string {
	return text.toLowerCase().replace(/[\s.!,;:]+$/g, '').replace(/\s+/g, ' ').trim();
}

function sameWords(a: string, b: string): boolean {
	return words(a) === words(b);
}

/**
 * Propose what the person's message states as lasting preferences, once
 * each: a preference already known (in any state, including one they said
 * "Not now" to) is not offered again. Reads only `{ kind: 'user', body }`.
 */
export async function captureStatedPreferences(
	db: D1Database,
	input: { actorId: string; runId: string },
	payload: unknown,
): Promise<MemoryFact[]> {
	const message = (payload ?? {}) as { kind?: unknown; body?: unknown };
	if (message.kind !== 'user') return [];
	const stated = statedPreferences(message.body);
	if (stated.length === 0) return [];
	const known = await db
		.prepare('select "content" from "memory_facts" where "userId" = ? and "projectId" is null')
		.bind(input.actorId)
		.all();
	const knownWords = new Set(((known.results ?? []) as { content: string }[]).map((row) => words(String(row.content))));
	const proposed: MemoryFact[] = [];
	for (const content of stated) {
		if (knownWords.has(words(content))) continue;
		knownWords.add(words(content));
		proposed.push(
			await proposeMemoryFact(db, input.actorId, {
				kind: 'preference',
				content,
				sourceRunId: `${STATED_SOURCE_PREFIX}${input.runId}`,
			}),
		);
	}
	return proposed;
}

/** One memory waiting for the person's OK, as the chat offers it. */
export interface MemoryOffer {
	readonly id: string;
	readonly content: string;
}

/**
 * What the chat offers to remember (plan 6.2): the person's own proposals
 * that came from this project's chats (what they stated, `stated:<runId>`,
 * and what Caddie proposed with remember, `<runId>`) while they still wait.
 * Remembered or declined, an offer is gone. Only the person's own runs and
 * facts are read, so nobody else's ever appear.
 */
export async function memoryOffers(db: D1Database, actorId: string, projectId: string): Promise<MemoryOffer[]> {
	const rows = await db
		.prepare(
			`select f."id", f."content" from "memory_facts" f
			  where f."userId" = ? and f."status" = 'proposed'
			    and f."sourceRunId" in (
			      select r."runId" from "run_bindings" r where r."projectId" = ? and r."createdBy" = ?
			      union all
			      select ? || r."runId" from "run_bindings" r where r."projectId" = ? and r."createdBy" = ?)
			  -- Oldest first, in the order they were written. Two proposals made
			  -- in the same millisecond share a "createdAt"; rowid keeps the
			  -- chat's order stable where the random ids would not.
			  order by f."createdAt" asc, f."rowid" asc`,
		)
		.bind(actorId, projectId, actorId, STATED_SOURCE_PREFIX, projectId, actorId)
		.all();
	return ((rows.results ?? []) as { id: string; content: string }[]).map((row) => ({
		id: String(row.id),
		content: String(row.content),
	}));
}
