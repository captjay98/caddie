/**
 * Project experience projection (R01, plan §5).
 *
 * Pure derivation: `projectExperience` turns the existing workflow snapshot
 * (build_workflows + latest prd revision + durable approval) into the ONE
 * shared `ProjectExperience` the UI reads. It performs NO writes and holds NO
 * state of its own.
 *
 * `approvePlan` is the command boundary: it maps the versioned, idempotent
 * `ApprovePlanCommand` onto the already-durable `decideWorkflow`, translating
 * its outcomes into the uniform `ExperienceCommandResult`. Buttons and an
 * unambiguous conversational approval both call this; authority stays
 * server-derived (the scope is the authenticated session's, never the body).
 */

import type {
	ApprovePlanCommand,
	ExperienceAction,
	ExperienceCommandResult,
	ProjectExperience,
	Scope,
	DesignOverview,
	DesignModule,
	DesignScreen,
	DesignReviewFindings,
	ModuleProgressItem,
	ModuleProgressState,
	SpendStop,
} from '@caddie/contracts';
import { parseArchitectureBlock, splitArchitectureBlock, type ArchitectureBlock } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { projectScopeForUser, ScopeError } from './scope.ts';
import { decideWorkflow, workflowSnapshot, readWorkflow, type BuildWorkflow } from './build-workflow.ts';
import { listBuildFeatures } from './build-features.ts';
import { canTryAgainFromSavePoint } from './build-steps.ts';
import { getProject } from './projects.ts';
import { buildActivity } from './build-activity.ts';
import { summariseArchitecture } from './architecture-summary.ts';
import { architectureBlockHash, listArchitectureReviews, reviewVerdict } from './architecture-review.ts';
import { listModules, type ModuleRow, type ModuleStatus } from './module-slots.ts';
import { lookupRunByConversation } from './runs.ts';

/** The sentinel stopWorkflow writes into detail; distinguishes stop from repair/infra block. */
export const STOP_SENTINEL = 'Stop requested.';

// --- "How your app works" (team mode, plan part B / section 7, screen 1) -----
//
// Pure projectors from the real architecture block + architect review into the
// serializable DesignOverview the Design review screen reads. Nothing is
// guessed — a section the block leaves empty is omitted upstream by
// summariseArchitecture, and the review is absent until the architect runs.

/** The one small-app module id (part B). An app with only this is 'small'. */
const SMALL_APP_MODULE = 'app';

/**
 * Turn an approved `caddie-architecture` block (and the architect's review,
 * when it has run) into the plain "How your app works" overview. Pure.
 *
 * - `app` is 'big' when the block has more than one module, else 'small'.
 * - `sections` are summariseArchitecture's plain-words groups (what it saves,
 *   who can do what, sign-in, services, AI, test-mode), each non-empty.
 * - `screens` are the declared screens in plain words, grouped by module.
 * - `modules` is present only for a big app (the parts side by side).
 * - `review` carries the architect's findings, security apart from advisory.
 * - `approved` says whether the person approved this exact design revision.
 */
export function designOverviewFrom(
	block: ArchitectureBlock,
	review: DesignReviewFindings | null,
	opts: { approved?: boolean } = {},
): DesignOverview {
	const big = block.modules.length > 1;
	const screens: DesignScreen[] = block.screens.map((s) => ({ plain: s.plain, module: s.module }));
	const overview: DesignOverview = {
		app: big ? 'big' : 'small',
		sections: summariseArchitecture(block),
		screens,
		approved: opts.approved === true,
	};
	if (big) {
		const modules: DesignModule[] = block.modules.map((m) => ({ id: m.id, plain: m.plain }));
		return { ...overview, modules, ...(review ? { review } : {}) };
	}
	return { ...overview, ...(review ? { review } : {}) };
}

// --- big-app module board (team mode, plan part P / section 7, screen 2) -----

/**
 * Map a stored module status to the plain state the person reads:
 *   pending     — waiting (a dependency or a slot is not ready yet);
 *   building    — building (a builder is on it);
 *   passed      — built (its own checks passed; it is joined in next, so it
 *                 is not in the app yet);
 *   merged      — joined (its part is in the app);
 *   not-merged  — not joined (a round of joining failed);
 *   stopped     — stopped (it stopped; the rest kept going).
 */
export function moduleProgressState(status: ModuleStatus): ModuleProgressState {
	switch (status) {
		case 'building':
			return 'building';
		case 'passed':
			return 'built';
		case 'merged':
			return 'joined';
		case 'not-merged':
			return 'not-joined';
		case 'stopped':
			return 'stopped';
		case 'pending':
		default:
			return 'waiting';
	}
}

