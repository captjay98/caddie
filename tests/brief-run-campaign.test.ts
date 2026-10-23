import { describe, expect, test } from 'bun:test';
import { runCampaign, type Brief, type CampaignSeams } from '../scripts/brief-run.ts';
import { AccountSession, CookieJar, type AccountProfile } from '../scripts/brief-run/dev-client.ts';
import { FakeClock } from '../scripts/brief-run/clock.ts';
import { memoryLedgerStore } from '../scripts/brief-run/ledger.ts';
import type { D1Query } from '../scripts/brief-run/d1-reader.ts';
import type { ProposalReader, CoordinatorSend } from '../scripts/brief-run/driver.ts';
import type { BrowserCheck } from '../scripts/brief-run/browser-check.ts';

/**
 * LANE 8 — the whole campaign orchestration (steps 1-6 composed) over FAKES.
 * No real API, no wrangler, no browser, NO paid build. The cap is proven
 * ACROSS runs from the ledger's own recorded spend.
 */

const USD = 1_000_000;
const A: AccountProfile = { label: 'A', sub: 'a', email: 'a@x', name: 'A' };
const B: AccountProfile = { label: 'B', sub: 'b', email: 'b@x', name: 'B' };

function brief(id: string, size: Brief['size'] = 'small'): Brief {
	return {
		id,
		name: id,
		size,
		source: 'https://devpost.com/x',
		theme: '',
		paired: false,
		teamMode: 'both',
		bigApp: size === 'big',
		admin: false,
		modules: [],
		prompt: `Build ${id}.`,
		completeWhen: ['it works'],
		file: `${id}.md`,
	};
}

/**
 * A session whose start flow ends ready with a preview: /home-project returns
 * the Home project, /runs returns a conversation, /proposals/accept returns a
 * new project, and /workflow walks review → design-review → ready.
 */
function readySession(profile: AccountProfile, runId = 'run_1'): AccountSession {
	let poll = 0;
	return new AccountSession(profile, 'http://127.0.0.1:5173', new CookieJar(), async (path, init) => {
		const method = init?.method ?? 'GET';
		if (path === '/api/home-project') return Response.json({ project: { id: 'home_1', workspaceId: 'ws_1' } });
		if (path.endsWith('/runs') && method === 'POST') return Response.json({ run: { conversationId: 'conv_1', runId } });
		if (path.includes('/agents/coordinator/')) return Response.json({ ok: true });
		if (path.includes('/proposals/') && path.endsWith('/accept')) return Response.json({ project: { id: 'proj_1' } });
		if (path.endsWith('/workflow')) {
			const phase = poll++ === 0 ? 'review' : poll === 2 ? 'design-review' : 'ready';
			return Response.json({
				workflow: { projectId: 'proj_1', runId, phase, planId: 'plan_1', previewId: phase === 'ready' ? 'out_1' : null, detail: null },
				plan: { id: 'plan_1' },
				design: { id: 'design_1' },
			});
		}
		return Response.json({ ok: true });
	});
}

/** A proposal reader that always has a fresh proposal (step 3). */
const proposalReady: ProposalReader = async () => ({ id: 'prop_1', status: 'proposed', createdAt: '2026-10-22T12:00:00.000Z' });
/** A coordinator send that records nothing (step 2). */
const sendNoop: CoordinatorSend = async () => {};

/** A D1 seam answering a fully-green team-mode build for `micros` spend. */
function greenD1(micros: number): D1Query {
	return async (sql) => {
		if (/build_workflows/.test(sql)) return [{ runId: 'run_1', planId: 'plan_1', phase: 'ready', detail: null, previewId: 'out_1', spendPayerId: 'payer_1' }];
		if (/build_features/.test(sql)) return [{ total: 5, passed: 5 }];
		// run_verifications: the latest receipt per check (all passed).
		if (/run_verifications/.test(sql)) return [
			{ checkName: 'dependencies', passed: 1 },
			{ checkName: 'behaviour-tests', passed: 1 },
			{ checkName: 'server-starts', passed: 1 },
		];
		// output_contract_receipts: one green receipt (all required checks true).
		if (/output_contract_receipts/.test(sql)) return [
			{ checksJson: JSON.stringify({ 'sign-in': true, 'second-person': true, restart: true }) },
		];
		if (/run_rounds/.test(sql)) return [{ total: 0 }];
		if (/build_spend_reservations/.test(sql)) return [{ settled: micros, reserved: 0 }];
		if (/build_spend_limits/.test(sql)) return [{ limitMicros: 5 * USD }];
		return [];
	};
}

