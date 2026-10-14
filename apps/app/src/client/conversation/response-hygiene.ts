/**
 * Assistant-text response hygiene (R04, plan §Caddie "Streaming must never
 * show svg, serialization fragments, reasoning tags or empty placeholder
 * chains").
 *
 * The Channel already routes by PART TYPE (reasoning parts never render, tool
 * parts cluster, data-cards schema-validate). This guards the remaining hole:
 * leakage that arrives INSIDE a `text` part's content — a model that emits a
 * `<think>…</think>` block, a raw `<svg …>` dump, a dangling JSON
 * serialization fragment, or an empty placeholder chain as plain text. Those
 * are not caught by part-type routing, so they must be stripped at the
 * presentation boundary before Markdown renders.
 *
 * Pure and dependency-free so it is unit-testable without a model, and so the
 * dry-run eval harness can assert the same rule the UI enforces.
 */

/** Tags whose ENTIRE content is model-internal and must never reach the user. */
const INTERNAL_TAG = /<(think|thinking|reasoning|scratchpad|antml:thinking)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** An UNCLOSED internal tag at the tail of a streaming chunk (strip to end). */
const INTERNAL_TAG_OPEN = /<(think|thinking|reasoning|scratchpad)\b[^>]*>[\s\S]*$/i;
/** Raw SVG dumped into prose (a serialized icon, not an intended code block). */
const RAW_SVG = /<svg\b[^>]*>[\s\S]*?<\/svg>|<svg\b[^>]*\/>/gi;
/** A lone serialization fragment line, e.g. a dangling `{"type":"text",…}` or
 *  a bare tool-envelope the model echoed as prose. Conservative: only a line
 *  that is ENTIRELY such a fragment. */
const SERIALIZATION_LINE = /^\s*[{[]"(?:type|role|toolName|part|reasoning)"\s*:[\s\S]*[}\]]\s*$/;
/** Empty placeholder chains: runs of whitespace, bullets or dashes with no words. */
const EMPTY_PLACEHOLDER = /^[\s•\-–—*·]+$/;

/**
 * UNTAGGED planning leakage — the live-observed failure (2026-10-12): a
 * reasoning model emitted its scratchpad as PLAIN PROSE with no `<think>`
 * wrapper, e.g. "We need to find all open hackathons on Devpost… We should
 * call find_hackathons with query maybe empty? … Let's call find_hackathons
 * with limit 20." The tag/serialization filters cannot catch it because there
 * is no delimiter.
 *
 * It is detected per SENTENCE and stripped ONLY from the leading run of the
 * text, so a real answer that happens to say "we need to" lower down is never
 * touched — the leak is always a prefix the model emits before its real reply.
 * A sentence is planning-leak when it is first-person deliberation ABOUT THE
 * MACHINERY: it talks about calling/invoking a tool, or it is visibly a
 * self-addressed plan ("We should…", "Let's…", "I'll call…", "maybe…",
 * "probably…"). The two signals must co-occur (a planning stance AND a
 * tool/deliberation reference) so ordinary prose using "we" survives.
 */
/** Internal tool ids / machinery words whose mention in a planning sentence marks it as scratchpad. */
const MACHINERY = /\b(find_hackathons|create_project|continue_project|update_profile|inspect_repository|list_stacks|verify_build|the research tool|the tool|tool call|function call|call the|invoke the|API call|json|schema|limit \d|maxResults|query (?:maybe|=|")|candidate ids?|the user (?:wants|asked|explicitly)|we (?:should|must|need to|could|can|will|'ll)|let's|i (?:should|'ll|will|need to) (?:call|use|invoke|search|fetch))\b/i;
/** A self-addressed deliberation stance — hedged planning language, not an answer. */
const DELIBERATION = /\b(we (?:need|should|must|could|can|will|'ll|'ve|have to)|let's|i (?:should|'ll|will|need to|can|could)|maybe|probably|perhaps|let me (?:call|think|check|use)|first,? we|then we|we'll (?:call|get|use|parse)|better to|we got|we can say|the user (?:wants|asked|explicitly|needs|said))\b/i;

/** Split into sentences conservatively (keep delimiters attached). */
function splitSentences(block: string): string[] {
	// Split on sentence-ending punctuation followed by whitespace, OR newlines.
	return block.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.length > 0);
}

/** Is this one sentence model planning-scratchpad (deliberation + machinery)? */
function isPlanningLeak(sentence: string): boolean {
	const s = sentence.trim();
	if (s.length === 0) return false;
	// Must look like self-addressed deliberation AND reference the machinery /
	// the user-as-third-party. Both signals required → ordinary prose survives.
	return DELIBERATION.test(s) && MACHINERY.test(s);
}

export interface SanitizeResult {
	/** The cleaned text (may be empty — render NOTHING, not a placeholder). */
	text: string;
	/** True when something was stripped (useful for the eval rubric). */
	changed: boolean;
	/** Which categories were stripped (for diagnostics / eval reporting). */
	stripped: string[];
}

/**
 * Strip model-internal leakage from a text part's content. Returns the cleaned
 * text plus what was removed. An all-stripped result yields an empty string so
 * the caller renders nothing.
 */
export function sanitizeAssistantText(input: string): SanitizeResult {
	const stripped: string[] = [];
	let text = input;

	if (INTERNAL_TAG.test(text)) {
		stripped.push('reasoning-tag');
		text = text.replace(INTERNAL_TAG, '');
	}
	if (INTERNAL_TAG_OPEN.test(text)) {
		stripped.push('reasoning-tag-open');
		text = text.replace(INTERNAL_TAG_OPEN, '');
	}
	if (RAW_SVG.test(text)) {
		stripped.push('raw-svg');
		text = text.replace(RAW_SVG, '');
	}

	// Untagged planning leakage: strip the LEADING run of scratchpad sentences
	// only. Walk sentences from the start; drop each that is a planning leak;
	// stop at the first sentence that is a real answer. Never touches the body.
	{
		const sentences = splitSentences(text);
		let cut = 0;
		while (cut < sentences.length && isPlanningLeak(sentences[cut]!)) cut += 1;
		// Guard: never strip EVERYTHING on this rule alone — if every sentence
		// "looks like" planning, the heuristic is probably wrong, so keep the
		// text and let the other filters/empty check decide.
		if (cut > 0 && cut < sentences.length) {
			stripped.push('planning-leak');
			text = sentences.slice(cut).join(' ').trim();
		}
	}

	// Line-level filters: drop entire serialization-fragment lines and empty
	// placeholder lines, then collapse the resulting blank runs.
	const lines = text.split('\n');
	const kept: string[] = [];
	let droppedSerialization = false;
	for (const line of lines) {
		if (SERIALIZATION_LINE.test(line)) {
			droppedSerialization = true;
			continue;
		}
		kept.push(line);
	}
	if (droppedSerialization) stripped.push('serialization-fragment');
	text = kept.join('\n');

	// Collapse 3+ blank lines to a single blank; trim ends.
	text = text.replace(/\n{3,}/g, '\n\n').trim();

	// If what remains is only an empty placeholder chain, it is nothing.
	if (text && EMPTY_PLACEHOLDER.test(text)) {
		stripped.push('empty-placeholder');
		text = '';
	}

	return { text, changed: stripped.length > 0, stripped };
}

/** Convenience: the cleaned text only (empty string → caller renders nothing). */
export function cleanAssistantText(input: string): string {
	return sanitizeAssistantText(input).text;
}
