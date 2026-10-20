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
	'**Real integration:** the model or service the core value depends on, the exact call path, and what the judge sees it do; when that call is c.env.CADDIE.ai, name the tier it waits on ("fast" or "super" — super is the deeper one, ~3.75x cost, for the call a judge watches). "None" is allowed only with a reason the app is still real.\n' +
	'**Mocks:** every mocked thing and why it does not carry the demo; "None" when nothing is mocked.\n' +
	'**Why this wins:** the hard part and why a generic CRUD entry would lose.';

const HEADING = /^##[ \t]+Demo contract[ \t]*$/im;
const NEXT_HEADING = /^##(?!#)[ \t]+\S/gm;
const FENCE = /^(`{3,}|~{3,})/gm;

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

	// The tier is a judge-facing decision, not an implementation detail: the core
	// call a person watches must wait on the depth it needs. When the integration
	// names Caddie's AI but no tier, the planner has left the default (fast)
	// silently in force — refuse with the two-tier contract.
	if (/c\.env\.CADDIE\.ai|caddie'?s?\s+ai|nebius/i.test(integration) && !/\b(?:fast|super)\b/i.test(integration)) {
		return {
			ok: false,
			error:
				'"Real integration:" names Caddie\'s AI but no tier — say which tier that call waits on: "fast" (cheap, quick, default) or "super" (deeper reasoning, ~3.75x cost, for the core call a judge watches). ' +
				DEMO_CONTRACT_GUIDE,
		};
	}

	return {
		ok: true,
		contract: { pitch, demoPath: steps, integration, mocks, whyItWins },
	};
}