/**
 * The per-module board for the build-progress screen. Each module's plain name
 * comes from the approved block; a module missing from the block falls back to
 * its id. `waitingFor` lists the dependencies of a waiting module that are not
 * merged yet (a dependent starts from the merged app, so a dependency that has
 * only passed its own checks still holds it), so the screen can say "Money:
 * waiting for Farms". Pure.
 */
export function moduleBoardToProgress(
	rows: readonly ModuleRow[],
	block: ArchitectureBlock | null,
	opts: { canRetry?: boolean } = {},
): ModuleProgressItem[] {
	const plainOf = new Map((block?.modules ?? []).map((m) => [m.id, m.plain] as const));
	const merged = new Set(rows.filter((r) => r.status === 'merged').map((r) => r.moduleId));
	return rows.map((row) => {
		const state = moduleProgressState(row.status);
		const item: ModuleProgressItem = {
			id: row.moduleId,
			plain: plainOf.get(row.moduleId) ?? row.moduleId,
			state,
		};
		if (state === 'waiting') {
			const waitingFor = row.dependsOn.filter((dep) => !merged.has(dep)).map((dep) => plainOf.get(dep) ?? dep);
			if (waitingFor.length > 0) return { ...item, waitingFor };
		}
		if (opts.canRetry && (state === 'not-joined' || state === 'stopped')) return { ...item, canRetry: true };
		return item;
	});
}

// --- spending-limit stop (team mode, plan part A / section 7, screen 2) ------

/** The sentinel the spend interceptor writes into detail when a build stops at its limit. */
export const SPEND_STOP_SENTINEL = 'reached its spending limit';

/** What retrying a spend-stopped build does (part A: a retry opens a fresh limit). */
export const SPEND_STOP_RETRY_NOTE = 'Retrying starts the build again with a new spending limit.';

/**
 * The spending-limit stop, when a build stopped because it reached its limit.
 * The stop sentence ("This build reached its spending limit of $5.00. Your
 * plan and files are saved.", SpendLimitError) is already the blocker detail
 * every blocked view shows, so this adds only what that sentence leaves out:
 * what retrying does. Returns null when the stop is not a spend stop. Pure.
 */
export function spendStopFrom(workflow: BuildWorkflow | null): SpendStop | null {
	const detail = workflow?.detail?.trim() ?? '';
	if (workflow?.phase !== 'blocked' || !detail.includes(SPEND_STOP_SENTINEL)) return null;
	return { note: SPEND_STOP_RETRY_NOTE };
}

/** Derive a monotonic version from the workflow's updatedAt (no new column). */
function versionOf(workflow: BuildWorkflow | null): number {
	if (!workflow?.updatedAt) return 0;
	const ms = Date.parse(workflow.updatedAt);
	return Number.isFinite(ms) ? ms : 0;
}

/**
 * Map the coarse server phase (+ detail sentinel + approval) to the richer
 * user-facing stage. `blocked` splits into `stopped` (user), `planning_blocked`
 * (blocked before the plan was ever approved — a stuck plan, nothing built to
 * retry) vs `blocked` (an approved build hit a repair/limit/infra wall).
 * `building` stays the umbrella (the UI narrates checking/repairing from
 * detail/preview, but the deterministic stage is `building`).
 */
function stageOf(workflow: BuildWorkflow | null, planApproved: boolean): ProjectExperience['stage'] {
	if (!workflow) return 'planning';
	switch (workflow.phase) {
		case 'planning':
			return 'planning';
		case 'review':
			return 'review';
		case 'looks':
			return 'looks';
		case 'looks-review':
			return 'looks_review';
		case 'design':
			return 'design';
		case 'design-review':
			return 'design_review';
		case 'building':
			return 'building';
		case 'ready':
			return 'ready';
		case 'blocked':
			if (workflow.detail?.startsWith(STOP_SENTINEL)) return 'stopped';
			// A block before any approved plan is a stuck PLAN, not a stuck build.
			return planApproved ? 'blocked' : 'planning_blocked';
		default:
			return 'planning';
	}
}

