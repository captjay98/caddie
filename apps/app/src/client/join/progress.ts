import { useMemo } from 'react';
import type { GuidedStepsCard, JoinStep } from '@caddie/contracts';

/**
 * useJoinProgress — the ONE derivation of the guided join → build → GitHub
 * steps, shared by the in-chat GuidedStepsCard and the project Overview
 * stepper so the two surfaces can never disagree.
 *
 * HONESTY (feature-ledger): every step state is DERIVED from a real signal,
 * never a flag the model or the client asserts:
 *   - project  → done once the project row exists (it always does by the time
 *     this renders; it is the anchor the other steps hang on).
 *   - github   → done when the project has at least one GitHub import (a repo
 *     was connected or created and snapshotted); 'skipped' ONLY when the user
 *     chose to skip (persisted per project in localStorage); otherwise active
 *     (nothing before it is pending) or todo.
 *   - build    → done when a plan draft exists; active once github is settled
 *     (done or skipped); otherwise todo.
 *
 * The skip flag is deliberately client-local: skipping is a soft, reversible
 * UI preference ("I'll connect later"), not durable project state, so it needs
 * no migration. Connecting a repo later supersedes it (github then reads done).
 */

export interface JoinSignals {
	/** The project exists (anchor). */
	readonly projectExists: boolean;
	/** The project has at least one GitHub import (repo connected/created). */
	readonly hasRepo: boolean;
	/** The user chose to skip the GitHub step for this project. */
	readonly githubSkipped: boolean;
	/** A plan draft exists for the project. */
	readonly hasPlanDraft: boolean;
}

const STEP_COPY = {
	project: {
		title: 'Project created',
		doneDetail: 'A Caddie build project is set up and linked to this contest.',
	},
	github: {
		title: 'Connect a GitHub repo',
		activeDetail:
			'Create a new repo or connect an existing one. Caddie reads it to learn your stack and ships changes as PRs — never pushes without your say.',
		doneDetail: 'Repo connected. Caddie can read your code and open PRs for review.',
		skippedDetail: 'Skipped for now — connect a repo whenever you have code to ship.',
	},
	build: {
		title: 'Shape the first build step',
		activeDetail: 'Caddie drafts a plan from the rules and your idea. You approve before anything runs.',
		todoDetail: 'Up next: Caddie drafts a plan you approve before anything runs.',
		doneDetail: 'A plan draft is ready for your review.',
	},
} as const;

/** Pure derivation: signals → the three ordered guided steps. Unit-tested. */
export function deriveJoinSteps(signals: JoinSignals): JoinStep[] {
	const project: JoinStep = {
		id: 'project',
		state: signals.projectExists ? 'done' : 'active',
		title: STEP_COPY.project.title,
		detail: STEP_COPY.project.doneDetail,
	};

	const githubState: JoinStep['state'] = signals.hasRepo
		? 'done'
		: signals.githubSkipped
			? 'skipped'
			: project.state === 'done'
				? 'active'
				: 'todo';
	const github: JoinStep = {
		id: 'github',
		state: githubState,
		title: STEP_COPY.github.title,
		detail:
			githubState === 'done'
				? STEP_COPY.github.doneDetail
				: githubState === 'skipped'
					? STEP_COPY.github.skippedDetail
					: STEP_COPY.github.activeDetail,
	};

	// Build is reachable once GitHub is settled (connected OR skipped) — skipping
	// GitHub must never wall the user out of starting to build.
	const githubSettled = githubState === 'done' || githubState === 'skipped';
	const buildState: JoinStep['state'] = signals.hasPlanDraft ? 'done' : githubSettled ? 'active' : 'todo';
	const build: JoinStep = {
		id: 'build',
		state: buildState,
		title: STEP_COPY.build.title,
		detail:
			buildState === 'done'
				? STEP_COPY.build.doneDetail
				: buildState === 'active'
					? STEP_COPY.build.activeDetail
					: STEP_COPY.build.todoDetail,
	};

	return [project, github, build];
}

/** True once every step is finished — done, or (GitHub only) skipped. */
export function joinStepsComplete(steps: readonly JoinStep[]): boolean {
	return steps.every((step) => step.state === 'done' || step.state === 'skipped');
}

// --- per-project GitHub-skip persistence (client-local, reversible) ----------

const SKIP_PREFIX = 'caddie-join-github-skipped:';

/** localStorage, or null where touching it throws (sandboxed iframes, private modes). */
function safeStorage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export function readGithubSkipped(projectId: string, storage: Storage | null = safeStorage()): boolean {
	if (!storage) return false;
	try {
		return storage.getItem(SKIP_PREFIX + projectId) === '1';
	} catch {
		return false;
	}
}

export function writeGithubSkipped(
	projectId: string,
	skipped: boolean,
	storage: Storage | null = safeStorage(),
): void {
	if (!storage) return;
	try {
		if (skipped) storage.setItem(SKIP_PREFIX + projectId, '1');
		else storage.removeItem(SKIP_PREFIX + projectId);
	} catch {
		// private mode: the choice stays session-only
	}
}

/**
 * The client hook: feed it the already-fetched signals (project row, import
 * count, plan-draft presence) and the per-project skip flag; it returns the
 * steps + completion. Kept signal-in / steps-out so the data-fetching stays
 * where the queries already live (queries.ts) and the derivation stays pure.
 */
export function useJoinProgress(input: {
	projectId: string;
	projectExists: boolean;
	hasRepo: boolean;
	githubSkipped: boolean;
	hasPlanDraft: boolean;
}): { steps: JoinStep[]; complete: boolean } {
	return useMemo(() => {
		const steps = deriveJoinSteps({
			projectExists: input.projectExists,
			hasRepo: input.hasRepo,
			githubSkipped: input.githubSkipped,
			hasPlanDraft: input.hasPlanDraft,
		});
		return { steps, complete: joinStepsComplete(steps) };
	}, [input.projectExists, input.hasRepo, input.githubSkipped, input.hasPlanDraft]);
}

/** Build the in-chat card payload from derived steps + contest context. */
export function buildGuidedStepsCard(input: {
	projectId: string;
	contestTitle: string;
	contestUrl: string | null;
	contestContext?: string;
	steps: JoinStep[];
}): GuidedStepsCard {
	return {
		projectId: input.projectId,
		contestTitle: input.contestTitle,
		contestUrl: input.contestUrl,
		contestContext: input.contestContext ?? '',
		steps: input.steps,
	};
}
