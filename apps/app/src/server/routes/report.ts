import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { ABUSE_CATEGORIES, fileAbuseReport, REPORT_DETAILS_MAX, type AbuseCategory, type OperatorNotifier } from '../abuse-reports.ts';
import { appsDomainOf, operatorNotifierFromEnv, type PublishEnv } from '../publish-env.ts';
import { ScopeError } from '../scope.ts';

/**
 * The public "Report an app" page every published app links to
 * (`/report?app=<slug>`). A plain HTML form — no scripts, works everywhere —
 * served by Caddie's Worker (wrangler run_worker_first includes /report).
 *
 *   GET  /report?app=<slug>   the form
 *   POST /report              file the report (form-encoded), answer with a
 *                             thank-you page, email the abuse inbox
 *
 * Anyone may report; there is no session. Spam controls: same-origin posts
 * only, a hidden honeypot field, and at most 5 reports per visitor per hour,
 * counted by a keyed hash of the visitor's IP and the day (the IP itself is
 * never stored).
 */

type Env = AuthEnv & PublishEnv & { BETTER_AUTH_SECRET?: string };

export interface ReportRouterOptions {
	notifierFor?: (env: Env) => OperatorNotifier;
}

const CATEGORY_LABELS: Record<AbuseCategory, string> = {
	phishing: 'It asks for passwords, bank or card details',
	malware: 'It tries to install something harmful',
	scam: 'It is a scam or fraud',
	illegal: 'It shows illegal content',
	other: 'Something else',
};

const PAGE_HEADERS = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
	'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
} as const;

