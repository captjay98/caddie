#!/usr/bin/env bun
/**
 * G1 model probe (S03, submission-build-plan §4).
 *
 *   CADDIE_LIVE_AUTHORIZED=1 bun scripts/probe-models.ts
 *
 * One free `GET /v1/models?verbose=true` plus THREE short chat completions
 * against the Nebius Token Factory base URL the app uses. The owner's standing
 * live-authorization convention applies: without `CADDIE_LIVE_AUTHORIZED=1`
 * this refuses to run (BLOCKED, nonzero). `NEBIUS_API_KEY` is loaded from
 * `.dev.vars` in-process the same way `scripts/verify-packet.ts` and
 * `scripts/release-check.ts` do (parsed, never printed).
 *
 * Budget / safety (S03 G1 = < $0.01):
 *   - exactly one free listing + three chat completions (two Super-VL, one
 *     Lightning JSON on the rules system prompt), tiny `max_tokens`;
 *   - a failing probe is recorded honestly and NOT retried;
 *   - the key is never printed, a full response body is never printed; the only
 *     things printed are HTTP status, latency ms, token usage, whether a tool
 *     call came back (and its name), a yes/no per assertion, and for the JSON
 *     probe only `JSON valid: yes/no` + the claims count.
 *
 * What each probe is:
 *   1. listing   — record every `/nemotron|glm-5/i` id, its price and context.
 *   2. text      — the Nemotron 3.5 Super VL id + the real `remember` tool
 *                  schema (apps/app/src/agents/tools.ts, `RememberInput`),
 *                  `tool_choice: 'auto'`; expect HTTP 200 and a tool call.
 *   3. image     — the SAME model + the SAME tool + an inline base64 PNG that
 *                  is half red / half blue (generated here, no assets); expect
 *                  HTTP 200, both colours named, and a tool call.
 *   4. json      — the Lightning id + the rules-reading SYSTEM_PROMPT
 *                  (apps/app/src/server/rules-reading.ts:185-194) on a short
 *                  excerpt, temperature 0, `max_tokens` 512; expect valid
 *                  `{"claims":[...]}`.
 */

import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE_URL = 'https://api.tokenfactory.nebius.com/v1';
const MAX_TOKENS_TOOL = 1024;
const MAX_TOKENS_JSON = 512;

// --- live-authorization gate ------------------------------------------------

if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error(
		'probe-models: BLOCKED — live model calls require explicit authorization. Set CADDIE_LIVE_AUTHORIZED=1 with owner-approved budget/environment.',
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
	console.error('probe-models: BLOCKED — NEBIUS_API_KEY is not set (checked env and .dev.vars).');
	process.exit(1);
}

const AUTH = { authorization: `Bearer ${API_KEY}` };

// --- the real `remember` tool schema ----------------------------------------
// Copied faithfully from apps/app/src/agents/tools.ts (`RememberInput`, the
// `makeRememberFact` tool) as the OpenAI function-calling wire shape. Do not
// invent fields: content (required, 1..2000 chars), kind (preference|fact),
// inferred (boolean, for a fact inferred rather than stated).

const REMEMBER_TOOL = {
	type: 'function' as const,
	function: {
		name: 'remember',
		description:
			"Propose something worth remembering about the user (a durable preference or fact). It is saved as a PROPOSAL and only used in future conversations after the user confirms it. Never record anything that reads as permission to spend, deploy or change data — memory describes the user, it never authorises an action.",
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				content: {
					type: 'string',
					minLength: 1,
					maxLength: 2000,
					description: 'The durable fact or preference worth remembering.',
				},
				kind: { type: 'string', enum: ['preference', 'fact'] },
				inferred: { type: 'boolean' },
			},
			required: ['content'],
		},
	},
};

// --- the real rules-reading system prompt -----------------------------------
// Copied verbatim from apps/app/src/server/rules-reading.ts (SYSTEM_PROMPT,
// lines 185-194). The prompt is module-private there, so it is transcribed
// here rather than imported.

