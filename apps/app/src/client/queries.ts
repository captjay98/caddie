import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from '@tanstack/react-query';
import type {
	AccountBriefPayload,
	ArtifactRevision,
	BuildFeatureView,
	DecisionCard,
	PlanDocRevision,
	Project,
	ProjectExperience,
	RunBindingRecord,
	Workspace,
} from '@caddie/contracts';
import type { DiscoveryEvaluatedList } from './discovery/Results.tsx';
import type { WorkflowPhase } from './workspace/project-status.ts';
import { fetchJson, postJson } from './api.ts';
import { workflowQueryOptions } from './workflow-query.ts';

/**
 * TanStack Query hooks over the REAL P02 REST surface (projects, plan-docs,
 * run-bindings, artifacts) plus the P01 session probe.
 *
 * Cross-account hygiene (P06 acceptance): every product query key carries the
 * session actor id, so two accounts can never share cached rows. `CacheGuard`
 * (below) wipes product queries whenever the auth status or the actor changes.
 */

export const AUTH_STATUS_STALE_MS = 15_000;

export interface AuthStatus {
	authenticated: boolean;
}

/** P01 composition contract: GET /api/auth/status -> { authenticated }. */
export function useAuthStatus() {
	return useQuery({
		queryKey: ['auth', 'status'],
		queryFn: () => fetchJson<AuthStatus>('/api/auth/status'),
		staleTime: AUTH_STATUS_STALE_MS,
		// React Query pauses queries while the browser is offline, and a paused
		// first check left an installed app opened offline on "Getting your
		// workspace ready…" for good. Run it anyway: it fails as `offline`, the
		// workspace says so (Chrome.tsx), and coming back online refetches it.
		networkMode: 'always',
		// A failed check with no data must STAY failed until someone retries
		// (Try again, or the browser coming back online). With the default, every
		// component that mounts refetches it; a refetch with no data puts the
		// query back to pending, OnboardingGate swaps the workspace for "Getting
		// your workspace ready…", the workspace remounts when the fetch fails, and
		// round it goes: 2,629 requests in 3 s with the network off.
		retryOnMount: false,
	});
}

interface SessionPayload {
	user?: { id?: unknown; name?: unknown; email?: unknown } | null;
}

/**
 * Canonical verified-session cache entry. This is the ONLY queryFn allowed to
 * write ['auth','session'] — it stores the raw Better Auth payload. Actor and
 * display-name observers project their view with `select` (stable module-level
 * functions, so TanStack can memoize the projection), meaning the cached shape
 * can never depend on which consumer mounted first (audit F02: two competing
 * queryFn under one key cached an actor string or a payload depending on mount
 * order, and the display name could vanish).
 */
function sessionQueryOptions(enabled: boolean) {
	return {
		queryKey: ['auth', 'session'] as const,
		queryFn: () => fetchJson<SessionPayload>('/api/auth/get-session'),
		enabled,
		staleTime: 60_000,
	};
}

function sessionActorId(payload: SessionPayload | null | undefined): string | null {
	const id = payload?.user?.id;
	return typeof id === 'string' && id.trim() ? id : null;
}

function sessionDisplayName(payload: SessionPayload | null | undefined): string | null {
	const name = payload?.user?.name;
	return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/**
 * Actor identity, known only once a verified session exists. Better Auth's
 * /api/auth/get-session returns { session, user } — only `user.id` is read.
 * The id is the cache-scope boundary; keys use 'pending' until it arrives.
 */
export function useSessionActor(enabled: boolean) {
	return useQuery({ ...sessionQueryOptions(enabled), select: sessionActorId });
}

/** Cache-scope token: 'pending' keeps keys stable-shaped until the actor lands. */
export type ActorScope = { actorId: string | null };

/**
 * The actor's display name from the verified session — for the avatar chip.
 * Shares the ['auth','session'] cache with useSessionActor; falls back to
 * null when the session carries no name (the avatar then shows the user
 * glyph, never a guessed initial).
 */
export function useSessionDisplayName() {
	return useQuery({ ...sessionQueryOptions(true), select: sessionDisplayName });
}

function sessionEmail(payload: SessionPayload | null | undefined): string | null {
	const email = payload?.user?.email;
	return typeof email === 'string' && email.trim() !== '' ? email : null;
}

/** The verified session's account email — the account menu's identity line
 *  (U01). Shares the ['auth','session'] cache; never a fabricated provider. */
export function useSessionEmail() {
	return useQuery({ ...sessionQueryOptions(true), select: sessionEmail });
}

export function useProjects(actor: ActorScope) {
	return useQuery({
		queryKey: ['projects', actor.actorId ?? 'pending'],
		queryFn: () => fetchJson<{ projects: Project[] }>('/api/projects'),
		enabled: actor.actorId !== null,
	});
}

export function usePlanDocRevisions(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['plan-docs', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<{ revisions: PlanDocRevision[]; latest: PlanDocRevision | null }>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/plan-docs`,
			),
		enabled: actor.actorId !== null && projectId !== null,
	});
}

export function useRunBindings(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['run-bindings', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<{ runBindings: RunBindingRecord[] }>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/run-bindings`,
			),
		enabled: actor.actorId !== null && projectId !== null,
	});
}

