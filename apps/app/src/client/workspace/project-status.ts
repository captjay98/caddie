import type { DecisionCard, ProjectExperience } from '@caddie/contracts';
import type { ProjectStepId, StepStatus } from './ProjectTabs.tsx';

/** Where a Projects-card action goes. */
export type ProjectCardTarget = 'chat' | 'project' | 'plan';

/** The Projects-list card, derived from the project's REAL workflow state. */
export interface ProjectCardState {
	readonly label: string;
	readonly tone: 'neutral' | 'action' | 'warn' | 'ok' | 'danger';
	/** True while Caddie is actively working (live dot). */
	readonly working: boolean;
	readonly detail: string;
	readonly action: { readonly label: string; readonly target: ProjectCardTarget };
}

/**
 * The Projects card from the shared ProjectExperience projection — the same
 * truth the project's Now panel reads — so the list can never say "No updates
 * yet" while Caddie is building. Returns null when the project has no workflow
 * (version 0); the caller then falls back to its Brief-card summary.
 */
export function projectCardFromExperience(experience: ProjectExperience): ProjectCardState | null {
	if (experience.version === 0) return null;
	switch (experience.stage) {
		case 'planning':
			return { label: 'Writing the plan', tone: 'action', working: true, detail: 'Caddie is drafting a plan for you to review. Nothing is built before you approve it.', action: { label: 'Continue with Caddie', target: 'chat' } };
		case 'review':
			return { label: 'Plan ready', tone: 'warn', working: false, detail: 'A plan is ready. Review it before anything is built.', action: { label: 'Review plan', target: 'plan' } };
		case 'design':
			return { label: 'Designing', tone: 'action', working: true, detail: 'Caddie is designing the screens. You review the design before anything is built.', action: { label: 'Continue with Caddie', target: 'chat' } };
		case 'design_review':
			return { label: 'Design ready', tone: 'warn', working: false, detail: 'A design is ready. Review it before anything is built.', action: { label: 'Review design', target: 'chat' } };
		case 'building':
		case 'checking':
			return { label: 'Building', tone: 'action', working: true, detail: 'Caddie is building your app and running its checks.', action: { label: 'See progress', target: 'project' } };
		case 'repairing':
			return { label: 'Fixing a problem', tone: 'action', working: true, detail: 'A check failed and Caddie is trying a fix.', action: { label: 'See progress', target: 'project' } };
		case 'ready':
			return { label: 'Ready to try', tone: 'ok', working: false, detail: 'Passed the required checks. Try it and tell Caddie what to change.', action: { label: 'Try app', target: 'project' } };
		case 'blocked':
			return { label: 'Needs attention', tone: 'danger', working: false, detail: experience.message, action: { label: 'Review next step', target: 'project' } };
		case 'planning_blocked':
			return { label: 'Plan needs another pass', tone: 'warn', working: false, detail: 'Caddie didn’t finish the plan. Nothing was built — continue and it picks up your feedback.', action: { label: 'Continue the plan', target: 'project' } };
		case 'stopped':
			return { label: 'Paused', tone: 'neutral', working: false, detail: 'Work is paused. Your plan and files are kept.', action: { label: 'Resume', target: 'project' } };
	}
}

const PRIORITY = { 'needs-you': 0, blocked: 1, changed: 2, handled: 3 };

/** The part of the copied-app preview the Projects card needs (import-preview.ts's view). */
export interface CopiedAppSummary {
	readonly status: 'checking' | 'ready' | 'failed';
	readonly origin?: 'github' | 'example';
	readonly message: string | null;
}

/**
 * The Projects card for a project with no workflow yet but a copied app: a
 * judge's finished example (S07b) or a "Start from my GitHub repo" copy.
 * Without this the card fell back to "No updates yet" while the project page
 * already showed the app ready to try.
 */
