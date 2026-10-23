/**
 * The architecture gate (plan part B — deterministic rules).
 *
 * `checkArchitecture(block, { kind })` runs every rule part B lists over a
 * parsed `caddie-architecture` block and returns a flat list of problems, each
 * with a `rule` tag, a dotted `path` into the block, and a `message` written
 * as a plain sentence for a non-technical person. An empty list means the
 * block passes the deterministic rules; the Ultra security review (part B) is
 * separate and runs after this.
 *
 * These rules ALWAYS block. The caps come from D7 plus part B's extra caps;
 * every "needs sign-in", "belongs to one module", "writes only its own tables"
 * and access-consistency rule is here. Constants are imported, never copied:
 * `APP_SECRET_NAME` from app-secrets.ts and `MAX_PLAN_FEATURES` from the
 * contracts' features module.
 */

import {
	CORE_MODULE,
	RESERVED_API_PREFIX,
	SMALL_APP_MODULE,
	parseArchitectureBlock,
	splitArchitectureBlock,
	teamRoleOf,
	type Access,
	type ArchitectureBlock,
	type ArchitectureRoute,
	type ArchitectureTable,
} from '@caddie/contracts';
import { MAX_PLAN_FEATURES } from '@caddie/contracts';
import { parseAppTheme, themeToCssVars, type AppTheme } from '@caddie/contracts';
import { APP_SECRET_NAME } from './app-secrets.ts';
import {
	architectureBlockHash,
	reviewVerdict,
	type ArchitectureReviewRound,
} from './architecture-review.ts';

export type ArchitectureKind = 'small' | 'big';

export interface ArchitectureIssue {
	/** A stable tag for the rule that fired, for tests and logs. */
	readonly rule: string;
	/** A dotted path into the block, e.g. "tables.3.owner". */
	readonly path: string;
	/** A plain sentence a non-technical person can act on. */
	readonly message: string;
}

// --- caps (D7 + part B extras) ----------------------------------------------

export const SMALL_CAPS = { features: MAX_PLAN_FEATURES, tables: 25 } as const;
export const BIG_CAPS = {
	modules: 12,
	features: 80,
	featuresPerModule: MAX_PLAN_FEATURES,
	tables: 60,
	routes: 200,
	screens: 80,
} as const;
/** Part B's extra caps, the same for small and big apps. */
export const EXTRA_CAPS = { services: 10, ai: 10, emails: 10, jobs: 5 } as const;

const CURRENCY = /^[A-Z]{3}$/;
/** A coarse "looks like an email address" check for an email request field's example. */
const EMAIL_EXAMPLE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** True when the app requires or offers sign-in (so admin/job/private routes can be checked). */
function hasSignIn(block: ArchitectureBlock): boolean {
	return block.signIn !== 'none';
}

/** The number of features declared across every route's `feature` id. */
function featureIds(block: ArchitectureBlock): Set<string> {
	return new Set(block.routes.map((r) => r.feature));
}

/**
 * Which test-mode features Caddie can run for this app (parts J, K, L, N).
 * Payments and uploads come with the project's app features; emails (K's host
 * side) and scheduled jobs (N) have landed (lane 10), so they come with the
 * project's app features too.
 */
export interface AvailableFeatures {
	readonly payments: boolean;
	readonly files: boolean;
	readonly emails: boolean;
	readonly jobs: boolean;
}

export function availableFeatures(appFeatures: boolean): AvailableFeatures {
	return { payments: appFeatures, files: appFeatures, emails: appFeatures, jobs: appFeatures };
}