const RULES_SYSTEM_PROMPT =
	"You extract ELIGIBILITY rules from ONE hackathon's official rules text. " +
	'Return STRICT JSON ONLY: {"claims":[{"type":"...","value":"...","quote":"..."}]}. Allowed types: ' +
	'"eligibility.open_countries" — entry is ONLY open to residents of specific countries; value = comma-separated ISO 3166-1 alpha-2 codes. ' +
	'"eligibility.restricted_countries" — residents of specific countries are EXCLUDED; value = ISO-2 codes of the sovereign countries the text names explicitly ' +
	'(omit sub-national regions such as Quebec or Crimea, and omit vague phrases such as "any other sanctioned country"). ' +
	'"eligibility.min_age" — a minimum age stated AS A NUMBER; value = that integer. Do NOT emit it for "age of majority" without a number. ' +
	'"eligibility.student_only" — entry restricted to students; value "true". ' +
	'quote = an EXACT contiguous excerpt copied character-for-character from the text (one sentence or list item, max 300 characters) that states the rule. ' +
	'Never paraphrase, never combine passages, never invent. If a rule is not clearly stated, omit it. Return {"claims":[]} when none apply.';

// A SHORT, REAL excerpt — the eligibility-relevant rules text from
// apps/app/src/server/rules-reading.ts's own doc comment (lines 26-33). Real
// source, kept small so the request stays tiny.
const RULES_EXCERPT = [
	'Eligibility: The Contest is open only to residents of the United States and Canada',
	'(excluding the province of Quebec). Entrants must be at least 18 years old.',
	'Submissions from any other sanctioned country are not accepted.',
].join('\n');

// --- helpers -----------------------------------------------------------------

interface Probe {
	name: string;
	status: number | string;
	ms: number | string;
	tokens: string;
	toolCall: string;
	assertion: string;
}

const probes: Probe[] = [];

function usdFromRaw(raw: number | null): string {
	if (raw === null) return 'n/a';
	// Nebius listings are inconsistent: some show $/Mtok, some $/token. Print
	// the raw value and a per-Mtok reading (per-token when raw < 1).
	const perMtok = raw < 1 ? raw * 1_000_000 : raw;
	return `${perMtok.toLocaleString('en-US', { maximumFractionDigits: 4 })}/Mtok (raw ${raw})`;
}

function asNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
	return null;
}

function pickPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const key of path.split('.')) {
		if (cur === null || typeof cur !== 'object') return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
}

function firstNumber(obj: unknown, paths: string[]): number | null {
	for (const path of paths) {
		const n = asNumber(pickPath(obj, path));
		if (n !== null) return n;
	}
	return null;
}

interface ChatResult {
	ok: boolean;
	status: number;
	ms: number;
	body: {
		choices?: { message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown } }[];
		usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
		error?: { type?: unknown; code?: unknown };
	} | null;
	unreadable: boolean;
}

