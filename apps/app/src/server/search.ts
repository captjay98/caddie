import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

/**
 * P14 search services — permission-filtered search over the user's
 * accessible content (feature-ledger audit defect: search must not leak
 * across projects).
 *
 * Isolation model: every query leads with the permission filter, written in
 * SQL, before any matching happens:
 *   - projects: workspace-membership join on the searcher's user id;
 *   - plan-doc revisions (and task titles = plan-docs with kind 'tasks'):
 *     projects join memberships;
 *   - memory facts: the searcher's own personal facts plus facts of projects
 *     the searcher is a member of; CONFIRMED facts only — proposed facts
 *     await user confirmation and retracted (deleted) facts are excluded.
 *
 * Counts come from the SAME filtered queries (count over the permission
 * predicate), so the number of inaccessible matches is never revealed —
 * "Alpha Secret" simply does not exist in another user's result set, not even
 * as an invisible +1 in a total.
 *
 * Result caps and pagination: each section is bounded by `limit` (default 10,
 * max 50) and paged by `offset` within the section; `total` is the exact
 * accessible count regardless of paging.
 *
 * Note: task titles live in plan-doc revisions with kind='tasks' in this
 * build (no dedicated tasks table yet); messages/files/links/images from
 * later packets plug in as additional sections with the same pattern.
 */

export const DEFAULT_SECTION_LIMIT = 10;
export const MAX_SECTION_LIMIT = 50;
const MAX_QUERY_LENGTH = 200;

export type SearchSectionName = 'projects' | 'planDocs' | 'tasks' | 'memory';

export interface SearchHit {
	type: 'project' | 'planDoc' | 'task' | 'memory';
	id: string;
	projectId: string | null;
	title: string;
	snippet: string | null;
}

export interface SearchSection {
	items: SearchHit[];
	total: number;
}

export interface SearchResponse {
	query: string;
	sections: Record<SearchSectionName, SearchSection>;
	total: number;
	limit: number;
	offset: number;
}

// --- helpers ---------------------------------------------------------------------

function requireActorId(actorId: unknown): string {
	if (typeof actorId !== 'string' || actorId.length === 0) {
		throw new ScopeError(
			500,
			'missing_actor',
			'search actor id is mandatory and must come from a verified session',
		);
	}
	return actorId;
}

/** Build a literal-substring LIKE pattern; wildcards in the user's query are
 * escaped so a "%" search never matches everything. */
function likePattern(query: string): string {
	const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
	return `%${escaped}%`;
}

function excerpt(text: string, max = 160): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function firstLine(text: string): string {
	const line = text.trim().split('\n', 1)[0] ?? '';
	return line.trim();
}

function clampLimit(raw: unknown): number {
	const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
	if (!Number.isFinite(n)) return DEFAULT_SECTION_LIMIT;
	return Math.min(Math.max(Math.trunc(n), 1), MAX_SECTION_LIMIT);
}

function clampOffset(raw: unknown): number {
	const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.trunc(n);
}

