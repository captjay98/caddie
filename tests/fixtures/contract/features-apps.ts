// Test apps for part E step 9 — the test-mode features (plan parts J, K, L, N):
// payments in test mode, emails to the test inbox, a job only Caddie can run,
// and file uploads. One correct app uses all four the way the starter's files
// and caddie/contract.ts say; each bad app breaks exactly one of them, and the
// generated contract test must catch it in the test-mode phase.
import type { ArchitectureBlock } from '@caddie/contracts';
import { generateSchema } from '../../../apps/app/src/server/schema-gen.ts';
import { appFeatureFiles } from '../../../apps/app/src/server/app-feature-files.ts';
import type { ContractFixture } from './notes-apps.ts';

const r = (
	id: string,
	feature: string,
	op: 'create' | 'read' | 'list' | 'update' | 'delete' | 'action',
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	table: string | null,
	access: string,
	request: Array<{ name: string; type: 'text'; example: string }>,
	response: string[],
) => ({ id, module: 'app', feature, op, method, path, table, plain: id, access, request, response });

export const FEATURES_BLOCK: ArchitectureBlock = {
	version: 2,
	signIn: 'required',
	team: null,
	modules: [{ id: 'app', plain: 'The whole app', dependsOn: [] }],
	tables: [
		{
			name: 'reports',
			module: 'app',
			plain: 'A report you wrote',
			owner: 'person',
			fields: [
				{ name: 'title', type: 'text', references: null },
				{ name: 'attachment', type: 'file', references: null },
			],
		},
	],
	routes: [
		r('reports.create', 'reports', 'create', 'POST', '/api/reports', 'reports', 'person', [{ name: 'title', type: 'text', example: 'Spring harvest' }], ['id', 'title']),
		r('reports.read', 'reports', 'read', 'GET', '/api/reports/:id', 'reports', 'person', [], ['id', 'title']),
		r('reports.list', 'reports', 'list', 'GET', '/api/reports', 'reports', 'person', [], ['id', 'title']),
		r('reports.update', 'reports', 'update', 'PUT', '/api/reports/:id', 'reports', 'person', [{ name: 'title', type: 'text', example: 'Spring harvest, final' }], ['id', 'title']),
		r('reports.delete', 'reports', 'delete', 'DELETE', '/api/reports/:id', 'reports', 'person', [], ['id']),
		// Locked: only a person with the Pro plan can export (part J).
		r('reports.export', 'export', 'action', 'POST', '/api/reports/export', null, 'person', [], ['url']),
		// Sends the "share" email to the address in the request (part K).
		r('reports.share', 'share', 'action', 'POST', '/api/reports/share', null, 'person', [{ name: 'email', type: 'text', example: 'friend@example.com' }], ['sent']),
		// Caddie's Run-now job (part N).
		r('jobs.nightly', 'nightly', 'action', 'POST', '/api/jobs/nightly', null, 'job', [], ['ran']),
	] as ArchitectureBlock['routes'],
	screens: [{ id: 'reports', module: 'app', path: '#/reports', plain: 'Your reports', shows: ['reports'] }],
	services: [],
	ai: [],
	payments: { currency: 'USD', plans: [{ id: 'pro', plain: 'Pro', priceMinor: 900, interval: 'month' }], locked: [{ route: 'reports.export', plans: ['pro'] }] },
	emails: [{ id: 'share', plain: 'Shares a report', route: 'reports.share', to: 'request-field:email' }],
	jobs: [{ id: 'nightly', plain: 'Sums up the day', route: 'jobs.nightly', every: 'day' }],
	screenOnly: [],
};

