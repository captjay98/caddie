import { describe, expect, test } from 'bun:test';

/**
 * P17 hosted release acceptance — the post-deploy smoke tied to a concrete
 * deployed base URL.
 *
 * Gates, each failing loudly (never a silent pass):
 *   1. CADDIE_LIVE_AUTHORIZED=1  — probing a hosted deployment is an external
 *      effect; verify-packet refuses the live category without it.
 *   2. CADDIE_RELEASE_URL        — the deployed base to smoke (no default,
 *      never localhost, never a guess).
 *
 * When both are present, the acceptance checks packets.md P17 names run for
 * real against that origin: the landing answers 200 with the pit-board
 * content, /app/ serves the SPA shell, the public session probe answers
 * (fail-closed sign-in availability), and the API surface is alive (JSON 404
 * fallback). Deployment itself remains an owner decision (release-check
 * gate 5); this spec only proves a deployed release serves correctly.
 */

const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1';
const releaseUrl = process.env.CADDIE_RELEASE_URL;

function base(): string {
	if (!releaseUrl) {
		throw new Error(
			'BLOCKED: the hosted release smoke requires CADDIE_RELEASE_URL (the deployed base URL, ' +
				'e.g. https://caddie.example.com). Provision the deployment, then re-run; this suite ' +
				'never smokes a guessed or local URL.',
		);
	}
	return releaseUrl.replace(/\/+$/, '');
}

describe('P17 hosted release acceptance (BLOCKED without authorization + deployment)', () => {
	test('live authorization and the deployed base URL are explicit', () => {
		if (!authorized) {
			throw new Error(
				'BLOCKED: hosted release acceptance requires CADDIE_LIVE_AUTHORIZED=1 (external effect: ' +
					'probing a deployed origin). Set it together with CADDIE_RELEASE_URL after owner-approved deployment.',
			);
		}
		expect(authorized).toBe(true);
		expect(releaseUrl, 'CADDIE_RELEASE_URL must name the deployed base').toBeTruthy();
	});

	test('the landing answers 200 with real pit-board content', async () => {
		const res = await fetch(`${base()}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		const html = await res.text();
		expect(html).toContain('Caddie');
		expect(html).toContain('class="pb"'); // the ported landing structure
		expect(html).toContain('LOCKED LINE'); // the honesty band shipped
	});

	test('/app/ serves the SPA shell', async () => {
		const res = await fetch(`${base()}/app/`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('id="root"');
		expect(html).toMatch(/<script[^>]+type="module"/); // a real built bundle, not the dev entry
	});

	test('the public session probe answers fail-closed (sign-in availability)', async () => {
		const res = await fetch(`${base()}/api/auth/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { authenticated: boolean };
		expect(body).toHaveProperty('authenticated');
		expect(typeof body.authenticated).toBe('boolean');
		// No session was presented, so the honest answer is "not authenticated"
		// whether or not OAuth is configured (fail-closed, never a fake session).
		expect(body.authenticated).toBe(false);
	});

	test('the API surface is alive (JSON 404 fallback)', async () => {
		const res = await fetch(`${base()}/api/definitely-not-a-route-p17`);
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(await res.json()).toEqual({ error: 'not_found' });
	});
});
