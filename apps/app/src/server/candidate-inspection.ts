import { findModelRouteForRole } from '../agents/providers.ts';
import { DIGEST_CALL_TIMEOUT_MS, MODEL_CALL_TIMEOUT_MS, timeoutSignal } from './http-timeouts.ts';

/**
 * AI inspection of discovery candidates (feature: "real AI inspection of every
 * hackathon"). Stage 1 broadened the FEED; this stage asks a model to actually
 * READ each candidate against the user's profile and return a fit verdict, a
 * one-line human reason, and a confidence — so ranking rests on judgement, not
 * only on keyword/prize/company heuristics.
 *
 * DESIGN:
 *   - ONE batched call scores every candidate (bounded N) — not N calls — to
 *     keep cost and latency small. Uses the `helper` model route (the 3.5 cheap
 *     tier, nemotron-3.5-lightning as of 2026-10-18: cheap, generous token cap)
 *     via the Nebius OpenAI-compatible /chat/completions endpoint.
 *   - FAIL-SOFT, never load-bearing: no key, a failed request, or an
 *     unparseable reply all return an EMPTY result (plus an `error` reason for
 *     the caller to surface as a visible gap). Discovery still ranks by its
 *     existing heuristics — AI inspection ADDS a signal, it never gates the
 *     feed. This module NEVER throws.
 *
 * HONESTY (mirrors the discovery contract):
 *   - a candidate the model does not score, or scores with too thin evidence,
 *     is 'unknown' — never a fabricated verdict;
 *   - the reason is the MODEL's words bounded to one short line; an empty or
 *     missing reason degrades to '' (the card shows nothing, not a guess);
 *   - the AI verdict is a FIT signal only — it never decides eligibility
 *     (which stays the rule-based engine) and never invents a prize/date.
 *
 * The key is read by the CALLER (from env) and passed in — this module never
 * reaches into env, keeping it fully unit-testable with a stubbed `fetch`.
 */

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

/** The AI fit verdict. 'unknown' is the honest default — never a guess. */
export type AiFitVerdict = 'strong' | 'possible' | 'weak' | 'unknown';

const VERDICTS: readonly AiFitVerdict[] = ['strong', 'possible', 'weak', 'unknown'];

/** One candidate's AI inspection outcome. */
export interface AiFitInspection {
	readonly verdict: AiFitVerdict;
	/** The model's one-line, user-facing reason (bounded). '' when none. */
	readonly reason: string;
	/** Model self-reported confidence 0..1, or null when not given. */
	readonly confidence: number | null;
}

/** The minimal candidate shape the inspector reads (a subset of CandidateRecord). */
export interface InspectableCandidate {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly summary: string;
}

/** The profile facts that make a fit judgement meaningful. All optional. */
export interface InspectionProfile {
	readonly country?: string | null;
	readonly experienceLevel?: string | null;
	readonly formatPreference?: string | null;
	readonly interests?: readonly string[];
	readonly skills?: readonly string[];
	readonly stack?: readonly string[];
	readonly weeklyHours?: number | null;
	readonly projectHighlight?: string | null;
}

export interface InspectCandidatesInput {
	readonly apiKey?: string;
	readonly profile: InspectionProfile;
	readonly candidates: readonly InspectableCandidate[];
}

export interface InspectCandidatesResult {
	/** candidate id -> inspection. A candidate absent from the map was not scored. */
	readonly byId: ReadonlyMap<string, AiFitInspection>;
	/** A visible gap when inspection could not run (no key / failed / unparseable); null when it ran. */
	readonly gap: string | null;
}

/** Hard cap on candidates per batch — bounds the prompt and the output. */
const MAX_BATCH = 20;

const EMPTY: ReadonlyMap<string, AiFitInspection> = new Map();