/**
 * The project's workflow phase, read from the same /workflow snapshot the
 * in-chat ProjectWorkflow card polls. Exposed as just the phase so the project
 * step bar can orient the user from REAL server state (planning → review →
 * building → ready/blocked), never a client guess. Polls so the bar follows a
 * live build.
 */
export function useWorkflowPhase(actor: ActorScope, projectId: string | null) {
	return useQuery({
		...workflowQueryOptions(actor.actorId, projectId),
		select: (data) => data.workflow?.phase ?? null,
	});
}

/** One deterministic build step (mirrors server BuildStep). */
export interface BuildStepView {
	key: 'scaffold' | 'implement' | 'check' | 'preview';
	label: string;
	state: 'done' | 'active' | 'pending';
}
/** One real run_rounds entry (mirrors server BuildRound). */
export interface BuildRoundView {
	issue: string;
	round: string;
	outcome: string;
	detail: string | null;
	at: string;
}
/** The derived timeline (mirrors server BuildTimeline in build-timeline.ts). */
export type TimelinePhaseView = WorkflowPhase;
export type TimelineStageKey = 'setup' | 'write' | 'test' | 'check' | 'preview';
export type TimelineStageState = 'done' | 'active' | 'pending' | 'failed';
export type TimelineFileArea = 'app' | 'test' | 'style' | 'config' | 'server';

export interface TimelineStageView {
	key: TimelineStageKey;
	label: string;
	state: TimelineStageState;
	startedAt: string | null;
	endedAt: string | null;
	durationMs: number | null;
	detail: string | null;
}
export interface TimelineFileView {
	path: string;
	area: TimelineFileArea;
	writes: number;
	lastAt: string;
	bytes: number | null;
	role: string | null;
}
export interface TimelineCommandView {
	command: string;
	outcome: 'ok' | 'failed' | 'cancelled';
	exitCode: number | null;
	testsPassed: number | null;
	testsFailed: number | null;
	at: string;
	durationMs: number;
	role: string | null;
}
export interface BuildTimelineView {
	phase: TimelinePhaseView;
	startedAt: string | null;
	lastActivityAt: string | null;
	elapsedMs: number | null;
	idleMs: number | null;
	quiet: boolean;
	summary: string;
	stages: TimelineStageView[];
	scope: string[];
	files: TimelineFileView[];
	fileAreas: Record<TimelineFileArea, number>;
	commands: TimelineCommandView[];
	tests: { passed: number; failed: number; at: string } | null;
	checks: { name: string; label: string; passed: boolean; at: string; durationMs: number }[];
}
export interface BuildActivityView {
	projectId: string;
	phase: WorkflowPhase;
	building: boolean;
	/** The plan's features and where each stands (server: build-features.ts). */
	features: BuildFeatureView[];
	steps: BuildStepView[];
	rounds: BuildRoundView[];
	openIssues: number;
	timeline: BuildTimelineView;
}

/**
 * The honest build-activity read (server-derived from run_rounds + the
 * workflow phase): ordered steps + the real repair/verification history, so
 * the workspace can show WHAT is being built instead of one frozen sentence.
 * Polls while mounted so the steps follow a live build.
 */