const passBrowser: BrowserCheck = async () => ({ passed: true, aPersisted: true, bIsolated: true, reason: 'ok' });

function seams(over: Partial<CampaignSeams> = {}): CampaignSeams {
	return {
		sessionA: readySession(A),
		sessionB: readySession(B),
		clock: new FakeClock(0),
		d1: greenD1(3 * USD),
		readProposal: proposalReady,
		coordinatorSend: sendNoop,
		browserCheck: passBrowser,
		ledgerStore: memoryLedgerStore(),
		base: 'http://127.0.0.1:5173',
		workspaceId: 'ws_1',
		payerId: 'owner',
		coordinatorModelRouteId: 'nemotron-3.5-super-vl',
		...over,
	};
}

describe('runCampaign orchestration (steps 1-6)', () => {
	test('a green build is complete and recorded in the ledger with the mode', async () => {
		const s = seams();
		const { rows, ledger } = await runCampaign([brief('moodloop')], s, {
			mode: 'team',
			capMicros: 150 * USD,
			pollEveryMs: 1000,
		});
		expect(rows[0].complete.complete).toBe(true);
		expect(ledger.runs.length).toBe(1);
		expect(ledger.runs[0].mode).toBe('team');
		expect(ledger.runs[0].buildSpentMicros).toBe(3 * USD);
		expect(ledger.runs[0].stopReason).toContain('ready');
	});

	test('a build whose browser check fails is NOT complete', async () => {
		const s = seams({ browserCheck: async () => ({ passed: false, aPersisted: true, bIsolated: false, reason: 'B saw it' }) });
		const { rows } = await runCampaign([brief('moodloop')], s, { mode: 'team', capMicros: 150 * USD, pollEveryMs: 1000 });
		expect(rows[0].complete.complete).toBe(false);
		expect(rows[0].complete.reason).toMatch(/browser/);
	});

	test('the cap refuses a build once the ledger spend leaves no room (D5, across runs)', async () => {
		// Each small build spends $4; the cap is tiny so the 2nd build cannot
		// fit its $5 LIMIT under it even though only $4 was actually spent.
		const s = seams({ d1: greenD1(4 * USD) });
		const { rows, ledger } = await runCampaign(
			[brief('a'), brief('b')],
			s,
			{ mode: 'baseline', capMicros: 8 * USD, pollEveryMs: 1000 },
		);
		// a: spent-before 0, 0+5 ≤ 8 → allowed. b: spent-before 4, 4+5=9 > 8 → refused.
		expect(rows[0].capAllowed).toBe(true);
		expect(rows[1].capAllowed).toBe(false);
		expect(rows[1].complete.complete).toBe(false);
		// The refused build is recorded (audit of what did NOT run) and spent nothing.
		expect(ledger.runs.length).toBe(2);
		expect(ledger.runs[1].buildSpentMicros).toBeNull();
	});

	test('the big brief is charged against the $40 limit, not $5', async () => {
		// spent-before 0, big limit 40, cap 40 → exactly fits (boundary allowed).
		const s = seams({ d1: greenD1(38 * USD) });
		const { rows } = await runCampaign([brief('farmops-big', 'big')], s, { mode: 'team', capMicros: 40 * USD, pollEveryMs: 1000 });
		expect(rows[0].capAllowed).toBe(true);
	});

	test('a big brief whose $40 limit would exceed a $39 cap is refused', async () => {
		const s = seams();
		const { rows } = await runCampaign([brief('farmops-big', 'big')], s, { mode: 'team', capMicros: 39 * USD, pollEveryMs: 1000 });
		expect(rows[0].capAllowed).toBe(false);
	});

	test('onlyBriefIds drives just the smoke brief', async () => {
		const s = seams();
		const { rows } = await runCampaign([brief('a'), brief('b'), brief('c')], s, {
			mode: 'baseline',
			capMicros: 150 * USD,
			pollEveryMs: 1000,
			onlyBriefIds: ['b'],
		});
		expect(rows.length).toBe(1);
		expect(rows[0].briefId).toBe('b');
	});
});