function emptySection(): SearchSection {
	return { items: [], total: 0 };
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

// --- sections ----------------------------------------------------------------------

interface SectionSpec {
	name: SearchSectionName;
	itemsSql: string;
	countSql: string;
	params: (actorId: string, pattern: string, limit: number, offset: number) => unknown[];
	countParams: (actorId: string, pattern: string) => unknown[];
	map: (row: Record<string, unknown>) => SearchHit;
}

const MEMBERSHIP_JOIN = `
	join "projects" p on p."id" = r."projectId"
	join "workspace_memberships" m on m."workspaceId" = p."workspaceId" and m."userId" = ?`;

/** Each section: the items query and the count query share the same
 * permission predicate — counts can never include inaccessible rows. */
const SECTIONS: SectionSpec[] = [
	{
		name: 'projects',
		itemsSql: `select p."id", p."name", p."description", p."status"
			from "projects" p
			join "workspace_memberships" m on m."workspaceId" = p."workspaceId" and m."userId" = ?
			where (p."name" like ? escape '\\' or coalesce(p."description", '') like ? escape '\\')
			order by p."createdAt" desc, p."id" desc limit ? offset ?`,
		countSql: `select count(*) as "n"
			from "projects" p
			join "workspace_memberships" m on m."workspaceId" = p."workspaceId" and m."userId" = ?
			where (p."name" like ? escape '\\' or coalesce(p."description", '') like ? escape '\\')`,
		params: (actorId, pattern, limit, offset) => [actorId, pattern, pattern, limit, offset],
		countParams: (actorId, pattern) => [actorId, pattern, pattern],
		map: (row) => ({
			type: 'project',
			id: String(row['id']),
			projectId: String(row['id']),
			title: String(row['name']),
			snippet: row['description'] == null ? null : excerpt(String(row['description'])),
		}),
	},
	{
		name: 'planDocs',
		itemsSql: `select r."id", r."projectId", r."body"
			from "plan_doc_revisions" r ${MEMBERSHIP_JOIN}
			where r."body" like ? escape '\\'
			order by r."createdAt" desc, r."id" desc limit ? offset ?`,
		countSql: `select count(*) as "n"
			from "plan_doc_revisions" r ${MEMBERSHIP_JOIN}
			where r."body" like ? escape '\\'`,
		params: (actorId, pattern, limit, offset) => [actorId, pattern, limit, offset],
		countParams: (actorId, pattern) => [actorId, pattern],
		map: (row) => ({
			type: 'planDoc',
			id: String(row['id']),
			projectId: String(row['projectId']),
			title: firstLine(String(row['body'])) || '(plan doc)',
			snippet: excerpt(String(row['body'])),
		}),
	},
	{
		name: 'tasks',
		// Task titles = plan-doc revisions of kind 'tasks' (first line of body).
		itemsSql: `select r."id", r."projectId", r."body"
			from "plan_doc_revisions" r ${MEMBERSHIP_JOIN}
			where r."kind" = 'tasks' and r."body" like ? escape '\\'
			order by r."createdAt" desc, r."id" desc limit ? offset ?`,
		countSql: `select count(*) as "n"
			from "plan_doc_revisions" r ${MEMBERSHIP_JOIN}
			where r."kind" = 'tasks' and r."body" like ? escape '\\'`,
		params: (actorId, pattern, limit, offset) => [actorId, pattern, limit, offset],
		countParams: (actorId, pattern) => [actorId, pattern],
		map: (row) => ({
			type: 'task',
			id: String(row['id']),
			projectId: String(row['projectId']),
			title: firstLine(String(row['body'])) || '(task)',
			snippet: excerpt(String(row['body'])),
		}),
	},
	{
		name: 'memory',
		// Personal facts of the searcher (projectId null, owner match) plus
		// project facts of projects the searcher belongs to. CONFIRMED only
		// (packet: "memory facts (confirmed only)") — proposals await user
		// confirmation and retracted facts are gone — so search can never be
		// used to fish for unconfirmed proposals that were meant to be private.
		itemsSql: `select f."id", f."projectId", f."content"
			from "memory_facts" f
			left join "workspace_memberships" m on m."workspaceId" = (select "workspaceId" from "projects" where "id" = f."projectId")
			where f."status" = 'confirmed'
			  and f."content" like ? escape '\\'
			  and ((f."projectId" is null and f."userId" = ?) or m."userId" = ?)
			order by f."createdAt" desc, f."id" desc limit ? offset ?`,
		countSql: `select count(*) as "n"
			from "memory_facts" f
			left join "workspace_memberships" m on m."workspaceId" = (select "workspaceId" from "projects" where "id" = f."projectId")
			where f."status" = 'confirmed'
			  and f."content" like ? escape '\\'
			  and ((f."projectId" is null and f."userId" = ?) or m."userId" = ?)`,
		params: (actorId, pattern, limit, offset) => [pattern, actorId, actorId, limit, offset],
		countParams: (actorId, pattern) => [pattern, actorId, actorId],
		map: (row) => ({
			type: 'memory',
			id: String(row['id']),
			projectId: row['projectId'] == null ? null : String(row['projectId']),
			title: excerpt(String(row['content']), 120),
			snippet: null,
		}),
	},
];

// --- service -----------------------------------------------------------------------

/**
 * Search the actor's accessible content. The query is matched as a literal
 * substring (case-insensitive, SQLite LIKE semantics with escaped wildcards).
 * Sections are ordered: projects, plan docs, tasks, memory.
 */
export async function searchContent(
	db: D1Database,
	actorId: string,
	query: string,
	opts: { limit?: unknown; offset?: unknown } = {},
): Promise<SearchResponse> {
	const verified = requireActorId(actorId);
	if (typeof query !== 'string' || query.trim().length === 0) {
		throw new ScopeError(400, 'invalid_request', 'a non-empty search query is required');
	}
	const trimmed = query.trim();
	if (trimmed.length > MAX_QUERY_LENGTH) {
		throw new ScopeError(400, 'invalid_request', `search query is limited to ${MAX_QUERY_LENGTH} characters`);
	}
	const limit = clampLimit(opts.limit);
	const offset = clampOffset(opts.offset);
	const pattern = likePattern(trimmed);

	const sections: Record<SearchSectionName, SearchSection> = {
		projects: emptySection(),
		planDocs: emptySection(),
		tasks: emptySection(),
		memory: emptySection(),
	};
	let total = 0;

	for (const spec of SECTIONS) {
		const rows = await queryAll(db, spec.itemsSql, ...spec.params(verified, pattern, limit, offset));
		const counts = await queryAll(db, spec.countSql, ...spec.countParams(verified, pattern));
		const section: SearchSection = {
			items: rows.map(spec.map),
			total: Number(counts[0]?.['n'] ?? 0),
		};
		sections[spec.name] = section;
		total += section.total;
	}

	return { query: trimmed, sections, total, limit, offset };
}