export function projectCardFromCopiedApp(preview: CopiedAppSummary): ProjectCardState {
	if (preview.status === 'ready') {
		return {
			label: 'Ready to try',
			tone: 'ok',
			working: false,
			detail:
				preview.origin === 'example'
					? 'An example app Caddie built. Try it, then tell Caddie what to change.'
					: 'Your app from GitHub is ready. Try it, then tell Caddie what to change.',
			action: { label: 'Try app', target: 'project' },
		};
	}
	if (preview.status === 'checking') {
		return { label: 'Getting it ready', tone: 'action', working: true, detail: 'Caddie is building the copied app so you can try it.', action: { label: 'See progress', target: 'project' } };
	}
	return {
		label: 'Code copied',
		tone: 'warn',
		working: false,
		detail: preview.message ?? 'Your code is saved. Tell Caddie what you would like, and it fixes the build first.',
		action: { label: 'Continue with Caddie', target: 'chat' },
	};
}

/** Brief cards report events, not a completed percentage of a build. */
export function projectStatus(cards: readonly DecisionCard[]) {
	const ordered = [...cards].sort((a, b) =>
		PRIORITY[a.status] - PRIORITY[b.status] || b.updatedAt.localeCompare(a.updatedAt));
	const next = ordered.find((card) => card.status !== 'handled') ?? null;
	const latest = next ?? ordered[0] ?? null;
	let label = 'No updates yet';
	if (latest) {
		if (latest.status === 'blocked') label = 'Needs attention';
		else if (latest.kind === 'approval' && latest.status === 'needs-you') label = 'Decision needed';
		else if (latest.status === 'changed') label = 'Changes to review';
		else if (latest.id.startsWith('brf_preview_')) label = 'Preview available';
		else if (latest.kind === 'deadline') label = 'Upcoming deadline';
		else label = 'Update available';
	}
	return {
		label,
		detail: latest?.summary ?? 'Tell Caddie what you would like to build or change.',
		next,
	};
}

/** The server workflow phase, as the pages read it from /workflow. */
export type WorkflowPhase = import('../../server/build-workflow.ts').WorkflowPhase;

/**
 * Plain-language status for the four project steps, derived ONLY from real
 * server state (the workflow phase, plus an optional Check readiness count).
 * A step is `done` (green ✓) only when its data genuinely says done; nothing
 * is invented, and an unknown phase leaves the later steps neutral.
 *
 * The mental model this encodes: Plan → Build → Check → Share. The phase moves
 * Plan and Build; Check and Share report their own readiness when the page
 * that owns them supplies it. Words are user-facing (copy.ts vocabulary), not
 * phase identifiers.
 */
export function workflowSteps(
	phase: WorkflowPhase | null,
	opts?: { personal?: boolean; checkReady?: { verified: number; total: number } | null },
): Partial<Record<ProjectStepId, StepStatus>> {
	const steps: Partial<Record<ProjectStepId, StepStatus>> = {};
	// Plan. `blocked` is ambiguous at the coarse-phase level (a stuck plan vs a
	// build that paused after approval), so it must NOT claim "Approved" — only
	// a genuinely post-approval phase (building/ready) earns the green check.
	if (phase === 'planning') steps.plan = { text: 'Caddie is drafting it', tone: 'neutral' };
	else if (phase === 'review') steps.plan = { text: 'Ready for you to review', tone: 'needs' };
    else if (phase === 'design') steps.plan = { text: 'Caddie is designing the screens', tone: 'neutral' };
    else if (phase === 'design-review') steps.plan = { text: 'Design ready for you to review', tone: 'needs' };
	else if (phase === 'blocked') steps.plan = { text: 'Paused — check with Caddie', tone: 'needs' };
	else if (phase) steps.plan = { text: 'Approved', tone: 'done' };
	// Build
	if (phase === 'planning' || phase === 'review' || phase === 'design' || phase === 'design-review') steps.build = { text: 'After you approve', tone: 'neutral' };
	else if (phase === 'building') steps.build = { text: 'Caddie is building it', tone: 'neutral' };
	else if (phase === 'blocked') steps.build = { text: 'Needs your help', tone: 'needs' };
	else if (phase === 'ready') steps.build = { text: 'Ready to try', tone: 'done' };
	// Check
	const ready = opts?.checkReady;
	if (ready && ready.total > 0) {
		steps.check =
			ready.verified >= ready.total
				? { text: 'Everything is ready', tone: 'done' }
				: { text: `${ready.verified} of ${ready.total} ready`, tone: 'needs' };
	} else if (phase === 'ready') {
		steps.check = { text: 'Ready when you are', tone: 'neutral' };
	} else {
		steps.check = { text: opts?.personal ? 'After it’s built' : 'Before you submit', tone: 'neutral' };
	}
	// Share / Submit
	steps.submission = opts?.personal
		? { text: 'Optional', tone: 'neutral' }
		: { text: 'Hand in when ready', tone: 'neutral' };
	return steps;
}