export function checkArchitecture(
	block: ArchitectureBlock,
	options: { kind: ArchitectureKind; available?: AvailableFeatures },
): ArchitectureIssue[] {
	const issues: ArchitectureIssue[] = [];
	const add = (rule: string, path: string, message: string) => issues.push({ rule, path, message });
	const { kind } = options;

	// --- test-mode features Caddie can run for this app (J, K, L, N) ---------
	// Checked only when the caller says what is available (the design gate
	// passes the project's app features). Refusing here makes the plan drop a
	// feature Caddie can't run yet, instead of building it and failing the
	// test-mode contract check three times.
	const available = options.available;
	if (available) {
		const hasFileField = block.tables.some((table) => table.fields.some((field) => field.type === 'file'));
		if (block.payments && !available.payments) {
			add('feature.payments', 'payments', "Taking payments isn't available for this app yet. Remove it from the plan.");
		}
		if (hasFileField && !available.files) {
			add('feature.files', 'tables', "Photo and file uploads aren't available for this app yet. Remove them from the plan.");
		}
		if (block.emails.length > 0 && !available.emails) {
			add('feature.emails', 'emails', "Sending emails isn't available yet. Remove them from the plan.");
		}
		if (block.jobs.length > 0 && !available.jobs) {
			add('feature.jobs', 'jobs', "Scheduled jobs aren't available yet. Remove them from the plan.");
		}
	}

	const moduleIds = new Set(block.modules.map((m) => m.id));
	const tableByName = new Map(block.tables.map((t) => [t.name, t]));
	const routeById = new Map(block.routes.map((r) => [r.id, r]));

	// --- reserved / duplicate field names (P2, review 2026-10-23) ------------
	// The generated schema ALWAYS emits id, createdAt and updatedAt, plus an
	// owner column (ownerId for a person-owned table, teamId for a team-owned
	// one). A declared field with one of those names — or a name repeated within
	// the table — makes the generated CREATE TABLE emit a duplicate column and
	// fail at build time. Reject it here, before the design is approved.
	for (let t = 0; t < block.tables.length; t += 1) {
		const table = block.tables[t]!;
		const ownerCol = table.owner === 'person' ? 'ownerId' : table.owner === 'team' ? 'teamId' : null;
		const reserved = new Set(['id', 'createdAt', 'updatedAt', ...(ownerCol ? [ownerCol] : [])]);
		const seen = new Set<string>();
		for (let f = 0; f < table.fields.length; f += 1) {
			const name = table.fields[f]!.name;
			if (reserved.has(name)) {
				add('field.reserved', `tables.${t}.fields.${f}`, `The "${table.name}" field "${name}" uses a name Caddie adds automatically (id, createdAt, updatedAt${ownerCol ? `, ${ownerCol}` : ''}). Rename it.`);
			}
			if (seen.has(name)) {
				add('field.duplicate', `tables.${t}.fields.${f}`, `The "${table.name}" table declares the field "${name}" more than once. Each field name must be unique.`);
			}
			seen.add(name);
		}
	}

	// --- caps (D7 + extras) --------------------------------------------------
	const features = featureIds(block);
	if (kind === 'small') {
		if (block.modules.length !== 1 || block.modules[0]?.id !== SMALL_APP_MODULE) {
			add('small.single-module', 'modules', `A small app has exactly one module, called "${SMALL_APP_MODULE}".`);
		}
		if (features.size > SMALL_CAPS.features) {
			add('cap.features', 'routes', `A small app can have at most ${SMALL_CAPS.features} features.`);
		}
		if (block.tables.length > SMALL_CAPS.tables) {
			add('cap.tables', 'tables', `A small app can have at most ${SMALL_CAPS.tables} kinds of record.`);
		}
	} else {
		if (block.modules.length > BIG_CAPS.modules) add('cap.modules', 'modules', `A big app can have at most ${BIG_CAPS.modules} parts.`);
		if (features.size > BIG_CAPS.features) add('cap.features', 'routes', `A big app can have at most ${BIG_CAPS.features} features.`);
		if (block.tables.length > BIG_CAPS.tables) add('cap.tables', 'tables', `A big app can have at most ${BIG_CAPS.tables} kinds of record.`);
		if (block.routes.length > BIG_CAPS.routes) add('cap.routes', 'routes', `A big app can have at most ${BIG_CAPS.routes} routes.`);
		if (block.screens.length > BIG_CAPS.screens) add('cap.screens', 'screens', `A big app can have at most ${BIG_CAPS.screens} screens.`);
		// at most 12 features per module
		const perModule = new Map<string, Set<string>>();
		for (const r of block.routes) {
			if (!perModule.has(r.module)) perModule.set(r.module, new Set());
			perModule.get(r.module)!.add(r.feature);
		}
		for (const [mod, feats] of perModule) {
			if (feats.size > BIG_CAPS.featuresPerModule) {
				add('cap.features-per-module', `modules.${mod}`, `Each part can have at most ${BIG_CAPS.featuresPerModule} features; "${mod}" has ${feats.size}.`);
			}
		}
	}
	if (block.services.length > EXTRA_CAPS.services) add('cap.services', 'services', `An app can use at most ${EXTRA_CAPS.services} outside services.`);
	if (block.ai.length > EXTRA_CAPS.ai) add('cap.ai', 'ai', `An app can have at most ${EXTRA_CAPS.ai} AI uses.`);
	if (block.emails.length > EXTRA_CAPS.emails) add('cap.emails', 'emails', `An app can send at most ${EXTRA_CAPS.emails} kinds of email.`);
	if (block.jobs.length > EXTRA_CAPS.jobs) add('cap.jobs', 'jobs', `An app can have at most ${EXTRA_CAPS.jobs} scheduled jobs.`);

	// --- unique ids ----------------------------------------------------------
	const dupe = (items: { id?: string; name?: string }[], key: 'id' | 'name', rule: string, path: string, label: string) => {
		const seen = new Set<string>();
		items.forEach((item, i) => {
			const value = item[key];
			if (value === undefined) return;
			if (seen.has(value)) add(rule, `${path}.${i}.${key}`, `Two ${label} are both called "${value}"; each needs its own name.`);
			seen.add(value);
		});
	};
	dupe(block.modules, 'id', 'unique.modules', 'modules', 'parts');
	dupe(block.tables, 'name', 'unique.tables', 'tables', 'kinds of record');
	dupe(block.routes, 'id', 'unique.routes', 'routes', 'routes');
	dupe(block.screens, 'id', 'unique.screens', 'screens', 'screens');
	dupe(block.services, 'id', 'unique.services', 'services', 'services');
	dupe(block.ai, 'id', 'unique.ai', 'ai', 'AI uses');
	dupe(block.emails, 'id', 'unique.emails', 'emails', 'emails');
	dupe(block.jobs, 'id', 'unique.jobs', 'jobs', 'jobs');

	// --- paths: /api/ and the reserved prefix --------------------------------
	block.routes.forEach((r, i) => {
		if (!r.path.startsWith('/api/')) {
			add('path.api-prefix', `routes.${i}.path`, `The route "${r.id}" must have a path that starts with /api/.`);
		}
		if (r.path.startsWith(RESERVED_API_PREFIX)) {
			add('path.reserved', `routes.${i}.path`, `The path for "${r.id}" uses ${RESERVED_API_PREFIX}, which Caddie keeps for itself. Choose another path.`);
		}
	});

	// --- everything belongs to one declared module ---------------------------
	const inModule = (id: string | undefined, path: string, label: string) => {
		if (id === undefined) return;
		if (!moduleIds.has(id)) add('module.unknown', path, `${label} points at a part "${id}" that this app does not have.`);
	};
	block.tables.forEach((t, i) => inModule(t.module, `tables.${i}.module`, `The record "${t.name}"`));
	block.routes.forEach((r, i) => inModule(r.module, `routes.${i}.module`, `The route "${r.id}"`));
	block.screens.forEach((s, i) => inModule(s.module, `screens.${i}.module`, `The screen "${s.id}"`));

	// --- dependsOn: no cycles, known modules ---------------------------------
	const deps = new Map(block.modules.map((m) => [m.id, m.dependsOn]));
	block.modules.forEach((m, i) => {
		m.dependsOn.forEach((d, j) => {
			if (!moduleIds.has(d)) add('module.unknown-dep', `modules.${i}.dependsOn.${j}`, `The part "${m.id}" is built after "${d}", but there is no such part.`);
		});
	});
	// cycle detection (depth-first)
	const WHITE = 0, GREY = 1, BLACK = 2;
	const colour = new Map<string, number>();
	let cycleReported = false;
	const visit = (id: string) => {
		if (cycleReported) return;
		colour.set(id, GREY);
		for (const d of deps.get(id) ?? []) {
			if (!moduleIds.has(d)) continue;
			const c = colour.get(d) ?? WHITE;
			if (c === GREY) {
				add('module.cycle', 'modules', `The parts "${id}" and "${d}" each wait for the other, so neither can be built first.`);
				cycleReported = true;
				return;
			}
			if (c === WHITE) visit(d);
		}
		colour.set(id, BLACK);
	};
	for (const m of block.modules) if ((colour.get(m.id) ?? WHITE) === WHITE) visit(m.id);

	// --- a module writes only its own tables; core is readable by all, written by core only ---
	const WRITE_OPS = new Set(['create', 'update', 'delete']);
	block.routes.forEach((r, i) => {
		if (r.table === null) return;
		const table = tableByName.get(r.table);
		if (!table) {
			add('route.unknown-table', `routes.${i}.table`, `The route "${r.id}" uses a record "${r.table}" that this app does not have.`);
			return;
		}
		if (WRITE_OPS.has(r.op) && table.module !== r.module) {
			if (table.module === CORE_MODULE) {
				add('module.core-write', `routes.${i}`, `The route "${r.id}" in part "${r.module}" changes a shared core record "${table.name}"; only the core part may change it.`);
			} else {
				add('module.cross-write', `routes.${i}`, `The route "${r.id}" in part "${r.module}" changes a record "${table.name}" that belongs to part "${table.module}".`);
			}
		}
	});

	// --- person/team-owned tables need full CRUD+list, none public/signed-in ---
	const privateOwners = new Set(['person', 'team']);
	for (let i = 0; i < block.tables.length; i++) {
		const t = block.tables[i]!;
		if (!privateOwners.has(t.owner)) continue;
		const ops = new Set(block.routes.filter((r) => r.table === t.name).map((r) => r.op));
		for (const needed of ['create', 'read', 'list', 'update', 'delete'] as const) {
			if (!ops.has(needed)) {
				add('table.missing-route', `tables.${i}`, `The record "${t.name}" is private, so it needs a way to ${needed} it, or the plan must say it leaves that out.`);
			}
		}
		for (const r of block.routes) {
			if (r.table !== t.name) continue;
			// The team table's own "create" and "list" are special: create makes
			// the team, and list shows the teams the person belongs to — neither
			// is scoped to a single :teamId, and both are reached as a signed-in
			// person. Every other route on the team table stays closed.
			const isTeamEntry = block.team?.table === t.name && (r.op === 'create' || r.op === 'list');
			if (r.access === 'public' || (r.access === 'signed-in' && !isTeamEntry)) {
				const j = block.routes.indexOf(r);
				add('table.private-open', `routes.${j}.access`, `The route "${r.id}" touches the private record "${t.name}", so it can't be open to ${r.access === 'public' ? 'everyone' : 'any signed-in person'}.`);
			}
		}
	}

	// --- team rules ----------------------------------------------------------
	const teamRoles = new Set(block.team?.roles ?? []);
	// team-owned tables need a declared team, and the team table belongs to core
	if (block.team) {
		const teamTable = tableByName.get(block.team.table);
		if (!teamTable) {
			add('team.table-missing', 'team.table', `The team record "${block.team.table}" must be one of the app's records.`);
		} else if (teamTable.module !== CORE_MODULE && kind === 'big') {
			add('team.table-core', 'team.table', `The team record "${block.team.table}" must belong to the core part.`);
		}
		if (!teamRoles.has(block.team.creatorRole)) {
			add('team.creator-role', 'team.creatorRole', `The role a team's creator gets, "${block.team.creatorRole}", must be one of the team's roles.`);
		}
	}
	block.tables.forEach((t, i) => {
		if (t.owner !== 'team') return;
		if (!block.team) {
			add('team.undeclared', `tables.${i}.owner`, `The record "${t.name}" belongs to a team, but this app has no team.`);
		}
	});
	// team routes: :teamId in path, team or team-role access with a known role
	block.routes.forEach((r, i) => {
		const table = r.table ? tableByName.get(r.table) : null;
		const touchesTeam = table?.owner === 'team';
		const role = teamRoleOf(r.access as Access);
		if (role !== null && !teamRoles.has(role)) {
			add('team.unknown-role', `routes.${i}.access`, `The route "${r.id}" needs the team role "${role}", which this app's teams don't have.`);
		}
		if (touchesTeam) {
			// The team table's "create" makes the team and "list" shows a person's
			// own teams — neither carries a :teamId, and both are reached as a
			// signed-in person (checked above).
			const isTeamEntry = block.team?.table === r.table && (r.op === 'create' || r.op === 'list');
			if (isTeamEntry) return;
			if (!r.path.includes(':teamId')) {
				add('team.route-path', `routes.${i}.path`, `The route "${r.id}" works on a team's records, so its path must include :teamId.`);
			}
			if (r.access !== 'team' && role === null) {
				add('team.route-access', `routes.${i}.access`, `The route "${r.id}" works on a team's records, so only a team member (team or team-role) may call it.`);
			}
		}
	});

	// --- admin and job access need sign-in; job only on a declared job route ---
	const jobRoutes = new Set(block.jobs.map((j) => j.route));
	block.routes.forEach((r, i) => {
		if ((r.access === 'admin' || r.access === 'job') && !hasSignIn(block)) {
			add('access.needs-sign-in', `routes.${i}.access`, `The route "${r.id}" is for ${r.access === 'admin' ? 'admins' : "Caddie's scheduled run"}, so the app must have sign-in.`);
		}
		if (r.access === 'job' && !jobRoutes.has(r.id)) {
			add('access.job-not-declared', `routes.${i}.access`, `The route "${r.id}" is marked for a scheduled run, but it is not listed under jobs.`);
		}
	});

	// --- every request field has an example ----------------------------------
	block.routes.forEach((r, i) => {
		r.request.forEach((f, j) => {
			if (!f.example || f.example.trim().length === 0) {
				add('request.needs-example', `routes.${i}.request.${j}.example`, `The field "${f.name}" on route "${r.id}" needs an example value.`);
			}
		});
	});

	// --- services: key name rule, https page ---------------------------------
	block.services.forEach((s, i) => {
		if (!APP_SECRET_NAME.test(s.keyName)) {
			add('service.key-name', `services.${i}.keyName`, `The key for "${s.id}" must be named in capitals, digits and underscores, like WEATHER_API_KEY.`);
		}
		if (!/^https:\/\//.test(s.keyPage)) {
			add('service.key-page', `services.${i}.keyPage`, `The page to get the "${s.id}" key must be an https web address.`);
		}
	});

	// --- AI: route exists; images need super ---------------------------------
	block.ai.forEach((a, i) => {
		if (!routeById.has(a.route)) {
			add('ai.unknown-route', `ai.${i}.route`, `The AI use "${a.id}" runs behind a route "${a.route}" that this app does not have.`);
		}
		if (a.images && a.tier !== 'super') {
			add('ai.images-super', `ai.${i}.tier`, `The AI use "${a.id}" looks at photos, so it needs the deeper "super" AI.`);
		}
	});

	// --- payments ------------------------------------------------------------
	if (block.payments) {
		const p = block.payments;
		if (!CURRENCY.test(p.currency)) add('payments.currency', 'payments.currency', `The currency must be a 3-letter code like USD.`);
		if (p.plans.length < 1 || p.plans.length > 3) add('payments.plan-count', 'payments.plans', `Payments need 1 to 3 plans.`);
		p.plans.forEach((plan, i) => {
			if (!Number.isInteger(plan.priceMinor) || plan.priceMinor < 1 || plan.priceMinor > 100_000) {
				add('payments.price', `payments.plans.${i}.priceMinor`, `The price of "${plan.id}" must be a whole amount from 1 to 100000 (in the smallest unit, like cents).`);
			}
		});
		const planIds = new Set(p.plans.map((pl) => pl.id));
		p.locked.forEach((l, i) => {
			const route = routeById.get(l.route);
			if (!route) {
				add('payments.locked-route', `payments.locked.${i}.route`, `A paid plan unlocks a route "${l.route}" that this app does not have.`);
			} else if (route.access === 'public') {
				add('payments.locked-open', `payments.locked.${i}.route`, `The paid route "${l.route}" is open to everyone, so a plan can't gate it; it needs sign-in.`);
			}
			l.plans.forEach((plan, j) => {
				if (!planIds.has(plan)) add('payments.locked-plan', `payments.locked.${i}.plans.${j}`, `A locked route names a plan "${plan}" that this app does not have.`);
			});
		});
	}

	// --- emails: route exists, needs sign-in, request-field names an email ----
	block.emails.forEach((e, i) => {
		const route = routeById.get(e.route);
		if (!route) {
			add('email.unknown-route', `emails.${i}.route`, `The email "${e.id}" is sent by a route "${e.route}" that this app does not have.`);
			return;
		}
		if (route.access === 'public') {
			add('email.open-route', `emails.${i}.route`, `The route "${e.route}" that sends the "${e.id}" email is open to everyone; it needs sign-in.`);
		}
		if (e.to.startsWith('request-field:')) {
			const fieldName = e.to.slice('request-field:'.length);
			const field = route.request.find((f) => f.name === fieldName);
			if (!field) {
				add('email.to-field', `emails.${i}.to`, `The "${e.id}" email goes to the field "${fieldName}", which the route "${e.route}" does not ask for.`);
			} else if (field.type !== 'text' || !EMAIL_EXAMPLE.test(field.example)) {
				add('email.to-example', `emails.${i}.to`, `The "${e.id}" email goes to the field "${fieldName}", so its example must be an email address.`);
			}
		}
	});

	return issues;
}