function escapeText(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
	return escapeText(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeText(title)} · Caddie</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f7f5;color:#1c1c1a}
main{max-width:34rem;margin:0 auto;padding:1.5rem 1rem 3rem}
h1{font-size:1.5rem;margin:.5rem 0}
p{margin:.5rem 0}
form{display:grid;gap:1rem;margin-top:1rem}
label,legend{font-weight:600}
fieldset{border:0;margin:0;padding:0;display:grid;gap:.4rem}
.choice{display:flex;gap:.5rem;align-items:flex-start;font-weight:400}
input[type=text],input[type=email],textarea{font:inherit;width:100%;box-sizing:border-box;padding:.55rem .65rem;border:1px solid #b9b9b2;border-radius:8px;background:#fff;color:inherit}
textarea{min-height:8rem}
.field{display:grid;gap:.3rem}
.hint{font-size:.9rem;color:#5c5c56;font-weight:400}
.address{display:flex;align-items:center;gap:.25rem}
.address span{white-space:nowrap;color:#5c5c56}
button{font:inherit;font-weight:600;padding:.6rem 1.1rem;border-radius:8px;border:0;background:#1a5fb4;color:#fff;cursor:pointer;justify-self:start}
.error{color:#a51d2d;font-weight:600}
.trap{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
@media (prefers-color-scheme:dark){body{background:#151513;color:#ecece8}input[type=text],input[type=email],textarea{background:#22221f;border-color:#55554f}.hint,.address span{color:#a8a8a0}.error{color:#ff7b72}button{background:#3584e4}}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

interface FormValues {
	app: string;
	category: string;
	details: string;
	email: string;
}

function formPage(values: FormValues, appsDomain: string | null, error: string | null): string {
	const choices = ABUSE_CATEGORIES.map(
		(category) =>
			`<label class="choice"><input type="radio" name="category" value="${category}" required${values.category === category ? ' checked' : ''}> ${escapeText(CATEGORY_LABELS[category])}</label>`,
	).join('\n');
	return page(
		'Report an app',
		`<h1>Report an app</h1>
<p>Tell Caddie about an app made with Caddie that tricks people, steals information or breaks the law. A person reads every report within a day.</p>
${error ? `<p class="error" role="alert">${escapeText(error)}</p>` : ''}
<form method="post" action="/report">
<div class="field">
<label for="app">App address</label>
<div class="address"><input type="text" id="app" name="app" value="${escapeAttr(values.app)}" required maxlength="64" autocomplete="off" spellcheck="false">${appsDomain ? `<span>.${escapeText(appsDomain)}</span>` : ''}</div>
</div>
<fieldset>
<legend>What is wrong with it?</legend>
${choices}
</fieldset>
<div class="field">
<label for="details">What did you see?</label>
<textarea id="details" name="details" required maxlength="${REPORT_DETAILS_MAX}">${escapeText(values.details)}</textarea>
</div>
<div class="field">
<label for="email">Your email <span class="hint">(optional — only if you want a reply)</span></label>
<input type="email" id="email" name="email" value="${escapeAttr(values.email)}" maxlength="254" autocomplete="email">
</div>
<div class="trap" aria-hidden="true"><label for="website">Leave this empty</label><input type="text" id="website" name="website" tabindex="-1" autocomplete="off"></div>
<button type="submit">Send report</button>
</form>`,
	);
}

function thanksPage(): string {
	return page(
		'Thank you',
		`<h1>Thank you</h1>
<p>Your report reached Caddie. A person will look at the app within a day, and take it down if it breaks Caddie's rules.</p>`,
	);
}

/** A keyed, daily-rotating hash of the visitor's IP: enough to rate-limit, useless to identify them. */
async function reporterHash(secret: string, ip: string, now: Date): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret || 'caddie-report'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ip}|${now.toISOString().slice(0, 10)}`)));
	return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	if (origin && origin !== 'null') return origin === new URL(request.url).origin;
	const site = request.headers.get('sec-fetch-site');
	return !site || site === 'same-origin' || site === 'none';
}

export function createReportRouter(options: ReportRouterOptions = {}): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	const notifierFor = options.notifierFor ?? ((env: Env) => operatorNotifierFromEnv(env));

	router.get('/report', (c) => {
		const app = (c.req.query('app') ?? '').trim().toLowerCase().slice(0, 64);
		return c.body(formPage({ app, category: '', details: '', email: '' }, appsDomainOf(c.env), null), 200, PAGE_HEADERS);
	});

	router.post('/report', async (c) => {
		const request = c.req.raw;
		if (!sameOrigin(request)) return c.body(page('Report an app', '<h1>Report an app</h1><p>Open this page from the Report link and send the form from there.</p>'), 403, PAGE_HEADERS);
		const declared = Number(request.headers.get('content-length') ?? '0');
		if (declared > 16 * 1024) return c.body(page('Report an app', '<h1>Report an app</h1><p>That report is too long.</p>'), 413, PAGE_HEADERS);
		let form: URLSearchParams;
		try {
			const text = await request.text();
			if (text.length > 16 * 1024) return c.body(page('Report an app', '<h1>Report an app</h1><p>That report is too long.</p>'), 413, PAGE_HEADERS);
			form = new URLSearchParams(text);
		} catch {
			return c.body(formPage({ app: '', category: '', details: '', email: '' }, appsDomainOf(c.env), "Caddie couldn't read that form. Try again."), 400, PAGE_HEADERS);
		}
		const values: FormValues = {
			app: (form.get('app') ?? '').trim().toLowerCase().slice(0, 64),
			category: form.get('category') ?? '',
			details: (form.get('details') ?? '').slice(0, REPORT_DETAILS_MAX),
			email: (form.get('email') ?? '').trim().slice(0, 254),
		};
		// The honeypot: people never see this field; a bot that fills it gets a thank-you and nothing is stored.
		if ((form.get('website') ?? '').trim() !== '') return c.body(thanksPage(), 200, PAGE_HEADERS);
		try {
			const hash = await reporterHash(c.env.BETTER_AUTH_SECRET ?? '', request.headers.get('cf-connecting-ip') ?? 'unknown', new Date());
			await fileAbuseReport(
				c.env.DB,
				{ slug: values.app, source: 'visitor', category: values.category, details: values.details, reporterEmail: values.email, reporterHash: hash },
				notifierFor(c.env),
			);
		} catch (error) {
			if (error instanceof ScopeError) {
				return c.body(formPage(values, appsDomainOf(c.env), error.message), error.status === 429 ? 429 : 400, PAGE_HEADERS);
			}
			console.error('report: filing failed:', error);
			return c.body(formPage(values, appsDomainOf(c.env), "Caddie couldn't save the report just now. Try again in a minute."), 500, PAGE_HEADERS);
		}
		return c.body(thanksPage(), 200, PAGE_HEADERS);
	});

	return router;
}
