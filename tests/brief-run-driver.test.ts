import { describe, expect, test } from 'bun:test';
import {
	driveBrief,
	type CoordinatorSend,
	type DriveOptions,
	type ProposalReader,
	type WorkflowPhase,
} from '../scripts/brief-run/driver.ts';
import { AccountSession, CookieJar, type AccountProfile } from '../scripts/brief-run/dev-client.ts';
import { FakeClock } from '../scripts/brief-run/clock.ts';

/**
 * LANE 8 STEP 2 — drive one brief end to end through the REAL start flow.
 * OFFLINE: a scripted fake server answers /home-project, /runs, the Flue
 * coordinator send, /proposals/accept and /workflow (a phase timeline); the
 * proposal read is a fake seam; the fake clock advances the poll loop
 * instantly. No real API, no build, no cost.
 */

const A: AccountProfile = { label: 'A', sub: 'alice', email: 'a@example.com', name: 'Alice' };

/**
 * A scripted dev server for the real start flow. `phaseTimeline` is the
 * sequence of /workflow phases returned on successive polls; the other routes
 * answer the documented shapes and record that they were called.
 */
function scriptedServer(phaseTimeline: WorkflowPhase[], opts: { previewId?: string; detail?: string } = {}) {
	const calls: string[] = [];
	let poll = 0;
	const session = new AccountSession(A, 'http://127.0.0.1:5173', new CookieJar(), async (path, init) => {
		const method = init?.method ?? 'GET';
		calls.push(`${method} ${path}`);
		if (path === '/api/home-project') return Response.json({ project: { id: 'home_1', workspaceId: 'ws_1' } });
		if (path.endsWith('/runs') && method === 'POST') return Response.json({ run: { conversationId: 'conv_1', runId: 'run_1' } });
		if (path.includes('/agents/coordinator/')) return Response.json({ ok: true });
		if (path.includes('/proposals/') && path.endsWith('/accept')) return Response.json({ project: { id: 'proj_1' } });
		if (path.endsWith('/workflow/decision')) return Response.json({ ok: true });
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
				plan: { id: 'plan_1' },
				design: { id: 'design_1' },
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
	coordinatorModelRouteId: 'nemotron-3.5-super-vl',
	payerId: 'alice',
	proposalWaitMs: 30 * 60 * 1000,
	planWaitMs: 30 * 60 * 1000,
	designWaitMs: 30 * 60 * 1000,
};

/** A seam set whose proposal appears at once and whose send records the call. */
function seams(over: { readProposal?: ProposalReader; sent?: string[] } = {}) {
	const sent = over.sent ?? [];
	const readProposal: ProposalReader = over.readProposal ?? (async () => ({ id: 'prop_1', status: 'proposed', createdAt: '2026-10-22T12:00:00.000Z' }));
	const coordinatorSend: CoordinatorSend = async ({ conversationId, body }) => void sent.push(`${conversationId}:${body}`);
	return { readProposal, coordinatorSend, sent };
}

describe('driveBrief end to end (step 2, real start flow)', () => {
	test('a happy path reaches ready and drives the documented start sequence', async () => {
		// review → design-review → building → ready
		const { session, calls } = scriptedServer(['review', 'design-review', 'building', 'ready']);
		const s = seams();
		const result = await driveBrief(session, new FakeClock(0), baseOpts, s);

		expect(result.outcome).toBe('ready');
		expect(result.homeProjectId).toBe('home_1');
		expect(result.projectId).toBe('proj_1');
		expect(result.proposalId).toBe('prop_1');
		expect(result.previewId).toBe('out_1');

		// It drove the REAL routes, in order: home-project, a run, a coordinator
		// send, accept, then the two approvals.
		expect(calls).toContain('GET /api/home-project');
		expect(calls.some((c) => c.endsWith('/runs'))).toBe(true);
		expect(calls.some((c) => c.includes('/proposals/prop_1/accept'))).toBe(true);
		expect(calls.some((c) => c.endsWith('/workflow/decision'))).toBe(true);
		expect(calls.some((c) => c.endsWith('/workflow/design-decision'))).toBe(true);
		// The brief text went to the coordinator conversation (via the seam).
		expect(s.sent).toEqual(['conv_1:Build MoodLoop, a mood journal.']);
		// There is NO /api/projects create and NO /experience/approve.
		expect(calls.some((c) => c === 'POST /api/projects')).toBe(false);
		expect(calls.some((c) => c.endsWith('/experience/approve'))).toBe(false);
	});

	test('no proposal within the budget is reported as no-proposal (nothing accepted)', async () => {
		const { session, calls } = scriptedServer(['ready']);
		const result = await driveBrief(session, new FakeClock(0), { ...baseOpts, proposalWaitMs: 2 * 60 * 1000 }, seams({ readProposal: async () => null }));
		expect(result.outcome).toBe('no-proposal');
		expect(result.projectId).toBe('');
		// It never accepted a proposal or polled a project workflow.
		expect(calls.some((c) => c.includes('/accept'))).toBe(false);
	});

	test('a plan-gate refusal lands as plan-refused and is NOT retried', async () => {
		// After accept, the plan review goes straight to blocked (a refusal).
		const { session, calls } = scriptedServer(['blocked'], { detail: 'the plan gate refused: unsupported stack' });
		const result = await driveBrief(session, new FakeClock(0), baseOpts, seams());
		expect(result.outcome).toBe('plan-refused');
		expect(result.detail).toContain('plan gate refused');
		// It did not approve a plan it never got to review.
		expect(calls.some((c) => c.endsWith('/workflow/decision'))).toBe(false);
	});

	test('a blocked build is reported as blocked with its detail', async () => {
		const { session } = scriptedServer(['review', 'design-review', 'building', 'blocked'], {
			detail: 'reached its spending limit of $5.00',
		});
		const result = await driveBrief(session, new FakeClock(0), baseOpts, seams());
		expect(result.outcome).toBe('blocked');
		expect(result.detail).toContain('spending limit');
	});

	test('a build that never leaves building within the budget is a timeout', async () => {
		const { session } = scriptedServer(['review', 'design-review', 'building']);
		const result = await driveBrief(session, new FakeClock(0), { ...baseOpts, buildWaitMs: 2 * 60 * 1000 }, seams());
		expect(result.outcome).toBe('timeout');
	});

	test('the big brief gets the 4-hour budget without real waiting', async () => {
		const timeline: WorkflowPhase[] = ['review', 'design-review'];
		for (let i = 0; i < 400; i++) timeline.push('building');
		timeline.push('ready');
		const { session } = scriptedServer(timeline);
		const result = await driveBrief(session, new FakeClock(0), { ...baseOpts, buildWaitMs: 4 * 60 * 60 * 1000 }, seams());
		expect(result.outcome).toBe('ready');
	});
});
