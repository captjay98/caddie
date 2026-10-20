import { FlueApiError } from '@flue/sdk';

/** Only known admission refusals are safe to show verbatim. Runtime errors
 * can contain implementation details and keep the existing generic fallback. */
export function quotaRefusalMessage(error: Error | undefined): string | null {
	if (!(error instanceof FlueApiError) || error.status !== 403) return null;
	const body = error.body;
	if (!body || typeof body !== 'object' || !('error' in body) || !('message' in body)) return null;
	if (!['JUDGE_LIMIT_MESSAGES', 'JUDGE_LIMIT_BUILDS', 'JUDGE_LIMIT_DISCOVERY'].includes(String(body.error))) return null;
	return typeof body.message === 'string' && body.message.trim() ? body.message : null;
}
