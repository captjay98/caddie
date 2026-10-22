import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { findModelRouteForRole, type ModelRoute } from '../agents/providers.ts';
import { timeoutSignal } from './http-timeouts.ts';
import { assertProjectScope } from './scope.ts';

/**
 * AI inside apps (Publish programme stage 9). A generated app's server calls
 * `env.CADDIE.ai({ messages })` and gets a reply from Caddie's model — the app
 * owner never needs an AI account or key. Caddie pays the model provider, so:
 *
 *   - every project has a monthly allowance (APP_AI_MONTHLY_LIMIT_CENTS); a
 *     call is RESERVED at its worst-case cost by an insert that refuses itself
 *     when the month's spend would pass the allowance, then SETTLED at the
 *     provider's reported tokens (0 when the provider refused it);
 *   - calls per minute are capped per project, so one visitor can't drain it;
 *   - a published app's calls count only while it is live.
 *
 * The app never sees a key, a model name or a price. Replies are values, not
 * exceptions (`{ ok: false, reason, message }`), so generated code can show
 * the message as it is. Prompts and replies are never stored.
 */

const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

export type AppAiMode = 'preview' | 'live';
export type AppAiFailure = 'invalid_request' | 'too_long' | 'limit_reached' | 'busy' | 'unavailable' | 'failed';

/** The image formats Super VL accepts (part M). */
export type AppAiImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

/**
 * A message's content is plain text (the everyday case) or a list of parts so
 * an app can show the model a photo (part M). An image part carries base64
 * `data`; the app's server reads the photo with `readFile()` (part L) and sends
 * it here. Images need the super tier, because Super VL is the vision model.
 */
export type AppAiContentPart =
	| { type: 'text'; text: string }
	| { type: 'image'; mime: AppAiImageMime; data: string };
export interface AppAiMessage {
	role: 'system' | 'user' | 'assistant';
	content: string | AppAiContentPart[];
}
export type AppAiReply = { ok: true; text: string } | { ok: false; reason: AppAiFailure; message: string };

export const APP_AI_LIMITS = {
	maxMessages: 40,
	/** All message text together. */
	maxChars: 32_000,
	timeoutMs: 20_000,
	callsPerMinute: { preview: 20, live: 60 } satisfies Record<AppAiMode, number>,
	defaultMonthlyCents: 100,
	/**
	 * The output cap for every app call, on either tier. An app's reply is read
	 * by a person in the UI, so the deep tier's larger route default would only
	 * buy a longer wait — and a larger worst-case reservation against the
	 * project's monthly allowance.
	 */
	maxOutputTokens: 4096,
	/** Part M image limits. */
	maxImagesPerCall: 4,
	/** Per image, measured on the decoded bytes (1.5 MB). */
	maxImageBytes: 1_500_000,
	/**
	 * A fixed per-image input estimate, in tokens, for the worst-case
	 * reservation. UNVERIFIED until S6: the real per-image cost is one paid
	 * Super VL call in the owner's Monday campaign. Until then an image is
	 * reserved at this flat estimate (generous: a 1.5 MB image is far under it
	 * on any plausible tile-based vision pricing), so the allowance can never be
	 * under-reserved.
	 */
	imageInputTokensEstimate: 2_000,
} as const;

/** The image MIME types part M accepts. */
export const APP_AI_IMAGE_MIMES: readonly AppAiImageMime[] = ['image/jpeg', 'image/png', 'image/webp'];

export interface AppAiDeps {
	/** Caddie's model-provider key; null when AI isn't set up on this server. */
	apiKey: string | null;
	monthlyLimitCents: number;
	/**
	 * Whether app features (part M photo input among them) are on for this
	 * call. Off refuses an image request with a plain message; text is never
	 * gated. Caddie sets this from the project's stamped `appFeatures` / the
	 * `app_features` switch — never the app. {@link appAiDepsFromEnv} gives the
	 * `APP_FEATURES` env default as a safe fallback.
	 */
	appFeatures: boolean;
	fetch?: (request: Request) => Promise<Response>;
	now?: () => Date;
}

export function appAiDepsFromEnv(env: { NEBIUS_API_KEY?: string; APP_AI_MONTHLY_LIMIT_CENTS?: string; APP_FEATURES?: string }): AppAiDeps {
	const raw = (env.APP_AI_MONTHLY_LIMIT_CENTS ?? '').trim();
	const parsed = /^\d{1,9}$/.test(raw) ? Number(raw) : APP_AI_LIMITS.defaultMonthlyCents;
	// The env var is the switch DEFAULT (platform-switches.ts). `on`/`owner`
	// mean the feature is available; anything else (including unset) is off.
	const appFeatures = ((env.APP_FEATURES ?? '').trim() === 'on' || (env.APP_FEATURES ?? '').trim() === 'owner');
	return { apiKey: env.NEBIUS_API_KEY?.trim() || null, monthlyLimitCents: parsed, appFeatures };
}

