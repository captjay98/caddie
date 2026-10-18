/**
 * Google Web Risk Lookup API: is this URL on Google's malware / social
 * engineering / unwanted software lists? Used by the daily recheck of live
 * apps (publish.ts recheckLiveApps). Known-bad lists only — it does not judge
 * a brand-new page; the URL Scanner gate at publish time does that.
 *
 *   GET {base}/v1/uris:search?uri=<url>&threatTypes=MALWARE&threatTypes=SOCIAL_ENGINEERING&threatTypes=UNWANTED_SOFTWARE
 *   -> {} when on no list, or { threat: { threatTypes: [...], expireTime } }
 *
 * (Request/response shape checked against Google's REST reference,
 * 2026-10-18.) The API key travels in the standard `x-goog-api-key` header,
 * never in the URL, so traces and logs of the subrequest cannot carry it.
 * Pricing: free up to 100,000 lookups a month, then paid (see Google's
 * pricing page; not authoritative here).
 */

export type WebRiskErrorCode = 'UNAUTHORIZED' | 'RATE_LIMITED' | 'UPSTREAM';

export class WebRiskError extends Error {
	constructor(
		readonly code: WebRiskErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'WebRiskError';
	}
}

export interface WebRiskClient {
	lookup(url: string): Promise<{ threats: string[] }>;
}

export const WEB_RISK_THREAT_TYPES = ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'] as const;

export function createWebRisk(input: { apiKey: string; base?: string; fetch?: (request: Request) => Promise<Response> }): WebRiskClient {
	const base = (input.base ?? 'https://webrisk.googleapis.com').replace(/\/+$/, '');
	const doFetch = input.fetch ?? ((request: Request) => fetch(request));
	return {
		async lookup(url: string) {
			const query = new URLSearchParams({ uri: url });
			for (const type of WEB_RISK_THREAT_TYPES) query.append('threatTypes', type);
			let response: Response;
			try {
				response = await doFetch(
					new Request(`${base}/v1/uris:search?${query.toString()}`, {
						headers: { 'x-goog-api-key': input.apiKey, accept: 'application/json' },
						signal: AbortSignal.timeout(10_000),
					}),
				);
			} catch (error) {
				throw new WebRiskError('UPSTREAM', `Web Risk did not answer: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (response.status === 401 || response.status === 403) throw new WebRiskError('UNAUTHORIZED', `Web Risk refused the key (HTTP ${response.status})`);
			if (response.status === 429) throw new WebRiskError('RATE_LIMITED', 'Web Risk quota exceeded');
			if (!response.ok) throw new WebRiskError('UPSTREAM', `Web Risk HTTP ${response.status}`);
			const body = (await response.json().catch(() => ({}))) as { threat?: { threatTypes?: unknown } };
			const types = Array.isArray(body.threat?.threatTypes) ? body.threat!.threatTypes.filter((t): t is string => typeof t === 'string') : [];
			return { threats: types };
		},
	};
}
