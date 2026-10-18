import { describe, expect, test } from 'bun:test';
import type { AppRoute } from '../packages/contracts/src/publish.ts';
import { AppPlatform, appCsp, handleDispatch, hostOnlyCookie, type DispatchEnv } from '../workers/dispatch/src/index.ts';
import { handleOutbound, outboundDecision } from '../workers/dispatch/src/outbound.ts';

/**
 * The dispatch Worker that serves published apps, and its outbound Worker.
 * SIMULATED: handlers called directly under Bun with a fake routing KV and a
 * fake dispatch namespace (Bun has HTMLRewriter, like workerd). Not evidence
 * about Workers for Platforms itself — the live check stays BLOCKED.
 */

const ORIGIN = 'https://caddie.example.com';

function route(overrides: Partial<AppRoute> = {}): AppRoute {
	return {
		v: 1,
		script: 'app-proj-1',
		projectId: 'proj-1',
		slug: 'farmlog',
		status: 'live',
		limits: { cpuMs: 50, subRequests: 50 },
		hasServer: true,
		updatedAt: '2026-10-18T10:00:00.000Z',
		...overrides,
	};
}

function world(routes: Record<string, unknown>, app: (request: Request) => Response | Promise<Response> = () => new Response('ok')) {
	const gets: Array<{ name: string; options: unknown }> = [];
	const args: unknown[] = [];
	const seen: Request[] = [];
	const env: DispatchEnv = {
		ROUTES: { get: async (key: string) => routes[key] ?? null },
		DISPATCHER: {
			get(name, _args, options) {
				gets.push({ name, options });
				args.push(_args);
				if (name === 'missing-script') throw new Error('Worker not found.');
				if (name === 'broken-script') throw new Error('internal: isolate exploded at 0xdeadbeef');
				return {
					fetch: async (request: Request) => {
						seen.push(request);
						return app(request);
					},
				};
			},
		},
		CADDIE_ORIGIN: ORIGIN,
		APPS_DOMAIN: 'caddieapps.com',
	};
	return { env, gets, seen, args };
}

const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

