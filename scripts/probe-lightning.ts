#!/usr/bin/env bun
/**
 * The Lightning fitness probe (owner review, 2026-10-19).
 *
 * WHY THIS EXISTS: `nemotron-3.5-lightning` was routed to `helper` and `app` on
 * 2026-10-18 from its price and context alone, and the one live call made that
 * day hit the PROBE's own 512-token cap and produced no parseable JSON. So the
 * route shipped with no passing live evidence. This probe answers, at
 * PRODUCTION settings, whether Lightning can do both jobs, and whether its
 * reasoning text leaks into `content` — which would break a caller that parses
 * the reply or shows it to a person.
 *
 * WHAT IT MIRRORS (imported from the production modules, so nothing can drift):
 *   - the rules-reading system prompt and the claim parser
 *     (`apps/app/src/server/rules-reading.ts`), its 6,000-character eligibility
 *     excerpt (`eligibilityExcerpt`), and its verbatim-quote check
 *     (`locateVerbatim`) — a claim whose quote is not in the page is dropped in
 *     production, so a paraphrasing model produces nothing usable;
 *   - the app path's request (`apps/app/src/server/app-ai.ts`): the `json` rule
 *     prepended to the system message, temperature 0.4, and
 *     `max_tokens = min(route.maxTokens, 4096)`;
 *   - the route's own `modelId` and `maxTokens` from the frozen registry,
 *     resolved by ROLE, so this tests whatever the roles currently point at.
 *
 * Seven probes in total: two rules-reading calls (the route leaving the helper
 * role, and whatever the helper role points at now) and five app calls (plain,
 * json, a bigger JSON schema, a long input, and — the owner's follow-up probe —
 * json over a long input, which is the exact shape that broke the helper role).
 *
 * `--budget-usd` (default 0.01) aborts before the first call if the worst-case
 * estimate exceeds it. Live calls require `CADDIE_LIVE_AUTHORIZED=1`; without it
 * this refuses (exit 1) and spends nothing. The key is read from the
 * environment or `.dev.vars` and never printed.
 *
 * Exit code is 0 only when every probe passes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findModelRoute, findModelRouteForRole, type ModelRoute } from '../apps/app/src/agents/providers.ts';
import {
	SYSTEM_PROMPT,
	eligibilityExcerpt,
	locateVerbatim,
	parseClaims,
} from '../apps/app/src/server/rules-reading.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
/** app-ai.ts's own cap: `Math.min(route.maxTokens, APP_AI_LIMITS.maxOutputTokens)`. */
const APP_AI_MAX_OUTPUT = 4096;

// --- live-authorization gate (same fence as scripts/probe-models.ts) --------

if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error(
		'probe-lightning: BLOCKED — live model calls require explicit authorization. ' +
			'Set CADDIE_LIVE_AUTHORIZED=1 with owner-approved budget/environment.',
	);
	process.exit(1);
}

// --- key loading (parsed, never printed) ------------------------------------

{
	const devVarsPath = join(REPO_ROOT, '.dev.vars');
	if (existsSync(devVarsPath)) {
		for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
			const match = /^([A-Z_a-z][A-Z0-9_a-z]*)=(.*)$/.exec(line);
			if (match && process.env[match[1]] === undefined && match[2].trim() !== '') {
				process.env[match[1]] = match[2];
			}
		}
	}
}

const API_KEY = process.env.NEBIUS_API_KEY?.trim() ?? '';
if (!API_KEY) {
	console.error('probe-lightning: BLOCKED — NEBIUS_API_KEY is not set (checked env and .dev.vars).');
	process.exit(1);
}

const budgetUsd = (() => {
	const i = process.argv.indexOf('--budget-usd');
	const raw = i === -1 ? '0.01' : (process.argv[i + 1] ?? '');
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : 0.01;
})();

/** `--only=b,c` runs a subset (labels: a1, a2, b, c, d, e, f). Default: all. */
const only = (() => {
	const arg = process.argv.find((a) => a.startsWith('--only='));
	return arg ? new Set(arg.slice('--only='.length).split(',').map((s) => s.trim())) : null;
})();
const want = (label: string): boolean => !only || only.has(label);

// --- a full-length rules page ------------------------------------------------