export function useBuildActivity(actor: ActorScope, projectId: string | null, poll = true) {
	return useQuery({
		queryKey: ['build-activity', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () => fetchJson<BuildActivityView>(`/api/projects/${encodeURIComponent(projectId ?? '')}/activity`),
		enabled: actor.actorId !== null && projectId !== null,
		staleTime: 1000,
        refetchInterval: poll ? query => query.state.data?.phase === 'building' ? 3000 : 30_000 : false,
	});
}

/**
 * The brief the project was started with, from the SAME cached /workflow query
 * (same key, different select), so the overview's "Your idea" card adds no
 * request. Older briefs were saved as "<last chat message>\n\nProject brief:
 * <brief>"; only the brief Caddie wrote is returned. Null when no workflow.
 */
export function useWorkflowBrief(actor: ActorScope, projectId: string | null) {
	return useQuery({
		...workflowQueryOptions(actor.actorId, projectId),
		select: (data) => briefText(data.workflow?.brief ?? null),
	});
}

export function briefText(brief: string | null): string | null {
	if (!brief) return null;
	const marker = '\n\nProject brief: ';
	const at = brief.indexOf(marker);
	const text = (at >= 0 ? brief.slice(at + marker.length) : brief).trim();
	return text || null;
}

/**
 * The project's GitHub imports — one row per repo snapshot taken for this
 * project (connect-existing or create-new both land here). A non-empty list is
 * the honest "a repo is connected" signal the guided join steps derive from;
 * it is real server state, never a client flag.
 */
export function useGithubImports(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['github-imports', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<{ imports: { id: string; repoFullName: string; ref: string; commitSha: string }[] }>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/github/imports`,
			),
		enabled: actor.actorId !== null && projectId !== null,
	});
}

/** The project's linked GitHub repo (mirrors server ProjectRepoView), or null. */
export interface ProjectRepoView {
	projectId: string;
	installationId: string;
	repoFullName: string;
	visibility: 'private' | 'public';
	origin: 'created' | 'adopted' | 'connected';
	htmlUrl: string;
}

/**
 * The ONE repo that is this project's home for its code (create-new,
 * connect-existing or adopted all land here). null = no repo yet. Real server
 * state — the Code settings section and the "repo before first build" gate
 * both read it, never a client flag.
 */
export function useProjectRepo(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['project-repo', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<{ repo: ProjectRepoView | null }>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/github/repo`,
			),
		enabled: actor.actorId !== null && projectId !== null,
	});
}

/** One "save the code to GitHub" (mirrors server SourceSaveView). */
export interface SourceSaveView {
	outputId: string;
	repoFullName: string;
	headBranch: string;
	pullRequestNumber: number | null;
	htmlUrl: string | null;
	fileCount: number;
	skipped: Array<{ path: string; reason: 'dependencies' | 'build-output' | 'secret' | 'symlink' | 'noise' }>;
	deleted: string[];
	createdAt: string;
}

/** The latest save, its pull request's live state, and the exact merge approval (server readSourceSave). */
export interface SourceSaveStatus {
	save: SourceSaveView | null;
	pullRequest: {
		number: number;
		state: 'open' | 'closed' | 'merged';
		mergeable: boolean | null;
		headSha: string;
		baseBranch: string;
		htmlUrl: string | null;
	} | null;
	pullRequestError: string | null;
	mergeIntent: import('@caddie/contracts').ApprovalIntent | null;
}

export function useSourceSave(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['source-save', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<SourceSaveStatus>(`/api/projects/${encodeURIComponent(projectId ?? '')}/github/source`),
		enabled: actor.actorId !== null && projectId !== null,
	});
}

/**
 * UI review board phase 2 — the brief feed: the project's real decisions
 * (pending approvals, retained conflicts, stale artifacts, failed rounds,
 * armed schedules) projected onto the DecisionCard contract.
 */
export function useBriefCards(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['brief', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<{ cards: DecisionCard[] }>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/brief`,
			),
		enabled: actor.actorId !== null && projectId !== null,
	});
}

/**
 * The shared ProjectExperience projection (R01/R06): the ONE source chat
 * cards, Projects and the project workspace read for stage, plan/preview
 * state, the derived user-facing message and the single-primary-action set.
 * Keyed by actor + project. A short refetch keeps the stage live while a
 * build runs; authority is always re-checked server-side on any command.
 */
export function useProjectExperience(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['experience', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<ProjectExperience>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/experience`,
			),
		enabled: actor.actorId !== null && projectId !== null,
		refetchInterval: 3000,
	});
}

/** The hackathon this project is for (header chips), or null. Derived server-side, read-only. */
export interface ProjectHackathonView {
	readonly title: string;
	readonly url: string | null;
	readonly track: string | null;
	readonly deadline: string | null;
	readonly daysLeft: number | null;
	readonly ended: boolean;
	readonly eligibility: 'eligible' | 'ineligible' | 'unknown';
}

