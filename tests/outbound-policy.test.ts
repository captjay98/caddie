import { describe, expect, test } from 'bun:test';
import { egressDenyHosts, fetchWithPolicy, outboundDecision, parseDenyHosts } from '../apps/app/src/server/outbound-policy.ts';

/**
 * Caddie's egress policy for generated apps' servers. LOCAL VERIFIED (pure
 * function; URLs parsed by the same WHATWG parser workerd uses).
 */

const decide = (url: string, deny: string[] = []) => {
	const d = outboundDecision(new URL(url), deny);
	return d.allow ? 'allow' : d.reason;
};

describe('egress policy', () => {
	test('ordinary public APIs are allowed', () => {
		for (const url of [
			'https://api.openweathermap.org/data/2.5/weather?q=Kano',
			'https://api.stripe.com/v1/charges',
			'http://example.com/',
			'https://8.8.8.8/',
			'https://[2606:4700:4700::1111]/',
			'https://sub.domain.example.co.uk:8443/path',
		]) {
			expect(decide(url)).toBe('allow');
		}
	});

	test('non-web schemes are refused', () => {
		for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'ws://example.com/', 'data:text/plain,hi', 'gopher://example.com/']) {
			expect(decide(url)).toBe('scheme');
		}
	});

	test('private and special IPv4 ranges are refused, in every spelling the URL parser accepts', () => {
		for (const url of [
			'http://127.0.0.1/',
			'http://127.255.255.254/',
			'http://10.0.0.1/',
			'http://172.16.0.1/',
			'http://172.31.255.255/',
			'http://192.168.1.1/',
			'http://169.254.169.254/latest/meta-data/',
			'http://100.64.0.1/',
			'http://100.127.255.255/',
			'http://0.0.0.0/',
			'http://198.18.0.1/',
			'http://224.0.0.1/',
			'http://255.255.255.255/',
			'http://2130706433/', // decimal 127.0.0.1
			'http://0x7f.1/', // hex + short form
			'http://017700000001/', // octal
			'http://0x0a.0.0.1/',
			'http://127.1/',
		]) {
			expect(decide(url)).toBe('private-address');
		}
		// Neighbours of the ranges stay public.
		for (const url of ['http://172.32.0.1/', 'http://100.128.0.1/', 'http://11.0.0.1/', 'http://192.169.0.1/', 'http://169.255.0.1/']) {
			expect(decide(url)).toBe('allow');
		}
	});

	test('private and special IPv6 forms are refused, including every IPv4-embedding form', () => {
		for (const url of [
			'http://[::1]/',
			'http://[::]/',
			'http://[0:0:0:0:0:0:0:1]/',
			'http://[fc00::1]/',
			'http://[fd12:3456:789a::1]/',
			'http://[fe80::1]/',
			'http://[febf::1]/',
			'http://[fec0::1]/',
			'http://[ff02::1]/',
			'http://[::ffff:127.0.0.1]/', // the parser rewrites this to ::ffff:7f00:1
			'http://[::ffff:a9fe:a9fe]/', // 169.254.169.254, mapped
			'http://[::127.0.0.1]/', // IPv4-compatible
			'http://[64:ff9b::7f00:1]/', // NAT64
			'http://[2002:7f00:1::]/', // 6to4
			'http://[2001:db8::1]/',
			'http://[100::1]/',
		]) {
			expect(decide(url)).toBe('private-address');
		}
	});

	test('local names are refused, with or without a trailing dot', () => {
		for (const url of [
			'http://localhost/',
			'http://LOCALHOST:8787/',
			'http://localhost./',
			'http://app.localhost/',
			'http://printer.local/',
			'http://db.internal/',
			'http://metadata.google.internal/computeMetadata/v1/',
			'http://router.home.arpa/',
			'http://intranet/',
		]) {
			expect(decide(url)).toBe('local-name');
		}
	});

	test("Caddie's own hosts and the apps domain are refused, exactly and as subdomains", () => {
		const deny = egressDenyHosts({ BETTER_AUTH_URL: 'https://caddie.example.com', APPS_DOMAIN: 'caddieapps.com', EGRESS_DENY_HOSTS: ' Extra.Example.org , ' });
		expect(deny.sort()).toEqual(['caddie.example.com', 'caddieapps.com', 'extra.example.org']);
		expect(decide('https://caddie.example.com/api/projects', deny)).toBe('denied-host');
		expect(decide('https://farmlog.caddieapps.com/api/notes', deny)).toBe('denied-host');
		expect(decide('https://caddieapps.com./', deny)).toBe('denied-host');
		expect(decide('https://deep.sub.extra.example.org/', deny)).toBe('denied-host');
		// A host that merely ends with the same letters is someone else's.
		expect(decide('https://notcaddieapps.com/', deny)).toBe('allow');
		expect(decide('https://example.com/', deny)).toBe('allow');
	});

	test('deny lists tolerate blanks and junk', () => {
		expect(parseDenyHosts(undefined)).toEqual([]);
		expect(parseDenyHosts(' , ,a.com,')).toEqual(['a.com']);
		expect(egressDenyHosts({ BETTER_AUTH_URL: 'not a url' })).toEqual([]);
	});
});