/**
 * A deterministic, SYNTHETIC page in the shape of a real Devpost rules document:
 * long enough that the eligibility excerpt is the real 6,000-character one, with
 * quotable eligibility facts scattered through it. Synthetic and generated (not
 * a copy of any event's page) so the run is reproducible; the excerpt logic it
 * feeds is production's.
 */
function fullRulesPage(): string {
	const parts: string[] = [
		'#### Synthetic Full-Length Hackathon Official Rules',
		'',
		'NO PURCHASE NECESSARY TO ENTER OR WIN. VOID WHERE PROHIBITED.',
		'',
		'##### 1. The Sponsor',
		'These rules govern the Synthetic Full-Length Hackathon (the "Hackathon"), sponsored by Example Sponsor Inc., 1 Example Plaza, Somewhere.',
		'',
		'##### 2. Dates and Timing',
		'Submission Period: October 1, 2026 at 9:00 AM Pacific Time through October 29, 2026 at 5:00 PM Pacific Time.',
		'Judging Period: October 30, 2026 through November 12, 2026. Winners announced on or about November 20, 2026.',
		'',
	];
	for (let i = 3; i <= 22; i++) {
		parts.push(
			`##### ${i}. Submission and Judging Detail ${i - 2}`,
			`Entries must be submitted through the Devpost platform during the Submission Period. Each entry is judged on ${['idea quality', 'technical execution', 'design', 'completeness', 'usefulness'][i % 5]} by a panel whose decisions are final.`,
			`A submission may be updated any number of times during the Submission Period; only the most recent version is judged. Section ${i} does not affect eligibility and is included to give this page the length of a real rules document.`,
			'',
		);
	}
	parts.push(
		'##### 23. Eligibility',
		'* Open only to residents of the United States, Canada (excluding Quebec), the United Kingdom, Germany, France, Spain, the Netherlands, Sweden, Poland, Japan, South Korea, Australia, New Zealand, India, Brazil, Mexico, Nigeria, Kenya, South Africa, Israel, and Singapore.',
		'* Entrants must be at least 18 years of age as of the start of the Submission Period. Individuals under 18 may not enter even with parental consent.',
		'* Officers, directors, and employees of the Sponsor and its subsidiaries are not eligible, nor are members of their immediate families.',
		'* Entrants residing in Iran, Cuba, North Korea, Syria, or the Crimea region are not eligible.',
		'* Residents of Argentina, Chile, Colombia, Peru, Uruguay, Ecuador, Bolivia, Paraguay, Venezuela, Guatemala, Honduras, El Salvador, Nicaragua, Costa Rica, Panama, the Dominican Republic, Jamaica, Trinidad and Tobago, and Barbados are eligible only if they can receive payment through a supported method; entrants from these countries must confirm a payment method before the Judging Period ends or their entry is disqualified.',
		'* Residents of Austria, Belgium, Switzerland, Ireland, Portugal, Italy, Norway, Denmark, Finland, Iceland, the Czech Republic, Slovakia, Hungary, Romania, Bulgaria, Croatia, Slovenia, Serbia, Estonia, Latvia, and Lithuania are eligible provided they are not employed by the Sponsor or any of its affiliates, agents, or advertising agencies, and are not involved in any way with the administration of this Hackathon.',
		'* Participation by government employees and contractors is limited to those acting in their personal capacity, and only where local law permits.',
		'* Each entrant must be the sole owner of the account used to submit, and must have the right to submit any code, design, or content included in the entry.',
		'* Teams of up to four people may enter; each team member must individually satisfy the age and residency requirements, and only the member who submits can claim a prize.',
		'* Entrants who are students must be enrolled at an accredited institution during the Submission Period, and must be able to produce proof of enrolment on request.',
		'* Entrants must not be subject to sanctions administered by the Office of Foreign Assets Control, the European Union, the United Nations, or the United Kingdom.',
		'* Employees of the Sponsor\'s parent companies, joint ventures, and any entity that has provided funding for the prize pool in excess of USD 25,000 are not eligible to enter or to receive a prize.',
		'* Entrants agree that the Sponsor may verify eligibility at any time, and that a failure to respond to a verification request within five business days is grounds for disqualification.',
		'* Residents of Quebec are expressly excluded from this Hackathon for legal reasons, and any entry submitted from Quebec is void from the outset.',
		'* Residents of countries not listed in the first bullet above are not eligible to enter, even if they are able to reach the submission form.',
		'* Entrants who have previously won a prize in any hackathon sponsored by the Sponsor within the twelve months preceding the Submission Period are not eligible for the grand prize, but may enter for the remaining prizes.',
		'* Immediate family members are defined for these purposes as spouses, domestic partners, parents, children, siblings, and the spouses or domestic partners of any of them.',
		'* An individual may enter only once, whether alone or as part of a team; duplicate entries from the same person result in the removal of every duplicate.',
		'* Entrants are responsible for ensuring that their participation does not breach any agreement with their current employer.',
		'* Where local law requires a skill test or additional documentation, the entrant must complete it before a prize can be awarded.',
		'* Entrants must provide a valid email address at registration and must keep it reachable for the duration of the Judging Period, since every prize notice and verification request is sent to that address only.',
		'* Residents of the United States must additionally confirm that they are not entering on behalf of a government entity, and must provide a mailing address in a state where this promotion is lawful.',
		'* Entrants affiliated with any organisation that has received more than USD 50,000 in sponsorship funding from the Sponsor during the current calendar year are not eligible for any prize, although they may participate for feedback.',
		'* Any entrant who is employed by a company that develops or markets a directly competing developer platform must disclose that affiliation at registration, and the Sponsor may, at its sole discretion, decline the entry.',
		'* Entrants who are unable to travel to an in-person awards event, if one is scheduled, remain eligible for all prizes and are not required to attend.',
		'* The Sponsor reserves the right to verify the identity, age, residency, and employment status of any entrant, and to require a notarised declaration where the prize value exceeds USD 5,000.',
		'* Entrants who are subject to a tax reporting obligation in their country of residence are responsible for any taxes arising from a prize, and must supply the tax forms the Sponsor requests before the prize is released.',
		'* Participation is void where prohibited by law, and the Sponsor may suspend the Hackathon in any jurisdiction where it determines that running the promotion would be unlawful.',
		'* Judges, mentors, and volunteers who have access to submissions before the Judging Period begins are not eligible to enter, and neither are members of their households.',
		'* Entrants must not use automated means to create accounts, and any entrant found to have done so is disqualified along with every entry associated with the account.',
		'* An entrant whose registration information is found to be materially false at any point, including after a prize has been awarded, forfeits the prize and must return any amount already paid.',
		'* Residents of countries where the local currency is not freely convertible may still enter, but a prize may be paid in the Sponsor\'s currency and any conversion cost is borne by the winner.',
		'',
		'##### 24. Judging Criteria',
		'Each submission is scored on originality, execution, and design. The panel may award discretionary prizes.',
		'',
		'##### 25. Prizes',
		'One grand prize of $10,000 USD, one runner-up prize of $3,000 USD, and two honorable mentions of $500 USD each.',
		'',
		'##### 26. Other Conditions',
		'By entering, each entrant agrees to these rules and to the Sponsor\'s privacy policy.',
		'',
	);
	return parts.join('\n');
}