function clampReason(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function clampConfidence(raw: unknown): number | null {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
	return Math.min(1, Math.max(0, raw));
}

function normalizeVerdict(raw: unknown): AiFitVerdict {
	return typeof raw === 'string' && (VERDICTS as readonly string[]).includes(raw) ? (raw as AiFitVerdict) : 'unknown';
}

/** Compose the batched inspection prompt. The model returns STRICT JSON only. */
function buildMessages(profile: InspectionProfile, candidates: readonly InspectableCandidate[]): { role: string; content: string }[] {
	const profileText = JSON.stringify({
		country: profile.country ?? null,
		experienceLevel: profile.experienceLevel ?? null,
		formatPreference: profile.formatPreference ?? null,
		interests: (profile.interests ?? []).slice(0, 12),
		skills: (profile.skills ?? []).slice(0, 12),
	});
	const list = candidates.map((c, i) => ({ i, title: c.title.slice(0, 200), summary: c.summary.slice(0, 600) }));
	const system =
		'You judge how well each hackathon fits ONE solo builder, from the hackathon text and the builder profile. ' +
		'For EACH item return a verdict and a short reason. verdict is exactly one of: ' +
		'"strong" (clearly a great fit for their interests/skills/level/format), ' +
		'"possible" (plausible fit, some signals), ' +
		'"weak" (little overlap), ' +
		'"unknown" (the text is too thin to judge — USE THIS rather than guessing). ' +
		'reason is ONE short user-facing sentence (no ids, no jargon) explaining the verdict from the actual text. ' +
		'confidence is a number 0..1. NEVER invent facts (dates, prizes, eligibility) not present in the text. ' +
		'Output STRICT JSON ONLY, no prose, in the shape: ' +
		'{"items":[{"i":0,"verdict":"strong","reason":"...","confidence":0.8}, ...]} — one object per input index.';
	const user = `Builder profile: ${profileText}\n\nHackathons (score every index):\n${JSON.stringify(list)}`;
	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	];
}

/** Extract the model's JSON object from its reply (tolerates stray prose/fences). */
function parseItems(content: string): { i?: unknown; verdict?: unknown; reason?: unknown; confidence?: unknown }[] | null {
	if (typeof content !== 'string' || !content.trim()) return null;
	// Prefer a fenced or first {...} block; fall back to the whole string.
	const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidateText = fenced ? fenced[1]! : content;
	const start = candidateText.indexOf('{');
	const end = candidateText.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		const parsed = JSON.parse(candidateText.slice(start, end + 1)) as { items?: unknown };
		return Array.isArray(parsed.items) ? (parsed.items as { i?: unknown }[]) : null;
	} catch {
		return null;
	}
}

/**
 * Inspect candidates against the profile in ONE batched model call. Fail-soft:
 * returns an empty map + a visible gap on no-key / failure / unparseable, never
 * throws. Honest: an unscored or thin candidate is simply absent (→ 'unknown'
 * at the read site), never a fabricated verdict.
 */
export async function inspectCandidates(input: InspectCandidatesInput): Promise<InspectCandidatesResult> {
	const candidates = input.candidates.slice(0, MAX_BATCH);
	if (candidates.length === 0) return { byId: EMPTY, gap: null };
	if (!input.apiKey) {
		return { byId: EMPTY, gap: 'AI fit inspection is unavailable: the model key is not configured — results are ranked by heuristics only.' };
	}
	const route = findModelRouteForRole('helper');
	let content: string;
	try {
		const res = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
			signal: timeoutSignal(MODEL_CALL_TIMEOUT_MS),
			body: JSON.stringify({
				model: route.modelId,
				messages: buildMessages(input.profile, candidates),
				temperature: 0,
				max_tokens: route.maxTokens,
			}),
		}).catch((cause: unknown) => {
			throw new Error(cause instanceof Error ? cause.message : 'network error');
		});
		if (!res.ok) {
			return { byId: EMPTY, gap: `AI fit inspection failed (status ${res.status}) — results are ranked by heuristics only.` };
		}
		const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
		const raw = body.choices?.[0]?.message?.content;
		content = typeof raw === 'string' ? raw : '';
	} catch {
		return { byId: EMPTY, gap: 'AI fit inspection failed (request error) — results are ranked by heuristics only.' };
	}

	const items = parseItems(content);
	if (!items) {
		return { byId: EMPTY, gap: 'AI fit inspection returned an unreadable response — results are ranked by heuristics only.' };
	}
	const byId = new Map<string, AiFitInspection>();
	for (const item of items) {
		const idx = typeof item.i === 'number' && Number.isInteger(item.i) ? item.i : -1;
		const candidate = candidates[idx];
		if (!candidate) continue; // an index the model invented maps to nothing — dropped
		byId.set(candidate.id, {
			verdict: normalizeVerdict(item.verdict),
			reason: clampReason(item.reason),
			confidence: clampConfidence(item.confidence),
		});
	}
	return { byId, gap: null };
}