/** A short, user-facing message derived from real state — never model prose. */
function messageOf(
	stage: ProjectExperience['stage'],
	workflow: BuildWorkflow | null,
	planApproved: boolean,
): string {
	switch (stage) {
		case 'planning':
			return 'Caddie is preparing a plan for this project.';
		case 'review':
			return 'A plan is ready for your review.';
		case 'looks':
			return 'Caddie is preparing a few looks for your app. You pick one before the screens are designed.';
		case 'looks_review':
			return 'Choose how your app should look. Caddie then designs every screen in that look.';
		case 'design':
			return 'Caddie is designing the screens. You review the design before anything is built.';
		case 'design_review':
			return 'A design is ready for your review. Nothing is built until you approve it.';
		case 'building':
			return planApproved
				? 'Caddie is building and checking your app.'
				: 'Working on your project.';
		case 'ready':
			return 'Your app passed the required checks. Try it out.';
		case 'blocked':
			return workflow?.detail?.trim()
				? workflow.detail.trim()
				: 'This project needs your input before Caddie can continue.';
		case 'planning_blocked':
			return "Caddie couldn't finish writing your plan. Nothing has been built yet — tell Caddie to continue and it will pick up your request and feedback.";
		case 'stopped':
			return 'Work stopped. Your plan and files are retained; retry when you are ready.';
		default:
			return 'Working on your project.';
	}
}

/**
 * The actions per stage. At most one carries primary=true: the stage's main
 * button when it waits for the person. While Caddie builds nothing needs the
 * person, so there is none, and Stop is never drawn as the filled button.
 * Every action is re-authorized server-side when invoked; these flags only
 * drive what the UI OFFERS.
 */
function actionsOf(
	stage: ProjectExperience['stage'],
	hasPlan: boolean,
	hasPreview: boolean,
	canTryAgain: boolean,
): ExperienceAction[] {
	switch (stage) {
		case 'planning':
			return [{ kind: 'suggest_change', label: 'Continue the conversation', enabled: true, primary: true }];
		case 'review':
			return [
				{ kind: 'approve_plan', label: 'Approve plan', enabled: hasPlan, primary: true,
					...(hasPlan ? {} : { reason: 'No plan revision is ready yet.' }) },
				{ kind: 'suggest_change', label: 'Request a change', enabled: hasPlan, primary: false },
			];
		case 'looks':
			return [{ kind: 'suggest_change', label: 'Continue the conversation', enabled: true, primary: true }];
		case 'looks_review':
			return [{ kind: 'choose_look', label: 'Choose a look', enabled: true, primary: true }];
		case 'design':
			return [{ kind: 'suggest_change', label: 'Continue the conversation', enabled: true, primary: true }];
		case 'design_review':
			return [
				{ kind: 'review_design', label: 'Review design', enabled: true, primary: true },
				{ kind: 'suggest_change', label: 'Request a change', enabled: true, primary: false },
			];
		case 'building':
		case 'checking':
		case 'repairing':
			return [
				{ kind: 'stop', label: 'Stop build', enabled: true, primary: false },
				...(hasPreview
					? [{ kind: 'open_preview' as const, label: 'View last preview', enabled: true, primary: false }]
					: []),
			];
		case 'ready':
			return [
				{ kind: 'open_preview', label: 'Try app', enabled: hasPreview, primary: true,
					...(hasPreview ? {} : { reason: 'No verified preview exists yet.' }) },
				{ kind: 'suggest_change', label: 'Request a change', enabled: true, primary: false },
			];
		case 'blocked':
			// Team mode (part F): a build stopped after three failed tries offers
			// "try this feature again from the last save point" as the primary
			// action; the resume (retryWorkflow) stays as a secondary. With team
			// mode off canTryAgain is false, so only the resume shows (unchanged).
			if (canTryAgain)
				return [
					{ kind: 'try_again', label: 'Try this feature again', enabled: true, primary: true },
					{ kind: 'retry', label: 'Resume the build', enabled: true, primary: false },
				];
			// The button resumes the build (retryWorkflow); a stalled build's
			// message says "Press Retry to continue from here".
			return [{ kind: 'retry', label: 'Retry build', enabled: true, primary: true }];
		case 'planning_blocked':
			// Nothing is built — the one action resumes PLANNING (retryWorkflow
			// routes a pre-approval block back to planning), worded honestly.
			return [{ kind: 'retry', label: 'Continue the plan', enabled: true, primary: true }];
		case 'stopped':
			return [{ kind: 'retry', label: 'Resume', enabled: true, primary: true }];
		default:
			return [];
	}
}