// --- request plumbing --------------------------------------------------------

interface ChatResult {
	status: number;
	ms: number;
	body: unknown;
}

async function chat(model: string, payload: Record<string, unknown>): Promise<ChatResult> {
	const start = Date.now();
	const res = await fetch(`${BASE_URL}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
		body: JSON.stringify({ model, ...payload }),
	});
	const text = await res.text();
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text.slice(0, 400) };
	}
	return { status: res.status, ms: Date.now() - start, body };
}

function messageOf(body: unknown): Record<string, unknown> {
	const choices = (body as { choices?: { message?: Record<string, unknown>; finish_reason?: unknown }[] } | null)?.choices;
	return choices?.[0]?.message ?? {};
}

function finishReasonOf(body: unknown): string {
	const choices = (body as { choices?: { finish_reason?: unknown }[] } | null)?.choices;
	return typeof choices?.[0]?.finish_reason === 'string' ? choices[0].finish_reason : '(none)';
}

function usageOf(body: unknown): { input: number; output: number } {
	const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
	const asNum = (v: unknown) => (typeof v === 'number' ? v : 0);
	return { input: asNum(usage?.prompt_tokens), output: asNum(usage?.completion_tokens) };
}

function contentOf(body: unknown): string {
	const content = messageOf(body).content;
	return typeof content === 'string' ? content : '';
}

function reasoningOf(body: unknown): string {
	const reasoning = (messageOf(body) as { reasoning_content?: unknown; reasoning?: unknown }).reasoning_content ?? (messageOf(body) as { reasoning?: unknown }).reasoning;
	return typeof reasoning === 'string' ? reasoning : '';
}

/**
 * Does the model's own thinking appear in `content`? A reasoning model may put
 * its chain of thought in `content` (or in a separate `reasoning_content`). The
 * former breaks callers: app-ai does `JSON.parse(reply.text)` and shows
 * `reply.text` to a person. Markers are deliberately conservative and the raw
 * head is printed too, so a human can overrule the heuristic.
 */
const REASONING_MARKERS = /<think(ing)?>|<\/think(ing)?>|^\s*(okay|ok|hmm|alright|we need|we need to|i need to|let me|let's|first,|the user|thinking|analysis:|reasoning:)/i;
function contentVerdict(content: string, expectsJson: boolean): { leak: boolean; why: string } {
	const marker = REASONING_MARKERS.exec(content);
	if (marker) return { leak: true, why: `content starts with / contains reasoning prose (${JSON.stringify(marker[0].slice(0, 24))})` };
	if (expectsJson) {
		const trimmed = content.trim();
		const firstChar = trimmed[0] ?? '';
		if (firstChar !== '{' && firstChar !== '[') {
			return { leak: true, why: `content does not start with a JSON value (starts ${JSON.stringify(trimmed.slice(0, 24))})` };
		}
	}
	return { leak: false, why: 'no reasoning marked in content' };
}

function usd(route: ModelRoute, tokens: { input: number; output: number }): number {
	return (tokens.input * route.inputPriceMinorUnits + tokens.output * route.outputPriceMinorUnits) / 100 / 1_000_000;
}

function head(text: string, max = 180): string {
	return JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, max));
}

// --- the probes --------------------------------------------------------------

const helperRoute = findModelRouteForRole('helper');
const appRoute = findModelRouteForRole('app');
const lightningRoute = findModelRoute('nemotron-3.5-lightning');
const page = fullRulesPage();
const excerpt = eligibilityExcerpt(page);

interface Outcome {
	name: string;
	pass: boolean;
	lines: string[];
}

const outcomes: Outcome[] = [];
let spentUsd = 0;

function report(name: string, pass: boolean, lines: string[]): void {
	outcomes.push({ name, pass, lines });
	console.log(`\n=== ${name}: ${pass ? 'PASS' : 'FAIL'} ===`);
	for (const line of lines) console.log(`  ${line}`);
}

function rulesReadingProbe(route: ModelRoute, label: string): Promise<Outcome> {
	return chat(route.modelId, {
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: `Rules text:\n"""\n${excerpt}\n"""` },
		],
		temperature: 0,
		max_tokens: route.maxTokens,
	}).then((result) => {
		const tokens = usageOf(result.body);
		spentUsd += usd(route, tokens);
		const content = contentOf(result.body);
		const reasoning = reasoningOf(result.body);
		const claims = parseClaims(content);
		// Production drops any claim whose quote is not in the page: a
		// paraphrasing model yields claims that all evaporate.
		const verbatim = (claims ?? []).map((claim) => {
			const quote = typeof claim.quote === 'string' ? claim.quote : '';
			return { type: String(claim.type ?? '?'), located: locateVerbatim(excerpt, quote) !== null };
		});
		const located = verbatim.filter((v) => v.located).length;
		const verdict = contentVerdict(content, true);
		const pass =
			result.status === 200 &&
			claims !== null &&
			claims.length > 0 &&
			located === claims.length &&
			finishReasonOf(result.body) !== 'length' &&
			!verdict.leak;
		return {
			name: label,
			pass,
			lines: [
				`route ${route.id} (${route.modelId}), max_tokens ${route.maxTokens}, temperature 0`,
				`excerpt ${excerpt.length} chars (production's eligibilityExcerpt of a ${page.length}-char page)`,
				`HTTP ${result.status} in ${result.ms}ms; finish_reason ${finishReasonOf(result.body)}; tokens ${tokens.input}in/${tokens.output}out; ≈$${usd(route, tokens).toFixed(6)}`,
				`message keys: ${Object.keys(messageOf(result.body)).join(', ') || '(none)'}; reasoning_content ${reasoning.length} chars`,
				`parseClaims: ${claims === null ? 'NULL (production would record a gap)' : `${claims.length} claims`}`,
				`claims verbatim in the page: ${located}/${verbatim.length}${verbatim.length && located !== verbatim.length ? ` — failing: ${verbatim.filter((v) => !v.located).map((v) => v.type).join(', ')}` : ''}`,
				`reasoning in content: ${verdict.leak ? 'YES' : 'no'} — ${verdict.why}`,
				`content head: ${head(content)}`,
			],
		};
	});
}