// --- candidate digest (detail pane, Tier 1) ----------------------------------------------

/**
 * The AI "digest" shown at the top of the detail pane: a one-line headline, a
 * few "label → detail" bullets, and an optional watch-out. Same contract as
 * inspectCandidates: ONE call, fail-soft, env-free, never throws, never invents
 * facts (dates/prizes/eligibility) absent from the supplied text. The verbatim
 * rules below the digest remain the source of truth — the digest is marked
 * "ai-read · verify below" at the render site.
 */
export interface CandidateDigest {
	readonly headline: string;
	readonly bullets: readonly string[];
	/** A caution the builder should confirm before committing, or null. */
	readonly watchOut: string | null;
	/** 1-2 plain sentences on what the hackathon asks you to build. Empty when the page does not say. */
	readonly about: string;
	/** Named tracks/categories from the page. Empty when none are listed. */
	readonly tracks: readonly DigestTrack[];
	/** Prize lines as listed ("Grand prize" → "$10,000"). Empty when the page lists none. */
	readonly prizes: readonly DigestPrize[];
	/** Credits, hardware, perks or other non-cash support named on the page. */
	readonly perks: readonly string[];
	/** Judging criteria named on the page. */
	readonly judging: readonly string[];
	/**
	 * Tracks that suit THIS builder — Caddie's INFERENCE from their stored
	 * profile against the listed tracks, never a fact from the page. Only names
	 * that also appear in `tracks` survive parsing.
	 */
	readonly fitTracks: readonly DigestFitTrack[];
}

export interface DigestTrack {
	readonly name: string;
	readonly detail: string;
}
export interface DigestPrize {
	readonly label: string;
	readonly amount: string;
}
export interface DigestFitTrack {
	readonly name: string;
	readonly why: string;
}

/**
 * Bumped whenever the digest prompt or shape changes, and folded into the
 * cache key — so every cached digest is rebuilt once instead of serving an
 * old-shape summary forever.
 */
export const DIGEST_VERSION = 'digest-v2';

/**
 * Output budget for the digest model call — explicitly LARGER than the nano
 * route's bounded default (2048).
 *
 * The helper route is a *reasoning* model: it spends tokens thinking before it
 * emits the answer. The richer digest-v2 contract (headline, about, bullets,
 * tracks, prizes, perks, judging, fit_tracks) written from up to 12k chars of
 * overview is big enough that reasoning + JSON together blew past 2048 — the
 * call came back finish_reason=length with EMPTY content, so parseDigest failed
 * and the pane fell back to raw rules ("unreadable response").
 *
 * LIVE-measured: a dense 12-track/12-prize event finishes (finish_reason=stop)
 * at ~4.0k completion tokens — so 4096 is already on the edge; 8192 leaves safe
 * margin. max_tokens is a CEILING not a target: a digest that finishes early
 * only bills the tokens it actually generated (~$0.001/event at nano pricing),
 * so the headroom is free.
 */
const DIGEST_MAX_TOKENS = 8192;

/**
 * Map a stored profile (structurally — so this module never imports profiles.ts)
 * to the facts the digest's "tracks that fit you" inference may use. Null in,
 * country-less empty profile out: the digest then returns no fit tracks.
 */
export function digestProfileFrom(
	profile: {
		readonly country: string | null;
		readonly experienceLevel?: string | null;
		readonly formatPreference?: string | null;
		readonly weeklyHours?: number | null;
		readonly freeTextInterests?: readonly string[];
		readonly skills?: readonly string[];
		readonly stackIds?: readonly string[];
		readonly projectHighlight?: string | null;
	} | null,
): InspectionProfile {
	if (!profile) return { country: null };
	return {
		country: profile.country,
		experienceLevel: profile.experienceLevel ?? null,
		formatPreference: profile.formatPreference ?? null,
		weeklyHours: profile.weeklyHours ?? null,
		interests: profile.freeTextInterests ?? [],
		skills: profile.skills ?? [],
		stack: profile.stackIds ?? [],
		projectHighlight: profile.projectHighlight ?? null,
	};
}

