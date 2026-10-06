import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ALL_TOOL_NAMES,
	mentionsProtectedPath,
	PROTECTED_PATH_PREFIXES,
	REPAIR_PAUSE_THRESHOLD,
	ROLE_TOOL_POLICY,
	SPECIALIST_ROLES,
	isProtectedPath,
} from '../apps/app/src/agents/permissions';
import { SPECIALIST_CATALOG, SPECIALIST_INSTRUCTIONS, buildSpecialistDeclarations } from '../apps/app/src/agents/specialists.ts';
import {
	makeRecordVerification,
	makeSandboxExec,
	makeWriteSandboxFile,
	assertNotProtectedPath,
} from '../apps/app/src/agents/tools';
import { PACKAGED_SKILLS } from '../apps/app/src/agents/skills';
import { evaluateGateLedger, gatePathFor } from '../apps/app/src/agents/completion-gate';
import * as runsService from '../apps/app/src/server/runs';
import { ScopeError, assertProjectScope } from '../apps/app/src/server/scope';

/**
 * P05 agent permissions + run lifecycle (unit level — no model calls).
 *
 * The live Flue lifecycle (real Nebius round-trips, browser reconnect,
 * duplicate-send) is tests/live/flsue-lifecycle.spec.ts and is BLOCKED without
 * owner credentials. Everything here is provable without a provider:
 * the permission matrix, protected-check guarding, skill-hash integrity,
 * the run lifecycle (budget-fail-closed creation, repair-ledger pause rule),
 * and the completion gate's acceptance rule.
 */

// ---- in-memory D1-shaped database -------------------------------------------

// The services use the D1 idiom (prepare().bind().run()/all()); wrap
// bun:sqlite to match, the same way the P02 fixture does.
function d1(db: Database) {
	return {
		prepare: (sql: string) => {
			const stmt = db.prepare(sql);
			return {
				bind: (...values: unknown[]) => ({
					run: () => stmt.run(...(values as never[])),
					all: () => ({ results: stmt.all(...(values as never[])) as unknown[] }),
				}),
				run: (...values: unknown[]) => stmt.run(...(values as never[])),
				all: (...values: unknown[]) => ({ results: stmt.all(...(values as never[])) as unknown[] }),
			};
		},
	};
}

function applyDdl(d1db: ReturnType<typeof d1>) {
	// 0001 provides the P02 product tables the runs services build on;
	// 0005 provides the run lifecycle tables. Identity tables from 0001 are
	// unnecessary here (foreign keys are off in bun:sqlite by default).
	for (const file of ['0001_product.sql', '0005_runs.sql']) {
		const migration = readFileSync(
			join(import.meta.dir, '..', 'apps', 'app', 'migrations', file),
			'utf8',
		);
		for (const statement of migration.split(/;\s*(?:\n|$)/)) {
			const trimmed = statement.trim();
			if (trimmed) d1db.prepare(trimmed).run();
		}
	}
}

// ---- permission matrix -------------------------------------------------------

describe('P05 permission matrix', () => {
	test('every specialist role has a tool policy and the catalog lists it once', () => {
		expect([...SPECIALIST_ROLES].sort()).toEqual(SPECIALIST_CATALOG.map((d) => d.role).sort());
		for (const role of SPECIALIST_ROLES) {
			expect(ROLE_TOOL_POLICY[role].length).toBeGreaterThan(0);
			expect(SPECIALIST_INSTRUCTIONS[role].length).toBeGreaterThan(20);
		}
	});

	test('QA holds no write-capable tools at all', () => {
		const writeCapable = new Set(['write_sandbox_file', 'write_plan_note', 'delegate_repair']);
		for (const tool of ROLE_TOOL_POLICY.qa) {
			expect(writeCapable.has(tool)).toBe(false);
		}
		// record_verification is QA's only mutation, and it appends evidence —
		// never product state.
		expect(ROLE_TOOL_POLICY.qa).toContain('record_verification');
	});

	test('product has no sandbox or write-file tools', () => {
		for (const tool of ROLE_TOOL_POLICY.product) {
			expect(tool.startsWith('sandbox_')).toBe(false);
			expect(tool).not.toBe('write_sandbox_file');
		}
	});

	test('every tool name in every policy is a known tool', () => {
		const known = new Set(ALL_TOOL_NAMES);
		for (const role of SPECIALIST_ROLES) {
			for (const tool of ROLE_TOOL_POLICY[role]) {
				expect(known.has(tool)).toBe(true);
			}
		}
	});

	test('specialist declarations carry the catalog name/description and no model override', () => {
		const context = stubContext();
		const declarations = buildSpecialistDeclarations(context);
		expect(declarations.map((d) => d.name)).toEqual(SPECIALIST_CATALOG.map((d) => d.name));
		for (const declaration of declarations) {
			// model lives on the coordinator's turn — definitions omit it
			expect('model' in declaration).toBe(false);
			expect(declaration.description.length).toBeGreaterThan(10);
		}
	});
});