/** The correct server: every feature through the starter's files and the contract. */
const FEATURES_SERVER = [
	'import { Hono } from "hono";',
	'import type { D1Database } from "../caddie/d1";',
	'import type { CaddiePlatform } from "../caddie/platform";',
	'import { mountSignIn } from "../caddie/auth";',
	'import { mountPayments } from "../caddie/payments";',
	'import { mountFiles } from "../caddie/files";',
	'import { implement, requireUser } from "../caddie/contract";',
	'',
	'export type Env = { DB: D1Database; CADDIE: CaddiePlatform; CADDIE_AUTH_SECRET?: string; CADDIE_JOB_SECRET?: string };',
	'export const app = new Hono<{ Bindings: Env }>().basePath("/api");',
	'app.get("/health", (c) => c.json({ ok: true }));',
	'mountSignIn(app);',
	'mountPayments(app, { currency: "USD", plans: [{ id: "pro", priceMinor: 900, interval: "month" }] });',
	'mountFiles(app);',
	'const now = () => new Date().toISOString();',
	'',
	'implement(app, {',
	'  "reports.create": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { title } = await c.req.json<{ title: string }>();',
	'    const id = crypto.randomUUID();',
	'    await c.env.DB.prepare("insert into reports (id, ownerId, title, createdAt, updatedAt) values (?, ?, ?, ?, ?)").bind(id, user.id, title, now(), now()).run();',
	'    return c.json({ id, title }, 201);',
	'  },',
	'  "reports.read": async (c) => {',
	'    const user = await requireUser(c);',
	'    const row = await c.env.DB.prepare("select id, title from reports where id = ? and ownerId = ?").bind(c.req.param("id"), user.id).first();',
	'    if (!row) return c.json({ error: "Not found." }, 404);',
	'    return c.json(row);',
	'  },',
	'  "reports.list": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { results } = await c.env.DB.prepare("select id, title from reports where ownerId = ? order by createdAt").bind(user.id).all();',
	'    return c.json(results);',
	'  },',
	'  "reports.update": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { title } = await c.req.json<{ title: string }>();',
	'    await c.env.DB.prepare("update reports set title = ?, updatedAt = ? where id = ? and ownerId = ?").bind(title, now(), c.req.param("id"), user.id).run();',
	'    const row = await c.env.DB.prepare("select id, title from reports where id = ? and ownerId = ?").bind(c.req.param("id"), user.id).first();',
	'    return c.json(row);',
	'  },',
	'  "reports.delete": async (c) => {',
	'    const user = await requireUser(c);',
	'    await c.env.DB.prepare("delete from reports where id = ? and ownerId = ?").bind(c.req.param("id"), user.id).run();',
	'    return c.json({ id: c.req.param("id") });',
	'  },',
	'  "reports.export": async (c) => c.json({ url: "/exports/latest.csv" }),',
	'  "reports.share": async (c) => {',
	'    const user = await requireUser(c);',
	'    const { email } = await c.req.json<{ email: string }>();',
	'    const sent = await c.env.CADDIE.email({ to: email, subject: "A report from " + user.email, text: "Here is the report you were sent.", template: "share" });',
	'    return c.json({ sent: sent.ok });',
	'  },',
	'  "jobs.nightly": async (c) => c.json({ ran: 1 }),',
	'});',
	'export default app;',
	'',
].join('\n');

const REPORTS_SCREEN = [
	'import { useEffect, useState } from "react";',
	'import { api } from "../caddie/api";',
	'',
	'export function ReportsScreen() {',
	'  const [titles, setTitles] = useState<string[] | null>(null);',
	'  useEffect(() => {',
	'    api.get<{ id: string; title: string }[]>("/api/reports").then((rows) => setTitles(rows.map((row) => row.title))).catch(() => setTitles([]));',
	'  }, []);',
	'  if (titles === null) return <p>Loading…</p>;',
	'  return <ul>{titles.map((t) => <li key={t}>{t}</li>)}</ul>;',
	'}',
	'',
].join('\n');

const REPORTS_APP = [
	'import { ReportsScreen } from "./ReportsScreen";',
	'',
	'export function App() {',
	'  const hash = typeof location !== "undefined" ? location.hash : "";',
	'  if (hash === "#/reports") return <ReportsScreen />;',
	'  return <main><h1>Your app</h1></main>;',
	'}',
	'',
].join('\n');

