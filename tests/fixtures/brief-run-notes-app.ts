/**
 * Lane 8d item 3 — the hand-written fixture app the real browser check drives.
 *
 * It is a tiny GENERATED-shaped app: the react-hono sign-in screen's own labels
 * and /api calls ("Email" / "Email me a code", then "Code" / "Sign in", calling
 * POST /api/auth/code and POST /api/auth/sign-in), a session kept by cookie, and
 * a hash-routed `#/notes` screen with a create form and a per-user list
 * (GET/POST /api/notes). It runs INSIDE the opaque preview frame: its fetch()
 * calls are relayed to the parent (apps/app InteractivePreview), so this app
 * never talks to the network directly — exactly like a real generated app in a
 * Caddie preview.
 *
 * Variants let the spec prove each verdict:
 *   - default: correct, per-user isolation → the check passes;
 *   - leaky: GET /api/notes returns EVERY user's notes → B sees A's note → fail;
 *   - neverSaves: the create form's submit does nothing (no POST, list never
 *     grows) → fail with the plain reason, and the diagnostic API create still
 *     works, so the reason says the FORM is the fault.
 *
 * The server half of this app (sessions, codes, notes) lives in the spec's
 * fixture server, which answers the relayed /api calls; this file is only the
 * CLIENT the frame runs.
 */

export interface NotesAppOptions {
	/** The create form's submit does nothing (no POST): the record never saves. */
	neverSaves?: boolean;
}

/** The fixture app's HTML + client script (served as the frame document body). */
export function notesAppHtml(opts: NotesAppOptions = {}): string {
	const neverSaves = Boolean(opts.neverSaves);
	return `<!doctype html><html><head><title>Notes</title></head><body>
<div id="app"><p>loading…</p></div>
<script>
'use strict';
var NEVER_SAVES = ${neverSaves ? 'true' : 'false'};
var app = document.getElementById('app');

async function api(path, options) {
  var res = await fetch(path, options || {});
  var body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { ok: res.ok, status: res.status, body: body };
}

function h(html) { app.innerHTML = html; }

// --- the sign-in screen (react-hono auth-files.ts labels) -------------------
function renderEmailStep(message) {
  h('<div class="caddie-sign-in"><h2>Sign in</h2><form id="email-form">'
    + '<label for="su-email">Email</label>'
    + '<input id="su-email" type="email" autocomplete="email" required>'
    + '<button type="submit">Email me a code</button></form>'
    + (message ? '<p role="alert">' + message + '</p>' : '') + '</div>');
  document.getElementById('email-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var button = e.target.querySelector('button');
    button.textContent = 'Sending…';
    var email = document.getElementById('su-email').value;
    var out = await api('/api/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email }) });
    if (!out.ok) { renderEmailStep("Couldn't send a code. Try again."); return; }
    renderCodeStep(email);
  });
}

function renderCodeStep(email) {
  h('<div class="caddie-sign-in"><h2>Sign in</h2><form id="code-form">'
    + '<p>We sent a 6-digit code to ' + email + '.</p>'
    + '<label for="su-code">Code</label>'
    + '<input id="su-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>'
    + '<button type="submit">Sign in</button></form></div>');
  document.getElementById('code-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var button = e.target.querySelector('button');
    button.textContent = 'Signing in…';
    var code = document.getElementById('su-code').value;
    var out = await api('/api/auth/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email, code: code }) });
    if (!out.ok || !out.body || !out.body.user) { renderCodeStep(email); return; }
    route();
  });
}

// --- the notes screen (hash-routed #/notes) ---------------------------------
async function renderNotes() {
  var listed = await api('/api/notes');
  var notes = (listed.body && listed.body.notes) || [];
  h('<section><h1>Your notes</h1>'
    + '<form id="note-form"><label for="note-body">Note</label>'
    + '<input id="note-body" type="text" required>'
    + '<button type="submit">Save note</button></form>'
    + '<ul id="notes">' + notes.map(function (n) { return '<li>' + escapeHtml(n.body) + '</li>'; }).join('') + '</ul></section>');
  document.getElementById('note-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    if (NEVER_SAVES) return; // the broken variant: submit does nothing
    var body = document.getElementById('note-body').value;
    await api('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: body }) });
    renderNotes();
  });
}

function escapeHtml(text) { return String(text).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

// --- routing: signed out → sign-in; signed in → the hash screen -------------
async function route() {
  var session = await api('/api/auth/session');
  var signedIn = session.ok && session.body && session.body.user;
  if (!signedIn) { renderEmailStep(); return; }
  var hash = location.hash || '#/';
  if (hash.indexOf('#/notes') === 0) { await renderNotes(); return; }
  h('<section><h1>Welcome</h1><p>Open a screen.</p></section>');
}

window.addEventListener('hashchange', route);
route();
</script></body></html>`;
}