describe('policy-checked fetch', () => {
	type Seen = { method: string; url: string; auth: string | null; body: string | null };
	function upstreamFrom(routes: Record<string, (req: Request) => Response>) {
		const seen: Seen[] = [];
		const upstream = async (req: Request) => {
			seen.push({ method: req.method, url: req.url, auth: req.headers.get('authorization'), body: req.body ? await req.text() : null });
			const handler = routes[req.url];
			return handler ? handler(req) : new Response('no route', { status: 404 });
		};
		return { seen, upstream };
	}
	const redirect = (status: number, location: string) => () => new Response(null, { status, headers: { location } });

	test('an allowed request goes out once, with its body and headers', async () => {
		const { seen, upstream } = upstreamFrom({ 'https://api.example.com/v1/items': () => Response.json({ ok: true }, { status: 201 }) });
		const res = await fetchWithPolicy(
			new Request('https://api.example.com/v1/items', { method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: '{"a":1}' }),
			{ denyHosts: [], upstream },
		);
		expect(res.status).toBe(201);
		expect(seen).toEqual([{ method: 'POST', url: 'https://api.example.com/v1/items', auth: 'Bearer k', body: '{"a":1}' }]);
	});

	test('a denied request never leaves, and the app gets a plain 403', async () => {
		const { seen, upstream } = upstreamFrom({});
		const res = await fetchWithPolicy(new Request('http://169.254.169.254/latest/meta-data/'), { denyHosts: [], upstream });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: 'egress_denied', reason: 'private-address', message: 'Apps cannot reach private or local network addresses.' });
		expect(seen).toEqual([]);
	});

	test('every redirect hop is checked: an allowed site cannot bounce the app to a private address', async () => {
		const { seen, upstream } = upstreamFrom({ 'https://public.example.com/start': redirect(302, 'http://10.0.0.5/admin') });
		const res = await fetchWithPolicy(new Request('https://public.example.com/start'), { denyHosts: [], upstream });
		expect(res.status).toBe(403);
		expect(seen.map((s) => s.url)).toEqual(['https://public.example.com/start']);
	});

	test('allowed redirects are followed; credentials are dropped when the origin changes', async () => {
		const { seen, upstream } = upstreamFrom({
			'https://a.example.com/one': redirect(301, '/two'),
			'https://a.example.com/two': redirect(307, 'https://b.example.org/three'),
			'https://b.example.org/three': () => new Response('done'),
		});
		const res = await fetchWithPolicy(new Request('https://a.example.com/one', { headers: { authorization: 'Bearer k' } }), { denyHosts: [], upstream });
		expect(await res.text()).toBe('done');
		expect(seen.map((s) => [s.url, s.auth])).toEqual([
			['https://a.example.com/one', 'Bearer k'],
			['https://a.example.com/two', 'Bearer k'],
			['https://b.example.org/three', null],
		]);
	});

	test('303 (and 302 after POST) becomes a bodiless GET; a 307 that needs the body back is handed to the app', async () => {
		const { seen, upstream } = upstreamFrom({
			'https://pay.example.com/charge': redirect(303, 'https://pay.example.com/receipt'),
			'https://pay.example.com/receipt': () => new Response('receipt'),
			'https://pay.example.com/moved': redirect(307, 'https://pay.example.com/charge2'),
		});
		const post = (url: string) => new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'amount=5' });
		const receipt = await fetchWithPolicy(post('https://pay.example.com/charge'), { denyHosts: [], upstream });
		expect(await receipt.text()).toBe('receipt');
		expect(seen.map((s) => [s.method, s.url, s.body])).toEqual([
			['POST', 'https://pay.example.com/charge', 'amount=5'],
			['GET', 'https://pay.example.com/receipt', null],
		]);
		const moved = await fetchWithPolicy(post('https://pay.example.com/moved'), { denyHosts: [], upstream });
		expect(moved.status).toBe(307);
		expect(moved.headers.get('location')).toBe('https://pay.example.com/charge2');
	});

	test('redirect limits and modes behave like fetch', async () => {
		const loop = upstreamFrom({ 'https://loop.example.com/': redirect(302, 'https://loop.example.com/') });
		await expect(fetchWithPolicy(new Request('https://loop.example.com/'), { denyHosts: [], upstream: loop.upstream, maxRedirects: 3 })).rejects.toThrow('redirected too many times');
		expect(loop.seen).toHaveLength(4);
		const manual = await fetchWithPolicy(new Request('https://loop.example.com/', { redirect: 'manual' }), { denyHosts: [], upstream: loop.upstream });
		expect(manual.status).toBe(302);
		await expect(fetchWithPolicy(new Request('https://loop.example.com/', { redirect: 'error' }), { denyHosts: [], upstream: loop.upstream })).rejects.toThrow(TypeError);
	});

	test('the log names method, host and decision only — never paths, queries, headers or bodies', async () => {
		const { upstream } = upstreamFrom({ 'https://api.example.com/v1/search?q=secret-term&key=k123': () => new Response('ok') });
		const lines: unknown[] = [];
		await fetchWithPolicy(new Request('https://api.example.com/v1/search?q=secret-term&key=k123', { headers: { authorization: 'Bearer k123' } }), { denyHosts: [], upstream, log: (e) => lines.push(e) });
		await fetchWithPolicy(new Request('http://localhost:8080/x?key=k123'), { denyHosts: [], upstream, log: (e) => lines.push(e) });
		expect(lines).toEqual([
			{ method: 'GET', host: 'api.example.com', decision: 'allow', hop: 0 },
			{ method: 'GET', host: 'localhost', decision: 'deny', reason: 'local-name', hop: 0 },
		]);
		expect(JSON.stringify(lines)).not.toContain('k123');
	});
});
