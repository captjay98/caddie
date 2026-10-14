import { afterEach, describe, expect, test } from 'bun:test';
import { tavilySearch } from '../apps/app/src/server/tavily.ts';
import { timeoutSignal } from '../apps/app/src/server/http-timeouts.ts';
import { settlementNotice } from '../apps/app/src/client/conversation/settlement-notice.ts';

/**
 * Reproduces the "i want to join nebius x nvidia" stop (2026-10-14). The stored
 * stream showed: reasoning → find_hackathons tool call → NOTHING for ~70 min →
 * Flue's durability supervisor aborted the submission (submission_timeout) →
 * the UI showed only the "Thought it through" note plus a vague "Caddie stopped
 * before finishing" banner, so the internal planning note read like the reply.
 *
 * Root cause: no outbound fetch on the discovery path had a timeout, so one
 * stalled socket hung the tool. These tests pin the two fixes: an outbound call
 * that never answers is aborted and fails soft, and a timed-out turn gets a
 * notice that says what happened.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** A fetch that never resolves unless its signal aborts — the hung socket. */
function hangingFetch(): void {
	globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) return; // no timeout → hangs forever (the old bug)
			signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
		})) as unknown as typeof fetch;
}

describe('stopped mid-turn — outbound timeouts + plain failure notice', () => {
	test('timeoutSignal aborts after its budget', async () => {
		const signal = timeoutSignal(20);
		await new Promise((r) => setTimeout(r, 60));
		expect(signal.aborted).toBe(true);
	});

	test('a Tavily search that never answers now passes a signal and rejects instead of hanging', async () => {
		let sawSignal = false;
		globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
			sawSignal = init?.signal instanceof AbortSignal;
			return new Promise<Response>((_resolve, reject) => {
				// abort immediately to keep the test fast; the real budget is 20s
				reject(new DOMException('The operation timed out.', 'TimeoutError'));
			});
		}) as unknown as typeof fetch;
		await expect(tavilySearch('k', 'nebius nvidia')).rejects.toThrow();
		expect(sawSignal).toBe(true);
	});

	test('a hanging fetch WITH a short signal settles (the old code had no signal and hung)', async () => {
		hangingFetch();
		const started = Date.now();
		await expect(fetch('https://example.invalid', { signal: timeoutSignal(30) })).rejects.toBeDefined();
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test('submission_timeout → a specific "ran out of time" notice, no raw error text', () => {
		const notice = settlementNotice({
			outcome: 'failed',
			error: { name: 'FlueError', message: 'Submission exceeded the configured timeout.', type: 'submission_timeout' },
		});
		expect(notice.kind).toBe('timeout');
		expect(notice.title).toContain('ran out of time');
		expect(`${notice.title} ${notice.detail}`).not.toContain('Submission exceeded');
	});

	test('aborted and other failures get their own plain notices', () => {
		expect(settlementNotice({ outcome: 'aborted' }).kind).toBe('cancelled');
		expect(settlementNotice({ outcome: 'failed', error: new Error('boom') }).kind).toBe('failed');
	});
});