/**
 * The step the WORK is on (distinct from the tab being viewed): Plan while
 * Caddie plans or waits for review, Build while building or blocked, Check
 * once the app is ready. Unknown phase (no workflow yet) → none highlighted.
 */
export function activeStep(phase: WorkflowPhase | null): ProjectStepId | null {
	if (phase === 'planning' || phase === 'review' || phase === 'design' || phase === 'design-review') return 'plan';
	if (phase === 'building' || phase === 'blocked') return 'build';
	if (phase === 'ready') return 'check';
	return null;
}

/** One of the card's four steps (plan 5.7). */
export interface JourneyStep {
	readonly id: ProjectStepId;
	readonly label: string;
	/** A few plain words under the step. */
	readonly sub: string;
	/** done ✓, now (the step the work is on), stop ✕ (paused there), todo. */
	readonly state: 'done' | 'now' | 'stop' | 'todo';
}

/**
 * Where a project is in Plan → Build → Check → Submit (Share for a personal
 * project), from the shared ProjectExperience stage (plan 5.7, variant B), so
 * the card and the project page tell the same story. Null when the project has
 * no workflow yet. Nothing is marked done unless its stage says so: a build
 * can only run on an approved plan, so a build stage implies Plan is done.
 */
export function journeyFromExperience(experience: ProjectExperience, opts: { personal: boolean }): JourneyStep[] | null {
	if (experience.version === 0) return null;
	const last = opts.personal ? 'Share' : 'Submit';
	const later = {
		check: opts.personal ? 'After it’s built' : 'Before you submit',
		submission: opts.personal ? 'Optional' : 'Hand in when ready',
	};
	const steps = (
		plan: [JourneyStep['state'], string],
		build: [JourneyStep['state'], string],
		check: [JourneyStep['state'], string] = ['todo', later.check],
	): JourneyStep[] => [
		{ id: 'plan', label: 'Plan', state: plan[0], sub: plan[1] },
		{ id: 'build', label: 'Build', state: build[0], sub: build[1] },
		{ id: 'check', label: 'Check', state: check[0], sub: check[1] },
		{ id: 'submission', label: last, state: 'todo', sub: later.submission },
	];
	const waitBuild: [JourneyStep['state'], string] = ['todo', 'After you approve'];
	switch (experience.stage) {
		case 'planning':
			return steps(['now', 'Caddie is drafting it'], waitBuild);
		case 'planning_blocked':
			return steps(['stop', 'Needs another pass'], waitBuild);
		case 'review':
			return steps(['now', 'Ready for you to review'], waitBuild);
		case 'design':
			return steps(['now', 'Caddie is designing the screens'], waitBuild);
		case 'design_review':
			return steps(['now', 'Design ready for you'], waitBuild);
		case 'building':
		case 'checking':
			return steps(['done', 'Approved'], ['now', 'Caddie is building it']);
		case 'repairing':
			return steps(['done', 'Approved'], ['now', 'Fixing a problem']);
		case 'blocked':
			return steps(['done', 'Approved'], ['stop', 'Needs your help']);
		case 'stopped':
			return experience.plan?.approved
				? steps(['done', 'Approved'], ['stop', 'Paused'])
				: steps(['stop', 'Paused'], waitBuild);
		case 'ready':
			return steps(['done', 'Approved'], ['done', 'Ready to try'], ['now', 'Ready when you are']);
	}
}