export function useProjectHackathon(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['project-hackathon', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<{ hackathon: ProjectHackathonView | null }>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/hackathon`,
			),
		enabled: actor.actorId !== null && projectId !== null,
		staleTime: 5 * 60_000,
	});
}

/**
 * The ACCOUNT brief (approved navigation 2026-10-09): every authorised
 * project's decision cards with per-actor read state (`GET /api/brief`).
 * Shared cache with the chrome (badge + chat notice) and the Brief surface:
 * keyed by actor, `placeholderData` keeps the last known cards during a
 * refetch so a stale/offline refresh never blanks the surface.
 */
export function useAccountBrief(actor: ActorScope, poll = true) {
	return useQuery({
		queryKey: ['brief', 'account', actor.actorId ?? 'pending'],
		queryFn: () => fetchJson<AccountBriefPayload>('/api/brief'),
        staleTime: 2000,
        refetchInterval: poll ? query => query.state.data?.cards.some(card => card.id.startsWith('brf_workflow_build_') || card.id.startsWith('brf_workflow_repair_')) ? 3000 : 30_000 : false,
		enabled: actor.actorId !== null,
		placeholderData: (previous) => previous,
	});
}

/** Mark brief cards read (explicit action / mark-all-read). Read state never
 *  resolves the underlying work — only the read marker moves. */
export function useMarkBriefRead(actor: ActorScope) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (keys: string[]) => postJson<{ marked: number }>('/api/brief/read', { keys }),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['brief', 'account', actor.actorId ?? 'pending'] });
		},
	});
}

/** One of the person's notifications (mirrors server NotificationRecord). */
export interface AppNotification {
	id: string;
	projectId: string | null;
	kind: string;
	title: string;
	body: string;
	createdAt: string;
}

/**
 * The person's unread notifications (plan 5.4) — what Caddie raised while they
 * were away, such as a build it paused. Polled so a new one shows up without a
 * reload; a failed read simply shows none.
 */
export function useUnreadNotifications(actor: ActorScope) {
	return useQuery({
		queryKey: ['notifications', 'unread', actor.actorId ?? 'pending'],
		queryFn: () => fetchJson<{ notifications: AppNotification[] }>('/api/notifications?unread=1'),
		enabled: actor.actorId !== null,
		refetchInterval: 30_000,
		select: (data) => data.notifications,
	});
}

/** Mark one notification read; the unread list refreshes. */
export function useMarkNotificationRead(actor: ActorScope) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (id: string) => postJson<unknown>(`/api/notifications/${encodeURIComponent(id)}/read`, {}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread', actor.actorId ?? 'pending'] });
		},
	});
}

/**
 * The actor's P14 profile — read from the real GET /api/profile. Home uses it
 * to state personalisation honestly (incomplete vs. complete), never to invent
 * a match score. Null means "nothing recorded" — surfaced as such, not guessed.
 */
export interface ProfileRecord {
	userId: string;
	country: string | null;
	timezone: string | null;
	weeklyHours: number | null;
	experienceLevel: 'beginner' | 'intermediate' | 'senior' | null;
	stackIds: string[];
	freeTextInterests: string[];
	formatPreference: 'online' | 'in_person' | 'either' | null;
	skills: string[];
	projectHighlight: string | null;
	budget: { mode: 'free_only' | 'set' | 'not_sure'; amount: number | null; currency: string | null } | null;
}

export function useProfile(actor: ActorScope) {
	return useQuery({
		queryKey: ['profile', actor.actorId ?? 'pending'],
		queryFn: () => fetchJson<{ profile: ProfileRecord | null }>('/api/profile'),
		enabled: actor.actorId !== null,
	});
}

/**
 * Account-scoped discovery read (GET /api/projects/:id/discovery/candidates?
 * evaluate=1) — the same endpoint Discover uses, exposed as a hook so Home can
 * show the top ranked candidates for the actor's account scope (the Home
 * project). It returns exactly what the server evaluated; no scores invented.
 */
export function useDiscoveryCandidates(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['discovery-candidates', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<DiscoveryEvaluatedList>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/discovery/candidates?evaluate=1`,
			),
		enabled: actor.actorId !== null && projectId !== null,
	});
}

/**
 * P07 content-addressed artifact revisions (the viewer's surface — distinct
 * from the P02 metadata-revision list behind useArtifacts).
 */