// ---- protected paths ----------------------------------------------------------

describe('P05 protected acceptance surfaces', () => {
	test('agent write tools refuse every protected path prefix', () => {
		for (const prefix of PROTECTED_PATH_PREFIXES) {
			expect(isProtectedPath(prefix)).toBe(true);
			expect(isProtectedPath(`${prefix}anything/else`)).toBe(true);
		}
		expect(isProtectedPath('src/components/App.tsx')).toBe(false);
	});

	test('write_sandbox_file refuses protected paths before touching the driver', async () => {
		const calls: string[] = [];
		const driver = {
			execute: async () => {
				calls.push('execute');
				return { remoteId: 'x' };
			},
			readFile: async () => {
				calls.push('read');
				return '';
			},
			writeFile: async () => {
				calls.push('write');
			},
		};
		const tool = makeWriteSandboxFile({ driver, sessionId: 's1' });
		let error: unknown = null;
		try {
			// run() is the raw definition's run; invoke through it directly.
			await (tool as unknown as { run: (ctx: { data: { path: string; content: string; sessionId: string } }) => Promise<unknown> }).run({
				data: { path: 'tests/acceptance/manifest.json', content: 'hacked', sessionId: 's1' },
			});
		} catch (caught) {
			error = caught;
		}
		expect(String(error)).toContain('PROTECTED_PATH');
		expect(calls).toEqual([]); // the driver was never touched
	});

	test('sandbox_exec refuses commands referencing protected paths', async () => {
		const calls: string[] = [];
		const driver = {
			execute: async (input: { command: string }) => {
				calls.push(input.command);
				return { remoteId: 'x' };
			},
			readFile: async () => {
				calls.push('read');
				return '';
			},
			writeFile: async () => {
				calls.push('write');
			},
		};
		const tool = makeSandboxExec({ driver, sessionId: 's1', runId: 'r1' });
		let error: unknown = null;
		try {
			await (tool as unknown as { run: (ctx: { data: { command: string; sessionId: string; timeoutMs: number } }) => Promise<unknown> }).run({
				data: { command: "echo hacked > tests/acceptance/manifest.json", sessionId: 's1', timeoutMs: 1000 },
			});
		} catch (caught) {
			error = caught;
		}
		expect(String(error)).toContain('PROTECTED_PATH');
		expect(calls).toEqual([]);
		// a benign command passes through
		await (tool as unknown as { run: (ctx: { data: { command: string; sessionId: string; timeoutMs: number } }) => Promise<unknown> }).run({
			data: { command: 'bun test src/', sessionId: 's1', timeoutMs: 1000 },
		});
		expect(calls).toEqual(['bun test src/']);
	});

	test('mentionsProtectedPath catches paths embedded mid-command', () => {
		expect(mentionsProtectedPath("echo hacked > tests/acceptance/manifest.json")).toBe(true);
		expect(mentionsProtectedPath("cat scripts/verify-packet.ts")).toBe(true);
		expect(mentionsProtectedPath('bun test src/')).toBe(false);
	});

	test('assertNotProtectedPath blocks the gate directory for regular agents', () => {
		expect(() => assertNotProtectedPath('.caddie/gates/rev-1.jsonl')).toThrow('PROTECTED_PATH');
	});
});

// ---- skills -------------------------------------------------------------------

