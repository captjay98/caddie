import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Review 2026-10-28: the chat's live search progress and the first-timer
 * signal travel as find_hackathons → context.discover(input, hooks) →
 * paidDiscoveryTools → discoverForActor. The host-context wrapper once dropped
 * the second argument, so neither reached the server and the UI showed one
 * frozen line. A Durable Object is needed to run that wrapper, so this guards
 * the forwarding at the source; the live journey is the behavioural proof.
 */
describe('discover hooks reach the server', () => {
	test('the host-context wrapper forwards hooks to the resolved host', () => {
		const source = readFileSync(new URL('../apps/app/src/agents/host-context.ts', import.meta.url), 'utf8');
		expect(source).toMatch(/discover:\s*async\s*\(input,\s*hooks\)\s*=>\s*\(await resolve\(\)\)\.discover\(input,\s*hooks\)/);
	});
	test('the paid tool wrapper passes progress and first-timer, and never pre-warms from chat', () => {
		const source = readFileSync(new URL('../apps/app/src/server/judge-paid-tools.ts', import.meta.url), 'utf8');
		expect(source).toContain('prewarm: false');
		expect(source).toContain('hooks?.onProgress');
		expect(source).toContain('hooks?.firstTimer');
	});
});
