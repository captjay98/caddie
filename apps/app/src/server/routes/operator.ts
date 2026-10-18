import { Hono } from 'hono';
import type { AuthEnv } from '../auth.ts';
import { listAbuseReports, resolveAbuseReport, type AbuseReportView } from '../abuse-reports.ts';
import { hostnameFor, restoreTakenDownApp, takeDownApp, type PublishDeps } from '../publish.ts';
import { appsDomainOf, publishDepsFromEnv, type PublishEnv } from '../publish-env.ts';
import { ScopeError, sessionUserId } from '../scope.ts';

/**
 * The operator's review page for abuse reports (Publish programme stage 5).
 * Caddie must answer reports within 24 hours; this is where a person does.
 *
 *   GET  /operator/reports                       open reports, then recent ones
 *   POST /operator/reports/:id/resolve           status=actioned|dismissed
 *   POST /operator/apps/:projectId/takedown      reason, report? -> 451 page
 *   POST /operator/apps/:projectId/restore       lift a takedown (app comes back unpublished)
 *
 * Only signed-in users whose email is in OPERATOR_EMAILS get in. A plain,
 * server-rendered page with no scripts; every action is a same-origin form
 * post that redirects back with a short note.
 */

type Env = AuthEnv & PublishEnv & { OPERATOR_EMAILS?: string };