/** One app-role call in the app path's own request shape (temperature 0.4, capped max_tokens). */
async function appCase(route: ModelRoute, label: string, messages: { role: string; content: string }[], json: boolean): Promise<Outcome> {
	const result = await chat(route.modelId, {
		messages,
		temperature: 0.4,
		max_tokens: Math.min(route.maxTokens, APP_AI_MAX_OUTPUT),
	});
	const tokens = usageOf(result.body);
	spentUsd += usd(route, tokens);
	const content = contentOf(result.body);
	const reasoning = reasoningOf(result.body);
	const verdict = contentVerdict(content, json);
	let parsedJson = false;
	let jsonNote = '';
	if (json) {
		try {
			const value = JSON.parse(content.trim()) as unknown;
			parsedJson = typeof value === 'object' && value !== null;
			jsonNote = parsedJson ? 'JSON.parse(content) succeeded and is an object' : 'parsed but not an object';
		} catch (error) {
			jsonNote = `JSON.parse(content) threw: ${error instanceof Error ? error.message : String(error)} — app-ai would return ok:false to the app`;
		}
	}
	const pass = result.status === 200 && content.trim() !== '' && finishReasonOf(result.body) !== 'length' && !verdict.leak && (!json || parsedJson);
	return {
		name: label,
		pass,
		lines: [
			`route ${route.id} (${route.modelId}), max_tokens ${Math.min(route.maxTokens, APP_AI_MAX_OUTPUT)}, temperature 0.4, json ${json}`,
			`HTTP ${result.status} in ${result.ms}ms; finish_reason ${finishReasonOf(result.body)}; tokens ${tokens.input}in/${tokens.output}out; ≈$${usd(route, tokens).toFixed(6)}`,
			`message keys: ${Object.keys(messageOf(result.body)).join(', ') || '(none)'}; reasoning_content ${reasoning.length} chars`,
			...(json ? [`${jsonNote}`] : []),
			`reasoning in content: ${verdict.leak ? 'YES' : 'no'} — ${verdict.why}`,
			`content head: ${head(content)}`,
		],
	};
}