/** BAD: the export is mounted straight on the app, before implement(), so the plan lock never runs. */
const LOCK_LEFT_OPEN_SERVER = FEATURES_SERVER.replace(
	'implement(app, {',
	'app.post("/reports/export", async (c) => { await requireUser(c); return c.json({ url: "/exports/latest.csv" }); });\nimplement(app, {',
);

/** BAD: the share email goes to an outside mail service, never the test inbox. */
const EMAIL_OUTSIDE_SERVER = FEATURES_SERVER.replace(
	'const sent = await c.env.CADDIE.email({ to: email, subject: "A report from " + user.email, text: "Here is the report you were sent.", template: "share" });\n    return c.json({ sent: sent.ok });',
	'await fetch("https://mail.example.com/send", { method: "POST", body: JSON.stringify({ to: email, from: user.email }) });\n    return c.json({ sent: true });',
);

/** BAD: the job is mounted straight on the app, so anyone can run it without Caddie's signature. */
const JOB_OPEN_SERVER = FEATURES_SERVER.replace(
	'implement(app, {',
	'app.post("/jobs/nightly", (c) => c.json({ ran: 1 }));\nimplement(app, {',
);

/** BAD: a file part route mounted before mountFiles(), with no owner check, so anyone signed in reads any file. */
const FILE_OPEN_SERVER = FEATURES_SERVER.replace(
	'mountFiles(app);',
	'app.get("/caddie/files/:id/parts/:n", async (c) => {\n  await requireUser(c);\n  const n = Number(c.req.param("n"));\n  const part = await c.env.DB.prepare("select data from caddie_file_parts where fileId = ? and n = ?").bind(c.req.param("id"), n).first<{ data: string }>();\n  if (!part) return c.json({ error: "Not found." }, 404);\n  return c.json({ n, data: part.data });\n});\nmountFiles(app);',
);

/** Only the reports feature is built: no billing, share or job routes yet (scoped check). */
const REPORTS_ONLY_SERVER = FEATURES_SERVER.replace(
	'mountPayments(app, { currency: "USD", plans: [{ id: "pro", priceMinor: 900, interval: "month" }] });\n',
	'',
).replace(/ {2}"reports\.export"[\s\S]*?(?=\}\);\nexport default app;)/, '');

function featureFiles(server: string): Record<string, string> {
	return {
		...appFeatureFiles(FEATURES_BLOCK, { appFeatures: true }),
		'src/server.ts': server,
		'src/ReportsScreen.tsx': REPORTS_SCREEN,
		'src/App.tsx': REPORTS_APP,
		'migrations/0001_schema.sql': generateSchema(FEATURES_BLOCK),
	};
}

export const FEATURE_FIXTURES: readonly ContractFixture[] = [
	{ id: 'features-correct', plain: 'A correct app with a locked export, a share email, a nightly job and file uploads.', mustFail: [], files: featureFiles(FEATURES_SERVER) },
	{ id: 'locked-route-left-open', plain: 'The export is mounted outside implement(), so it opens without a plan.', mustFail: ['test-mode'], files: featureFiles(LOCK_LEFT_OPEN_SERVER) },
	{ id: 'email-sent-outside-caddie', plain: 'The share email goes to an outside mail service instead of the test inbox.', mustFail: ['test-mode'], files: featureFiles(EMAIL_OUTSIDE_SERVER) },
	{ id: 'job-route-open', plain: 'The nightly job is mounted outside implement(), so anyone can run it.', mustFail: ['test-mode'], files: featureFiles(JOB_OPEN_SERVER) },
	{ id: 'file-readable-by-anyone', plain: 'A file route skips the owner check, so a second person reads the file.', mustFail: ['test-mode'], files: featureFiles(FILE_OPEN_SERVER) },
	{
		id: 'features-reports-built',
		plain: 'Only the reports feature is built; checked for it alone, it passes (its file uploads are checked already).',
		mustFail: [],
		features: ['reports'],
		files: featureFiles(REPORTS_ONLY_SERVER),
	},
];
