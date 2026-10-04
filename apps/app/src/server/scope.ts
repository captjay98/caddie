import type { Scope } from '@caddie/contracts';
import type { AuthEnv, D1Database } from './auth.ts';
import { getAuth } from './auth.ts';

/**
 * P02 scope enforcement: Scope is derived ONLY from the verified session plus
 * the D1 membership/project rows — never from body or model input (contracts:
 * "Create Scope from verified session+membership, never body/model supplied
 * actor ID").
 *
 * Contract: missing scope THROWS rather than silently returning success. Every
 * failure is a typed {@link ScopeError} that the route layer maps to a JSON
 * response:
 *
 *   401 unauthenticated        no verified session
 *   403 not_a_member           actor has no workspace_memberships row
 *   403 project_out_of_scope   scope workspace does not match the project's
 *   404 project_not_found      addressed project does not exist
 *   400 invalid_request        empty/malformed path or query reference
 *   400 invalid_input          body failed its strict contract schema
 *   409 revision_conflict ...  concurrent revision allocation
 *   500 missing_scope          scope argument absent — caller bug, must never
 *                              be reachable from a route handler
 */

/** Workspace-level scope: the project-level {@link Scope} minus the project. */
export type WorkspaceScope = Readonly<{ actorId: string; workspaceId: string }>;

export class ScopeError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'ScopeError';
	}
}

function fail(status: number, code: string, message: string): never {
	throw new ScopeError(status, code, message);
}

/**
 * Runtime guard for scope ARGUMENTS: a service called without a scope is a
 * caller bug and throws instead of proceeding (the "missing scope throws"
 * acceptance invariant — services take scope as a mandatory parameter with no
 * optional-owner fallback, audit defect #3 class).
 */
function requireScopeObject<K extends string>(
	scope: unknown,
	kind: string,
	fields: readonly K[],
): Record<K, string> {
	if (scope === null || scope === undefined || typeof scope !== 'object' || Array.isArray(scope)) {
		fail(
			500,
			'missing_scope',
			`${kind} scope is mandatory — refusing to proceed without an explicit scope`,
		);
	}
	const record = scope as Record<string, unknown>;
	const out = {} as Record<K, string>;
	for (const field of fields) {
		const value = record[field];
		if (typeof value !== 'string' || value.length === 0) {
			fail(
				500,
				'missing_scope',
				`${kind} scope field '${field}' is missing or empty — refusing to proceed`,
			);
		}
		out[field] = value;
	}
	return out;
}

/**
 * Resolve the authenticated user id from the VERIFIED session, or null.
 * Fail-closed: an auth outage reads as "no session" — never as an identity.
 */
export async function sessionUserId(env: AuthEnv, headers: Headers): Promise<string | null> {
	try {
		// Structural view of better-auth 1.7.7's getSession result at the adapter
		// edge (its deep plugin generics do not expose `session.userId` cleanly);
		// the shape is proven by the P01/P02 integration suites.
		const session = (await getAuth(env).api.getSession({ headers })) as {
			session?: { userId?: string };
		} | null;
		return session?.session?.userId ?? null;
	} catch (error) {
		console.error('scope: session probe failed:', error);
		return null;
	}
}

async function queryAll(
	db: D1Database,
	sql: string,
	...params: unknown[]
): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

async function membershipExists(
	db: D1Database,
	workspaceId: string,
	userId: string,
): Promise<boolean> {
	const rows = await queryAll(
		db,
		'select "id" from "workspace_memberships" where "workspaceId" = ? and "userId" = ?',
		workspaceId,
		userId,
	);
	return rows.length > 0;
}

/**
 * Membership-scoped workspace authorization for a user id that MUST already
 * have come from a verified session (see {@link requireWorkspaceScope}).
 */
