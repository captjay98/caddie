import { describe, expect, test } from 'bun:test';
import {
	assertLocalBase,
	CookieJar,
	DevClient,
	HostNotLocalError,
	type AccountProfile,
	type FetchLike,
} from '../scripts/brief-run/dev-client.ts';

/**
 * LANE 8 STEP 1 — the local dev-server client. Strictly OFFLINE: every network
 * hop goes through an injected fake fetch, so no real request is ever made.
 */

// --- host guard --------------------------------------------------------------

describe('host guard: only 127.0.0.1 / localhost (step 1)', () => {
	test('accepts the local bases and normalises to an origin', () => {
		expect(assertLocalBase('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
		expect(assertLocalBase('http://localhost:5173/')).toBe('http://localhost:5173');
	});

	test('refuses any other host, including a private LAN address', () => {
		for (const bad of ['https://caddie.example.com', 'http://10.0.0.5:5173', 'http://169.254.1.1', 'http://0.0.0.0:5173']) {
			expect(() => assertLocalBase(bad)).toThrow(HostNotLocalError);
		}
	});

	test('the DevClient constructor refuses a non-local base', () => {
		expect(() => new DevClient('https://app.caddie.dev', async () => new Response())).toThrow(HostNotLocalError);
	});
});

// --- cookie jar --------------------------------------------------------------

describe('cookie jar (step 1)', () => {
	test('absorbs Set-Cookie and serialises it, last-write-wins', () => {
		const jar = new CookieJar();
		jar.absorb(new Response(null, { headers: { 'set-cookie': 'session=abc; Path=/; HttpOnly' } }));
		jar.absorb(new Response(null, { headers: { 'set-cookie': 'csrf=xyz; Path=/' } }));
		expect(jar.has('session')).toBe(true);
		expect(jar.has('csrf')).toBe(true);
		expect(jar.header()).toContain('session=abc');
		expect(jar.header()).toContain('csrf=xyz');
	});
});

// --- two-account sign-in through the stub OAuth flow -------------------------

/**
 * A fake dev server: the social sign-in start returns a local authorize URL;
 * the authorize URL redirects to a local callback; the callback sets the
 * account's session cookie. Two accounts get two cookies. No real network.
 */
function fakeDevServer(base: string): { fetch: FetchLike; requests: string[] } {
	const requests: string[] = [];
	const fetch: FetchLike = async (input, init) => {
		const url = new URL(input);
		requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
		if (url.pathname === '/api/auth/sign-in/social') {
			const body = JSON.parse(String(init?.body ?? '{}')) as { requestProfile?: { sub?: string } };
			const sub = body.requestProfile?.sub ?? 'unknown';
			return Response.json({ url: `${base}/stub/authorize?sub=${sub}` });
		}
		if (url.pathname === '/stub/authorize') {
			const sub = url.searchParams.get('sub') ?? 'unknown';
			return new Response(null, { status: 302, headers: { location: `${base}/api/auth/callback/google?code=${sub}` } });
		}
		if (url.pathname === '/api/auth/callback/google') {
			const sub = url.searchParams.get('code') ?? 'unknown';
			return new Response(null, { status: 302, headers: { 'set-cookie': `session=sess-${sub}; Path=/; HttpOnly` } });
		}
		return new Response('not found', { status: 404 });
	};
	return { fetch, requests };
}

const A: AccountProfile = { label: 'A', sub: 'alice', email: 'a@example.com', name: 'Alice' };
const B: AccountProfile = { label: 'B', sub: 'bob', email: 'b@example.com', name: 'Bob' };

describe('two-account test sign-in (step 1)', () => {
	test('signs in A and B, each with its own session cookie', async () => {
		const base = 'http://127.0.0.1:5173';
		const server = fakeDevServer(base);
		const client = new DevClient(base, server.fetch);

		const sessionA = await client.signIn(A);
		const sessionB = await client.signIn(B);

		expect(sessionA.label).toBe('A');
		expect(sessionB.label).toBe('B');
		// Each account's jar carries ITS OWN session (A ≠ B).
		expect(sessionA.jar.has('session')).toBe(true);
		expect(sessionB.jar.has('session')).toBe(true);
		expect(sessionA.jar.header()).toContain('session=sess-alice');
		expect(sessionB.jar.header()).toContain('session=sess-bob');

		// The flow hit start → authorize → callback for each account.
		expect(server.requests).toContain('POST /api/auth/sign-in/social');
		expect(server.requests).toContain('GET /stub/authorize');
		expect(server.requests).toContain('GET /api/auth/callback/google');
	});

	test("an account's fetch carries its own cookie to the app", async () => {
		const base = 'http://127.0.0.1:5173';
		let sawCookie: string | null | undefined = null;
		const server = fakeDevServer(base);
		const fetchSpy: FetchLike = async (input, init) => {
			const url = new URL(input);
			if (url.pathname === '/api/projects') {
				sawCookie = new Headers(init?.headers).get('cookie');
				return Response.json({ id: 'proj_1' });
			}
			return server.fetch(input, init);
		};
		const client = new DevClient(base, fetchSpy);
		const sessionA = await client.signIn(A);
		await sessionA.json('/api/projects', { method: 'POST', body: '{}' });
		expect(String(sawCookie)).toContain('session=sess-alice');
	});

	test('sign-in start failure is surfaced, not swallowed', async () => {
		const base = 'http://127.0.0.1:5173';
		const client = new DevClient(base, async () => new Response('no', { status: 500 }));
		await expect(client.signIn(A)).rejects.toThrow(/sign-in start/);
	});
});
