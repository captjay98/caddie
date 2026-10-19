/**
 * The share target (manifest.webmanifest `share_target`): on a phone, sharing
 * a page to Caddie opens `/app/?shared_title=…&shared_text=…&shared_url=…`.
 *
 * The shared values become a composer draft the user reads and sends
 * themselves; nothing is ever sent for them. They travel through
 * sessionStorage rather than the URL, because the address may still have to
 * pass sign-in (an OAuth round trip in the same tab) or onboarding before the
 * conversation exists:
 *
 *   1. share-capture.ts runs captureSharedDraft before the router reads the
 *      URL: the draft is stored, and the shared values leave the address so a
 *      reload or a bookmark never repeats them;
 *   2. once the signed-in Home conversation is ready, the workspace chrome
 *      takes the draft (once) and merges it into the composer.
 */

export const SHARE_PARAMS = { title: 'shared_title', text: 'shared_text', url: 'shared_url' } as const;
export const SHARED_DRAFT_KEY = 'caddie:shared-draft';
/** A share is a link and a line or two; anything longer is cut to this. */
export const SHARED_DRAFT_MAX = 2000;

export interface SharedValues {
	title?: string | null;
	text?: string | null;
	url?: string | null;
}

export interface ShareStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface ShareLocation {
	pathname: string;
	search: string;
	hash: string;
}

export interface ShareHistory {
	readonly state: unknown;
	replaceState(data: unknown, unused: string, url: string): void;
}

const clean = (value: string | null | undefined) => (typeof value === 'string' ? value.trim() : '');

/**
 * One draft from what the other app shared. Apps differ: a browser sends the
 * page title plus the link, a social app often sends text that already holds
 * the link. Nothing is repeated, and no words are added.
 */
export function composeSharedDraft(values: SharedValues): string | null {
	const title = clean(values.title);
	const text = clean(values.text);
	const url = clean(values.url);
	const parts: string[] = [];
	if (title && title !== url && !text.includes(title)) parts.push(title);
	if (text) parts.push(text);
	if (url && !text.includes(url)) parts.push(url);
	return parts.length ? parts.join('\n').slice(0, SHARED_DRAFT_MAX) : null;
}

/** Move shared values from the address into storage. Returns the draft, if any. */
export function captureSharedDraft(location: ShareLocation, storage: ShareStorage | null, history: ShareHistory): string | null {
	const params = new URLSearchParams(location.search);
	const names = Object.values(SHARE_PARAMS);
	if (!names.some((name) => params.has(name))) return null;
	const draft = composeSharedDraft({
		title: params.get(SHARE_PARAMS.title),
		text: params.get(SHARE_PARAMS.text),
		url: params.get(SHARE_PARAMS.url),
	});
	for (const name of names) params.delete(name);
	const search = params.toString();
	history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
	if (draft && storage) {
		try {
			storage.setItem(SHARED_DRAFT_KEY, draft);
		} catch {
			// Storage refused (private mode, quota): the share is dropped, the app is unaffected.
		}
	}
	return draft;
}

/** The waiting draft, handed over once. */
export function takeSharedDraft(storage: ShareStorage | null): string | null {
	if (!storage) return null;
	try {
		const draft = storage.getItem(SHARED_DRAFT_KEY);
		if (draft === null) return null;
		storage.removeItem(SHARED_DRAFT_KEY);
		return draft.trim() ? draft : null;
	} catch {
		return null;
	}
}

/** Add the shared draft under whatever the user was already typing. */
export function mergeSharedDraft(current: string, shared: string): string {
	if (!current.trim()) return shared;
	if (current.includes(shared)) return current;
	return `${current.replace(/\s+$/, '')}\n${shared}`;
}

/** sessionStorage, or null where touching it throws. */
export function sessionShareStorage(): ShareStorage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}