describe('dispatch Worker', () => {
	test("an app with a server gets env.CADDIE for its own project; a static app gets none", async () => {
		const { env, args } = world({
			'route:farmlog.caddieapps.com': route(),
			'route:poster.caddieapps.com': route({ slug: 'poster', script: 'app-poster', projectId: 'proj-2', hasServer: false }),
		});
		const forwarded: unknown[][] = [];
		env.CADDIE_PLATFORM = {
			ai: async (projectId, request) => { forwarded.push([projectId, request]); return { ok: true, text: 'Try soup.' }; },
			signInCode: async (projectId, request) => { forwarded.push(['code', projectId, request]); return { ok: true }; },
		};
		const made: Array<{ projectId: string }> = [];
		const ctx = {
			exports: {
				AppPlatform: (options: { props: { projectId: string } }) => {
					made.push(options.props);
					return new AppPlatform({ props: options.props } as never, env);
				},
			},
		};
		await handleDispatch(new Request('https://farmlog.caddieapps.com/api/ask'), env, ctx);
		await handleDispatch(new Request('https://poster.caddieapps.com/'), env, ctx);
		expect(made).toEqual([{ projectId: 'proj-1' }]);
		expect(args[1]).toEqual({});
		const platform = (args[0] as { props: { CADDIE: AppPlatform } }).props.CADDIE;
		expect(platform).toBeInstanceOf(AppPlatform);
		// Each call reaches Caddie with the route's project, whatever the app sends.
		const request = { messages: [{ role: 'user', content: 'Dinner?' }], projectId: 'proj-2' };
		expect(await platform.ai(request)).toEqual({ ok: true, text: 'Try soup.' });
		expect(await platform.signInCode({ email: 'ada@example.com', code: '123456' })).toEqual({ ok: true });
		expect(forwarded).toEqual([['proj-1', request], ['code', 'proj-1', { email: 'ada@example.com', code: '123456' }]]);
		// Without the binding the app gets a plain no, not a crash.
		delete env.CADDIE_PLATFORM;
		expect(await platform.ai(request)).toMatchObject({ ok: false, reason: 'unavailable' });
		expect(await platform.signInCode({ email: 'ada@example.com', code: '123456' })).toMatchObject({ ok: false, reason: 'unavailable' });
	});

	test('health and reserved paths never reach an app', async () => {
		const { env, gets } = world({ 'route:farmlog.caddieapps.com': route() });
		const health = await handleDispatch(new Request('https://farmlog.caddieapps.com/__caddie/health'), env);
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true });
		const reserved = await handleDispatch(new Request('https://farmlog.caddieapps.com/__caddie/admin'), env);
		expect(reserved.status).toBe(404);
		expect(gets).toEqual([]);
	});

	test('missing, unpublished and taken-down apps get plain pages, never cached', async () => {
		const { env, gets } = world({
			'route:paused.caddieapps.com': route({ slug: 'paused', status: 'paused' }),
			'route:bad.caddieapps.com': route({ slug: 'bad-app', status: 'blocked' }),
		});
		const missing = await handleDispatch(new Request('https://nothing.caddieapps.com/'), env);
		expect(missing.status).toBe(404);
		expect(await missing.text()).toContain('No app lives at this address.');
		const paused = await handleDispatch(new Request('https://paused.caddieapps.com/'), env);
		expect(paused.status).toBe(404);
		expect(await paused.text()).toContain("This app isn't published right now.");
		const blocked = await handleDispatch(new Request('https://BAD.caddieapps.com./anything'), env);
		expect(blocked.status).toBe(451);
		const page = await blocked.text();
		expect(page).toContain("This app was taken down for breaking Caddie's rules.");
		expect(page).toContain('href="https://caddie.example.com/report?app=bad-app"');
		for (const res of [missing, paused, blocked]) {
			expect(res.headers.get('cache-control')).toBe('no-store');
			expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
			expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		}
		expect(gets).toEqual([]);
	});

	test("a live app gets its route's limits and its project/slug for the outbound Worker; Caddie's headers are stripped", async () => {
		const { env, gets, seen } = world({ 'route:farmlog.caddieapps.com': route({ limits: { cpuMs: 30, subRequests: 20 } }) });
		const res = await handleDispatch(
			new Request('https://farmlog.caddieapps.com/api/notes?x=1', { headers: { 'x-caddie-actor': 'admin', 'X-Caddie-Trust': 'yes', accept: 'application/json' } }),
			env,
		);
		expect(res.status).toBe(200);
		expect(gets).toEqual([{ name: 'app-proj-1', options: { limits: { cpuMs: 30, subRequests: 20 }, outbound: { projectId: 'proj-1', slug: 'farmlog' } } }]);
		expect(seen[0]!.url).toBe('https://farmlog.caddieapps.com/api/notes?x=1');
		expect(seen[0]!.headers.get('x-caddie-actor')).toBeNull();
		expect(seen[0]!.headers.get('x-caddie-trust')).toBeNull();
		expect(seen[0]!.headers.get('accept')).toBe('application/json');
	});

	test('a script that is gone is a 404; any other failure is a 502 that hides internals', async () => {
		const { env } = world({
			'route:gone.caddieapps.com': route({ script: 'missing-script' }),
			'route:broken.caddieapps.com': route({ script: 'broken-script' }),
			'route:junk.caddieapps.com': { v: 9, nonsense: true },
		});
		const gone = await handleDispatch(new Request('https://gone.caddieapps.com/'), env);
		expect(gone.status).toBe(404);
		const broken = await handleDispatch(new Request('https://broken.caddieapps.com/'), env);
		expect(broken.status).toBe(502);
		const text = await broken.text();
		expect(text).toContain("This app couldn't load right now.");
		expect(text).not.toContain('0xdeadbeef');
		const junk = await handleDispatch(new Request('https://junk.caddieapps.com/'), env);
		expect(junk.status).toBe(502);
	});

	test("HTML gets Caddie's CSP appended, the badge exactly once, and host-only cookies", async () => {
		const { env } = world({ 'route:farmlog.caddieapps.com': route() }, () => {
			const res = html('<!doctype html><html><head><title>Farm</title></head><body><h1>Farm log</h1></body></html>', {
				'content-security-policy': "img-src 'self'",
				'content-length': '84',
			});
			res.headers.append('set-cookie', 'sid=abc; Domain=caddieapps.com; Path=/; HttpOnly; Secure');
			res.headers.append('set-cookie', 'theme=dark; Path=/; domain=.caddieapps.com');
			return res;
		});
		const res = await handleDispatch(new Request('https://farmlog.caddieapps.com/'), env);
		const csp = res.headers.get('content-security-policy')!;
		expect(csp).toContain("img-src 'self'"); // the app's own policy is kept
		expect(csp).toContain(appCsp(ORIGIN)); // Caddie's is added on top
		expect(appCsp(ORIGIN)).toContain("connect-src 'self'");
		expect(appCsp(ORIGIN)).toContain("form-action 'self'");
		expect(appCsp(ORIGIN)).toContain(`frame-ancestors 'self' ${ORIGIN}`);
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
		expect(res.headers.get('content-length')).toBeNull();
		expect(res.headers.getSetCookie()).toEqual(['sid=abc; Path=/; HttpOnly; Secure', 'theme=dark; Path=/']);
		const body = await res.text();
		expect(body.match(/data-caddie-badge/g)).toHaveLength(1);
		expect(body).toContain('href="https://caddie.example.com/report?app=farmlog"');
		expect(body).toContain('rel="noopener"');
		expect(body.indexOf('data-caddie-badge')).toBeLessThan(body.indexOf('</body>'));
	});

	test('a page with two body tags or none still gets one badge; JSON and HEAD get none', async () => {
		const pages: Record<string, () => Response> = {
			'/double': () => html('<body>one</body><body>two</body>'),
			'/fragment': () => html('<h1>No body tag</h1>'),
			'/api/data': () => Response.json({ ok: true }),
		};
		const { env } = world({ 'route:farmlog.caddieapps.com': route() }, (request) => pages[new URL(request.url).pathname]!());
		for (const path of ['/double', '/fragment']) {
			const text = await (await handleDispatch(new Request(`https://farmlog.caddieapps.com${path}`), env)).text();
			expect(text.match(/data-caddie-badge/g)).toHaveLength(1);
		}
		const json = await handleDispatch(new Request('https://farmlog.caddieapps.com/api/data'), env);
		expect(json.headers.get('content-security-policy')).toBeNull();
		expect(json.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await json.json()).toEqual({ ok: true });
		const head = await handleDispatch(new Request('https://farmlog.caddieapps.com/fragment', { method: 'HEAD' }), env);
		expect(head.headers.get('content-security-policy')).toContain("script-src 'self'");
		expect(await head.text()).toBe('');
	});

	test('cookie attributes other than Domain survive', () => {
		expect(hostOnlyCookie('a=b; Domain=x.com; Path=/; SameSite=Lax')).toBe('a=b; Path=/; SameSite=Lax');
		expect(hostOnlyCookie('domain=value-not-attr; Path=/')).toBe('domain=value-not-attr; Path=/');
	});
});

