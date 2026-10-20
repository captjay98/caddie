import { useCallback, useEffect, useState } from 'react';
import type { FlueConversationMessage, FlueConversationSettlement } from '@flue/react';
import { mergeSharedDraft } from '../share-target.ts';

/**
 * Props-driven channel store — feature-ledger row C7 (transport ADOPT
 * @flue/react; presentation ADAPT here).
 *
 * P06 ships the typed presentation: the Shell feeds the channel a
 * {@link ChannelSource} shaped exactly like `useFlueAgent()`'s snapshot, so
 * P05 plugs the real transport in one place (pass its result as `source`)
 * without touching any rendering code. Nothing here simulates streaming or
 * invents assistant output — an empty source is the honest standby state.
 *
 * Optimistic sends: until a transport exists, a send is retained as a draft
 * carrying a generated idempotency key. When P05 lands, `addDraft` becomes
 * `sendMessage(text, { idempotencyKey })` and the draft becomes the failedSends
 * retry affordance (same shape, same key contract: one key per submission
 * attempt, retries reuse or rotate the key explicitly, never implicitly).
 */

export interface ChannelSource {
	messages: readonly FlueConversationMessage[];
	status: 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';
	historyReady: boolean;
	error: Error | undefined;
	failedSends: ReadonlyArray<{ id: string; message: string; error: Error }>;
	settlements: readonly FlueConversationSettlement[];
}

/** P06 standby source: no transport yet, so the channel shows honest standby. */
export const standbySource: ChannelSource = {
	messages: [],
	status: 'idle',
	historyReady: true,
	error: undefined,
	failedSends: [],
	settlements: [],
};

export interface ChannelDraft {
	id: string;
	/** Idempotency key concept: generated at compose time, one per send. */
	idempotencyKey: string;
	text: string;
	createdAt: string;
	attempts: number;
	/** sending: on its way (no buttons) · unsent: failed, offer Send again ·
	 *  cancelled: discarded, kept for reference. */
	state: 'sending' | 'unsent' | 'cancelled';
}

function newDraft(text: string, state: 'sending' | 'unsent'): ChannelDraft {
	const id = crypto.randomUUID();
	return {
		id: `draft-${id}`,
		idempotencyKey: `idem-${id}`,
		text,
		createdAt: new Date().toISOString(),
		attempts: 0,
		state,
	};
}

const DRAFTS_KEY = 'caddie-channel-drafts';
const COMPOSER_KEY = 'caddie-composer-draft';

function storageKey(sessionKey: string, projectId: string | null): string {
	return `${DRAFTS_KEY}:${sessionKey}:${projectId ?? 'none'}`;
}

function composerKey(sessionKey: string, projectId: string | null): string {
	return `${COMPOSER_KEY}:${sessionKey}:${projectId ?? 'none'}`;
}

function loadComposerDraft(key: string): string {
	try {
		return sessionStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}

function loadDrafts(key: string): ChannelDraft[] {
	try {
		const raw = sessionStorage.getItem(key);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(item): item is ChannelDraft =>
					item !== null &&
					typeof item === 'object' &&
					typeof (item as ChannelDraft).id === 'string' &&
					typeof (item as ChannelDraft).idempotencyKey === 'string' &&
					typeof (item as ChannelDraft).text === 'string' &&
					['sending', 'unsent', 'cancelled'].includes((item as ChannelDraft).state),
			)
			// A draft still on its way when the page went away may or may not
			// have reached Caddie: offer Send again (its key makes a repeat a no-op).
			.map((draft) => (draft.state === 'sending' ? { ...draft, state: 'unsent' as const } : draft));
	} catch {
		return [];
	}
}

