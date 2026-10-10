import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * B05 — one chat thread per "Talking about" scope
 * (docs/design/2026-10-10-v2/PACKETS.md).
 *
 * Step 1 of the packet: VERIFY current behaviour first; record whether
 * threads are already per project.
 *
 * Finding (verified against the source, 2026-10-10): threads ARE already per
 * scope. The conversation binds to the route's scope and the transport keys
 * off the conversationId of THAT project's latest run binding:
 *   - `useCoordinatorTransport(actor, projectId)` (coordinator.ts) resolves
 *     the run binding per (actor, projectId) and resets its session run on
 *     any scope change (useEffect on [actorId, projectId]).
 *   - The Flue conversation url is
 *     `/agents/coordinator/<run.conversationId>` — one conversation per run
 *     binding, and run bindings are per project (P02 run_bindings rows).
 *   - Drafts are already keyed per scope in channel-store
 *     (`caddie-channel-drafts:<actorId>:<projectId>`).
 *
 * So: switching the "Talking about" scope shows only that scope's messages
 * because the transport ITSELF re-binds. This test pins those invariants so
 * a refactor cannot silently merge scopes.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const coordinatorSrc = readFileSync(
	join(REPO_ROOT, 'apps/app/src/client/coordinator.ts'),
	'utf8',
);
const chromeSrc = readFileSync(
	join(REPO_ROOT, 'apps/app/src/client/workspace/Chrome.tsx'),
	'utf8',
);
const storeSrc = readFileSync(
	join(REPO_ROOT, 'apps/app/src/client/conversation/channel-store.ts'),
	'utf8',
);

describe('B05: per-scope chat threads (current behaviour, pinned)', () => {
	test('the transport keys the conversation off the run binding of the CURRENT scope only', () => {
		// The Flue conversation url comes from the scope's own run binding.
		expect(coordinatorSrc).toContain('useRunBindings(actor, projectId)');
		expect(coordinatorSrc).toContain('`/agents/coordinator/${encodeURIComponent(run.conversationId)}`');
		// A scope switch discards any session-created run: no carry-over.
		expect(coordinatorSrc).toContain('setSessionRun(null)');
		expect(coordinatorSrc).toMatch(/\[actor\.actorId, projectId\]/);
	});

	test('run bindings are per project in the database schema', () => {
		const migrations = readFileSync(
			join(REPO_ROOT, 'apps/app/migrations/0001_product.sql'),
			'utf8',
		);
		// run_bindings carry projectId — the conversation identity is scoped.
		expect(migrations).toMatch(/create table "run_bindings"/);
		expect(migrations).toContain('"projectId"');
		expect(migrations).toContain('"conversationId"');
	});

	test('drafts and unsent work are keyed per actor + scope in the channel store', () => {
		expect(storeSrc).toContain('function storageKey(sessionKey: string, projectId: string | null)');
		expect(storeSrc).toMatch(/projectId \?\? 'none'/);
	});

	test('the chrome passes the CURRENT conversation scope to the transport (no global singleton)', () => {
		// The transport is bound to conversationProjectId — the scope the user
		// is talking about — never to a module-level singleton.
		expect(chromeSrc).toContain('useCoordinatorTransport(actorMemo, conversationProjectId)');
		// Switching scope (Talking about) navigates, which re-renders the chrome
		// with the new conversationProjectId.
		expect(chromeSrc).toContain('goScope(');
	});
});
