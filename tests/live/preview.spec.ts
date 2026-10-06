import { describe, expect, test } from 'bun:test';

/**
 * P07 private preview gateway — hosted acceptance against a concrete
 * deployed base URL (the same gating grammar as tests/live/release.spec.ts).
 *
 * Gates, each failing loudly (never a silent pass):
 *   1. CADDIE_LIVE_AUTHORIZED=1 — probing a hosted deployment is an external
 *      effect; verify-packet refuses the live category without it.
 *   2. CADDIE_RELEASE_URL       — the deployed base to probe (no default,
 *      never localhost, never a guess).
 *
 * What runs when both are present: the preview gateway's fail-closed
 * behavior on the real deployment — a preview artifact route WITHOUT a
 * valid token answers 401/403 (never the artifact), and unknown preview
 * tokens are rejected with a JSON/classified error rather than a crash.
 * Token minting itself is owner-gated (it requires an authenticated
 * session against a real project); this spec proves the gateway refuses
 * the public, which is the security half that must hold everywhere.
 */

const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1';
const releaseUrl = process.env.CADDIE_RELEASE_URL;

function base(): string {
	if (!releaseUrl) {
		throw new Error(
			'BLOCKED: the private preview acceptance requires CADDIE_RELEASE_URL (the deployed ' +
				'base URL, e.g. https://caddie.example.com). Provision the deployment, then re-run.',
		);
	}
	return releaseUrl.replace(/\/$/, '');
}

describe('P07 private preview gateway (hosted acceptance)', () => {
	test('live authorization is explicit', () => {
		expect(authorized).toBe(true);
	});

	test('preview artifact routes fail closed without a valid token', async () => {
		if (!authorized || !releaseUrl) {
			throw new Error('BLOCKED: set CADDIE_LIVE_AUTHORIZED=1 and CADDIE_RELEASE_URL to run this acceptance.');
		}
		const origin = base();
		// An unauthenticated request to a preview artifact path must never leak
		// the artifact: 401 (session required) or 403/404 (token rejected).
		const probes = [
			`${origin}/api/projects/any/previews/preview-token-not-real`,
			`${origin}/api/projects/any/previews/preview-token-not-real/artifact`,
		];
		for (const url of probes) {
			const response = await fetch(url, { redirect: 'manual' });
			expect([401, 403, 404]).toContain(response.status);
			if (response.status !== 404) {
				// A JSON/classified refusal, never an HTML artifact dump.
				const contentType = response.headers.get('content-type') ?? '';
				expect(contentType).toContain('application/json');
			}
		}
	});
});