describe('outbound Worker', () => {
	test('it applies the shared egress policy, with the project in each log line and no query strings', async () => {
		const lines: string[] = [];
		const upstream = async (request: Request) => new Response(`upstream ${request.url}`);
		const env = { projectId: 'proj-1', slug: 'farmlog', CADDIE_ORIGIN: ORIGIN, APPS_DOMAIN: 'caddieapps.com', DENY_HOSTS: 'blocked.example' };
		const allowed = await handleOutbound(new Request('https://api.weather.example.com/v1?key=k-secret'), env, upstream, (l) => lines.push(l));
		expect(await allowed.text()).toBe('upstream https://api.weather.example.com/v1?key=k-secret');
		for (const target of ['http://10.0.0.1/', 'https://caddie.example.com/api/projects', 'https://other.caddieapps.com/', 'https://x.blocked.example/']) {
			const denied = await handleOutbound(new Request(target), env, upstream, (l) => lines.push(l));
			expect(denied.status).toBe(403);
			expect((await denied.json()).error).toBe('egress_denied');
		}
		expect(lines).toHaveLength(5);
		expect(JSON.parse(lines[0]!)).toEqual({ kind: 'app-egress', projectId: 'proj-1', slug: 'farmlog', method: 'GET', host: 'api.weather.example.com', decision: 'allow', hop: 0 });
		expect(lines.join('\n')).not.toContain('k-secret');
	});

	test('the decision table the dispatch brief names', () => {
		const deny = (url: string) => !outboundDecision(new URL(url)).allow;
		for (const url of ['http://[::1]/', 'http://[fc00::1]/', 'http://169.254.1.1/', 'http://100.64.0.1/', 'http://10.1.1.1/', 'http://172.16.5.5/', 'http://192.168.0.10/', 'http://3232235521/', 'http://0xC0A80001/']) {
			expect(deny(url)).toBe(true);
		}
		expect(deny('https://api.example.com/')).toBe(false);
	});
});
