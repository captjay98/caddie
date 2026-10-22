/**
 * "How your app works" — the architecture block (plan part B, version 2).
 *
 * A plan's DESIGN document carries ONE fenced block with the info string
 * `caddie-architecture` holding a JSON object that describes the whole app in
 * plain words before it is built: its sign-in, its team shape, its modules,
 * its tables (and who owns each record), its routes (and who may call each),
 * its screens, outside services, AI uses, payments, emails and jobs. Like the
 * `caddie-features` block, it lives inside the document the user approves, so
 * the approval binds to exactly this shape — the host builds nothing the user
 * did not see.
 *
 * This file is the SHAPE only: a valibot schema, the TS types, and
 * `parseArchitectureBlock(markdown)` which lifts the fenced block out of a
 * design document. The deterministic rules that BLOCK a bad block live in
 * `apps/app/src/server/architecture-gate.ts`, and the generated schema in
 * `apps/app/src/server/schema-gen.ts`; both read the types defined here.
 */

import * as v from 'valibot';

export const ARCHITECTURE_BLOCK_INFO = 'caddie-architecture';

export const ARCHITECTURE_VERSION = 2 as const;

/** The small-app module every single-module app uses (part B). */
export const SMALL_APP_MODULE = 'app';

/** The one module whose tables anyone may read and only it may write (part B). */
export const CORE_MODULE = 'core';

/** `/api/caddie/*` is reserved for Caddie's own generated routes (parts J, L). */
export const RESERVED_API_PREFIX = '/api/caddie/';

// --- small shared pieces -----------------------------------------------------

/** A short lowercase slug: ids of modules, tables, routes, screens, services… */
const Slug = v.pipe(
	v.string(),
	v.regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'an id must be a short lowercase slug like "feed-log"'),
);

/**
 * A route id, which may be dotted like "animals.create" (part B's examples).
 * The same shape is used wherever a route is REFERENCED by id (an AI use, an
 * email, a job, a locked route).
 */
const RouteId = v.pipe(
	v.string(),
	v.regex(/^[a-z0-9][a-z0-9_-]{0,62}(\.[a-z0-9][a-z0-9_-]{0,62})*$/, 'a route id is a dotted slug like "animals.create" or "feed_stock.list"'),
);

/**
 * A database identifier: a table name, a field name, or a reference target.
 * Allows snake_case table names (`feed_stock`) and camelCase field names
 * (`ownerId`), so the generated SQL reads naturally. Must start with a letter.
 */
const Ident = v.pipe(
	v.string(),
	v.regex(/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/, 'a name uses letters, digits and underscores, like "feed_stock" or "ownerId"'),
);

/** A plain-words line a non-technical person reads. */
const Plain = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(240));

/** An https page (service key pages). */
const HttpsUrl = v.pipe(v.string(), v.trim(), v.url('must be a web address'), v.startsWith('https://', 'must be an https web address'));

export const SIGN_IN_MODES = ['required', 'optional', 'none'] as const;
export type SignInMode = (typeof SIGN_IN_MODES)[number];