const fail = (reason: AppAiFailure, message: string): AppAiReply => ({ ok: false, reason, message });

const monthOf = (date: Date) => date.toISOString().slice(0, 7);
function renewsOn(date: Date): string {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

/** Decoded byte length of a base64 string, without decoding it. */
function base64Bytes(data: string): number {
	const len = data.length;
	if (len === 0) return 0;
	const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
	return Math.floor((len * 3) / 4) - padding;
}

/** A read request: the validated messages plus what the reservation needs. */
interface ReadRequest {
	messages: AppAiMessage[];
	json: boolean;
	/** Text characters across all parts (image data never counts). */
	chars: number;
	tier: 'fast' | 'super';
	/** Image parts across all messages (part M). */
	imageCount: number;
}

/**
 * Validate what the app sent. Forgiving about extra fields; strict about shape
 * and size. `appFeatures` gates image parts (part M): text is never gated.
 */
function readRequest(input: unknown, appFeatures: boolean): ReadRequest | AppAiReply {
	const body = input as { messages?: unknown; json?: unknown; tier?: unknown } | null;
	if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
		return fail('invalid_request', 'Send { messages: [{ role: "user", content: "…" }] }.');
	}
	if (body.tier !== undefined && body.tier !== 'fast' && body.tier !== 'super') {
		return fail('invalid_request', 'Choose tier "fast" or "super".');
	}
	if (body.messages.length > APP_AI_LIMITS.maxMessages) {
		return fail('too_long', `Send at most ${APP_AI_LIMITS.maxMessages} messages.`);
	}
	const tier: 'fast' | 'super' = body.tier === 'super' ? 'super' : 'fast';
	const messages: AppAiMessage[] = [];
	let chars = 0;
	let imageCount = 0;
	for (const item of body.messages as unknown[]) {
		const message = item as { role?: unknown; content?: unknown } | null;
		if (!message || (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant')) {
			return fail('invalid_request', 'Each message needs a role (system, user or assistant) and text content.');
		}
		if (typeof message.content === 'string') {
			chars += message.content.length;
			messages.push({ role: message.role, content: message.content });
			continue;
		}
		if (!Array.isArray(message.content) || message.content.length === 0) {
			return fail('invalid_request', 'Each message needs a role (system, user or assistant) and text content.');
		}
		const parts: AppAiContentPart[] = [];
		for (const raw of message.content as unknown[]) {
			const part = raw as { type?: unknown; text?: unknown; mime?: unknown; data?: unknown } | null;
			if (!part || typeof part !== 'object') {
				return fail('invalid_request', 'Each content part must be { type: "text", text } or { type: "image", mime, data }.');
			}
			if (part.type === 'text') {
				if (typeof part.text !== 'string') return fail('invalid_request', 'A text part needs text.');
				chars += part.text.length;
				parts.push({ type: 'text', text: part.text });
				continue;
			}
			if (part.type === 'image') {
				if (!appFeatures) return fail('invalid_request', 'This app can\u2019t send photos to the AI.');
				if (typeof part.data !== 'string' || part.data.length === 0 || typeof part.mime !== 'string') {
					return fail('invalid_request', 'An image part needs a mime type and base64 data.');
				}
				if (!(APP_AI_IMAGE_MIMES as readonly string[]).includes(part.mime)) {
					return fail('invalid_request', 'Photos must be JPEG, PNG or WebP.');
				}
				if (tier !== 'super') return fail('invalid_request', 'Looking at a photo needs tier "super".');
				imageCount += 1;
				if (imageCount > APP_AI_LIMITS.maxImagesPerCall) return fail('too_long', `Send at most ${APP_AI_LIMITS.maxImagesPerCall} photos in one call.`);
				if (base64Bytes(part.data) > APP_AI_LIMITS.maxImageBytes) {
					return fail('too_long', `Each photo must be under ${(APP_AI_LIMITS.maxImageBytes / 1_000_000).toLocaleString('en-US')} MB.`);
				}
				parts.push({ type: 'image', mime: part.mime as AppAiImageMime, data: part.data });
				continue;
			}
			return fail('invalid_request', 'Each content part must be { type: "text", text } or { type: "image", mime, data }.');
		}
		messages.push({ role: message.role, content: parts });
	}
	if (chars === 0 && imageCount === 0) return fail('invalid_request', 'The messages are empty.');
	if (chars > APP_AI_LIMITS.maxChars) return fail('too_long', `Keep the messages under ${APP_AI_LIMITS.maxChars.toLocaleString('en-US')} characters in total.`);
	// Omitted means the everyday fast tier; only an explicit "super" upgrades.
	return { messages, json: body.json === true, chars, tier, imageCount };
}

/** Worst-case cost in micro-cents: a generous input estimate plus the call's whole output cap. */
function reservationFor(route: ModelRoute, chars: number, messageCount: number, imageCount = 0): number {
	const inputTokens = Math.ceil(chars / 3) + 16 * messageCount + imageCount * APP_AI_LIMITS.imageInputTokensEstimate;
	return inputTokens * route.inputPriceMinorUnits + Math.min(route.maxTokens, APP_AI_LIMITS.maxOutputTokens) * route.outputPriceMinorUnits;
}

/**
 * One wire message for the provider. Plain text stays a string; a parts list
 * becomes OpenAI-style content parts, with each image an `image_url` carrying a
 * data URL. UNVERIFIED until S6: that Token Factory accepts this exact shape
 * for Super VL and what an image costs (one paid call in the Monday campaign).
 */
function toProviderMessage(message: AppAiMessage): { role: string; content: unknown } {
	if (typeof message.content === 'string') return { role: message.role, content: message.content };
	const parts = message.content.map((part) =>
		part.type === 'text'
			? { type: 'text', text: part.text }
			: { type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.data}` } },
	);
	return { role: message.role, content: parts };
}

/** The first JSON object in a reply (models sometimes wrap it in a fence or a sentence). */
function extractJson(text: string): string | null {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fenced ? fenced[1]! : text;
	const start = candidate.indexOf('{');
	const end = candidate.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	const slice = candidate.slice(start, end + 1);
	try {
		JSON.parse(slice);
		return slice;
	} catch {
		return null;
	}
}

async function settle(db: D1Database, id: string, update: { status: 'settled' | 'failed'; costMicros: number; inputTokens?: number | null; outputTokens?: number | null; outcome?: string | null; now: Date }) {
	await db
		.prepare('update "app_ai_usage" set "status" = ?, "costMicros" = ?, "inputTokens" = ?, "outputTokens" = ?, "outcome" = ?, "updatedAt" = ? where "id" = ? and "status" = \'reserved\'')
		.bind(update.status, update.costMicros, update.inputTokens ?? null, update.outputTokens ?? null, update.outcome ?? null, update.now.toISOString(), id)
		.run();
}

/**
 * One AI call for an app. `projectId` and `mode` come from Caddie (the preview
 * relay or the dispatch Worker), never from the app's own code.
 */
export async function runAppAi(db: D1Database, deps: AppAiDeps, input: { projectId: string; mode: AppAiMode; request: unknown }): Promise<AppAiReply> {
	const now = deps.now?.() ?? new Date();
	const read = readRequest(input.request, deps.appFeatures);
	if ('ok' in read) return read;
	if (!deps.apiKey) return fail('unavailable', "AI isn't available for apps on this Caddie server yet.");
	if (input.mode === 'live') {
		const published = (await db.prepare('select "status" from "app_publications" where "projectId" = ?').bind(input.projectId).all()).results?.[0] as { status?: string } | undefined;
		if (published?.status !== 'live') return fail('unavailable', "This app isn't published right now.");
	}

	const recent = (await db
		.prepare('select count(*) as "n" from "app_ai_usage" where "projectId" = ? and "mode" = ? and "createdAt" > ?')
		.bind(input.projectId, input.mode, new Date(now.getTime() - 60_000).toISOString())
		.all()).results?.[0] as { n?: number } | undefined;
	if (Number(recent?.n ?? 0) >= APP_AI_LIMITS.callsPerMinute[input.mode]) {
		return fail('busy', 'Too many AI requests in the last minute. Try again shortly.');
	}

	const route = findModelRouteForRole(read.tier === 'super' ? 'appSuper' : 'app');
	const month = monthOf(now);
	const reserved = reservationFor(route, read.chars, read.messages.length, read.imageCount);
	const id = `aiu_${crypto.randomUUID()}`;
	const stamp = now.toISOString();
	const inserted = await db
		.prepare(
			`insert into "app_ai_usage" ("id","projectId","mode","month","status","routeId","reservedMicros","costMicros","createdAt","updatedAt")
			 select ?,?,?,?,'reserved',?,?,0,?,?
			 where (select coalesce(sum(case when "status" = 'reserved' then "reservedMicros" else "costMicros" end), 0)
			        from "app_ai_usage" where "projectId" = ? and "month" = ?) + ? <= ?`,
		)
		.bind(id, input.projectId, input.mode, month, route.id, reserved, stamp, stamp, input.projectId, month, reserved, deps.monthlyLimitCents * 1_000_000)
		.run();
	if (Number((inserted as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) {
		return fail('limit_reached', `This app has used its AI allowance for the month. It renews on ${renewsOn(now)}.`);
	}

	const jsonRule = 'Reply with one JSON object and nothing else.';
	const firstIsStringSystem = read.messages[0]?.role === 'system' && typeof read.messages[0].content === 'string';
	const messages: AppAiMessage[] = !read.json
		? read.messages
		: firstIsStringSystem
			? [{ role: 'system', content: `${read.messages[0]!.content as string}\n\n${jsonRule}` }, ...read.messages.slice(1)]
			: [{ role: 'system', content: jsonRule }, ...read.messages];
	const fetchFn = deps.fetch ?? ((request: Request) => fetch(request));
	let response: Response;
	try {
		response = await fetchFn(
			new Request(`${NEBIUS_BASE_URL}/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.apiKey}` },
				body: JSON.stringify({ model: route.modelId, messages: messages.map(toProviderMessage), max_tokens: Math.min(route.maxTokens, APP_AI_LIMITS.maxOutputTokens), temperature: 0.4 }),
				signal: timeoutSignal(APP_AI_LIMITS.timeoutMs),
			}),
		);
	} catch (error) {
		const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
		// A timed-out call may still have been billed: keep the worst case. A refused connection wasn't.
		await settle(db, id, { status: timedOut ? 'settled' : 'failed', costMicros: timedOut ? reserved : 0, outcome: timedOut ? 'timeout' : 'unreachable', now: deps.now?.() ?? new Date() });
		return fail('failed', timedOut ? 'The AI took too long to answer. Try again.' : "The AI couldn't be reached. Try again.");
	}
	const later = deps.now?.() ?? new Date();
	if (!response.ok) {
		await settle(db, id, { status: 'failed', costMicros: 0, outcome: `provider ${response.status}`, now: later });
		return response.status === 429
			? fail('busy', 'The AI is busy right now. Try again in a moment.')
			: fail('failed', "The AI couldn't answer right now. Try again.");
	}
	let body: { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
	try {
		body = (await response.json()) as typeof body;
	} catch {
		await settle(db, id, { status: 'settled', costMicros: reserved, outcome: 'unreadable reply', now: later });
		return fail('failed', "The AI's answer couldn't be read. Try again.");
	}
	const inputTokens = Number.isInteger(body.usage?.prompt_tokens) ? Number(body.usage!.prompt_tokens) : null;
	const outputTokens = Number.isInteger(body.usage?.completion_tokens) ? Number(body.usage!.completion_tokens) : null;
	const cost = inputTokens !== null && outputTokens !== null
		? inputTokens * route.inputPriceMinorUnits + outputTokens * route.outputPriceMinorUnits
		: reserved;
	const raw = body.choices?.[0]?.message?.content;
	const text = (typeof raw === 'string' ? raw : '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
	await settle(db, id, { status: 'settled', costMicros: cost, inputTokens, outputTokens, outcome: text ? null : 'empty reply', now: later });
	if (!text) return fail('failed', 'The AI gave an empty answer. Try again.');
	if (read.json) {
		const json = extractJson(text);
		return json === null ? fail('failed', "The AI's answer wasn't valid JSON. Try again.") : { ok: true, text: json };
	}
	return { ok: true, text };
}

export interface AppAiUsageView {
	/** AI is set up on this server. */
	available: boolean;
	month: string;
	/** Answered calls this month (preview and live). */
	calls: number;
	usedPercent: number;
	/** A typical call would be refused now. */
	limitReached: boolean;
	renewsOn: string;
}

/** What the project card shows: how much of this month's allowance the app has used. */
export async function getAppAiUsage(db: D1Database, deps: AppAiDeps, scope: Scope): Promise<AppAiUsageView> {
	const verified = await assertProjectScope(db, scope);
	const now = deps.now?.() ?? new Date();
	const month = monthOf(now);
	const row = (await db
		.prepare(
			`select count(case when "status" = 'settled' and "outcome" is null then 1 end) as "calls",
			        coalesce(sum(case when "status" = 'reserved' then "reservedMicros" else "costMicros" end), 0) as "spent"
			 from "app_ai_usage" where "projectId" = ? and "month" = ?`,
		)
		.bind(verified.projectId, month)
		.all()).results?.[0] as { calls?: number; spent?: number } | undefined;
	const spent = Number(row?.spent ?? 0);
	const limit = deps.monthlyLimitCents * 1_000_000;
	const typical = reservationFor(findModelRouteForRole('app'), 1_000, 2);
	return {
		available: deps.apiKey !== null,
		month,
		calls: Number(row?.calls ?? 0),
		usedPercent: limit === 0 ? 100 : Math.min(100, Math.floor((spent * 100) / limit)),
		limitReached: spent + typical > limit,
		renewsOn: renewsOn(now),
	};
}
