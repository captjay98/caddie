/**
 * GitHub's return, said once in plain words (plan 6.1).
 *
 * After an install GitHub sends the person to Caddie's Setup URL; the server
 * connects the installation (only for Caddie's own signed request) and sends
 * them back to their page with `?github=<outcome>`. Like a share
 * (share-target.ts), the outcome leaves the address before the router reads
 * it, so a reload or a bookmark never repeats it; it waits in sessionStorage
 * and the workspace shows it once (GithubReturnNotice).
 */

export const GITHUB_RETURN_PARAM = 'github';
export const GITHUB_RETURN_KEY = 'caddie:github-return';

/** The outcomes the server sends (server/github-connect.ts GithubReturnOutcome). */
export const GITHUB_RETURN_OUTCOMES = [
	'connected',
	'requested',
	'not_signed_in',
	'expired',
	'not_found',
	'suspended',
	'missing_permissions',
	'already_bound',
	'not_configured',
	'github_identity_required',
	'installation_ownership_unverified',
	'failed',
] as const;

export type GithubReturnOutcome = (typeof GITHUB_RETURN_OUTCOMES)[number];

export interface ReturnStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface ReturnLocation {
	pathname: string;
	search: string;
	hash: string;
}

export interface ReturnHistory {
	readonly state: unknown;
	replaceState(data: unknown, unused: string, url: string): void;
}

function isOutcome(value: unknown): value is GithubReturnOutcome {
	return typeof value === 'string' && (GITHUB_RETURN_OUTCOMES as readonly string[]).includes(value);
}

/** Move `?github=` out of the address; a known outcome waits to be shown. */
export function captureGithubReturn(
	location: ReturnLocation,
	storage: ReturnStorage | null,
	history: ReturnHistory,
): GithubReturnOutcome | null {
	const params = new URLSearchParams(location.search);
	if (!params.has(GITHUB_RETURN_PARAM)) return null;
	const value = params.get(GITHUB_RETURN_PARAM);
	params.delete(GITHUB_RETURN_PARAM);
	const search = params.toString();
	history.replaceState(history.state, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
	if (!isOutcome(value)) return null;
	try {
		storage?.setItem(GITHUB_RETURN_KEY, value);
	} catch {
		// Storage refused (private mode, quota): the notice is skipped, nothing else.
	}
	return value;
}

/** The waiting outcome, handed over once. */
export function takeGithubReturn(storage: ReturnStorage | null): GithubReturnOutcome | null {
	if (!storage) return null;
	try {
		const value = storage.getItem(GITHUB_RETURN_KEY);
		if (value === null) return null;
		storage.removeItem(GITHUB_RETURN_KEY);
		return isOutcome(value) ? value : null;
	} catch {
		return null;
	}
}

export interface GithubReturnWords {
	readonly tone: 'ok' | 'warn' | 'danger';
	readonly title: string;
	readonly detail: string;
}

const WORDS: Record<GithubReturnOutcome, GithubReturnWords> = {
	github_identity_required: {
		tone: 'warn',
		title: 'Sign in with GitHub to connect it.',
		detail: 'Sign in to this same Caddie account with GitHub, then connect your personal GitHub installation again.',
	},
	installation_ownership_unverified: {
		tone: 'danger',
		title: 'GitHub ownership could not be verified.',
		detail: 'Connect the personal installation belonging to your linked GitHub account. Organisation installations are not supported yet.',
	},
	connected: {
		tone: 'ok',
		title: 'GitHub is connected.',
		detail: 'Caddie can now use the repositories you chose on GitHub.',
	},
	requested: {
		tone: 'warn',
		title: 'Waiting for your organisation.',
		detail: "GitHub asked your organisation's owner to approve Caddie. Once they do, connect GitHub again here.",
	},
	not_signed_in: {
		tone: 'danger',
		title: 'GitHub was not connected.',
		detail: 'You were signed out when GitHub sent you back. Sign in, then connect GitHub again.',
	},
	expired: {
		tone: 'danger',
		title: 'GitHub was not connected.',
		detail: "That GitHub link didn't come from your Caddie session in the last 30 minutes, so nothing was connected. Connect GitHub again from here.",
	},
	not_found: {
		tone: 'danger',
		title: 'GitHub was not connected.',
		detail: "GitHub didn't send back an installation of Caddie's app. Connect GitHub again from here.",
	},
	suspended: {
		tone: 'danger',
		title: 'GitHub was not connected.',
		detail: "Caddie's app is suspended on that GitHub account. Resume it in GitHub's settings, then connect again.",
	},
	missing_permissions: {
		tone: 'danger',
		title: 'GitHub was not connected.',
		detail: "That installation doesn't let Caddie read and save code or open pull requests. Accept Caddie's permissions on GitHub, then connect again.",
	},
	already_bound: {
		tone: 'danger',
		title: 'GitHub was not connected.',
		detail: 'That GitHub account is already connected to another Caddie workspace.',
	},
	not_configured: {
		tone: 'danger',
		title: 'GitHub was not connected.',
		detail: "GitHub isn't set up on this Caddie yet.",
	},
	failed: {
		tone: 'danger',
		title: 'GitHub was not connected.',
		detail: 'Something went wrong on the way back from GitHub. Try connecting again.',
	},
};

/** One plain sentence for the page (no codes, no ids). */
export function githubReturnWords(outcome: GithubReturnOutcome): GithubReturnWords {
	return WORDS[outcome];
}