// --- budget estimate (abort before spending) ---------------------------------

const appWorstUsd = usd(appRoute, { input: excerpt.length / 3 + 300, output: APP_AI_MAX_OUTPUT });
const worstCaseUsd =
	(want('a1') ? usd(lightningRoute, { input: excerpt.length / 3, output: lightningRoute.maxTokens }) : 0) +
	(want('a2') ? usd(helperRoute, { input: excerpt.length / 3, output: helperRoute.maxTokens }) : 0) +
	['b', 'c', 'd', 'e', 'f'].filter(want).length * appWorstUsd;
if (worstCaseUsd > budgetUsd) {
	console.error(
		`probe-lightning: BLOCKED — worst-case estimate $${worstCaseUsd.toFixed(4)} exceeds the $${budgetUsd.toFixed(4)} budget. ` +
			'Raise --budget-usd only with the owner\'s approval.',
	);
	process.exit(1);
}

console.log(`probe-lightning: ${only ? `probes ${[...only].join(',')}` : 'all 6 probes'} at production settings`);
console.log(`  helper role → ${helperRoute.id} (max_tokens ${helperRoute.maxTokens}); app role → ${appRoute.id}; leaving-the-helper-role comparison → ${lightningRoute.id}`);
console.log(`  worst-case estimate $${worstCaseUsd.toFixed(4)} (budget $${budgetUsd.toFixed(4)})`);

const jsonRule = 'Reply with one JSON object and nothing else.';
const ask = 'Give me one dinner idea I can cook in 20 minutes with lentils, rice and a lemon.';

