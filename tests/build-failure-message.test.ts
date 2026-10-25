import { describe, expect, test } from 'bun:test';
import { buildFailureMessageOk, FORBIDDEN_DEBUG_TOKENS } from '../apps/app/src/server/build-failure-message.ts';

// B07.2 — a build that cannot finish explains what is saved and what happens
// next, and never asks a nontechnical user to debug the harness. This locks the
// real hand-written blocker strings and rejects a would-be debug message.
describe('B07.2 — failure text is truthful and never asks the user to debug', () => {
	// Verbatim from coordinator-host.ts / build-workflow.ts.
	const REAL = [
		'Caddie could not get the app checks passing after three attempts. Your plan and files are saved. The app is not ready to try yet.',
		'Caddie used this build\u2019s 150-step budget without getting the checks to pass, so the build was paused. Your plan and files are saved. Retry to continue with a fresh budget.',
		'This build reached its time limit, so it was paused. Your plan and files are saved. Press Retry to continue from here.',
		'The build sandbox is not configured. Your plan is saved; connect the sandbox to continue.',
		'The app still doesn\u2019t match the design you approved after three attempts. Your plan and files are saved. The app is not ready to try yet.',
	];

	test('every real build-failure message passes', () => {
		for (const message of REAL) {
			const verdict = buildFailureMessageOk(message);
			expect(verdict.ok, `${message} :: ${verdict.ok ? '' : verdict.reason}`).toBe(true);
		}
	});

	test('a message that asks the user to debug the harness is rejected', () => {
		const verdict = buildFailureMessageOk('Build failed: TypeError null pointer at line 42 — check the stack trace in stderr.');
		expect(verdict.ok).toBe(false);
	});

	test('a message that leaks a secret term is rejected', () => {
		expect(buildFailureMessageOk('The build failed because the API key was missing; your plan is saved, retry.').ok).toBe(false);
	});

	test('a message that never says what is saved is rejected', () => {
		expect(buildFailureMessageOk('The build was paused. Press Retry to continue.').ok).toBe(false);
	});

	test('a message with no next step is rejected', () => {
		expect(buildFailureMessageOk('The build failed. Your plan and files are saved.').ok).toBe(false);
	});

	test('the forbidden set is non-empty', () => {
		expect(FORBIDDEN_DEBUG_TOKENS.length).toBeGreaterThan(0);
	});
});