/** Build the shared projection from a workflow snapshot. Pure. */
export async function projectExperience(db: D1Database, scope: Scope): Promise<ProjectExperience> {
	const { workflow, plan, approval, design, designApproval } = await workflowSnapshot(db, scope);
	const planApproved = approval?.status === 'approved';
	// A block is a stuck PLAN only when this revision was never approved. A
	// revoked/expired approval is a stopped BUILD (retry is then denied by the
	// approval gate) — the same rule retryWorkflow uses.
	const planEverApproved =
		approval?.status === 'approved' || approval?.status === 'revoked' || approval?.status === 'expired';
	const stage = stageOf(workflow, planEverApproved);
	const hasPlan = Boolean(plan);
	const previewId = workflow?.previewId ?? null;
	const hasPreview = Boolean(previewId);
	// A preview is "current" only when it belongs to the latest plan the
	// workflow points at AND that plan is approved.
	const previewCurrent = hasPreview && Boolean(plan) && workflow?.planId === plan!.id && planApproved;

	// Team mode (part F): offer "try this feature again from the last save
	// point" only on a stopped team-mode build after three failed tries. The
	// gate reads teamMode + the feature rows; with team mode off it is false, so
	// the blocked stage shows only the resume action (unchanged behaviour). Read
	// the full workflow (teamMode) and the feature rows; cheap and only when
	// blocked.
	let canTryAgain = false;
	if (stage === 'blocked') {
		const full = await readWorkflow(db, scope);
		const features = full?.planId ? await listBuildFeatures(db, scope.projectId, full.planId) : [];
		canTryAgain = canTryAgainFromSavePoint(full, features);
	}

	// Team mode (plan part B / P / A, section 7): the plain-words extras the
	// Design review and build-progress screens read. All optional and
	// read-only: computed only when the real source exists, absent otherwise,
	// so a non-team-mode project's projection is byte-identical to before.
	const design_overview = await designOverviewFor(db, scope, design, designApproval?.status === 'approved');
	// Big apps: Try again on a part is the build owner's, while the build is
	// ready or building (a stopped build is retried as a whole first).
	const partRetryAllowed =
		(workflow?.phase === 'ready' || workflow?.phase === 'building') &&
		workflow !== null &&
		(await lookupRunByConversation(db, workflow.conversationId))?.createdBy === scope.actorId;
	const modules = await moduleProgressFor(db, scope, design, { canRetry: partRetryAllowed });
	const spendStop = spendStopFrom(workflow);

	return {
		projectId: scope.projectId,
		version: versionOf(workflow),
		stage,
		plan: plan ? { id: plan.id, revision: String(plan.revision), approved: planApproved } : null,
		preview: previewId
			? { id: previewId, revision: plan ? String(plan.revision) : 'unknown', current: previewCurrent }
			: null,
		message: messageOf(stage, workflow, planApproved),
		actions: actionsOf(stage, hasPlan, hasPreview, canTryAgain),
		...(design_overview ? { design: design_overview } : {}),
		...(modules ? { modules } : {}),
		...(spendStop ? { spendStop } : {}),
	};
}

/** The design doc revision shape workflowSnapshot returns (its body carries the block). */
type DesignDoc = { readonly body: string } | null;

/**
 * Read the approved `caddie-architecture` block from the latest design doc and
 * the architect's review, and project them into the Design review overview.
 * Returns null when there is no design, no architecture block in it, or the
 * block does not parse (a non-team-mode or pre-block design) — the screen then
 * shows nothing.
 */
async function designOverviewFor(db: D1Database, scope: Scope, design: DesignDoc, approved: boolean): Promise<DesignOverview | null> {
	if (!design?.body) return null;
	const parsed = parseArchitectureBlock(design.body);
	if (!parsed.ok) return null;
	const review = await reviewFindingsFor(db, scope, design.body);
	return designOverviewFrom(parsed.block, review, { approved });
}

/** The architect's findings for the exact block in `body`, or null before the architect ran. */
async function reviewFindingsFor(db: D1Database, scope: Scope, body: string): Promise<DesignReviewFindings | null> {
	const { raw } = splitArchitectureBlock(body);
	if (raw === null) return null;
	const rounds = await listArchitectureReviews(db, scope.projectId);
	if (rounds.length === 0) return null;
	const verdict = reviewVerdict(rounds, architectureBlockHash(raw));
	if (verdict.round === 0) return null;
	return { blocks: verdict.blocks, security: verdict.securityMessages, advisory: verdict.advisoryMessages };
}

/**
 * The big-app module board for the build-progress screen. Returns null for a
 * small app (one module or no block) — the screen then shows the small-app
 * server/screens parts. Reads the most recent build's modules.
 */