// A1 targets the route that LEFT the helper role, by NAME, so the probe says the
// same thing before and after the revert.
if (want('a1')) {
	const o = await rulesReadingProbe(lightningRoute, `rules-reading on ${lightningRoute.id} (left the helper role)`);
	report(o.name, o.pass, o.lines);
}
if (want('a2')) {
	const o = await rulesReadingProbe(helperRoute, `rules-reading on the helper role → ${helperRoute.id}`);
	report(o.name, o.pass, o.lines);
}
if (want('b')) {
	const o = await appCase(
		appRoute,
		`plain app reply on ${appRoute.id} (app)`,
		[
			{ role: 'system', content: 'You are the assistant inside a small recipe app. Answer in at most three short sentences.' },
			{ role: 'user', content: ask },
		],
		false,
	);
	report(o.name, o.pass, o.lines);
}
if (want('c')) {
	const o = await appCase(
		appRoute,
		`json:true app reply on ${appRoute.id} (app)`,
		[
			{ role: 'system', content: `You are the assistant inside a small recipe app.\n\n${jsonRule}` },
			{ role: 'user', content: `${ask} Answer as {"title":"…","steps":["…"]}.` },
		],
		true,
	);
	report(o.name, o.pass, o.lines);
}
// The two harder app cases. The app role serves GENERATED apps whose prompts we
// do not control, so an easy prompt passing is not enough to keep the role: the
// rules-reading failure showed Lightning can dump its thinking into `content`,
// which is exactly what breaks app-ai's JSON.parse.
if (want('d')) {
	const o = await appCase(
		appRoute,
		`json:true, bigger schema and a longer system prompt on ${appRoute.id} (app)`,
		[
			{ role: 'system', content: `You are the assistant inside a personal finance app that helps people see where their money goes.\n\n${jsonRule}` },
			{
				role: 'user',
				content:
					'Categorise every transaction and total them. Return {"transactions":[{"id":"1","category":"coffee","note":"…"}],"total":8}. ' +
					'Transactions: 1) 12.40 COFFEE HAUS 2) 89.10 GREENGROCER 3) 4.20 CITYTRANSIT 4) 250.00 RENTCO 5) 16.00 PHARMACY 6) 9.99 STREAMFLIX 7) 62.30 POWERBOARD 8) 21.75 COFFEE HAUS',
			},
		],
		true,
	);
	report(o.name, o.pass, o.lines);
}
if (want('e')) {
	const o = await appCase(
		appRoute,
		`plain reply over a long input on ${appRoute.id} (app)`,
		[
			{ role: 'system', content: 'You are the assistant inside a research app. Answer in at most four sentences.' },
			{ role: 'user', content: `Summarise who may enter this hackathon:\n\n${excerpt}` },
		],
		false,
	);
	report(o.name, o.pass, o.lines);
}
// F (owner review follow-up, 2026-10-19): the LONG INPUT **and** the app path's
// `json` rule together — the combination that made the helper role unusable on
// Lightning. app-ai does `JSON.parse(reply.text)` and shows `reply.text` to a
// person, so a model that narrates its reasoning into `content` breaks the app,
// and the long input is what provoked that on the rules-reading probe (b/‘d’
// alone are easy prompts). Budget: the owner capped this single call at $0.002,
// which the worst-case estimate below is checked against before any spend.
if (want('f')) {
	const o = await appCase(
		appRoute,
		`json:true over a long input on ${appRoute.id} (app)`,
		[
			{ role: 'system', content: `You are the assistant inside a research app.\n\n${jsonRule}` },
			{
				role: 'user',
				content: `Summarise who may enter this hackathon. Answer as {"eligible":true,"who":["…"],"why":"…"}.\n\nRules text:\n\n${excerpt}`,
			},
		],
		true,
	);
	report(o.name, o.pass, o.lines);
}

// --- summary -----------------------------------------------------------------

const failed = outcomes.filter((o) => !o.pass);
console.log(`\n=== SUMMARY ===`);
console.log(`  ${outcomes.length - failed.length}/${outcomes.length} probes passed; spend ≈$${spentUsd.toFixed(6)}`);
if (failed.length > 0) {
	console.log(`  FAILED: ${failed.map((o) => o.name).join('; ')}`);
	console.log('  → a failing probe means the route is not fit for that role; revert the role and record why.');
} else {
	console.log('  → every probe passed: the roles may stay as they are.');
}
process.exit(failed.length === 0 ? 0 : 1);