export interface DigestCandidateInput {
	readonly apiKey?: string;
	readonly profile: InspectionProfile;
	readonly candidate: InspectableCandidate;
	/** Short facts already known (meta line, eligibility note) — grounds the digest. */
	readonly facts?: readonly string[];
	/**
	 * The event's OVERVIEW prose — its real "about"/tagline text read from the
	 * detail page (see rules-reading.overviewByCandidateId). This is the rich
	 * source the Devpost list API never carries; when present it is the primary
	 * material the digest is written from, so the digest reads like the event
	 * rather than like its one-line meta summary. Absent → the digest falls back
	 * to summary + facts (today's behaviour). Bounded by the caller.
	 */
	readonly overview?: string | null;
}

export interface DigestCandidateResult {
	/** The digest, or null when it could not run / was unreadable. */
	readonly digest: CandidateDigest | null;
	/** A visible gap when the digest could not run; null when it ran. */
	readonly gap: string | null;
}

const MAX_BULLETS = 5;

function clampLine(raw: unknown, max: number): string {
	if (typeof raw !== 'string') return '';
	return raw.replace(/\s+/g, ' ').trim().slice(0, max);
}

function parseDigest(content: string): Record<string, unknown> | null {
	if (typeof content !== 'string' || !content.trim()) return null;
	const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const text = fenced ? fenced[1]! : content;
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		const value: unknown = JSON.parse(text.slice(start, end + 1));
		return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function buildDigestMessages(
	profile: InspectionProfile,
	candidate: InspectableCandidate,
	facts: readonly string[],
	overview?: string | null,
): { role: string; content: string }[] {
	const profileText = JSON.stringify({
		country: profile.country ?? null,
		experienceLevel: profile.experienceLevel ?? null,
		formatPreference: profile.formatPreference ?? null,
		weeklyHours: profile.weeklyHours ?? null,
		interests: (profile.interests ?? []).slice(0, 12),
		skills: (profile.skills ?? []).slice(0, 12),
		stack: (profile.stack ?? []).slice(0, 12),
		projectHighlight: profile.projectHighlight ? profile.projectHighlight.slice(0, 300) : null,
	});
	const system =
		'You write an honest, plain-language digest of ONE hackathon for ONE solo builder, from the supplied text only. ' +
		'Write for a nontechnical reader: short sentences, no jargon. ' +
		'Return STRICT JSON ONLY in the shape: ' +
		'{"headline":"...","about":"...","bullets":["label → detail", ...],"tracks":[{"name":"...","detail":"..."}],' +
		'"prizes":[{"label":"...","amount":"..."}],"perks":["..."],"judging":["..."],' +
		'"fit_tracks":[{"name":"...","why":"..."}],"watch_out":"..."|null}. ' +
		'headline: one sentence on what this hackathon is. ' +
		'about: 1-2 sentences on what you are asked to build and the core technical requirement (e.g. which platform or API it must use). ' +
		'bullets: 2-4 key facts as "label → detail" (format, deadline, team size, total prize). At most ONE bullet about eligibility. ' +
		'tracks: every named track/category/challenge with a one-line detail. ' +
		'prizes: each listed prize line with its amount exactly as written (cash, hardware, or credit value). ' +
		'perks: credits, free API/cloud access, hardware, mentorship or other support that is offered. ' +
		'judging: the judging criteria, one short item each. ' +
		'fit_tracks: up to 2 of the listed tracks that best suit the builder profile, each with a short "why" naming the profile fact it relies on; [] when the profile is empty or no track is listed. ' +
		'watch_out: ONE caution to confirm before committing, or null. ' +
		'Use [] or "" for anything the text does not state. NEVER invent tracks, prizes, amounts, dates, perks or eligibility. No prose outside the JSON.';
	// The overview page (when read) is the richest material — prefer it, but keep
	// the summary + facts as grounding the model must not contradict. The cap
	// matches what the rules sweep stores (12k): a smaller cut dropped the prize
	// breakdown, which sits low on most event pages.
	const overviewText = typeof overview === 'string' && overview.trim() ? overview.trim().slice(0, 12_000) : '';
	const hackathon = overviewText
		? { title: candidate.title.slice(0, 200), summary: candidate.summary.slice(0, 1200), about: overviewText }
		: { title: candidate.title.slice(0, 200), summary: candidate.summary.slice(0, 1200) };
	const user =
		`Builder profile: ${profileText}\n\n` +
		`Hackathon:\n${JSON.stringify(hackathon)}\n\n` +
		`Known facts (ground the digest in these, do not contradict them):\n${JSON.stringify(facts.slice(0, 10))}`;
	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user },
	];
}