// --- the design gate (plan part B — "The gate") ------------------------------
//
// decideDesign (build-workflow.ts) calls evaluateDesignGate before it approves
// a design IN TEAM MODE ONLY. It refuses approval while the design's
// caddie-architecture block is missing, fails the deterministic rules, or has
// open security issues from the Ultra review — listing the plain sentences.
// On approval the host stores the design revision id (approvedDesignRevisionId,
// migration 0040), and getApprovedBlock(db, projectId) returns that revision's
// block for lanes E and P. teamMode=0 never reaches any of this.

/** Which app kind to check a block as, from a workflow's big-apps flag. */
export function architectureKindForBuild(bigApps: boolean): ArchitectureKind {
	return bigApps ? 'big' : 'small';
}

export type DesignGateResult =
	| { ok: true; block: ArchitectureBlock; blockHash: string }
	| { ok: false; reason: 'missing' | 'rules' | 'security' | 'change-plan'; messages: string[] };

/**
 * Decide whether a design brief may be approved in team mode. In order:
 *   1. the brief must carry a valid caddie-architecture block (parse);
 *   2. the block must pass every deterministic rule (checkArchitecture);
 *   3. the Ultra review's latest round for this exact block must carry no open
 *      security issue — and if security issues have persisted for the round
 *      limit, the reason is 'change-plan' (the coordinator must change the plan
 *      and go back to plan review), not another review of the same block.
 * `ok: true` carries the block and its hash so the caller binds the approval
 * to exactly the reviewed block. Every `messages` entry is a plain sentence.
 */