export function useArtifactRevisions<Revision>(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['artifact-revisions', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<{ artifacts: Revision[]; latest: Revision | null }>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/artifact-revisions`,
			),
		enabled: actor.actorId !== null && projectId !== null,
	});
}

/**
 * The actor's Home project — the project-less conversation with Caddie, and
 * the account-scoped bucket for Discover and the general brief.
 *
 * Created server-side on first fetch (ensureHomeProject), so it is the account
 * scope that exists BEFORE any build project. `enabled` gates the query on a
 * verified session: the chrome turns it on as soon as auth settles, so the
 * general conversation and account-level discovery resolve even when the actor
 * has zero build projects. Home is still kind='home', which the server keeps
 * build/gate-less — resolving it never starts paid execution.
 */
export function useHomeProject(actor: ActorScope, enabled: boolean) {
	return useQuery({
		queryKey: ['home-project', actor.actorId ?? 'pending'],
		queryFn: () => fetchJson<{ project: Project }>('/api/home-project'),
		enabled: actor.actorId !== null && enabled,
	});
}

export function useArtifacts(actor: ActorScope, projectId: string | null) {
	return useQuery({
		queryKey: ['artifacts', actor.actorId ?? 'pending', projectId ?? 'none'],
		queryFn: () =>
			fetchJson<{ artifacts: ArtifactRevision[] }>(
				`/api/projects/${encodeURIComponent(projectId ?? '')}/artifacts`,
			),
		enabled: actor.actorId !== null && projectId !== null,
	});
}

export interface CreateProjectInput {
	name: string;
	description?: string;
	/** Known workspace to create in; when absent a "Home" workspace is created. */
	workspaceId?: string;
	/** Optional contest link the project was explored from (Discover handoff). */
	contestId?: string;
	contestUrl?: string;
}

export function useCreateProject(actor: ActorScope) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (input: CreateProjectInput) => {
			let workspaceId = input.workspaceId;
			if (!workspaceId) {
				// P02 surface has no workspace list — a first project bootstraps a
				// "Home" workspace explicitly (never an implicit server default).
				const created = await postJson<{ workspace: Workspace }>('/api/workspaces', {
					name: 'Home',
				});
				workspaceId = created.workspace.id;
			}
			return postJson<{ project: Project }>('/api/projects', {
				workspaceId,
				name: input.name,
				...(input.description ? { description: input.description } : {}),
				...(input.contestId ? { contestId: input.contestId } : {}),
				...(input.contestUrl ? { contestUrl: input.contestUrl } : {}),
			});
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ['projects', actor.actorId ?? 'pending'] });
		},
	});
}

/**
 * Cross-account cache hygiene: product queries are keyed by actor, and this
 * guard additionally wipes them on every auth-status or actor transition so a
 * sign-out / account switch can never serve (or prefetch into) another
 * account's cache. Auth keys themselves are kept — they describe the session.
 */
export function watchAuthTransitions(queryClient: QueryClient): {
	maybe: (authenticated: boolean | undefined, actorId: string | null | undefined) => void;
} {
	let lastActor: string | null | undefined = undefined;
	let lastAuthed: boolean | undefined = undefined;
	return {
		maybe(authenticated, actorId) {
			if (lastActor === undefined && lastAuthed === undefined) {
				lastActor = actorId ?? null;
				lastAuthed = authenticated;
				return;
			}
			const authChanged = lastAuthed !== authenticated;
			const actorChanged = lastActor !== (actorId ?? null);
			if (!authChanged && !actorChanged) return;
			lastActor = actorId ?? null;
			lastAuthed = authenticated;
			queryClient.removeQueries({
				predicate: (query) => {
					const [head] = query.queryKey;
					return head !== 'auth';
				},
			});
		},
	};
}

/** A project card's hackathon line (mirrors server ProjectHackathonLine). */
export interface ProjectHackathonLine {
	title: string;
	deadline: string | null;
	daysLeft: number | null;
	ended: boolean;
}

/**
 * Every one of the person's projects with its hackathon and deadline, in one
 * read for the Projects list (plan 5.7). A failed read simply leaves the
 * cards without the contest line.
 */
export function useProjectHackathons(actor: ActorScope) {
	return useQuery({
		queryKey: ['project-hackathons', actor.actorId ?? 'pending'],
		queryFn: () => fetchJson<{ hackathons: Record<string, ProjectHackathonLine> }>('/api/project-hackathons'),
		enabled: actor.actorId !== null,
		staleTime: 60_000,
		select: (data) => data.hackathons,
	});
}