async function chat(model: string, payload: Record<string, unknown>): Promise<ChatResult> {
	const started = Date.now();
	let response: Response;
	try {
		response = await fetch(`${BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...AUTH },
			body: JSON.stringify({ model, ...payload }),
		});
	} catch (error) {
		return { ok: false, status: 0, ms: Date.now() - started, body: null, unreadable: false };
	}
	const ms = Date.now() - started;
	let body: ChatResult['body'] = null;
	let unreadable = false;
	try {
		body = (await response.json()) as ChatResult['body'];
	} catch {
		unreadable = true;
	}
	return { ok: response.ok, status: response.status, ms, body, unreadable };
}

function usageOf(result: ChatResult): string {
	const input = asNumber(result.body?.usage?.prompt_tokens);
	const output = asNumber(result.body?.usage?.completion_tokens);
	return input === null && output === null ? 'n/a' : `${input ?? '?'}/${output ?? '?'}`;
}

function toolCallNames(result: ChatResult): string[] {
	const calls = result.body?.choices?.[0]?.message?.tool_calls;
	if (!Array.isArray(calls)) return [];
	return calls
		.map((call) => asString((call as { function?: { name?: unknown } })?.function?.name))
		.filter((name): name is string => name !== null);
}

function asString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

/** All assistant text on the first choice: content (falling back to reasoning). */
function responseText(result: ChatResult): { text: string; field: 'content' | 'reasoning_content' | 'none' } {
	const message = result.body?.choices?.[0]?.message;
	const content = asString(message?.content);
	if (content !== null && content.trim() !== '') return { text: content, field: 'content' };
	const reasoning = asString(message?.reasoning_content);
	if (reasoning !== null && reasoning.trim() !== '') return { text: reasoning, field: 'reasoning_content' };
	return { text: '', field: 'none' };
}

// --- half-red / half-blue PNG, generated here -------------------------------

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = Buffer.from(type, 'ascii');
	const seeded = new Uint8Array(typeBytes.length + data.length);
	seeded.set(typeBytes, 0);
	seeded.set(data, typeBytes.length);
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(typeBytes, 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(seeded));
	return out;
}

/** An 8x8 truecolour PNG: left half red, right half blue (~few hundred bytes). */
function splitPng(): Uint8Array {
	const width = 8;
	const height = 8;
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour RGB
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	const raw = new Uint8Array(height * (1 + width * 3));
	let offset = 0;
	for (let y = 0; y < height; y++) {
		raw[offset++] = 0; // filter: none
		for (let x = 0; x < width; x++) {
			const red = x < width / 2;
			raw[offset++] = red ? 0xff : 0x00;
			raw[offset++] = 0x00;
			raw[offset++] = red ? 0x00 : 0xff;
		}
	}
	const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const idat = new Uint8Array(deflateSync(Buffer.from(raw)));
	const chunks = [signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))];
	const total = chunks.reduce((n, chunk) => n + chunk.length, 0);
	const png = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		png.set(chunk, at);
		at += chunk.length;
	}
	return png;
}

// --- 1. free model listing ---------------------------------------------------

console.log(`probe-models: G1 — base ${BASE_URL} (key loaded, not printed)`);
console.log('');

interface ListingModel {
	id: string;
	raw: unknown;
}

const listingStart = Date.now();
let listingModels: ListingModel[] = [];
let listingStatus: number | string = 0;
try {
	const response = await fetch(`${BASE_URL}/models?verbose=true`, { headers: AUTH });
	listingStatus = response.status;
	const body = (await response.json()) as { data?: unknown[] };
	if (response.ok && Array.isArray(body.data)) {
		listingModels = body.data
			.map((entry) => ({ id: asString((entry as { id?: unknown })?.id) ?? '', raw: entry }))
			.filter((model) => model.id !== '');
	}
} catch (error) {
	listingStatus = 'unreachable';
}
const listingMs = Date.now() - listingStart;

console.log(`[listing] GET /v1/models?verbose=true — status ${listingStatus}, ${listingMs} ms, ${listingModels.length} model(s)`);
if (listingModels.length === 0) {
	console.error('probe-models: FAIL — the model listing returned nothing; cannot select a model, stopping (a failure is a result).');
	process.exit(1);
}

const wanted = listingModels.filter((model) => /nemotron|glm-5/i.test(model.id));
console.log(`[listing] ids matching /nemotron|glm-5/i: ${wanted.length}`);
for (const model of wanted) {
	const input = firstNumber(model.raw, [
		'pricing.prompt',
		'pricing.input',
		'pricing.input_price',
		'pricing.inputPrice',
		'input_price',
		'inputPrice',
		'prompt_price',
		'price_in',
		'cost.input',
	]);
	const output = firstNumber(model.raw, [
		'pricing.completion',
		'pricing.output',
		'pricing.output_price',
		'pricing.outputPrice',
		'output_price',
		'outputPrice',
		'completion_price',
		'price_out',
		'cost.output',
	]);
	const context = firstNumber(model.raw, [
		'context_length',
		'context_window',
		'contextWindow',
		'max_context_length',
		'max_model_len',
		'max_input_tokens',
		'context',
		'max_tokens',
	]);
	const hasPrice = input !== null || output !== null;
	const hasContext = context !== null;
	console.log(`  - ${model.id}`);
	console.log(`      in ${usdFromRaw(input)} | out ${usdFromRaw(output)} | context ${hasContext ? context.toLocaleString('en-US') : 'n/a'}`);
	if (!hasPrice || !hasContext) {
		// Diagnostic only: key names, never values (a listing entry holds no secret).
		const keys = model.raw && typeof model.raw === 'object' ? Object.keys(model.raw as Record<string, unknown>) : [];
		console.log(`      (fields present: ${keys.join(', ') || 'none'})`);
	}
}

// --- model selection ---------------------------------------------------------

const normalize = (id: string) => id.toLowerCase().replace(/_/g, '-');
const ids = listingModels.map((model) => model.id);
const superVl =
	ids.find((id) => /nemotron/.test(normalize(id)) && /super/.test(normalize(id)) && /(^|[-.])vl/.test(normalize(id))) ??
	ids.find((id) => /nemotron/.test(normalize(id)) && /super/.test(normalize(id)) && /3[-.]?5/.test(normalize(id))) ??
	ids.find((id) => /nemotron/.test(normalize(id)) && /super/.test(normalize(id))) ??
	null;
const lightning =
	ids.find((id) => /nemotron/.test(normalize(id)) && /3[-.]?5-?lightning/.test(normalize(id))) ??
	ids.find((id) => /lightning/.test(normalize(id))) ??
	null;

console.log('');
if (superVl === null) {
	console.log('[select] Nemotron 3.5 Super VL: NOT SERVED by this listing — no Super-VL text/image probe possible.');
} else {
	console.log(`[select] Super VL model id: ${superVl}`);
}
if (lightning === null) {
	console.log('[select] Nemotron 3.5 Lightning: NOT SERVED by this listing — no JSON probe possible.');
} else {
	console.log(`[select] Lightning model id: ${lightning}`);
}
console.log('');

// --- 2. text probe: Super VL + the remember tool -----------------------------

if (superVl !== null) {
	const result = await chat(superVl, {
		messages: [
			{
				role: 'user',
				content:
					'I am a Python developer and I prefer short answers. Use the remember tool to save that as a preference.',
			},
		],
		tools: [REMEMBER_TOOL],
		tool_choice: 'auto',
		max_tokens: MAX_TOKENS_TOOL,
	});
	const names = toolCallNames(result);
	const status200 = result.ok && result.status === 200;
	const asserted = status200 && names.length > 0;
	console.log(
		`[text]  ${superVl} — status ${result.status}, ${result.ms} ms, tokens ${usageOf(result)}, tool call: ${
			names.length > 0 ? `yes (${names.join(', ')})` : 'no'
		}, assertion (200 + tool call): ${asserted ? 'PASS' : 'FAIL'}`,
	);
	if (!asserted && result.body?.error) {
		console.log(`        provider error: ${asString(result.body.error.type) ?? asString(result.body.error.code) ?? 'unknown'}`);
	}
	probes.push({
		name: 'text:super-vl',
		status: result.status,
		ms: result.ms,
		tokens: usageOf(result),
		toolCall: names.length > 0 ? names.join(',') : 'no',
		assertion: asserted ? 'PASS' : 'FAIL',
	});

	// --- 3. image probe: same model, same tool, inline PNG -------------------
	const png = splitPng();
	const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
	const image = await chat(superVl, {
		messages: [
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: "This image is split into two halves. Name the colour of the left half and the colour of the right half. Then use the remember tool to record what the test image showed.",
					},
					{ type: 'image_url', image_url: { url: dataUrl } },
				],
			},
		],
		tools: [REMEMBER_TOOL],
		tool_choice: 'auto',
		max_tokens: MAX_TOKENS_TOOL,
	});
	const imageNames = toolCallNames(image);
	const read = responseText(image);
	const sawRed = /\bred\b/i.test(read.text);
	const sawBlue = /\bblue\b/i.test(read.text);
	const imageOk = image.ok && image.status === 200;
	const imageAsserted = imageOk && sawRed && sawBlue && imageNames.length > 0;
	console.log(
		`[image] ${superVl} — status ${image.status}, ${image.ms} ms, tokens ${usageOf(image)}, colours named: red=${
			sawRed ? 'yes' : 'no'
		} blue=${sawBlue ? 'yes' : 'no'} (${read.field}), tool call: ${
			imageNames.length > 0 ? `yes (${imageNames.join(', ')})` : 'no'
		}, assertion (200 + both colours + tool call): ${imageAsserted ? 'PASS' : 'FAIL'}`,
	);
	if (!imageOk && image.body?.error) {
		console.log(`        provider error: ${asString(image.body.error.type) ?? asString(image.body.error.code) ?? 'unknown'}`);
	}
	probes.push({
		name: 'image:super-vl',
		status: image.status,
		ms: image.ms,
		tokens: usageOf(image),
		toolCall: imageNames.length > 0 ? imageNames.join(',') : 'no',
		assertion: imageAsserted ? 'PASS' : 'FAIL',
	});
} else {
	probes.push({ name: 'text:super-vl', status: 'n/a', ms: 'n/a', tokens: 'n/a', toolCall: 'n/a', assertion: 'FAIL (model not served)' });
	probes.push({ name: 'image:super-vl', status: 'n/a', ms: 'n/a', tokens: 'n/a', toolCall: 'n/a', assertion: 'FAIL (model not served)' });
}

// --- 4. JSON probe: Lightning + the rules system prompt ----------------------

if (lightning !== null) {
	// Tolerant JSON extraction, mirroring rules-reading.ts `parseClaims`.
	const parseClaims = (text: string): { count: number } | null => {
		if (!text.trim()) return null;
		const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
		const candidate = fenced ? fenced[1]! : text;
		const start = candidate.indexOf('{');
		const end = candidate.lastIndexOf('}');
		if (start === -1 || end <= start) return null;
		try {
			const parsed = JSON.parse(candidate.slice(start, end + 1)) as { claims?: unknown };
			return Array.isArray(parsed.claims) ? { count: parsed.claims.length } : null;
		} catch {
			return null;
		}
	};
	const result = await chat(lightning, {
		messages: [
			{ role: 'system', content: RULES_SYSTEM_PROMPT },
			{ role: 'user', content: `Rules text:\n"""\n${RULES_EXCERPT}\n"""` },
		],
		temperature: 0,
		max_tokens: MAX_TOKENS_JSON,
	});
	const read = responseText(result);
	const claims = result.ok && result.status === 200 ? parseClaims(read.text) : null;
	const jsonValid = claims !== null;
	console.log(
		`[json]  ${lightning} — status ${result.status}, ${result.ms} ms, tokens ${usageOf(result)}, JSON valid: ${
			jsonValid ? 'yes' : 'no'
		}${jsonValid ? `, claims: ${claims.count}` : ''}, assertion (valid {"claims":[...]}): ${jsonValid ? 'PASS' : 'FAIL'}`,
	);
	if (!result.ok && result.body?.error) {
		console.log(`        provider error: ${asString(result.body.error.type) ?? asString(result.body.error.code) ?? 'unknown'}`);
	}
	probes.push({
		name: 'json:lightning',
		status: result.status,
		ms: result.ms,
		tokens: usageOf(result),
		toolCall: 'n/a',
		assertion: jsonValid ? 'PASS' : 'FAIL',
	});
} else {
	probes.push({ name: 'json:lightning', status: 'n/a', ms: 'n/a', tokens: 'n/a', toolCall: 'n/a', assertion: 'FAIL (model not served)' });
}

// --- summary -----------------------------------------------------------------

console.log('');
console.log('probe | status | ms | tokens in/out | tool call | assertion');
for (const probe of probes) {
	console.log(
		`${probe.name.padEnd(16)} | ${String(probe.status).padEnd(6)} | ${String(probe.ms).padEnd(6)} | ${String(
			probe.tokens,
		).padEnd(12)} | ${String(probe.toolCall).padEnd(9)} | ${probe.assertion}`,
	);
}
const calls = [
	superVl !== null ? `2 Super-VL (${superVl})` : '0 Super-VL (not served)',
	lightning !== null ? `1 Lightning (${lightning})` : '0 Lightning (not served)',
].join(' + ');
console.log('');
console.log(`SPEND: under $0.01 — 1 free GET /v1/models?verbose=true + ${calls}; max_tokens ${MAX_TOKENS_TOOL}/${MAX_TOKENS_JSON}, no retries.`);