/**
 * Produce the detail-pane digest for one candidate in ONE model call. Fail-soft:
 * null digest + a visible gap on no-key / failure / unparseable; never throws.
 */
export async function digestCandidate(input: DigestCandidateInput): Promise<DigestCandidateResult> {
	if (!input.apiKey) {
		return { digest: null, gap: 'AI digest is unavailable: the model key is not configured — read the verbatim rules below.' };
	}
	const route = findModelRouteForRole('helper');
	let content: string;
	try {
		const res = await fetch(`${NEBIUS_BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
			signal: timeoutSignal(DIGEST_CALL_TIMEOUT_MS),
			body: JSON.stringify({
				model: route.modelId,
				messages: buildDigestMessages(input.profile, input.candidate, input.facts ?? [], input.overview),
				temperature: 0,
				// Explicit higher ceiling than route.maxTokens (2048): the reasoning
				// model needs room to think AND emit the full digest-v2 JSON. See
				// DIGEST_MAX_TOKENS.
				max_tokens: DIGEST_MAX_TOKENS,
			}),
		}).catch((cause: unknown) => {
			throw new Error(cause instanceof Error ? cause.message : 'network error');
		});
		if (!res.ok) {
			return { digest: null, gap: `AI digest failed (status ${res.status}) — read the verbatim rules below.` };
		}
		const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
		const raw = body.choices?.[0]?.message?.content;
		content = typeof raw === 'string' ? raw : '';
	} catch {
		return { digest: null, gap: 'AI digest failed (request error) — read the verbatim rules below.' };
	}

	const parsed = parseDigest(content);
	if (!parsed) {
		return { digest: null, gap: 'AI digest returned an unreadable response — read the verbatim rules below.' };
	}
	const digest = normalizeDigest(parsed);
	// An empty digest (no headline AND no bullets) is as good as none — be honest.
	if (!digest) {
		return { digest: null, gap: 'AI digest returned nothing usable — read the verbatim rules below.' };
	}
	return { digest, gap: null };
}

const MAX_TRACKS = 8;
const MAX_PRIZES = 10;
const MAX_LIST = 6;
const MAX_FIT = 2;

function asRecords(raw: unknown): Record<string, unknown>[] {
	return Array.isArray(raw) ? raw.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null) : [];
}

function asLines(raw: unknown, max: number, len: number): string[] {
	return Array.isArray(raw) ? raw.map((x) => clampLine(x, len)).filter((x) => x.length > 0).slice(0, max) : [];
}

/**
 * Normalise a parsed model response into a {@link CandidateDigest}: every field
 * bounded, missing fields become empty (never invented), and a fit track only
 * survives when it names a track that is actually listed. Null when the
 * response carries neither a headline nor any bullet.
 */
export function normalizeDigest(parsed: Record<string, unknown>): CandidateDigest | null {
	const headline = clampLine(parsed['headline'], 200);
	const bullets = asLines(parsed['bullets'], MAX_BULLETS, 160);
	if (!headline && bullets.length === 0) return null;
	const tracks = asRecords(parsed['tracks'])
		.map((t) => ({ name: clampLine(t['name'], 80), detail: clampLine(t['detail'], 200) }))
		.filter((t) => t.name.length > 0)
		.slice(0, MAX_TRACKS);
	const prizes = asRecords(parsed['prizes'])
		.map((p) => ({ label: clampLine(p['label'], 100), amount: clampLine(p['amount'], 60) }))
		.filter((p) => p.label.length > 0 || p.amount.length > 0)
		.slice(0, MAX_PRIZES);
	const trackNames = new Set(tracks.map((t) => t.name.toLowerCase()));
	const fitTracks = asRecords(parsed['fit_tracks'])
		.map((f) => ({ name: clampLine(f['name'], 80), why: clampLine(f['why'], 200) }))
		.filter((f) => f.name.length > 0 && trackNames.has(f.name.toLowerCase()))
		.slice(0, MAX_FIT);
	return {
		headline,
		bullets,
		watchOut: clampLine(parsed['watch_out'], 240) || null,
		about: clampLine(parsed['about'], 400),
		tracks,
		prizes,
		perks: asLines(parsed['perks'], MAX_LIST, 160),
		judging: asLines(parsed['judging'], MAX_LIST, 120),
		fitTracks,
	};
}
