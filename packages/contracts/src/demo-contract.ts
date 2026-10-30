/**
 * The demo contract (quality gate, 2026-10-20).
 *
 * A PRD can be complete and still produce a toy: FarmLog AI's PRD named every
 * table and endpoint, but its "AI" was a local Ollama model, its prices were
 * mock data and its alerts were a rule table — nothing a judge could watch
 * work. Completeness is not the bar; a demo is.
 *
 * Every PRD must therefore carry a `## Demo contract` section before the
 * feature list. It is prose the owner sees on the review card and the host
 * checks deterministically at save time: the pitch, at least three numbered
 * demo steps, the one real integration the demo depends on, every mock, and
 * why this beats a generic CRUD entry. A PRD without it is refused before it
 * becomes a revision.
 */

export const DEMO_CONTRACT_HEADING = '## Demo contract';

/** The exact section the planner must write (used in instructions and refusals). */
export const DEMO_CONTRACT_GUIDE =
	'Before the feature block, the PRD must contain this section with these exact labels:\n' +
	'## Demo contract\n' +
	'**One-line pitch:** what a judge hears first (one sentence).\n' +
	'**Demo path (3 minutes):**\n' +
	'1. the first thing the judge does, with real input\n' +
	'2. the core value happening in front of them\n' +
	'3. the result they can see and check (at least 3 numbered steps)\n' +
	'**Real integration:** the service the core value depends on, the exact call path, and what the judge sees it do; when that call is Caddie\'s AI, say in plain words how hard it thinks — "(a deep answer)" for the call a judge watches, "(a quick answer)" for a small one. "None" is allowed only with a reason the app is still real.\n' +
	'**Mocks:** every mocked thing and why it does not carry the demo; "None" when nothing is mocked.\n' +
	'**Why this wins:** the hard part and why a generic CRUD entry would lose.\n' +
	'This section is the owner\'s own words: never a model name, provider, AI tier or price here, and never name what you avoided either ("not Ollama" still leaks) — "Caddie\'s AI" is the whole of what the owner needs to read.';

const HEADING = /^##[ \t]+Demo contract[ \t]*$/im;
const NEXT_HEADING = /^##(?!#)[ \t]+\S/gm;
const FENCE = /^(`{3,}|~{3,})/gm;
const FENCED_BLOCK = /^(`{3,}|~{3,})[\s\S]*?^\1[ \t]*$/gim;

/**
 * Words from Caddie's plumbing that must never reach prose the owner reads.
 * The owner's line is "my app can use AI"; which model runs it, how deep that
 * call is and what it costs belongs to the builder's instructions and to the
 * design's caddie-architecture block, where `ai[].tier` is machine-checked.
 */
const INTERNAL_VOCABULARY: readonly { label: string; pattern: RegExp }[] = [
	{ label: 'a model or provider name', pattern: /\b(?:nemotron|token\s?factory|ollama|openai|anthropic|gemini|claude|hugging\s?face|deepseek|llama|mistral|grok|qwen)\b/i },
	{ label: 'an AI tier or a depth setting', pattern: /\btier\b|\b\d+(?:\.\d+)?[xX]\s+cost\b/ },
];

/**
 * The first plumbing word in owner-facing prose, or null. Deterministic, so the
 * authoring gate refuses a leak at save time instead of copy-editing a revision
 * the owner already saw.
 */
export function internalVocabularyError(prose: string): string | null {
	for (const { label, pattern } of INTERNAL_VOCABULARY) {
		const hit = pattern.exec(prose);
		if (hit) return `${label} ("${hit[0].trim()}")`;
	}
	return null;
}

/** The PRD prose a person reads: every fenced machine block (features, mocks) removed. */
export function ownerProse(body: string): string {
	return body.replace(FENCED_BLOCK, '');
}

/** "Real integration:" names Caddie's AI — the depth must still be in plain words. */
const CADDIE_AI = /c\.env\.CADDIE\.ai|caddie'?s?\s+ai|platform ai/i;
const DEPTH_STATED = /\b(?:deep|quick)\b/i;

interface LabelSpec {
	key: 'pitch' | 'path' | 'integration' | 'mocks' | 'why';
	label: string;
	min: number;
}

const LABELS: readonly LabelSpec[] = [
	{ key: 'pitch', label: 'One-line pitch', min: 20 },
	{ key: 'path', label: 'Demo path', min: 0 },
	{ key: 'integration', label: 'Real integration', min: 20 },
	{ key: 'mocks', label: 'Mocks', min: 1 },
	{ key: 'why', label: 'Why this wins', min: 40 },
];

export interface DemoContract {
	pitch: string;
	demoPath: readonly string[];
	integration: string;
	mocks: string;
	whyItWins: string;
}

export type DemoContractResult =
	| { ok: true; contract: DemoContract }
	| { ok: false; error: string };

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `**One-line pitch:**`, `### Demo path (3 minutes):` and plain `Mocks -` all match. */
function labelPattern(label: string): RegExp {
	return new RegExp(
		`^[ \\t]*(?:#{1,4}[ \\t]*)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?(?:[ \\t]*\\([^\\r\\n)]*\\))?[ \\t]*[:\\-—][ \\t]*`,
		'im',
	);
}

function clean(value: string): string {
	return value
		.replace(/\*\*/g, '')
		.replace(/\r/g, '')
		.trim();
}