describe('P05 packaged skills', () => {
	test('all three skills are packaged via the flue mechanism', () => {
		const names = Object.keys(PACKAGED_SKILLS);
		expect(names).toContain('planning');
		expect(names).toContain('build-verify');
		expect(names).toContain('delivery-checklist');
		for (const name of names) {
			const skill = PACKAGED_SKILLS[name as keyof typeof PACKAGED_SKILLS];
			expect(skill).toBeDefined();
		}
	});

	test('unknown skill lookup is type-unsafe by design (compile-time union)', () => {
		// PackagedSkillName is a union of the three known names — a typo fails
		// at compile time, not runtime.
		expect(Object.keys(PACKAGED_SKILLS)).toHaveLength(3);
	});
});

// ---- completion gate ------------------------------------------------------------

describe('P05 completion gate', () => {
	test('no record under the current revision refuses completion', () => {
		const verdict = evaluateGateLedger(
			`${JSON.stringify({ check: 'x', command: 'bun test', exitCode: 0, planRevision: 'rev-1', outputDigest: 'd', operationKey: 'exec:r1:aaaaaaaaaaaaaaaaaaaaaaaa', recordedAt: 't' })}\n`,
			'rev-2',
		);
		expect(verdict.completable).toBe(false);
		expect(verdict.reason).toContain('no acceptance record');
	});

	test('a failing record refuses completion even with passing history', () => {
		const pass = `${JSON.stringify({ check: 'old', command: 'bun test', exitCode: 0, planRevision: 'rev-1', outputDigest: 'd', operationKey: 'exec:r1:aaaaaaaaaaaaaaaaaaaaaaaa', recordedAt: 't' })}\n`;
		const fail = `${JSON.stringify({ check: 'new', command: 'bun test', exitCode: 1, planRevision: 'rev-2', outputDigest: 'd', operationKey: 'exec:r1:bbbbbbbbbbbbbbbbbbbbbbbb', recordedAt: 't' })}\n`;
		const verdict = evaluateGateLedger(pass + fail, 'rev-2');
		expect(verdict.completable).toBe(false);
		expect(verdict.reason).toContain('unresolved failing checks');
	});

	test('a passing record under the current revision completes', () => {
		const verdict = evaluateGateLedger(
			`${JSON.stringify({ check: 'tests', command: 'bun test', exitCode: 0, planRevision: 'rev-2', outputDigest: 'd', operationKey: 'exec:r1:cccccccccccccccccccccccc', recordedAt: 't' })}\n`,
			'rev-2',
		);
		expect(verdict.completable).toBe(true);
	});

	test('a corrupt line does not erase passing records around it', () => {
		const content = [
			'{not json',
			JSON.stringify({ check: 't', command: 'bun test', exitCode: 0, planRevision: 'rev-1', outputDigest: 'd', operationKey: 'exec:r1:aaaaaaaaaaaaaaaaaaaaaaaa', recordedAt: 't' }),
			'',
		].join('\n');
		const verdict = evaluateGateLedger(content, 'rev-1');
		expect(verdict.completable).toBe(true);
	});

	test('a record without an operation key is not acceptance evidence', () => {
		const noKey = `${JSON.stringify({ check: 'x', command: 'bun test', exitCode: 0, planRevision: 'rev-1', outputDigest: 'd', recordedAt: 't' })}\n`;
		const verdict = evaluateGateLedger(noKey, 'rev-1');
		expect(verdict.completable).toBe(false);
		expect(verdict.reason).toContain('no acceptance record');
	});

	test('latest record per check decides: a re-run failure after a pass blocks', () => {
		const pass = `${JSON.stringify({ check: 'tests', command: 'bun test', exitCode: 0, planRevision: 'rev-1', outputDigest: 'd', operationKey: 'exec:r1:dddddddddddddddddddddddd', recordedAt: 't1' })}\n`;
		const fail = `${JSON.stringify({ check: 'tests', command: 'bun test', exitCode: 1, planRevision: 'rev-1', outputDigest: 'd', operationKey: 'exec:r1:eeeeeeeeeeeeeeeeeeeeeeee', recordedAt: 't2' })}\n`;
		// Both orders: the latest (by array order in the ledger) wins
		expect(evaluateGateLedger(pass + fail, 'rev-1').completable).toBe(false);
	});

	test('empty gate (fail closed) refuses completion', () => {
		expect(evaluateGateLedger('', 'rev-1').completable).toBe(false);
		expect(gatePathFor('rev-1')).toBe('.caddie/gates/rev-1.jsonl');
	});
});

