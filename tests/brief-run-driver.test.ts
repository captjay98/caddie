import { describe, expect, test } from 'bun:test';
import { driveBrief, type DriveOptions, type WorkflowPhase } from '../scripts/brief-run/driver.ts';
import { AccountSession, CookieJar, type AccountProfile } from '../scripts/brief-run/dev-client.ts';
import { FakeClock } from '../scripts/brief-run/clock.ts';

/**
 * LANE 8 STEP 2 — drive one brief end to end. OFFLINE: a scripted fake server
 * answers /projects (create) and /workflow (a phase timeline), and the fake
 * clock advances the poll loop instantly. No real API, no build, no cost.
 */

const A: AccountProfile = { label: 'A', sub: 'alice', email: 'a@example.com', name: 'Alice' };

/**
 * A scripted dev server. `phaseTimeline` is the sequence of phases /workflow
 * returns on successive polls; the decision routes just record that they were
 * called. Create returns a fixed project id.
 */
function scriptedServer(phaseTimeline: WorkflowPhase[], opts: { previewId?: string; detail?: string } = {}) {
	const calls: string[] = [];
	let poll = 0;
	const session = new AccountSession(A, 'http://127.0.0.1:5173', new CookieJar(), async (path, init) => {
		const method = init?.method ?? 'GET';
		calls.push(`${method} ${path}`);
		if (path === '/api/projects' && method === 'POST') return Response.json({ project: { id: 'proj_1' } });
		if (path.endsWith('/workflow/decision')) return Response.json({ ok: true });
		if (path.endsWith('/experience/approve')) return Response.json({ outcome: 'applied' });
		if (path.endsWith('/workflow/design-decision')) return Response.json({ ok: true });
		if (path.endsWith('/workflow')) {
			const phase = phaseTimeline[Math.min(poll, phaseTimeline.length - 1)];
			poll++;
			return Response.json({
				workflow: {
					projectId: 'proj_1',
					runId: 'run_1',
					phase,
					planId: 'plan_1',
					previewId: phase === 'ready' ? (opts.previewId ?? 'out_1') : null,
					detail: phase === 'blocked' ? (opts.detail ?? 'blocked reason') : null,
				},
			});
		}
		return new Response('not found', { status: 404 });
	});
	return { session, calls };
}

const baseOpts: DriveOptions = {
	prompt: 'Build MoodLoop, a mood journal.',
	briefId: 'moodloop',
	teamMode: true,
	buildWaitMs: 90 * 60 * 1000,
	pollEveryMs: 30 * 1000,
	workspaceId: 'ws_1',
};

describe('driveBrief end to end (step 2)', () => {
	test('a happy path reaches ready and approves plan + design along the way', async () => {
		// planning → review → design-review → building → ready
		const { session, calls } = scriptedServer([
			'planning',
			'review',
			'design-review',
			'building',
			'ready',
		]);
		const result = await driveBrief(session, new FakeClock(0), baseOpts);

		expect(result.outcome).toBe('ready');
		expect(result.projectId).toBe('proj_1');
		expect(result.previewId).toBe('out_1');
		// It drove the DOCUMENTED routes, in order.
		expect(calls).toContain('POST /api/projects');
		expect(calls.some((c) => c.endsWith('/experience/approve'))).toBe(true);
		expect(calls.some((c) => c.endsWith('/workflow/design-decision'))).toBe(true);
		// The phase trail records the whole journey.
		expect(result.phasesSeen).toEqual(['planning', 'review', 'design-review', 'building', 'ready']);
	});

	test('a blocked build is reported as blocked with its detail', async () => {
		const { session } = scriptedServer(['review', 'design-review', 'building', 'blocked'], {
			detail: 'reached its spending limit of $5.00',
		});
		const result = await driveBrief(session, new FakeClock(0), baseOpts);
		expect(result.outcome).toBe('blocked');
		expect(result.detail).toContain('spending limit');
	});

	test('a build that never leaves building within the budget is a timeout', async () => {
		// Stuck in building forever; the budget is small so the loop ends.
		const { session } = scriptedServer(['review', 'design-review', 'building']);
		const result = await driveBrief(session, new FakeClock(0), {
			...baseOpts,
			buildWaitMs: 2 * 60 * 1000, // 2 min budget, 30s polls → a few polls then timeout
		});
		expect(result.outcome).toBe('timeout');
	});

	test('the big brief gets the 4-hour budget without real waiting', async () => {
		// Only ready on a very late poll; with 30s polls that is hundreds of
		// iterations — proving the FakeClock makes the long budget instant.
		const timeline: WorkflowPhase[] = ['review', 'design-review'];
		for (let i = 0; i < 400; i++) timeline.push('building');
		timeline.push('ready');
		const { session } = scriptedServer(timeline);
		const result = await driveBrief(session, new FakeClock(0), {
			...baseOpts,
			buildWaitMs: 4 * 60 * 60 * 1000,
		});
		expect(result.outcome).toBe('ready');
	});
});