export function evaluateDesignGate(
	designBody: string,
	options: { kind: ArchitectureKind; reviews: ArchitectureReviewRound[]; available?: AvailableFeatures },
): DesignGateResult {
	const parsed = parseArchitectureBlock(designBody);
	if (!parsed.ok) {
		return {
			ok: false,
			reason: 'missing',
			messages: ['The design does not yet describe how the app works. Caddie must add the "How your app works" block before this can be approved.'],
		};
	}
	const issues = checkArchitecture(parsed.block, { kind: options.kind, ...(options.available ? { available: options.available } : {}) });
	if (issues.length > 0) {
		return { ok: false, reason: 'rules', messages: issues.map((i) => i.message) };
	}
	const { raw } = splitArchitectureBlock(designBody);
	const blockHash = architectureBlockHash(raw ?? '');
	const verdict = reviewVerdict(options.reviews, blockHash);
	if (verdict.blocks) {
		const security = verdict.securityMessages.length
			? verdict.securityMessages
			: ['The architecture review has not run on this design yet, so Caddie cannot confirm it is safe.'];
		if (verdict.mustChangePlan) {
			return {
				ok: false,
				reason: 'change-plan',
				messages: [
					'The review found the same safety problems twice. Caddie should change the plan and send it back to plan review instead of trying the same design again.',
					...security,
				],
			};
		}
		return { ok: false, reason: 'security', messages: security };
	}
	return { ok: true, block: parsed.block, blockHash };
}