function oneLine(value: string): string {
	return clean(value).replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

function placeholder(value: string): boolean {
	return /\b(?:tbd|todo|to be decided|fill (?:this|it) in)\b/i.test(value) || /^\.{3,}$/.test(value);
}

/**
 * Parse and check the demo contract. Pure: no I/O, so the host gate and the
 * tests read the same rules.
 */
export function parseDemoContract(body: string): DemoContractResult {
	const heading = HEADING.exec(body);
	if (!heading) {
		return {
			ok: false,
			error: `the PRD has no "${DEMO_CONTRACT_HEADING}" section before the feature list. ${DEMO_CONTRACT_GUIDE}`,
		};
	}
	const sectionStart = heading.index + heading[0].length;
	let sectionEnd = body.length;
	for (const boundary of [NEXT_HEADING, FENCE]) {
		boundary.lastIndex = sectionStart;
		const match = boundary.exec(body);
		if (match && match.index < sectionEnd) sectionEnd = match.index;
	}
	const section = body.slice(sectionStart, sectionEnd);

	const found = LABELS.map((spec) => {
		const match = labelPattern(spec.label).exec(section);
		return { spec, match };
	});
	const missing = found.filter((entry) => !entry.match).map((entry) => entry.spec.label);
	if (missing.length > 0) {
		return {
			ok: false,
			error: `the demo contract is missing ${missing.map((label) => `"${label}:"`).join(', ')}. ${DEMO_CONTRACT_GUIDE}`,
		};
	}

	const ordered = found
		.map((entry) => ({ ...entry, start: entry.match!.index, valueStart: entry.match!.index + entry.match![0].length }))
		.sort((a, b) => a.start - b.start);
	const values = new Map<LabelSpec['key'], string>();
	for (let i = 0; i < ordered.length; i += 1) {
		const current = ordered[i]!;
		const end = i + 1 < ordered.length ? ordered[i + 1]!.start : section.length;
		values.set(current.spec.key, section.slice(current.valueStart, end));
	}

	const pitch = oneLine(values.get('pitch') ?? '');
	const integration = oneLine(values.get('integration') ?? '');
	const mocks = oneLine(values.get('mocks') ?? '');
	const whyItWins = oneLine(values.get('why') ?? '');
	const pathRaw = clean(values.get('path') ?? '');

	const short: string[] = [];
	if (pitch.length < LABELS[0]!.min) short.push('"One-line pitch:" needs a full sentence (at least 20 characters)');
	if (pathRaw.length === 0) short.push('"Demo path (3 minutes):" is empty');
	if (integration.length < LABELS[2]!.min) short.push('"Real integration:" needs the service and what the judge sees (at least 20 characters)');
	if (mocks.length < LABELS[3]!.min) short.push('"Mocks:" must name them or say "None"');
	if (whyItWins.length < LABELS[4]!.min) short.push('"Why this wins:" needs the hard part and the contrast (at least 40 characters)');
	if (short.length > 0) {
		return { ok: false, error: `the demo contract is too thin — ${short.join('; ')}. ${DEMO_CONTRACT_GUIDE}` };
	}
	for (const [label, value] of [
		['One-line pitch', pitch],
		['Real integration', integration],
		['Mocks', mocks],
		['Why this wins', whyItWins],
	] as const) {
		if (placeholder(value)) {
			return { ok: false, error: `"${label}:" still contains a placeholder. ${DEMO_CONTRACT_GUIDE}` };
		}
	}

	const steps = pathRaw
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => /^\d+[.)]\s+\S/.test(line))
		.map((line) => line.replace(/^\d+[.)]\s+/, '').trim());
	if (steps.length < 3) {
		return {
			ok: false,
			error: `the demo path needs at least 3 numbered steps (a judge must do real things, not watch a canned screen). ${DEMO_CONTRACT_GUIDE}`,
		};
	}

	if (/^(?:a\s+)?mock\b/i.test(integration)) {
		return {
			ok: false,
			error: `"Real integration:" cannot be a mock — name the service the core value depends on, or write "None" plus why the app is still real. ${DEMO_CONTRACT_GUIDE}`,
		};
	}

	// Plumbing first: a leak is the more serious refusal, and a line that names
	// both a tier and no depth must teach the planner the vocabulary rule, not
	// the depth rule.
	for (const [label, value] of [
		['One-line pitch', pitch],
		['Demo path', pathRaw],
		['Real integration', integration],
		['Mocks', mocks],
		['Why this wins', whyItWins],
	] as const) {
		const leak = internalVocabularyError(value);
		if (leak) {
			return {
				ok: false,
				error:
					`"${label}:" carries ${leak} — this section is the owner's own words, so drop it and say "Caddie's AI" instead (do not name what you avoided either). ` +
					DEMO_CONTRACT_GUIDE,
			};
		}
	}

	// How hard the core call thinks is a demo decision — a judge waits or does
	// not. It must be stated, but in the owner's words: the builder turns "a deep
	// answer" into the deeper AI, and the machine-checked tier lives in the
	// design's caddie-architecture block. (HerdVoice's PRD carried `tier:"super"`
	// 18 times into a non-technical owner's review card, 2026-10-28.)
	if (CADDIE_AI.test(integration) && !DEPTH_STATED.test(integration)) {
		return {
			ok: false,
			error:
				'"Real integration:" names Caddie\'s AI without saying how hard that call thinks — write "(a deep answer)" for the call a judge watches, or "(a quick answer)" for a small one. Never a tier, model or provider name here; the owner\'s line is that the app can use AI. ' +
				DEMO_CONTRACT_GUIDE,
		};
	}

	return {
		ok: true,
		contract: { pitch, demoPath: steps, integration, mocks, whyItWins },
	};
}