export function useChannelStore(options: {
	/** Cache-scope boundary: drafts never cross accounts or projects. */
	sessionKey: string;
	projectId: string | null;
}) {
	const { sessionKey, projectId } = options;
	const key = storageKey(sessionKey, projectId);
	const composerKey_ = composerKey(sessionKey, projectId);
	const [drafts, setDrafts] = useState<ChannelDraft[]>(() => loadDrafts(key));
	// Unsent typing (audit F01): survives navigation and reloads, scoped to
	// actor + conversation exactly like the sent-draft records.
	const [composerText, setComposerTextState] = useState(() => loadComposerDraft(composerKey_));

	// Reload when the scope changes (project switch / account switch) —
	// sessionStorage keeps unsent work across reloads, scoped per account+project.
	useEffect(() => {
		setDrafts(loadDrafts(key));
		setComposerTextState(loadComposerDraft(composerKey_));
	}, [key, composerKey_]);

	useEffect(() => {
		try {
			sessionStorage.setItem(key, JSON.stringify(drafts));
		} catch {
			// storage full/blocked: drafts stay in memory for the session
		}
	}, [key, drafts]);

	const setComposerText = useCallback(
		(text: string) => {
			setComposerTextState(text);
			try {
				if (text) sessionStorage.setItem(composerKey_, text);
				else sessionStorage.removeItem(composerKey_);
			} catch {
				// storage blocked: text stays in memory for the session
			}
		},
		[composerKey_],
	);

	/** Add text under the unsent typing (a link shared into Caddie). It works
	 *  from the CURRENT state, so it lands on the draft of the scope that is
	 *  live when it runs, even in the commit where that scope's draft was just
	 *  loaded. The write inside the updater is idempotent (StrictMode may run
	 *  an updater twice: same input, same stored value). */
	const appendComposerText = useCallback(
		(text: string) => {
			setComposerTextState((current) => {
				const next = mergeSharedDraft(current, text);
				try {
					sessionStorage.setItem(composerKey_, next);
				} catch {
					// storage blocked: text stays in memory for the session
				}
				return next;
			});
		},
		[composerKey_],
	);

	/** Creates the optimistic draft and returns it (null for empty input) —
	 *  the caller sends it through the transport with the draft's own key. */
	const addDraft = useCallback((text: string, options: { sending?: boolean } = {}): ChannelDraft | null => {
		const trimmed = text.trim();
		if (!trimmed) return null;
		const draft = newDraft(trimmed, options.sending ? 'sending' : 'unsent');
		setDrafts((existing) => [...existing, draft]);
		return draft;
	}, []);

	/** A send failed (or there was nothing to send it through): offer Send again. */
	const failDraft = useCallback((id: string) => {
		setDrafts((existing) =>
			existing.map((draft) =>
				draft.id === id && draft.state !== 'cancelled'
					? { ...draft, state: 'unsent', attempts: draft.attempts + 1 }
					: draft,
			),
		);
	}, []);

	/** Send again: the same key, so the server can never take it twice. */
	const resendDraft = useCallback((id: string) => {
		setDrafts((existing) => existing.map((draft) => (draft.id === id && draft.state === 'unsent' ? { ...draft, state: 'sending' } : draft)));
	}, []);

	const discardDraft = useCallback((id: string) => {
		setDrafts((existing) =>
			existing.map((draft) =>
				draft.id === id && draft.state === 'unsent' ? { ...draft, state: 'cancelled' } : draft,
			),
		);
	}, []);

	/** Edit an unsent draft (§3.6): its text goes back into the composer and
	 *  the failed row is removed — the user rewords and sends fresh, with a
	 *  NEW idempotency key (a changed message is a new submission). */
	const editDraft = useCallback(
		(id: string) => {
			const draft = drafts.find((d) => d.id === id && d.state === 'unsent');
			if (!draft) return;
			setDrafts((existing) => existing.filter((d) => d.id !== id));
			setComposerTextState(draft.text);
			try {
				sessionStorage.setItem(composerKey_, draft.text);
			} catch {
				// storage blocked: text stays in memory for the session
			}
		},
		[drafts, composerKey_],
	);

	/** Removes the draft entirely — the send-success path. Once the transport
	 *  admits the message it lives in the transcript; the optimistic row must
	 *  not linger. Only an explicitly discarded draft is kept for reference
	 *  with its key (discardDraft). */
	const resolveDraft = useCallback((id: string) => {
		setDrafts((existing) => existing.filter((draft) => draft.id !== id));
	}, []);

	return { drafts, addDraft, failDraft, resendDraft, discardDraft, editDraft, resolveDraft, composerText, setComposerText, appendComposerText };
}