export interface OperatorRouterOptions {
	/** Production: the verified session. Tests substitute a resolver. */
	actorFor?: (env: Env, request: Request) => Promise<{ id: string; email: string } | null>;
	depsFor?: (env: Env) => Promise<PublishDeps | null>;
}

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
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f7f5;color:#1c1c1a}
main{max-width:52rem;margin:0 auto;padding:1.25rem 1rem 3rem}
h1{font-size:1.4rem;margin:.25rem 0 1rem}
h2{font-size:1.05rem;margin:1.5rem 0 .5rem}
ul{list-style:none;margin:0;padding:0;display:grid}
li{padding:.9rem 0;border-top:1px solid #d6d6cf;display:grid;gap:.4rem}
.meta{font-size:.85rem;color:#5c5c56}
.details{white-space:pre-wrap;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:.5rem;align-items:flex-end}
form{display:flex;flex-wrap:wrap;gap:.4rem;align-items:flex-end;margin:0}
input[type=text]{font:inherit;padding:.35rem .5rem;border:1px solid #b9b9b2;border-radius:6px;min-width:16rem;background:#fff;color:inherit}
button{font:inherit;font-weight:600;padding:.35rem .8rem;border-radius:6px;border:1px solid #b9b9b2;background:#fff;color:inherit;cursor:pointer}
button.danger{background:#a51d2d;border-color:#a51d2d;color:#fff}
.note{padding:.5rem .75rem;border-left:3px solid #1a5fb4;background:#e8f0fb}
.tag{display:inline-block;padding:0 .45rem;border-radius:999px;font-size:.8rem;font-weight:600;background:#e3e3dc}
.tag.blocked{background:#f6d5d9;color:#7a1220}
.tag.live{background:#d7efdc;color:#195a29}
@media (prefers-color-scheme:dark){body{background:#151513;color:#ecece8}li{border-color:#3a3a35}.meta{color:#a8a8a0}input[type=text],button{background:#22221f;border-color:#55554f}.note{background:#1d2a3d}.tag{background:#33332e}.tag.blocked{background:#4d1a21;color:#ffb3bb}.tag.live{background:#1d3b24;color:#9fe0ad}}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

function operatorEmails(env: Env): Set<string> {
	return new Set(
		(env.OPERATOR_EMAILS ?? '')
			.split(',')
			.map((email) => email.trim().toLowerCase())
			.filter((email) => email.length > 0),
	);
}

async function sessionActor(env: Env, request: Request): Promise<{ id: string; email: string } | null> {
	const id = await sessionUserId(env, request.headers);
	if (!id) return null;
	const row = (await env.DB.prepare('select "email" from "user" where "id" = ?').bind(id).all<{ email: string }>()).results[0];
	return row ? { id, email: String(row.email) } : null;
}

function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	if (origin && origin !== 'null') return origin === new URL(request.url).origin;
	const site = request.headers.get('sec-fetch-site');
	return !site || site === 'same-origin';
}

function reportItem(report: AbuseReportView, appsDomain: string | null): string {
	const appUrl = appsDomain ? `https://${hostnameFor(report.slug, appsDomain)}/` : null;
	const app = report.app;
	const appState = app ? `<span class="tag ${escapeAttr(app.status)}">${escapeText(app.status === 'blocked' ? 'taken down' : app.status)}</span>` : '<span class="tag">no such app</span>';
	const actions: string[] = [];
	if (report.projectId && app && app.status !== 'blocked') {
		actions.push(`<form method="post" action="/operator/apps/${encodeURIComponent(report.projectId)}/takedown">
<input type="hidden" name="report" value="${escapeAttr(report.id)}">
<label>Reason <input type="text" name="reason" value="${escapeAttr(`Reported for ${report.category}.`)}" maxlength="300" required></label>
<button class="danger" type="submit">Take the app down</button>
</form>`);
	}
	if (report.projectId && app?.status === 'blocked') {
		actions.push(`<form method="post" action="/operator/apps/${encodeURIComponent(report.projectId)}/restore"><button type="submit">Restore the app</button></form>`);
	}
	if (report.status === 'open') {
		actions.push(`<form method="post" action="/operator/reports/${encodeURIComponent(report.id)}/resolve"><input type="hidden" name="status" value="actioned"><button type="submit">Mark handled</button></form>`);
		actions.push(`<form method="post" action="/operator/reports/${encodeURIComponent(report.id)}/resolve"><input type="hidden" name="status" value="dismissed"><button type="submit">Dismiss</button></form>`);
	}
	return `<li data-report="${escapeAttr(report.id)}">
<div><strong>${appUrl ? `<a href="${escapeAttr(appUrl)}" rel="noopener noreferrer nofollow" target="_blank">${escapeText(report.slug)}</a>` : escapeText(report.slug)}</strong> ${appState} · ${escapeText(report.category)} · from ${escapeText(report.source)}</div>
<div class="meta">${escapeText(report.createdAt)}${report.reporterEmail ? ` · ${escapeText(report.reporterEmail)}` : ''}${app?.blockedReason ? ` · down because: ${escapeText(app.blockedReason)}` : ''}${report.status !== 'open' ? ` · ${escapeText(report.status)}${report.resolution ? `: ${escapeText(report.resolution)}` : ''}` : ''}</div>
<div class="details">${escapeText(report.details)}</div>
${actions.length ? `<div class="actions">${actions.join('\n')}</div>` : ''}
</li>`;
}

export function createOperatorRouter(options: OperatorRouterOptions = {}): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	const actorFor = options.actorFor ?? sessionActor;
	const depsFor = options.depsFor ?? ((env: Env) => publishDepsFromEnv(env));

	/** The signed-in operator, or the page that explains why not. */
	async function operator(env: Env, request: Request): Promise<{ id: string; email: string } | Response> {
		const actor = await actorFor(env, request);
		if (!actor) return new Response(page('Sign in', '<h1>Sign in first</h1><p><a href="/app/">Sign in to Caddie</a>, then open this page again.</p>'), { status: 401, headers: PAGE_HEADERS });
		if (!operatorEmails(env).has(actor.email.toLowerCase())) {
			return new Response(page('Not available', "<h1>Not available</h1><p>This page is for Caddie's operators.</p>"), { status: 403, headers: PAGE_HEADERS });
		}
		return actor;
	}

	const back = (note: string) => new Response(null, { status: 303, headers: { location: `/operator/reports?done=${encodeURIComponent(note)}`, 'cache-control': 'no-store' } });
	const refuse = () => new Response(page('Not allowed', '<h1>Not allowed</h1><p>Send this form from the operator page.</p>'), { status: 403, headers: PAGE_HEADERS });

	router.get('/operator/reports', async (c) => {
		const actor = await operator(c.env, c.req.raw);
		if (actor instanceof Response) return actor;
		const appsDomain = appsDomainOf(c.env);
		const open = await listAbuseReports(c.env.DB, { status: 'open', limit: 100 });
		const recent = (await listAbuseReports(c.env.DB, { limit: 40 })).filter((r) => r.status !== 'open').slice(0, 20);
		const done = (c.req.query('done') ?? '').slice(0, 200);
		const body = `<h1>Abuse reports</h1>
${done ? `<p class="note" role="status">${escapeText(done)}</p>` : ''}
<p class="meta">Signed in as ${escapeText(actor.email)}. Answer every report within 24 hours.${c.env.ABUSE_INBOX ? '' : ' No abuse inbox is set (ABUSE_INBOX), so new reports are not emailed.'}</p>
<h2>Open (${open.length})</h2>
${open.length ? `<ul>${open.map((r) => reportItem(r, appsDomain)).join('\n')}</ul>` : '<p>Nothing waiting.</p>'}
<h2>Recently handled</h2>
${recent.length ? `<ul>${recent.map((r) => reportItem(r, appsDomain)).join('\n')}</ul>` : '<p>None yet.</p>'}`;
		return c.body(page('Abuse reports', body), 200, PAGE_HEADERS);
	});

	router.post('/operator/reports/:id/resolve', async (c) => {
		const actor = await operator(c.env, c.req.raw);
		if (actor instanceof Response) return actor;
		if (!sameOrigin(c.req.raw)) return refuse();
		const form = new URLSearchParams(await c.req.raw.text());
		try {
			await resolveAbuseReport(c.env.DB, c.req.param('id'), { status: form.get('status'), note: form.get('note') ?? undefined, by: actor.id });
		} catch (error) {
			if (error instanceof ScopeError) return back(error.message);
			throw error;
		}
		return back(form.get('status') === 'dismissed' ? 'Report dismissed.' : 'Report marked as handled.');
	});

	router.post('/operator/apps/:projectId/takedown', async (c) => {
		const actor = await operator(c.env, c.req.raw);
		if (actor instanceof Response) return actor;
		if (!sameOrigin(c.req.raw)) return refuse();
		const form = new URLSearchParams(await c.req.raw.text());
		const reason = (form.get('reason') ?? '').trim().slice(0, 300) || 'Taken down after review.';
		const deps = await depsFor(c.env);
		if (!deps) return back("Publishing isn't set up on this server, so there is nothing live to take down.");
		const done = await takeDownApp(c.env.DB, deps, c.req.param('projectId'), { by: actor.id, reason });
		if (!done) return back('No published app for that project.');
		const reportId = form.get('report');
		if (reportId) await resolveAbuseReport(c.env.DB, reportId, { status: 'actioned', note: `Taken down: ${reason}`, by: actor.id }).catch(() => undefined);
		return back('The app is down; its address shows the takedown page.');
	});

	router.post('/operator/apps/:projectId/restore', async (c) => {
		const actor = await operator(c.env, c.req.raw);
		if (actor instanceof Response) return actor;
		if (!sameOrigin(c.req.raw)) return refuse();
		const deps = await depsFor(c.env);
		if (!deps) return back("Publishing isn't set up on this server.");
		const done = await restoreTakenDownApp(c.env.DB, deps, c.req.param('projectId'), { by: actor.id });
		return back(done ? 'The takedown is lifted. The owner can publish again.' : 'That app was not taken down.');
	});

	return router;
}