/**
 * The architecture block of the APPROVED design revision of a project, for
 * lanes E and P. Reads approvedDesignRevisionId off the workflow, loads that
 * revision's body, and returns its parsed block — null when no design is
 * approved yet or the stored revision somehow carries no valid block.
 */
export async function getApprovedBlock(
	db: {
		prepare: (sql: string) => {
			bind: (...args: unknown[]) => { all: <T = Record<string, unknown>>() => Promise<{ results?: T[] }> };
		};
	},
	projectId: string,
): Promise<ArchitectureBlock | null> {
	const workflow = (
		await db.prepare('select "approvedDesignRevisionId" from "build_workflows" where "projectId" = ?').bind(projectId).all<{
			approvedDesignRevisionId: string | null;
		}>()
	).results?.[0];
	const revisionId = workflow?.approvedDesignRevisionId;
	if (!revisionId) return null;
	const revision = (
		await db.prepare('select "body" from "plan_doc_revisions" where "id" = ?').bind(revisionId).all<{ body: string }>()
	).results?.[0];
	if (!revision) return null;
	const parsed = parseArchitectureBlock(revision.body);
	return parsed.ok ? parsed.block : null;
}

/**
 * The APPROVED design's theme (its caddie-theme block), or null when no design
 * is approved yet or the approved revision carries no valid theme. Works in
 * team and non-team mode: `approvedDesignRevisionId` is stamped on any design
 * approval. The host writes this into the app's `caddie/theme.css` so every app
 * is painted in the look the user approved. Shares the exact reader shape with
 * getApprovedBlock.
 */