async function moduleProgressFor(
	db: D1Database,
	scope: Scope,
	design: DesignDoc,
	opts: { canRetry?: boolean } = {},
): Promise<ModuleProgressItem[] | null> {
	const block = design?.body ? parseArchitectureBlock(design.body) : null;
	const parsedBlock = block?.ok ? block.block : null;
	// A small app (0-1 modules) has no board.
	if (!parsedBlock || parsedBlock.modules.length <= 1) return null;
	const buildSeq = await latestModuleBuildSeq(db, scope.projectId);
	if (buildSeq === null) return null;
	const rows = await listModules(db, scope.projectId, buildSeq);
	if (rows.length === 0) return null;
	return moduleBoardToProgress(rows, parsedBlock, opts);
}

/** The newest buildSeq that has module rows for this project, or null when none. */
async function latestModuleBuildSeq(db: D1Database, projectId: string): Promise<number | null> {
	const res = await db
		.prepare('select max("buildSeq") as "seq" from "build_modules" where "projectId" = ?')
		.bind(projectId)
		.all<{ seq: number | null }>();
	const seq = res.results?.[0]?.seq;
	return typeof seq === 'number' ? seq : null;
}

/**
 * The approve-plan command. Versioned + idempotent on top of the already
 * durable decideWorkflow. Returns the uniform outcome plus the refreshed
 * projection (always current truth).
 */
export async function approvePlan(
	db: D1Database,
	scope: Scope,
	command: ApprovePlanCommand,
	limits?: unknown,
): Promise<ExperienceCommandResult> {
	if (command.projectId !== scope.projectId) {
		// The authenticated scope is authoritative; a mismatched body is denied,
		// never silently retargeted.
		return {
			outcome: 'denied',
			code: 'PROJECT_MISMATCH',
			experience: await projectExperience(db, scope),
		};
	}

	// Optimistic-concurrency check against the projection the client acted on.
	const before = await projectExperience(db, scope);
	if (before.version !== command.expectedVersion) {
		return { outcome: 'stale', code: 'STALE_VERSION', experience: before };
	}
	// The exact revision must still be the one presented.
	if (!before.plan || before.plan.id !== command.planRevisionId) {
		return { outcome: 'stale', code: 'STALE_PLAN', experience: before };
	}
	// A duplicate click on an already-approved revision is a no-op.
	if (before.plan.approved) {
		return { outcome: 'noop', experience: before };
	}

	try {
		await decideWorkflow(db, scope, { planId: command.planRevisionId, decision: 'approved' }, limits);
	} catch (error) {
		if (error instanceof ScopeError) {
			// A judge limit is not a stale projection: it must reach the route's
			// {error,message} handler with its 403, not become a silent 'denied'
			// with the plain sentence dropped.
			if (error.code.startsWith('JUDGE_LIMIT_')) throw error;
			// STALE_PLAN etc. from the durable layer — surface as a refreshable
			// conflict, never a crash, with the current truth attached.
			const code = error.code;
			const outcome = code === 'STALE_PLAN' ? 'stale' : 'denied';
			return { outcome, code, experience: await projectExperience(db, scope) };
		}
		throw error;
	}
	return { outcome: 'applied', experience: await projectExperience(db, scope) };
}

/** What Caddie may say about one of the person's own projects (plan 3.7). */
export type ProjectStatusReply =
	| {
			found: true;
			name: string;
			stage: ProjectExperience['stage'];
			/** The same sentence the project page shows. */
			message: string;
			/** "3 of 7 features done", or null before the build has features. */
			features: string | null;
			/** The build's latest line while it runs or is stopped, else null. */
			latest: string | null;
	  }
	| { found: false; message: string };

/**
 * Home Caddie's read of a project's progress: read-only, the person's own
 * projects only (the same membership check every project route makes), in
 * words and without record ids.
 */
export async function projectStatusForActor(db: D1Database, actorId: string, projectId: string): Promise<ProjectStatusReply> {
	let scope: Scope;
	try {
		scope = await projectScopeForUser(db, actorId, projectId);
	} catch (error) {
		if (error instanceof ScopeError) return { found: false, message: 'None of your projects has that id; use one from the list of existing projects.' };
		throw error;
	}
	const project = await getProject(db, scope);
	if (project.kind === 'home') return { found: false, message: 'That is Home, not a project.' };
	const experience = await projectExperience(db, scope);
	const activity = await buildActivity(db, scope);
	const done = activity.features.filter((feature) => feature.status === 'passed').length;
	return {
		found: true,
		name: project.name,
		stage: experience.stage,
		message: experience.message,
		features: activity.features.length > 0 ? `${done} of ${activity.features.length} features done` : null,
		latest: activity.building || activity.phase === 'blocked' ? activity.timeline.summary : null,
	};
}
