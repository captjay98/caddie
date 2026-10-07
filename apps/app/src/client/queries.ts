import {
	useMutation,
	useQuery,
	useQueryClient,
	type QueryClient,
} from '@tanstack/react-query';
import type {
	ArtifactRevision,
	DecisionCard,
	PlanDocRevision,
	Project,
	RunBindingRecord,
	Workspace,
} from '@caddie/contracts';
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
	user?: { id?: unknown } | null;
}

/**
 * Actor identity, known only once a verified session exists. Better Auth's
 * /api/auth/get-session returns { session, user } — only `user.id` is read.
 * The id is the cache-scope boundary; keys use 'pending' until it arrives.
 */
export function useSessionActor(enabled: boolean) {
	return useQuery({
		queryKey: ['auth', 'session'],
		queryFn: async () => {
			const payload = await fetchJson<SessionPayload>('/api/auth/get-session');
			const id = payload?.user?.id;
			return typeof id === 'string' && id.trim() ? id : null;
		},
		enabled,
		staleTime: 60_000,
	});
}

/** Cache-scope token: 'pending' keeps keys stable-shaped until the actor lands. */
export type ActorScope = { actorId: string | null };

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
 * The actor's Home project — the project-less conversation with Caddie.
 * Created server-side on first fetch; only queried once the actor has at
 * least one project, so a brand-new user still meets the onboarding first.
 */
export function useHomeProject(actor: ActorScope, hasProjects: boolean) {
	return useQuery({
		queryKey: ['home-project', actor.actorId ?? 'pending'],
		queryFn: () => fetchJson<{ project: Project }>('/api/home-project'),
		enabled: actor.actorId !== null && hasProjects,
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
