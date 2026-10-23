// A generic CORRECT app for any design, written the way a careful builder
// would: every route does what its op says, a person's records are filtered by
// their owner, a team's records by their team, and every screen reads its table
// from the server through caddie/api. tests/contract-checks.test.ts runs the
// generated contract test against it on the big farm design (37 tables), to
// prove the every-table checks pass a correct big app and to time the phases.
import type { ArchitectureBlock, ArchitectureRoute, ArchitectureTable } from '@caddie/contracts';
import { generateSchema } from '../../../apps/app/src/server/schema-gen.ts';
import { appFeatureFiles } from '../../../apps/app/src/server/app-feature-files.ts';

const q = (value: unknown): string => JSON.stringify(value);

/** The app's builder files: its server, its screens, the generated schema, and Caddie's feature files. */
export function genericAppFiles(block: ArchitectureBlock): Record<string, string> {
	return {
		...appFeatureFiles(block, { appFeatures: true }),
		'src/server.ts': genericServer(block),
		'src/App.tsx': genericScreens(block),
		'migrations/0001_schema.sql': generateSchema(block),
	};
}

/** Where a table's records are scoped: the owner (person), the team in the path (team), or nowhere (shared). */
function scopeOf(table: ArchitectureTable, route: ArchitectureRoute): { column: string; value: string } | null {
	if (table.owner === 'person') return { column: 'ownerId', value: '(await requireUser(c)).id' };
	if (table.owner === 'team' && route.path.includes(':teamId')) return { column: 'teamId', value: 'c.req.param("teamId")' };
	return null;
}

function handlerFor(route: ArchitectureRoute, block: ArchitectureBlock): string {
	// A declared email's route sends it once, to the test inbox, with its template (part K).
	const email = block.emails.find((e) => e.route === route.id);
	if (email) {
		const to = email.to === 'person' ? 'user.email' : `String(body[${q(email.to.slice('request-field:'.length))}] ?? "")`;
		return [
			'async (c) => {',
			'    const user = await requireUser(c);',
			'    const body = await c.req.json<Body>().catch(() => ({}) as Body);',
			`    const sent = await c.env.CADDIE.email({ to: ${to}, subject: ${q(email.plain)}, text: ${q(email.plain)}, template: ${q(email.id)} });`,
			'    return c.json({ ok: sent.ok });',
			'  }',
		].join('\n');
	}
	if (!route.table) return 'async (c) => c.json({ ok: true })';
	const table = block.tables.find((t) => t.name === route.table)!;
	const name = table.name;
	const fields = q(table.fields.map((f) => f.name));
	const scope = scopeOf(table, route);
	const where = scope ? ` and ${scope.column} = ?` : '';
	const isTeamTable = block.team?.table === name;
	switch (route.op) {
		case 'create': {
			if (isTeamTable) {
				// Starting a team: the creator joins it with the creator role.
				return [
					'async (c) => {',
					'    const user = await requireUser(c);',
					'    const body = await c.req.json<Body>();',
					`    const keys = pick(${fields}, body);`,
					'    const id = crypto.randomUUID();',
					'    const cols = ["id", "teamId", ...keys, "createdAt", "updatedAt"];',
					`    await c.env.DB.prepare("insert into ${name} (" + cols.join(", ") + ") values (" + cols.map(() => "?").join(", ") + ")").bind(id, id, ...keys.map((k) => val(body, k)), now(), now()).run();`,
					`    await c.env.DB.prepare("insert into team_members (teamId, personId, role, createdAt) values (?, ?, ?, ?)").bind(id, user.id, ${q(block.team!.creatorRole)}, now()).run();`,
					`    return c.json(await c.env.DB.prepare("select * from ${name} where id = ?").bind(id).first(), 201);`,
					'  }',
				].join('\n');
			}
			const ownerCol = scope ? `"${scope.column}", ` : '';
			const ownerVal = scope ? `${scope.value}, ` : '';
			return [
				'async (c) => {',
				'    const body = await c.req.json<Body>();',
				`    const keys = pick(${fields}, body);`,
				'    const id = crypto.randomUUID();',
				`    const cols = ["id", ${ownerCol}...keys, "createdAt", "updatedAt"];`,
				`    await c.env.DB.prepare("insert into ${name} (" + cols.join(", ") + ") values (" + cols.map(() => "?").join(", ") + ")").bind(id, ${ownerVal}...keys.map((k) => val(body, k)), now(), now()).run();`,
				`    return c.json(await c.env.DB.prepare("select * from ${name} where id = ?").bind(id).first(), 201);`,
				'  }',
			].join('\n');
		}
		case 'read':
			return [
				'async (c) => {',
				`    const row = await c.env.DB.prepare("select * from ${name} where id = ?${where}").bind(c.req.param("id")${scope ? `, ${scope.value}` : ''}).first();`,
				'    if (!row) return c.json({ error: "Not found." }, 404);',
				'    return c.json(row);',
				'  }',
			].join('\n');
		case 'list': {
			if (isTeamTable && !route.path.includes(':teamId')) {
				return [
					'async (c) => {',
					'    const user = await requireUser(c);',
					`    const { results } = await c.env.DB.prepare("select t.* from ${name} t join team_members m on m.teamId = t.id where m.personId = ? order by t.createdAt, t.id").bind(user.id).all();`,
					'    return c.json(results);',
					'  }',
				].join('\n');
			}
			return [
				'async (c) => {',
				`    const { results } = await c.env.DB.prepare("select * from ${name}${scope ? ` where ${scope.column} = ?` : ''} order by createdAt, id")${scope ? `.bind(${scope.value})` : ''}.all();`,
				'    return c.json(results);',
				'  }',
			].join('\n');
		}
		case 'update':
			return [
				'async (c) => {',
				'    const body = await c.req.json<Body>();',
				`    const keys = pick(${fields}, body);`,
				'    if (keys.length > 0) {',
				`      await c.env.DB.prepare("update ${name} set " + keys.map((k) => k + " = ?").join(", ") + ", updatedAt = ? where id = ?${where}").bind(...keys.map((k) => val(body, k)), now(), c.req.param("id")${scope ? `, ${scope.value}` : ''}).run();`,
				'    }',
				`    const row = await c.env.DB.prepare("select * from ${name} where id = ?${where}").bind(c.req.param("id")${scope ? `, ${scope.value}` : ''}).first();`,
				'    if (!row) return c.json({ error: "Not found." }, 404);',
				'    return c.json(row);',
				'  }',
			].join('\n');
		case 'delete':
			return [
				'async (c) => {',
				`    await c.env.DB.prepare("delete from ${name} where id = ?${where}").bind(c.req.param("id")${scope ? `, ${scope.value}` : ''}).run();`,
				'    return c.json({ ok: true, id: c.req.param("id") });',
				'  }',
			].join('\n');
		default:
			return 'async (c) => c.json({ ok: true })';
	}
}