export const FIELD_TYPES = ['text', 'integer', 'real', 'boolean', 'datetime', 'json', 'file'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const TABLE_OWNERS = ['person', 'team', 'shared', 'public'] as const;
export type TableOwner = (typeof TABLE_OWNERS)[number];

export const ROUTE_OPS = ['create', 'read', 'list', 'update', 'delete', 'action'] as const;
export type RouteOp = (typeof ROUTE_OPS)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Who may call a route. `team-role:<role>` carries the role inline; every
 * other kind is a fixed word. The valibot check accepts both.
 */
export const FIXED_ACCESS = ['public', 'signed-in', 'person', 'team', 'admin', 'job'] as const;
export type FixedAccess = (typeof FIXED_ACCESS)[number];
export type Access = FixedAccess | `team-role:${string}`;

const ACCESS_PATTERN = /^(public|signed-in|person|team|admin|job|team-role:[a-z0-9][a-z0-9-]{0,47})$/;
const AccessSchema = v.pipe(
	v.string(),
	v.regex(ACCESS_PATTERN, 'access must be public, signed-in, person, team, team-role:<role>, admin or job'),
) as unknown as v.GenericSchema<Access>;

export const AI_TIERS = ['fast', 'super'] as const;
export type AiTier = (typeof AI_TIERS)[number];

export const PLAN_INTERVALS = ['month', 'year'] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

export const JOB_INTERVALS = ['hour', 'day', 'week'] as const;
export type JobInterval = (typeof JOB_INTERVALS)[number];

// --- the block's pieces ------------------------------------------------------

export const TeamSchema = v.strictObject({
	/** The team table's name, e.g. "farms". */
	table: Ident,
	plain: Plain,
	/** The roles a member can hold, e.g. ["owner", "worker"]. */
	roles: v.pipe(v.array(Slug), v.minLength(1, 'a team needs at least one role'), v.maxLength(10)),
	/** The role the person who creates a team gets; must be one of `roles`. */
	creatorRole: Slug,
});
export type TeamShape = v.InferOutput<typeof TeamSchema>;

export const ModuleSchema = v.strictObject({
	id: Slug,
	plain: Plain,
	/** Other modules this one is built after; no cycles (checked in the gate). */
	dependsOn: v.array(Slug),
});
export type ArchitectureModule = v.InferOutput<typeof ModuleSchema>;

export const FieldSchema = v.strictObject({
	name: Ident,
	type: v.picklist(FIELD_TYPES, 'a field type must be text, integer, real, boolean, datetime, json or file'),
	/** The table this field points at, or null. */
	references: v.nullable(Ident),
});
export type ArchitectureField = v.InferOutput<typeof FieldSchema>;

export const TableSchema = v.strictObject({
	name: Ident,
	module: Slug,
	plain: Plain,
	owner: v.picklist(TABLE_OWNERS, 'a table owner must be person, team, shared or public'),
	fields: v.pipe(v.array(FieldSchema), v.maxLength(40, 'a table has at most 40 fields')),
});
export type ArchitectureTable = v.InferOutput<typeof TableSchema>;

export const RequestFieldSchema = v.strictObject({
	name: Ident,
	type: v.picklist(FIELD_TYPES),
	/** An example value, always shown (the gate requires it). */
	example: v.pipe(v.string(), v.minLength(1, 'every request field needs an example')),
});
export type RequestField = v.InferOutput<typeof RequestFieldSchema>;

export const RouteSchema = v.strictObject({
	id: RouteId,
	module: Slug,
	/** The feature this route belongs to (a `caddie-features` id). */
	feature: Slug,
	op: v.picklist(ROUTE_OPS, 'op must be create, read, list, update, delete or action'),
	method: v.picklist(HTTP_METHODS),
	/** The /api/… path; /api/caddie/* is reserved (checked in the gate). */
	path: v.pipe(v.string(), v.trim(), v.minLength(1)),
	/** The table this route reads or writes, or null for an action. */
	table: v.nullable(Ident),
	plain: Plain,
	access: AccessSchema,
	request: v.array(RequestFieldSchema),
	response: v.array(v.string()),
});
export type ArchitectureRoute = v.InferOutput<typeof RouteSchema>;

export const ScreenSchema = v.strictObject({
	id: Slug,
	module: Slug,
	/** A hash route, e.g. "#/animals". */
	path: v.pipe(v.string(), v.trim(), v.startsWith('#/', 'a screen path starts with #/')),
	plain: Plain,
	/** The tables this screen shows; empty for a screen that shows no saved data. */
	shows: v.array(Ident),
});
export type ArchitectureScreen = v.InferOutput<typeof ScreenSchema>;

export const ServiceSchema = v.strictObject({
	id: Slug,
	plain: Plain,
	/** The app-key name the owner pastes; must match APP_SECRET_NAME (gate). */
	keyName: v.string(),
	keyPage: HttpsUrl,
});
export type ArchitectureService = v.InferOutput<typeof ServiceSchema>;

export const AiUseSchema = v.strictObject({
	id: Slug,
	plain: Plain,
	/** The route this AI use runs behind (a route id). */
	route: RouteId,
	tier: v.picklist(AI_TIERS, 'an AI tier must be fast or super'),
	/** True when it looks at photos; needs the super tier (gate). */
	images: v.boolean(),
});
export type ArchitectureAiUse = v.InferOutput<typeof AiUseSchema>;

export const PaymentPlanSchema = v.strictObject({
	id: Slug,
	plain: Plain,
	/** Whole minor units (cents), 1..100000 (gate). */
	priceMinor: v.number(),
	interval: v.picklist(PLAN_INTERVALS, 'a plan interval must be month or year'),
});
export type PaymentPlan = v.InferOutput<typeof PaymentPlanSchema>;

export const LockedRouteSchema = v.strictObject({
	/** The route id that this plan set unlocks. */
	route: RouteId,
	/** The plan ids that unlock it. */
	plans: v.pipe(v.array(Slug), v.minLength(1, 'a locked route needs at least one plan')),
});
export type LockedRoute = v.InferOutput<typeof LockedRouteSchema>;

export const PaymentsSchema = v.strictObject({
	/** A 3-letter currency code, e.g. "USD" (gate). */
	currency: v.string(),
	plans: v.array(PaymentPlanSchema),
	locked: v.array(LockedRouteSchema),
});
export type ArchitecturePayments = v.InferOutput<typeof PaymentsSchema>;

/** Who an email goes to: a request field, or the signed-in person. */
const EmailTo = v.pipe(
	v.string(),
	v.regex(/^(person|request-field:[a-zA-Z][a-zA-Z0-9_]{0,62})$/, 'an email "to" must be "person" or "request-field:<name>"'),
);

export const EmailSchema = v.strictObject({
	id: Slug,
	plain: Plain,
	/** The route that sends this email (a route id). */
	route: RouteId,
	to: EmailTo,
});
export type ArchitectureEmail = v.InferOutput<typeof EmailSchema>;

export const JobSchema = v.strictObject({
	id: Slug,
	plain: Plain,
	/** The route Caddie's Run-now call hits (a route id). */
	route: RouteId,
	/** Shown to the person only; nothing runs on a timer this week. */
	every: v.picklist(JOB_INTERVALS, 'a job interval must be hour, day or week'),
});
export type ArchitectureJob = v.InferOutput<typeof JobSchema>;

// --- the whole block ---------------------------------------------------------

export const ArchitectureBlockSchema = v.strictObject({
	version: v.literal(ARCHITECTURE_VERSION),
	signIn: v.picklist(SIGN_IN_MODES, 'signIn must be required, optional or none'),
	team: v.nullable(TeamSchema),
	modules: v.pipe(v.array(ModuleSchema), v.minLength(1, 'an app needs at least one module')),
	tables: v.array(TableSchema),
	routes: v.array(RouteSchema),
	screens: v.array(ScreenSchema),
	services: v.array(ServiceSchema),
	ai: v.array(AiUseSchema),
	payments: v.nullable(PaymentsSchema),
	emails: v.array(EmailSchema),
	jobs: v.array(JobSchema),
	/** Screens that show no saved data, such as a calculator; the screen check skips them. */
	screenOnly: v.array(Slug),
});
export type ArchitectureBlock = v.InferOutput<typeof ArchitectureBlockSchema>;

// --- parsing -----------------------------------------------------------------

const FENCE = new RegExp('^(`{3,}|~{3,})[ \\t]*' + ARCHITECTURE_BLOCK_INFO + '[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n\\1[ \\t]*$', 'm');

/** Split a design document into the prose a person reads and the raw block JSON. */
export function splitArchitectureBlock(body: string): { display: string; raw: string | null } {
	const match = FENCE.exec(body);
	if (!match) return { display: body, raw: null };
	const display = (body.slice(0, match.index) + body.slice(match.index + match[0].length)).replace(/\n{3,}/g, '\n\n').trim();
	return { display, raw: match[2] ?? '' };
}

export type ArchitectureParse = { ok: true; block: ArchitectureBlock } | { ok: false; error: string };

/**
 * Extract and validate the design document's `caddie-architecture` block.
 * Never throws: a missing block, bad JSON or a shape error all come back as
 * `{ ok: false, error }` with a readable reason. The DETERMINISTIC rules
 * (caps, access consistency, module ownership…) are checked separately by
 * `checkArchitecture`; this only proves the JSON matches the shape.
 */
export function parseArchitectureBlock(body: string): ArchitectureParse {
	const { raw } = splitArchitectureBlock(body);
	if (raw === null) return { ok: false, error: `the design has no \`${ARCHITECTURE_BLOCK_INFO}\` block` };
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		return {
			ok: false,
			error: `the ${ARCHITECTURE_BLOCK_INFO} block is not valid JSON (${error instanceof Error ? error.message : 'parse error'})`,
		};
	}
	const parsed = v.safeParse(ArchitectureBlockSchema, json);
	if (!parsed.success) {
		const issue = parsed.issues[0];
		const path = issue?.path?.map((p) => String(p.key)).join('.') ?? '';
		return {
			ok: false,
			error: `the ${ARCHITECTURE_BLOCK_INFO} block is invalid${path ? ` at ${path}` : ''}: ${issue?.message ?? 'unknown problem'}`,
		};
	}
	return { ok: true, block: parsed.output };
}

/** Pull the inline role out of a `team-role:<role>` access, else null. */
export function teamRoleOf(access: Access): string | null {
	return access.startsWith('team-role:') ? access.slice('team-role:'.length) : null;
}
