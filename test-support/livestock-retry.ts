/**
 * TEMP (not committed): trigger the workflow retry for the Livestock Risk
 * Tracker project against the running dev server, authenticated as the project
 * owner via a Better Auth signed session cookie (read read-only from local D1).
 *
 * No DB writes from here; the retry route owns its own writes. The secret is
 * read from BETTER_AUTH_SECRET and never printed.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/livestock-retry.ts [retryKey]
 */
import { createHmac } from 'node:crypto';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const PROJECT = 'proj_8f9cb1aeea005c54dd52af005dc92627';
const KEY = process.argv[2] ?? `livestock-rebuild-${new Date().toISOString().slice(0, 10)}`;

const token = process.env.SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET;
if (!token || !secret) {
	console.error('need SESSION_TOKEN and BETTER_AUTH_SECRET');
	process.exit(3);
}

// better-call signCookieValue: standard base64 (btoa, with +/=), then
// encodeURIComponent of `${value}.${sig}`.
function signCookieValue(value: string): string {
	const sig = createHmac('sha256', secret!).update(value).digest('base64');
	return encodeURIComponent(`${value}.${sig}`);
}
const cookie = `better-auth.session_token=${signCookieValue(token)}`;

async function main() {
	// 1. Prove the session is accepted.
	const status = await fetch(`${BASE}/api/auth/status`, { headers: { cookie } });
	console.log('auth/status', status.status, await status.text());

	const sess = await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie } });
	const sj = await sess.json().catch(() => null);
	console.log('get-session user =', (sj as any)?.user?.email ?? (sj as any)?.user?.id ?? JSON.stringify(sj)?.slice(0, 120));

	// 2. Read the workflow snapshot before.
	const before = await fetch(`${BASE}/api/projects/${PROJECT}/workflow`, { headers: { cookie } });
	const bj = await before.json().catch(() => null);
	console.log('workflow BEFORE phase =', (bj as any)?.workflow?.phase, 'http', before.status);

	// 3. Fire the retry.
	const retry = await fetch(`${BASE}/api/projects/${PROJECT}/workflow/retry`, {
		method: 'POST',
		headers: { cookie, 'content-type': 'application/json' },
		body: JSON.stringify({ key: KEY }),
	});
	const rj = await retry.json().catch(() => null);
	console.log('RETRY http', retry.status, 'key', KEY);
	console.log('retry response:', JSON.stringify(rj)?.slice(0, 600));
	console.log('workflow AFTER phase =', (rj as any)?.workflow?.phase);
	process.exit(retry.ok ? 0 : 1);
}
main().catch((e) => { console.error('ERROR', e); process.exit(2); });
