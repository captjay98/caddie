/**
 * TEMP (not committed): recover a stalled `building` Livestock workflow via the
 * product's own path — POST /workflow/stop (→ blocked, aborts the DO turn) then
 * POST /workflow/retry (re-dispatch the coordinator to continue from the first
 * unfinished feature; saved work preserved). Authenticated as the project owner
 * via a Better Auth signed cookie. Secret read from env, never printed.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/livestock-stop-retry.ts
 */
import { createHmac } from 'node:crypto';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const PROJECT = 'proj_8f9cb1aeea005c54dd52af005dc92627';
const token = process.env.SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET;
if (!token || !secret) { console.error('need SESSION_TOKEN and BETTER_AUTH_SECRET'); process.exit(3); }

function signCookieValue(value: string): string {
	const sig = createHmac('sha256', secret!).update(value).digest('base64');
	return encodeURIComponent(`${value}.${sig}`);
}
const cookie = `better-auth.session_token=${signCookieValue(token)}`;
const H = { cookie, 'content-type': 'application/json' } as const;

async function snap(tag: string) {
	const r = await fetch(`${BASE}/api/projects/${PROJECT}/workflow`, { headers: { cookie } });
	const j = await r.json().catch(() => null);
	console.log(`${tag}: http=${r.status} phase=${(j as any)?.workflow?.phase} detail=${String((j as any)?.workflow?.detail ?? '').slice(0, 60)}`);
	return (j as any)?.workflow?.phase;
}

async function main() {
	await snap('BEFORE');
	// 1. Stop the stalled build.
	const stop = await fetch(`${BASE}/api/projects/${PROJECT}/workflow/stop`, { method: 'POST', headers: H });
	console.log('STOP http', stop.status, JSON.stringify(await stop.json().catch(() => null))?.slice(0, 160));
	await new Promise((r) => setTimeout(r, 1500));
	await snap('AFTER-STOP');
	// 2. Retry to re-dispatch.
	const key = `livestock-resume-${Date.now()}`;
	const retry = await fetch(`${BASE}/api/projects/${PROJECT}/workflow/retry`, {
		method: 'POST', headers: H, body: JSON.stringify({ key }),
	});
	const rj = await retry.json().catch(() => null);
	console.log('RETRY http', retry.status, 'key', key, 'phase', (rj as any)?.workflow?.phase);
	if (!retry.ok) console.log('retry body:', JSON.stringify(rj)?.slice(0, 200));
	await snap('AFTER-RETRY');
	process.exit(retry.ok ? 0 : 1);
}
main().catch((e) => { console.error('ERROR', e); process.exit(2); });
