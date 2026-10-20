import { describe, expect, test } from 'bun:test';
import {
	GITHUB_RETURN_KEY,
	GITHUB_RETURN_OUTCOMES,
	captureGithubReturn,
	githubReturnWords,
	takeGithubReturn,
} from '../apps/app/src/client/github-return.ts';

/**
 * Plan 6.1: after GitHub's return the server sends the person back to their
 * page with `?github=<outcome>`. The outcome leaves the address before the
 * router reads it (a reload or a bookmark never repeats it), waits in
 * sessionStorage, and the page says it once, in plain words.
 */

function memoryStorage() {
	const items = new Map<string, string>();
	return {
		items,
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => void items.set(key, value),
		removeItem: (key: string) => void items.delete(key),
	};
}

function memoryHistory() {
	const calls: string[] = [];
	return { calls, state: { idx: 3 }, replaceState: (_data: unknown, _unused: string, url: string) => void calls.push(url) };
}

describe("GitHub's return is said once, in plain words (plan 6.1)", () => {
	test('a known outcome leaves the address, keeping the page and its section, and waits to be shown', () => {
		const storage = memoryStorage();
		const history = memoryHistory();
		const outcome = captureGithubReturn(
			{ pathname: '/app/project/settings', search: '?project=proj-a&github=connected', hash: '#code' },
			storage,
			history,
		);
		expect(outcome).toBe('connected');
		expect(history.calls).toEqual(['/app/project/settings?project=proj-a#code']);
		expect(storage.items.get(GITHUB_RETURN_KEY)).toBe('connected');
		// Handed over once.
		expect(takeGithubReturn(storage)).toBe('connected');
		expect(takeGithubReturn(storage)).toBeNull();
	});

	test('anything else in ?github= leaves the address but is never shown; no ?github= touches nothing', () => {
		const storage = memoryStorage();
		const history = memoryHistory();
		expect(captureGithubReturn({ pathname: '/app/', search: '?github=%3Cscript%3E', hash: '' }, storage, history)).toBeNull();
		expect(history.calls).toEqual(['/app/']);
		expect(storage.items.size).toBe(0);
		const untouched = memoryHistory();
		expect(captureGithubReturn({ pathname: '/app/projects', search: '?project=p', hash: '' }, storage, untouched)).toBeNull();
		expect(untouched.calls).toEqual([]);
		// A stored value that is not an outcome is dropped, not shown.
		storage.setItem(GITHUB_RETURN_KEY, 'installation_id=1');
		expect(takeGithubReturn(storage)).toBeNull();
		expect(takeGithubReturn(null)).toBeNull();
	});

	test('every outcome reads as one plain sentence; only a connection is good news', () => {
		expect([...GITHUB_RETURN_OUTCOMES].sort()).toEqual(
			['already_bound', 'connected', 'expired', 'failed', 'github_identity_required', 'installation_ownership_unverified', 'missing_permissions', 'not_configured', 'not_found', 'not_signed_in', 'requested', 'suspended'],
		);
		for (const outcome of GITHUB_RETURN_OUTCOMES) {
			const words = githubReturnWords(outcome);
			expect(words.title.length).toBeGreaterThan(0);
			// Plain words: no outcome codes, ids or underscores reach the page.
			expect(`${words.title} ${words.detail}`).not.toMatch(/_|installation id|setup_action|state=/i);
			expect(words.tone).toBe(outcome === 'connected' ? 'ok' : ['requested', 'github_identity_required'].includes(outcome) ? 'warn' : 'danger');
		}
		expect(githubReturnWords('connected').title).toBe('GitHub is connected.');
		expect(githubReturnWords('expired').detail).toContain('nothing was connected');
	});
});
