import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from '@tanstack/react-query';
import type {
	AccountBriefPayload,
	ArtifactRevision,
	DecisionCard,
	PlanDocRevision,
	Project,
	RunBindingRecord,
	Workspace,
} from '@caddie/contracts';
import type { DiscoveryEvaluatedList } from './discovery/Results.tsx';
import { fetchJson, postJson } from './api.ts';

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
 * The ACCOUNT brief (approved navigation 2026-10-09): every authorised
 * project's decision cards with per-actor read state (`GET /api/brief`).
 * Shared cache with the chrome (badge + chat notice) and the Brief surface:
 * keyed by actor, `placeholderData` keeps the last known cards during a
 * refetch so a stale/offline refresh never blanks the surface.
 */
export function useAccountBrief(actor: ActorScope) {
	return useQuery({
		queryKey: ['brief', 'account', actor.actorId ?? 'pending'],
		queryFn: () => fetchJson<AccountBriefPayload>('/api/brief'),
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
