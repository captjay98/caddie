import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFlueAgent, type UseFlueAgentResult } from '@flue/react';
import type { FlueConversationMessage } from '@flue/sdk';
import { pagedAgentClient, mergeHistory, HISTORY_PAGE_SIZE } from './paged-agent.ts';

export interface SharedAgentResult extends UseFlueAgentResult {
 hasOlder?: boolean;
 olderPending?: boolean;
 olderError?: Error;
 loadOlder?: () => Promise<void>;
}

/**
 * One live agent session per conversation, shared across every mount.
 *
 * `useFlueAgent` creates and disposes a session per hook mount, and each
 * unbounded session replays the whole conversation stream from the server (measured
 * 2026-10-24: 1.8–9.1s of main-thread long tasks per project-page visit on
 * the owner's real 607-batch conversation; each observation keeps its own
 * state, so nothing is shared through the client). Mounting a route therefore
 * paid a full replay on every visit, twice over where the chrome transport
 * and ProjectWorkflow observed the same conversation.
 *
 * The provider keeps a small set of sessions warm across route changes: each
 * conversation URL gets exactly one hidden `useFlueAgent` mount (a "keeper")
 * that lives while any consumer holds it and for an idle grace period after
 * the last consumer unmounts, bounded by an LRU cap. Consumers read the
 * keeper's result object — same shape as `useFlueAgent`, same sendMessage —
 * so a remount adopts the already-reduced transcript instead of replaying.
 */

/** Warm-session budget: the active conversation plus recent bounce targets. */
const WARM_CAP = 4;
/** How long a conversation with no mounted consumer keeps its session. */
const IDLE_GRACE_MS = 5 * 60_000;

interface AgentKeeperContextValue {
	/** Registers a consumer's interest; returns its release function. */
	acquire: (url: string) => () => void;
	/** Live keeper results; a url absent here is still connecting. */
	sessions: ReadonlyMap<string, SharedAgentResult>;
	/** Bumped whenever the registry changes, so consumers re-render. */
	version: number;
	/** Wall-clock ms of the last REAL publish per conversation url (liveness). */
	activity: ReadonlyMap<string, number>;
}

const AgentKeeperContext = createContext<AgentKeeperContextValue | null>(null);

const dormantAgent: SharedAgentResult = {
	messages: [],
	status: 'idle',
	historyReady: false,
	error: undefined,
	failedSends: [],
	settlements: [],
	sendMessage: async () => { throw new Error('no conversation selected'); },
	refresh: () => {},
};

const connectingAgent: SharedAgentResult = {
	...dormantAgent,
	status: 'connecting',
};

/** Session state fields, compared by identity: the session's published
 * snapshot replaces these arrays/objects on change, so unequal identity
 * means new state to propagate. */
function sameState(a: SharedAgentResult, b: SharedAgentResult): boolean {
	return a.messages === b.messages && a.status === b.status && a.historyReady === b.historyReady
		&& a.settlements === b.settlements && a.failedSends === b.failedSends && a.error?.message === b.error?.message
        && a.hasOlder === b.hasOlder && a.olderPending === b.olderPending && a.olderError?.message === b.olderError?.message && a.loadOlder === b.loadOlder;
}

/**
 * Content signature for one session state. Compare all parts: equal-length
 * corrections and earlier-message changes are meaningful too. The underlying flue observation
 * restarts and REBUILDS the whole conversation on a schedule of its own
 * (2026-10-24: ~1.3s), publishing fresh object identities for identical
 * content — propagating those re-rendered every consumer in a visible loop
 * (jumping transcript, flickering status). A publish propagates only when
 * the content signature changed (or an error appeared); identity churn
 * alone is noise.
 */
function contentSignature(a: SharedAgentResult): string {
 return JSON.stringify([a.messages, a.settlements, a.failedSends.map(send => [send.id,send.message,send.error.message]), a.hasOlder, a.olderPending, a.olderError?.message]);
}

/**
 * Pure eviction policy (unit-tested): a warm url is dropped when its refcount
 * is zero AND it has been idle past the grace period, or — for the LRU cap —
 * when it is the least-recently-used zero-refcount url while over capacity.
 */
export function evictWarm(
	refs: ReadonlyMap<string, number>,
	lastUsed: ReadonlyMap<string, number>,
	now: number,
	options: { idleMs: number; cap: number },
): string[] {
	const zeroIdle: string[] = [];
	const zeroRecent: Array<{ url: string; used: number }> = [];
	for (const url of lastUsed.keys()) {
		const used = lastUsed.get(url) ?? 0;
		if ((refs.get(url) ?? 0) > 0) continue;
		if (now - used >= options.idleMs) zeroIdle.push(url);
		else zeroRecent.push({ url, used });
	}
	if (zeroIdle.length) return zeroIdle;
	if (lastUsed.size - options.cap <= 0) return [];
	return zeroRecent
		.sort((a, b) => a.used - b.used)
		.slice(0, lastUsed.size - options.cap)
		.map(entry => entry.url);
}

