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
const MACHINERY = /\b(find_hackathons|create_project|propose_project|start_brainstorm|hackathon_details|continue_project|update_profile|inspect_repository|list_stacks|verify_build|the research tool|the tool|tool call|function call|call the|invoke the|API call|json|schema|limit \d|maxResults|query (?:maybe|=|")|candidate ids?|the user (?:wants|asked|explicitly)|we (?:should|must|need to|could|can|will|'ll)|let's|i (?:should|'ll|will|need to) (?:call|use|invoke|search|fetch))\b/i;
/** A self-addressed deliberation stance — hedged planning language, not an answer. */
const DELIBERATION = /\b(we (?:need|should|must|could|can|will|'ll|'ve|have to)|let's|i (?:should|'ll|will|need to|can|could)|maybe|probably|perhaps|let me (?:call|think|check|use)|first,? we|then we|we'll (?:call|get|use|parse)|better to|we got|we can say|the user (?:wants|asked|explicitly|needs|said))\b/i;

/**
 * Caddie's plumbing rewritten in the owner's words. A non-technical builder is
 * told their app can use AI — not which model runs it or how deep a call is
 * (live finding, 2026-10-28: Street Food Share's replies said `tier: super` and
 * `tier: fast` in the transcript). The raw text stays readable in the reply's
 * "Original draft response" inspector; only the prose a person reads changes.
 */
const PLUMBING_PHRASES: readonly { pattern: RegExp; replace: () => string }[] = [
	{ pattern: /\btier\s*[:=]?\s*["']?super["']?/gi, replace: () => 'a deep answer' },
	{ pattern: /\btier\s*[:=]?\s*["']?fast["']?/gi, replace: () => 'a quick answer' },
	{ pattern: /\b(?:the\s+|a\s+)?super\s+tier\b/gi, replace: () => 'the deeper AI' },
	{ pattern: /\b(?:the\s+|a\s+)?fast\s+tier\b/gi, replace: () => 'the standard AI' },
	{ pattern: /\bNVIDIA\s+Nemotron(?:\s+(?:3\.5|Super|Ultra|VL|Lightning|Nano|Plus))*\b/gi, replace: () => "Caddie's AI" },
	{ pattern: /\bNemotron(?:\s+(?:3\.5|Super|Ultra|VL|Lightning|Nano|Plus))*\b/gi, replace: () => "Caddie's AI" },
	{ pattern: /\b(?:Nebius\s+)?Token\s+Factory\b/gi, replace: () => 'the platform' },
	// The service handle Caddie's own code uses. A builder reading it in a reply
	// is being shown the wiring, not told their app can use AI.
	{ pattern: /`?\bc\.env\.CADDIE\.ai\b`?/gi, replace: () => "Caddie's AI" },
	// Caddie's own document and tool names (live reply 2026-10-29: "The PRD is
	// approved… directly via write_plan_note… host-side allowance step").
	{ pattern: /\bPRDs?\b/g, replace: () => 'plan' },
	{ pattern: /`?\bwrite_plan_note\b`?/g, replace: () => 'saving' },
	{ pattern: /\bdesign brief\b/gi, replace: () => 'screen designs' },
	{ pattern: /\bhost[- ]side\s+/gi, replace: () => '' },
	{ pattern: /\bthe host's\s+/gi, replace: () => '' },
	{ pattern: /\b(?:looks |design )?payloads?\b/gi, replace: () => 'draft' },
	{ pattern: /\bscaffold(?:ed|ing)?\b/gi, replace: () => 'set up' },
	// Stack names in a card a non-technical owner reads (proposal "Build first",
	// 2026-10-29: "Scaffold the React + Bun + Hono web app … stubbed anomaly check").
	{ pattern: /\s*\bReact\s*\+\s*Bun\s*\+\s*Hono\b\s*/g, replace: () => ' ' },
	{ pattern: /\bstubbed\s+/gi, replace: () => 'first ' },
	{ pattern: /\banomaly (?:check|detection)\b/gi, replace: () => 'check for unusual days' },
	// Anything still talking about tiers talks about depth.
	{ pattern: /\btiers?\b/gi, replace: () => 'depth' },
];

function rewritePlumbing(input: string): { text: string; changed: boolean } {
	let text = input;
	let changed = false;
	for (const { pattern, replace } of PLUMBING_PHRASES) {
		const next = text.replace(pattern, replace);
		if (next !== text) changed = true;
		text = next;
	}
	return { text, changed };
}

/**
 * The plumbing words only, with nothing removed — for a stored document the
 * owner reads (a plan section, a design brief, a decision record). Those bodies
 * predate the authoring gate, and their structure must survive: a PRD's data
 * model is full of `{"type": …}` lines the reply sanitizer would delete. So
 * documents get the vocabulary swap and never the stripping.
 */
export function plainWordsForOwner(input: string): string {
	return rewritePlumbing(input).text.replace(/ {2,}/g, ' ').trim();
}

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

/** First-person narration of Caddie's internal team or workflow phases. */
const HANDOFF_STANCE = /\b(?:let me|i(?:'m| am| will|'ll)|i've|now i|next i)\b/i;
const HANDOFF_SUBJECT = /\b(?:delegat\w*|hand(?:ing)? (?:this|it) (?:off|over)|specialists?|coordinator|subagents?|the designer|product specialist|PRD|(?:planning|looks|design|build) phase)\b/i;
function isHandoffNarration(sentence: string): boolean {
	const s = sentence.trim();
	return s.length > 0 && s.length < 240 && HANDOFF_STANCE.test(s) && HANDOFF_SUBJECT.test(s);
}

/** Remove dropped sentences while keeping the remaining text's own line breaks. */
function rejoinKept(text: string, sentences: readonly string[], kept: readonly string[]): string {
	const drop = new Set(sentences.filter((sentence) => !kept.includes(sentence)));
	let out = text;
	for (const sentence of drop) out = out.replace(sentence, '');
	return out.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/[ \t]{2,}/g, ' ');
}

/**
 * A coordinator step written out as text instead of being called (live
 * finding, 2026-10-20: the model printed propose_project's arguments, twice,
 * and no card appeared). An object carrying ALL of a card-making step's
 * required inputs is never shown; any other JSON is left alone.
 */
const TOOL_ARGUMENT_SIGNATURES: readonly (readonly string[])[] = [['name', 'idea', 'brief']];

function isToolArguments(candidate: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return false;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
	const keys = new Set(Object.keys(parsed));
	return TOOL_ARGUMENT_SIGNATURES.some((signature) => signature.every((key) => keys.has(key)));
}

/** Where the JSON object starting at `start` ends (exclusive), or -1 when it does not close. */
function objectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === '\\') i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) return i + 1;
	}
	return -1;
}

function stripToolArguments(input: string): { text: string; stripped: boolean } {
	let stripped = false;
	// Fenced blocks first (```json … ```), then bare objects that start a line.
	let text = input.replace(/```[A-Za-z]*[ \t]*\n([\s\S]*?)\n?```/g, (block, body: string) => {
		if (!isToolArguments(body.trim())) return block;
		stripped = true;
		return '';
	});
	for (let at = text.indexOf('{'); at >= 0; at = text.indexOf('{', at + 1)) {
		if (at > 0 && text[at - 1] !== '\n') continue;
		const end = objectEnd(text, at);
		if (end < 0 || !isToolArguments(text.slice(at, end))) continue;
		text = text.slice(0, at) + text.slice(end);
		stripped = true;
		at -= 1;
	}
	return { text, stripped };
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
	{
		const tool = stripToolArguments(text);
		if (tool.stripped) {
			stripped.push('tool-arguments');
			text = tool.text;
		}
	}
	{
		const plumbing = rewritePlumbing(text);
		if (plumbing.changed) {
			stripped.push('plumbing-vocabulary');
			text = plumbing.text;
		}
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

	// Hand-off narration anywhere in the reply: Caddie talking about its own
	// team ("Let me delegate the designer to author the look proposals", "I'm
	// in the looks phase now", FarmLog/Poultry runs 2026-10-29). The person
	// sees the project card for that; the sentence is plumbing.
	{
		const sentences = splitSentences(text);
		const kept = sentences.filter((sentence) => !isHandoffNarration(sentence));
		if (kept.length > 0 && kept.length < sentences.length) {
			stripped.push('handoff-narration');
			text = rejoinKept(text, sentences, kept);
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
