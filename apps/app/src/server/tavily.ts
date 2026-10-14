import { TAVILY_EXTRACT_TIMEOUT_MS, TAVILY_SEARCH_TIMEOUT_MS, timeoutSignal } from './http-timeouts.ts';
/**
 * The shared Tavily client — the SINGLE place in the server that talks to the
 * Tavily API (https://tavily.com). Tavily is this repo's REQUIRED search
 * provider: the discovery feed's primary source and the chat research tool
 * both go through here. Parallel is not used.
 *
 * Two capabilities, each a thin typed wrapper over one Tavily endpoint:
 *   - {@link tavilySearch}  — POST /search : ranked web results for a query,
 *     optionally scoped to a set of domains (how discovery sweeps across
 *     Devpost / Devfolio / MLH / HackerEarth / DoraHacks in one call).
 *   - {@link tavilyExtract} — POST /extract : clean page content for one or
 *     more URLs (how the research tool reads a contest's rules page).
 *
 * HONESTY / FAIL-LOUD CONTRACT:
 *   - No key configured  → {@link TavilyNotConfiguredError}. Callers turn this
 *     into a VISIBLE configuration gap, never a silent empty result.
 *   - Non-2xx or network failure → {@link TavilyRequestError} with the status.
 *     Discovery turns a thrown error into a named feed gap (runDiscoveryFeed);
 *     the research tool reports the failure with its reason.
 *   - A result missing url/title is dropped (it cannot be cited), never
 *     fabricated into a fake-complete record.
 *
 * The key is read by the CALLER (from env) and passed in — this module never
 * reaches into env, keeping it fully unit-testable with a stubbed `fetch`.
 */

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';

/** Thrown when no Tavily key is configured — surfaces as a visible config gap. */
export class TavilyNotConfiguredError extends Error {
	constructor() {
		super('TAVILY_API_KEY is not configured — Tavily is the required search provider for discovery and research.');
		this.name = 'TavilyNotConfiguredError';
	}
}

/** Thrown when a Tavily request fails (non-2xx or transport). Carries the status. */
export class TavilyRequestError extends Error {
	readonly status: number;
	constructor(status: number, detail?: string) {
		super(`Tavily request failed (${status})${detail ? `: ${detail}` : ''}`);
		this.name = 'TavilyRequestError';
		this.status = status;
	}
}

/** One search result, normalized from Tavily's `results[]`. url+title guaranteed non-empty. */
export interface TavilySearchResult {
	readonly url: string;
	readonly title: string;
	/** Extracted snippet/content for the result (may be empty). */
	readonly content: string;
	/** Tavily's relevance score 0..1 when present. */
	readonly score: number | null;
}

export interface TavilySearchOptions {
	/** Restrict results to these domains (e.g. ['devpost.com','mlh.io']). */
	readonly includeDomains?: readonly string[];
	/** 'basic' (fast) or 'advanced' (deeper, slower). Default 'basic'. */
	readonly searchDepth?: 'basic' | 'advanced';
	/** Max results to return (Tavily caps this). Default 10. */
	readonly maxResults?: number;
}

interface TavilySearchRawResult {
	url?: string;
	title?: string;
	content?: string;
	score?: number;
}

/**
 * Search the web via Tavily. Returns ranked results (url/title guaranteed).
 * @throws {TavilyNotConfiguredError} when apiKey is empty.
 * @throws {TavilyRequestError} on a non-2xx response.
 */
export async function tavilySearch(
	apiKey: string | undefined,
	query: string,
	options: TavilySearchOptions = {},
): Promise<TavilySearchResult[]> {
	if (!apiKey) throw new TavilyNotConfiguredError();
	if (typeof query !== 'string' || !query.trim()) {
		throw new TavilyRequestError(400, 'query is required');
	}
	const body: Record<string, unknown> = {
		api_key: apiKey,
		query: query.trim(),
		search_depth: options.searchDepth ?? 'basic',
		max_results: options.maxResults ?? 10,
	};
	if (options.includeDomains && options.includeDomains.length > 0) {
		body['include_domains'] = [...options.includeDomains];
	}
	const res = await fetch(TAVILY_SEARCH_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: timeoutSignal(TAVILY_SEARCH_TIMEOUT_MS),
	}).catch((cause: unknown) => {
		throw new TavilyRequestError(0, cause instanceof Error ? cause.message : 'network error');
	});
	if (!res.ok) throw new TavilyRequestError(res.status);
	const parsed = (await res.json()) as { results?: TavilySearchRawResult[] };
	const seen = new Set<string>();
	const out: TavilySearchResult[] = [];
	for (const r of parsed.results ?? []) {
		if (typeof r.url !== 'string' || !r.url.trim()) continue;
		if (typeof r.title !== 'string' || !r.title.trim()) continue;
		if (seen.has(r.url)) continue;
		seen.add(r.url);
		out.push({
			url: r.url.trim(),
			title: r.title.trim(),
			content: typeof r.content === 'string' ? cleanContent(r.content) : '',
			score: typeof r.score === 'number' ? r.score : null,
		});
	}
	return out;
}

/** One extracted page, normalized from Tavily's `results[]`. */
export interface TavilyExtractResult {
	readonly url: string;
	readonly title: string | null;
	/** Cleaned page text (markdown image/asset noise stripped). */
	readonly content: string;
}

export interface TavilyExtractOptions {
	readonly extractDepth?: 'basic' | 'advanced';
}

interface TavilyExtractRawResult {
	url?: string;
	title?: string;
	raw_content?: string;
	content?: string;
}

/**
 * Extract clean page content for one or more URLs via Tavily.
 * @throws {TavilyNotConfiguredError} when apiKey is empty.
 * @throws {TavilyRequestError} on a non-2xx response.
 */
export async function tavilyExtract(
	apiKey: string | undefined,
	urls: readonly string[],
	options: TavilyExtractOptions = {},
): Promise<TavilyExtractResult[]> {
	if (!apiKey) throw new TavilyNotConfiguredError();
	const cleaned = urls.map((u) => (typeof u === 'string' ? u.trim() : '')).filter(Boolean);
	if (cleaned.length === 0) throw new TavilyRequestError(400, 'at least one url is required');
	const res = await fetch(TAVILY_EXTRACT_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			api_key: apiKey,
			urls: cleaned,
			extract_depth: options.extractDepth ?? 'basic',
		}),
		signal: timeoutSignal(TAVILY_EXTRACT_TIMEOUT_MS),
	}).catch((cause: unknown) => {
		throw new TavilyRequestError(0, cause instanceof Error ? cause.message : 'network error');
	});
	if (!res.ok) throw new TavilyRequestError(res.status);
	const parsed = (await res.json()) as { results?: TavilyExtractRawResult[] };
	const out: TavilyExtractResult[] = [];
	for (const r of parsed.results ?? []) {
		if (typeof r.url !== 'string' || !r.url.trim()) continue;
		const raw = typeof r.raw_content === 'string' ? r.raw_content : typeof r.content === 'string' ? r.content : '';
		out.push({
			url: r.url.trim(),
			title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : null,
			content: cleanContent(raw),
		});
	}
	return out;
}

/**
 * Strip the markdown image/asset noise Tavily's extract returns (logos, SVG
 * data lines) and collapse whitespace, so the content is readable prose. Not
 * a full sanitizer — just enough to drop the obvious non-text chrome.
 */
export function cleanContent(raw: string): string {
	return raw
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '') // markdown images
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
		.replace(/\r/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]{2,}/g, ' ')
		.trim();
}