function Keeper(props: { url: string; register: (url: string, agent: SharedAgentResult) => void; unregister: (url: string) => void }) {
 const transport = useMemo(() => pagedAgentClient(props.url), [props.url]);
 const live = useFlueAgent({ client: transport.client });
 const [older, setOlder] = useState<FlueConversationMessage[]>([]);
 const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
 const [olderPending, setOlderPending] = useState(false);
 const [olderError, setOlderError] = useState<Error>();
 const pending = useRef(false);
 const generation = useRef(0);
 const observedCursor = transport.cursor.current;
 useEffect(() => {
  generation.current++;
  setOlder([]); setNextCursor(observedCursor); setOlderError(undefined);
 }, [observedCursor]);
 const messages = useMemo(() => older.length ? mergeHistory(older, live.messages) : live.messages, [older, live.messages]);
 const refreshRef = useRef(live.refresh);
 refreshRef.current = live.refresh;
 const loadOlder = useMemo(() => async () => {
  if (!nextCursor || pending.current) return;
  pending.current = true; setOlderPending(true); setOlderError(undefined);
  const current = generation.current;
  try {
   const page = await transport.client.historyBefore(nextCursor, { limit: HISTORY_PAGE_SIZE });
   if (generation.current !== current) return;
   setOlder(previous => mergeHistory(page.messages, previous));
   setNextCursor(page.before);
  } catch (error) {
   if (generation.current === current) {
    setOlderError(error instanceof Error ? error : new Error('Earlier messages could not be loaded'));
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 410) refreshRef.current();
   }
  } finally { pending.current = false; setOlderPending(false); }
 }, [transport, nextCursor]);
 const agent: SharedAgentResult = { ...live, messages, hasOlder: Boolean(nextCursor), olderPending, olderError, loadOlder };
 const agentRef = useRef(agent); agentRef.current = agent;
 useEffect(() => { props.register(props.url, agentRef.current); return () => { generation.current++; props.unregister(props.url); }; }, [props.url, props.register, props.unregister]);
 const published = useRef(agent);
 useEffect(() => {
  const prev = published.current;
  // A reconnect is not an empty conversation. Keep the last coherent page
  // until the native bounded snapshot has finished hydrating.
  if (!agent.historyReady && prev.historyReady && !agent.error) return;
  if (sameState(prev, agent)) return;
  const contentEqual = contentSignature(prev) === contentSignature(agent);
  if (contentEqual && prev.historyReady === agent.historyReady && prev.error?.message === agent.error?.message && prev.loadOlder === agent.loadOlder && (prev.status === agent.status || (prev.historyReady && agent.status === 'connecting' && !agent.error))) return;
  published.current = agent;
  props.register(props.url, agent);
 });
 return null;
}

export function AgentSessionsProvider(props: { children: ReactNode }) {
	// Module-scoped so Keeper and useSharedAgent see one registry without
	// prop drilling; provider state drives keeper mounts and re-renders.
	const registry = useRef(new Map<string, SharedAgentResult>());
	const activity = useRef(new Map<string, number>());
	const refs = useRef(new Map<string, number>());
	const lastUsed = useRef(new Map<string, number>());
	const [warmUrls, setWarmUrls] = useState<readonly string[]>([]);
	const [version, setVersion] = useState(0);

	const register = useMemo(() => (url: string, agent: SharedAgentResult) => {
		const previous = registry.current.get(url);
        if (previous && previous.status === agent.status && previous.historyReady === agent.historyReady && previous.error?.message === agent.error?.message && previous.loadOlder === agent.loadOlder && contentSignature(previous) === contentSignature(agent)) return;
        if (previous?.historyReady && JSON.stringify(previous.messages.at(-1)) !== JSON.stringify(agent.messages.at(-1)) && agent.messages.length > 0) activity.current.set(url, Date.now());
        registry.current.set(url, agent);
		setVersion(value => value + 1);
	}, []);
	const unregister = useMemo(() => (url: string) => {
		registry.current.delete(url);
		setVersion(value => value + 1);
	}, []);

	const acquire = useMemo(() => (url: string) => {
		refs.current.set(url, (refs.current.get(url) ?? 0) + 1);
		lastUsed.current.set(url, Date.now());
		setWarmUrls(current => current.includes(url) ? current : [...current, url]);
		setVersion(value => value + 1);
		return () => {
			const next = (refs.current.get(url) ?? 1) - 1;
			if (next <= 0) { refs.current.delete(url); lastUsed.current.set(url, Date.now()); }
			else refs.current.set(url, next);
		};
	}, []);

	// Idle eviction: drop sessions nobody has looked at for the grace period.
	useEffect(() => {
		const timer = setInterval(() => {
			const drop = evictWarm(refs.current, lastUsed.current, Date.now(), { idleMs: IDLE_GRACE_MS, cap: WARM_CAP });
			if (!drop.length) return;
			for (const url of drop) {
				refs.current.delete(url);
				lastUsed.current.delete(url);
			}
			setWarmUrls(current => current.filter(url => !drop.includes(url)));
			// Registry entries leave with their keeper's unmount effect.
		}, 30_000);
		return () => clearInterval(timer);
	}, []);

	const contextValue = useMemo<AgentKeeperContextValue>(() => ({
		acquire,
		sessions: registry.current,
		version,
		activity: activity.current,
	}), [acquire, version]);

	return <AgentKeeperContext.Provider value={contextValue}>
		{props.children}
		{warmUrls.map(url => <Keeper key={url} url={url} register={register} unregister={unregister} />)}
	</AgentKeeperContext.Provider>;
}

/**
 * When the shared session last PUBLISHED new content for this conversation
 * (ms epoch), or undefined before the first publish. The liveness signal for
 * "is Caddie working or stuck?" — a card can show "active Ns ago" and flag
 * long silences honestly.
 */
export function useSharedAgentActivity(url: string | undefined): number | undefined {
	const context = useContext(AgentKeeperContext);
	if (!url || !context) return undefined;
	return context.activity.get(url);
}

/** The shared session for one conversation url, or a dormant/connecting fallback. */
export function useSharedAgent(url: string | undefined): SharedAgentResult {
	const context = useContext(AgentKeeperContext);
	const acquire = context?.acquire;
	useEffect(() => {
		if (!url || !acquire) return;
		return acquire(url);
	}, [acquire, url]);
	if (!url || !context) return dormantAgent;
	return context.sessions.get(url) ?? connectingAgent;
}