export async function workspaceScopeForUser(
	db: D1Database,
	userId: string,
	workspaceId: string,
): Promise<WorkspaceScope> {
	if (typeof userId !== 'string' || userId.length === 0) {
		fail(401, 'unauthenticated', 'workspace scope requires a verified session user');
	}
	if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
		fail(400, 'invalid_request', 'workspaceId is required');
	}
	if (!(await membershipExists(db, workspaceId, userId))) {
		fail(403, 'not_a_member', 'actor has no membership in this workspace');
	}
	return { actorId: userId, workspaceId };
}

/**
 * Project-scoped authorization for a session-derived user id. The workspace
 * binding is taken from the PROJECT ROW, never from caller input.
 */
export async function projectScopeForUser(
	db: D1Database,
	userId: string,
	projectId: string,
): Promise<Scope> {
	if (typeof userId !== 'string' || userId.length === 0) {
		fail(401, 'unauthenticated', 'project scope requires a verified session user');
	}
	if (typeof projectId !== 'string' || projectId.length === 0) {
		fail(400, 'invalid_request', 'projectId is required');
	}
	const rows = await queryAll(
		db,
		'select "workspaceId" from "projects" where "id" = ?',
		projectId,
	);
	const project = rows[0];
	if (!project) fail(404, 'project_not_found', 'no such project');
	const workspaceId = String(project['workspaceId']);
	if (!(await membershipExists(db, workspaceId, userId))) {
		fail(403, 'not_a_member', 'actor has no membership in this project workspace');
	}
	return { actorId: userId, workspaceId, projectId };
}

/** Derive a workspace scope from the verified request session + membership. */
export async function requireWorkspaceScope(
	db: D1Database,
	env: AuthEnv,
	headers: Headers,
	workspaceId: string,
): Promise<WorkspaceScope> {
	const userId = await sessionUserId(env, headers);
	if (!userId) fail(401, 'unauthenticated', 'a verified session is required');
	return workspaceScopeForUser(db, userId, workspaceId);
}

/** Derive a full project scope from the verified request session + membership. */
export async function requireProjectScope(
	db: D1Database,
	env: AuthEnv,
	headers: Headers,
	projectId: string,
): Promise<Scope> {
	const userId = await sessionUserId(env, headers);
	if (!userId) fail(401, 'unauthenticated', 'a verified session is required');
	return projectScopeForUser(db, userId, projectId);
}

/**
 * Re-verify a workspace scope against D1. Services call this at entry so a
 * scope is never trusted across a trust boundary, even from in-process callers.
 */
export async function assertWorkspaceScope(
	db: D1Database,
	scope: unknown,
): Promise<WorkspaceScope> {
	const fields = requireScopeObject(scope, 'workspace', ['actorId', 'workspaceId'] as const);
	if (!(await membershipExists(db, fields.workspaceId, fields.actorId))) {
		fail(403, 'not_a_member', 'actor has no membership in this workspace');
	}
	return { actorId: fields.actorId, workspaceId: fields.workspaceId };
}

/**
 * Re-verify a project scope against D1: the project must exist, the scope's
 * workspace must be the project's real workspace, and the actor must hold the
 * membership. Catches fabricated and tampered scopes alike.
 */
export async function assertProjectScope(db: D1Database, scope: unknown): Promise<Scope> {
	const fields = requireScopeObject(scope, 'project', [
		'actorId',
		'workspaceId',
		'projectId',
	] as const);
	const rows = await queryAll(
		db,
		'select "workspaceId" from "projects" where "id" = ?',
		fields.projectId,
	);
	const project = rows[0];
	if (!project) fail(404, 'project_not_found', 'no such project');
	const realWorkspaceId = String(project['workspaceId']);
	if (realWorkspaceId !== fields.workspaceId) {
		fail(403, 'project_out_of_scope', 'scope workspace does not match the project workspace');
	}
	if (!(await membershipExists(db, realWorkspaceId, fields.actorId))) {
		fail(403, 'not_a_member', 'actor has no membership in this project workspace');
	}
	return { actorId: fields.actorId, workspaceId: realWorkspaceId, projectId: fields.projectId };
}