function genericServer(block: ArchitectureBlock): string {
	const files = block.tables.some((t) => t.fields.some((f) => f.type === 'file'));
	const plans = block.payments ? block.payments.plans.map((p) => ({ id: p.id, priceMinor: p.priceMinor, interval: p.interval })) : [];
	return [
		'import { Hono } from "hono";',
		'import type { D1Database } from "../caddie/d1";',
		'import type { CaddiePlatform } from "../caddie/platform";',
		'import { mountSignIn } from "../caddie/auth";',
		...(block.payments ? ['import { mountPayments } from "../caddie/payments";'] : []),
		...(files ? ['import { mountFiles } from "../caddie/files";'] : []),
		'import { implement, requireUser } from "../caddie/contract";',
		'',
		'export type Env = { DB: D1Database; CADDIE: CaddiePlatform; CADDIE_AUTH_SECRET?: string; CADDIE_JOB_SECRET?: string };',
		'export const app = new Hono<{ Bindings: Env }>().basePath("/api");',
		'app.get("/health", (c) => c.json({ ok: true }));',
		'mountSignIn(app);',
		...(block.payments ? [`mountPayments(app, { currency: ${q(block.payments.currency)}, plans: ${q(plans)} });`] : []),
		...(files ? ['mountFiles(app);'] : []),
		'type Body = Record<string, unknown>;',
		'const now = () => new Date().toISOString();',
		'/** The declared fields this request sets (never a column the request names itself). */',
		'const pick = (fields: readonly string[], body: Body) => fields.filter((f) => f in body);',
		'const val = (body: Body, key: string) => { const v = body[key]; return v === undefined ? null : typeof v === "object" && v !== null ? JSON.stringify(v) : v; };',
		'',
		'implement(app, {',
		...block.routes.map((route) => `  ${q(route.id)}: ${handlerFor(route, block)},`),
		'});',
		'export default app;',
		'',
	].join('\n');
}

/** Every screen that shows a table lists that table's records, read from the server through caddie/api. */
function genericScreens(block: ArchitectureBlock): string {
	const teamTable = block.team?.table ?? null;
	const screens = block.screens
		.filter((s) => s.shows.length > 0)
		.map((s) => {
			const table = block.tables.find((t) => t.name === s.shows[0])!;
			const list = block.routes.find((r) => r.table === table.name && r.op === 'list') ?? null;
			return { path: s.path, list: list?.path ?? null, team: Boolean(list?.path.includes(':teamId')), fields: table.fields.map((f) => f.name) };
		});
	const teamList = teamTable ? block.routes.find((r) => r.table === teamTable && r.op === 'list' && !r.path.includes(':teamId'))?.path ?? null : null;
	return [
		'import { useEffect, useState } from "react";',
		'import { api, currentTeamId } from "../caddie/api";',
		'',
		'interface Screen { path: string; list: string | null; team: boolean; fields: string[] }',
		`const SCREENS: Screen[] = ${q(screens)};`,
		`const TEAM_LIST: string | null = ${q(teamList)};`,
		'',
		'function Rows(props: { screen: Screen }) {',
		'  const [texts, setTexts] = useState<string[] | null>(null);',
		'  useEffect(() => {',
		'    (async () => {',
		'      const s = props.screen;',
		'      if (!s.list) return setTexts([]);',
		'      let url = s.list;',
		'      if (s.team) {',
		'        let teamId = currentTeamId();',
		'        if (!teamId && TEAM_LIST) teamId = (await api.get<{ id: string }[]>(TEAM_LIST))[0]?.id ?? null;',
		'        if (!teamId) return setTexts([]);',
		'        url = url.replace(":teamId", teamId);',
		'      }',
		'      const rows = await api.get<Record<string, unknown>[]>(url);',
		'      setTexts(rows.map((r) => s.fields.map((f) => r[f]).filter((v) => v !== null && v !== undefined && v !== "").join(" · ")));',
		'    })().catch(() => setTexts([]));',
		'  }, [props.screen.path]);',
		'  if (texts === null) return <p>Loading…</p>;',
		'  return <ul>{texts.map((t, i) => <li key={i}>{t}</li>)}</ul>;',
		'}',
		'',
		'export function App() {',
		'  const hash = typeof location !== "undefined" ? location.hash : "";',
		'  const screen = SCREENS.find((s) => s.path === hash);',
		'  if (!screen) return <main><h1>Your app</h1></main>;',
		'  return <main><Rows screen={screen} /></main>;',
		'}',
		'',
	].join('\n');
}