export async function getApprovedTheme(
	db: {
		prepare: (sql: string) => {
			bind: (...args: unknown[]) => { all: <T = Record<string, unknown>>() => Promise<{ results?: T[] }> };
		};
	},
	projectId: string,
): Promise<AppTheme | null> {
	const workflow = (
		await db.prepare('select "approvedDesignRevisionId" from "build_workflows" where "projectId" = ?').bind(projectId).all<{
			approvedDesignRevisionId: string | null;
		}>()
	).results?.[0];
	const revisionId = workflow?.approvedDesignRevisionId;
	if (!revisionId) return null;
	const revision = (
		await db.prepare('select "body" from "plan_doc_revisions" where "id" = ?').bind(revisionId).all<{ body: string }>()
	).results?.[0];
	if (!revision) return null;
	const parsed = parseAppTheme(revision.body);
	return parsed.ok ? parsed.theme : null;
}

/** The body of the app's `caddie/theme.css` for an approved theme (a `:root{}` rule). */
export function themeCssFor(theme: AppTheme): string {
	return `/* Caddie wrote your app's look here from the approved design "${theme.name}". Do not edit. */\n:root {\n${themeToCssVars(theme)
		.split('\n')
		.map((line) => `  ${line}`)
		.join('\n')}\n}\n`;
}