// ---- run lifecycle ---------------------------------------------------------------

function stubContext() {
	return {
		driver: {
			execute: async () => ({ remoteId: 'r1' }),
			readFile: async () => '',
			writeFile: async () => {},
		},
		sessionId: 'sess-1',
		runId: 'run-1',
		readPlanNote: async () => null,
		writePlanNote: async () => {},
		delegateRepair: async () => {},
		recordVerification: async () => {},
	};
}

describe('P05 run lifecycle', () => {
	let tmp: string;
	let db: Database;
	let d1db: ReturnType<typeof d1>;
	let projectAId: string;
	let runAId: string;
	let aliceScope: { actorId: string; workspaceId: string; projectId: string };
	let bobScope: { actorId: string; workspaceId: string; projectId: string } | null = null;

	function seedProject() {
		d1db.prepare(
			`insert into "workspaces" ("id","name","createdAt") values (?,?,?)`,
		).run('ws_t', 'Test Workspace', '2026-10-05T00:00:00.000Z');
		d1db.prepare(
			`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt") values (?,?,?,?,?)`,
		).run('m_alice', 'ws_t', 'user_alice', 'owner', '2026-10-05T00:00:00.000Z');
		d1db.prepare(
			`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt") values (?,?,?,?,?)`,
		).run('m_bob', 'ws_t', 'user_bob', 'member', '2026-10-05T00:00:00.000Z');
		d1db.prepare(
			`insert into "projects" ("id","workspaceId","name","description","contestId","contestUrl","status","createdAt","updatedAt") values (?,?,?,?,?,?,?,?,?)`,
		).run('proj_t', 'ws_t', 'Test Project', null, null, null, 'active', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
		d1db.prepare(
			`insert into "projects" ("id","workspaceId","name","description","contestId","contestUrl","status","createdAt","updatedAt") values (?,?,?,?,?,?,?,?,?)`,
		).run('proj_other', 'ws_t', 'Other Project', null, null, null, 'active', '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
		d1db.prepare(
			`insert into "run_bindings" ("runId","projectId","conversationId","submissionId","planRevision","stackId","payerId","modelRouteId","pricingVersion","createdBy","createdAt") values (?,?,?,?,?,?,?,?,?,?,?)`,
		).run(
			'run_other',
			'proj_other',
			'conv_other',
			'sub_other',
			'rev-0',
			'react-hono',
			'payer',
			'nemotron-3-super',
			'2026-10-adjudication',
			'user_alice',
			'2026-10-05T00:00:00.000Z',
		);
	}

	function count(sql: string): number {
		const result = d1db.prepare(sql).all() as unknown as { results: Record<string, unknown>[] };
		return Number(result.results[0]?.['n'] ?? 0);
	}

	test('createRun freezes a registered model route and binds the conversation durably', async () => {
		tmp = mkdtempSync(join(tmpdir(), 'p05-runs-'));
		db = new Database(':memory:');
		d1db = d1(db);
		applyDdl(d1db);
		seedProject();
		projectAId = 'proj_t';
		aliceScope = { actorId: 'user_alice', workspaceId: 'ws_t', projectId: projectAId };
		bobScope = { actorId: 'user_bob', workspaceId: 'ws_t', projectId: projectAId };

		const binding = await runsService.createRun(d1db as never, aliceScope, {
			modelRouteId: 'nemotron-3-super',
			planRevision: 'rev-1',
			payerId: 'payer_alice',
		});
		runAId = binding.runId;
		expect(binding.modelRouteId).toBe('nemotron-3-super');
		expect(binding.pricingVersion).toBe('2026-10-adjudication');
		// conversation binding is server-derived and durable
		const byConversation = await runsService.lookupRunByConversation(d1db as never, binding.conversationId);
		expect(byConversation?.runId).toBe(runAId);
	});

	test('unknown model route fails closed (no silent fallback)', async () => {
		let error: unknown = null;
		try {
			await runsService.createRun(d1db as never, aliceScope, {
				modelRouteId: 'cheap-and-unknown',
				planRevision: 'rev-1',
				payerId: 'payer_alice',
			});
		} catch (caught) {
			error = caught;
		}
		expect(String(error)).toContain('unknown model route');
	});

	test('three failed repair attempts on the same issue pause; other kinds never count', async () => {
		// diagnosis rounds do not count toward the threshold
		await runsService.recordRepairRound(d1db as never, aliceScope, runAId, {
			issue: 'flaky-widget',
			round: 'diagnosis',
			outcome: 'failed',
		});
		expect((await runsService.isRunPaused(d1db as never, runAId)).paused).toBe(false);

		await runsService.recordRepairRound(d1db as never, aliceScope, runAId, {
			issue: 'flaky-widget',
			round: 'repair_attempt',
			outcome: 'failed',
		});
		await runsService.recordRepairRound(d1db as never, aliceScope, runAId, {
			issue: 'flaky-widget',
			round: 'repair_attempt',
			outcome: 'failed',
		});
		expect((await runsService.isRunPaused(d1db as never, runAId)).paused).toBe(false);

		const third = await runsService.recordRepairRound(d1db as never, aliceScope, runAId, {
			issue: 'flaky-widget',
			round: 'repair_attempt',
			outcome: 'failed',
		});
		expect(third.paused).toBe(true);
		expect((await runsService.isRunPaused(d1db as never, runAId)).issue).toBe('flaky-widget');

		// a DIFFERENT issue starts its own count
		const other = await runsService.recordRepairRound(d1db as never, aliceScope, runAId, {
			issue: 'other-bug',
			round: 'repair_attempt',
			outcome: 'failed',
		});
		expect(other.paused).toBe(false);
		expect(other.failedRepairAttempts).toBe(1);
		expect(REPAIR_PAUSE_THRESHOLD).toBe(3);
	});

	test('completion requires machine-checked evidence under the current revision — self-reports never suffice', async () => {
		// no evidence yet
		let verdict = await runsService.evaluateCompletion(d1db as never, runAId, 'rev-2');
		expect(verdict.completable).toBe(false);

		// evidence under an OLDER revision does not complete rev-2
		await runsService.recordVerification(d1db as never, aliceScope, runAId, {
			check: 'unit tests',
			passed: true,
			evidence: 'bun test exit 0',
			planRevision: 'rev-1',
		});
		verdict = await runsService.evaluateCompletion(d1db as never, runAId, 'rev-2');
		expect(verdict.completable).toBe(false);

		// stale tool results are rejected after a plan revision
		expect(runsService.isStaleToolResult('rev-1', 'rev-2')).toBe(true);
		expect(runsService.isStaleToolResult('rev-2', 'rev-2')).toBe(false);

		// failing evidence blocks
		await runsService.recordVerification(d1db as never, aliceScope, runAId, {
			check: 'acceptance',
			passed: false,
			evidence: 'acceptance exit 1',
			planRevision: 'rev-2',
		});
		verdict = await runsService.evaluateCompletion(d1db as never, runAId, 'rev-2');
		expect(verdict.completable).toBe(false);
		expect(verdict.reason).toContain('failing');

		// passing evidence under the current revision completes
		await runsService.recordVerification(d1db as never, aliceScope, runAId, {
			check: 'acceptance',
			passed: true,
			evidence: 'acceptance exit 0',
			planRevision: 'rev-2',
		});
		verdict = await runsService.evaluateCompletion(d1db as never, runAId, 'rev-2');
		expect(verdict.completable).toBe(true);

		// last good checkpoint kept across the failure
		const snapshot = await runsService.runSnapshot(d1db as never, aliceScope, runAId);
		expect(snapshot.lastCheckpoint).not.toBeNull();
		expect(snapshot.lastCheckpoint?.planRevision).toBe('rev-2');
	});

	test('run snapshot is project-scoped: no cross-project reads', async () => {
		let error: unknown = null;
		try {
			// the run bound to proj_t is invisible under proj_other's scope
			await runsService.runSnapshot(d1db as never, { actorId: 'user_alice', workspaceId: 'ws_t', projectId: 'proj_other' }, runAId);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ScopeError);
		expect((error as ScopeError).status).toBe(404);
	});
});
