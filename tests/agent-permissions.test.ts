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
	isShellTestCommand,
} from '../apps/app/src/agents/permissions';
import { BUILD_RECIPE_INSTRUCTION, PLATFORM_AI_RULE, SPECIALIST_CATALOG, SPECIALIST_INSTRUCTIONS, buildSpecialistDeclarations } from '../apps/app/src/agents/specialists.ts';
import { CADDIE_SCRATCH_DIR } from '../apps/app/src/server/source-export.ts';
import { findModelRouteForRole } from '../apps/app/src/agents/providers.ts';
import {
	makeRecordAcceptance,
	makeRecordVerification,
	makeSandboxExec,
	makeVerifyBuild,
	makeWriteSandboxFile,
	assertNotProtectedPath,
} from '../apps/app/src/agents/tools';
import { PACKAGED_SKILLS } from '../apps/app/src/agents/skills';
import { evaluateGateLedger, gatePathFor } from '../apps/app/src/agents/completion-gate';
import * as runsService from '../apps/app/src/server/runs';
import { ScopeError, assertProjectScope } from '../apps/app/src/server/scope';
import { LruCache } from '../apps/app/src/server/lru-cache';

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
		expect(ROLE_TOOL_POLICY.qa).toContain('verify_build');
 expect(ROLE_TOOL_POLICY.qa).not.toContain('sandbox_exec');
	});

	test('product has no sandbox or write-file tools', () => {
		for (const tool of ROLE_TOOL_POLICY.product) {
			expect(tool.startsWith('sandbox_')).toBe(false);
			expect(tool).not.toBe('write_sandbox_file');
		}
	});

	test('build roles test only through run_checks; planners and QA do not hold it', () => {
		for (const role of ['frontend', 'backend', 'mobile', 'tech-lead'] as const) {
			expect(ROLE_TOOL_POLICY[role]).toContain('run_checks');
		}
		for (const role of ['product', 'designer', 'qa'] as const) {
			expect(ROLE_TOOL_POLICY[role]).not.toContain('run_checks');
		}
	});

	test('shell test commands are detected however they are wrapped; installs and builds are not', () => {
		for (const command of [
			'bun test',
			'bun test src/diag.test.ts 2>&1 | head -14',
			'cd /workspace/p && bun run test',
			'npm test',
			'pnpm run test',
			'npx vitest run',
			'bunx jest --watch',
			'TMPDIR=/tmp jest',
			'echo start; vitest',
			'sh -c "bun test src"',
		]) {
			expect(isShellTestCommand(command), command).toBe(true);
		}
		for (const command of [
			'bun install',
			'bun add -d @testing-library/jest-dom',
			'bun run build',
			'cat src/App.test.tsx',
			'ls test/examples',
			'bun run src/server.ts',
		]) {
			expect(isShellTestCommand(command), command).toBe(false);
		}
	});

	test('the build recipe points at the pre-wired harness, not hand-built DOM setup', () => {
		expect(BUILD_RECIPE_INSTRUCTION).toContain('run_checks');
		expect(BUILD_RECIPE_INSTRUCTION).toContain('test/setup/');
		expect(BUILD_RECIPE_INSTRUCTION).not.toContain('global-jsdom');
		expect(BUILD_RECIPE_INSTRUCTION).not.toContain('initialize jsdom');
	});

	test("probes go in Caddie's scratch folder, and a failure inside Caddie's own steps is reported, not debugged (live finding, 2026-10-20)", () => {
		// The FarmLog build left scratch-*.ts probes in the app and spent its
		// repairs reading /tmp/caddie-verified-install.mjs after Caddie's own
		// installer crashed.
		expect(BUILD_RECIPE_INSTRUCTION).toContain(`only in ${CADDIE_SCRATCH_DIR}/`);
		expect(BUILD_RECIPE_INSTRUCTION).toContain('never in the app root or src/');
		for (const sign of ['/tmp/caddie-', 'could not be unpacked', 'the registry could not be reached']) {
			expect(BUILD_RECIPE_INSTRUCTION).toContain(sign);
		}
		expect(BUILD_RECIPE_INSTRUCTION).toContain("that is Caddie's problem, not your code");
		expect(BUILD_RECIPE_INSTRUCTION).toContain('stop that repair');
	});

	test('every tool name in every policy is a known tool', () => {
		const known = new Set(ALL_TOOL_NAMES);
		for (const role of SPECIALIST_ROLES) {
			for (const tool of ROLE_TOOL_POLICY[role]) {
				expect(known.has(tool)).toBe(true);
			}
		}
	});

	test('planners stay on the plan role; implementation and QA use the 3.5 build route', () => {
		const context = stubContext();
		const declarations = buildSpecialistDeclarations(context);
		expect(declarations.map((d) => d.name)).toEqual(SPECIALIST_CATALOG.map((d) => d.name));
		const plan = findModelRouteForRole('plan');
		const build = findModelRouteForRole('build');
		expect(plan.id).toBe('glm-5.3-flash');
		expect(build.id).toBe('nemotron-3.5-super-vl');
		const modelByName = Object.fromEntries(declarations.map((d) => [d.name, d.model]));
		for (const name of ['product', 'designer', 'tech-lead']) expect(modelByName[name]).toBe(plan.specifier);
		for (const name of ['frontend', 'backend', 'mobile', 'qa']) expect(modelByName[name]).toBe(build.specifier);
		for (const declaration of declarations) expect(declaration.description.length).toBeGreaterThan(10);
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

	test('record_acceptance refuses a planRevision that is not the run\'s current one', async () => {
		const writes: string[] = [];
		const tool = makeRecordAcceptance(() => 'rev-0');
		const run = async (planRevision: string) =>
			(tool as unknown as { run: (ctx: { data: Record<string, unknown>; harness: { sandbox: { readFile: (p: string) => Promise<string>; writeFile: (p: string, c: string) => Promise<void> } } }) => Promise<{ output: string }> }).run({
				data: { check: 'tests', command: 'bun test', exitCode: 0, outputDigest: 'd', operationKey: 'exec:r1:aaaaaaaaaaaaaaaaaaaaaaaa', planRevision },
				harness: {
					sandbox: {
						readFile: async () => '',
						writeFile: async (_p: string, content: string) => {
							writes.push(content);
						},
					},
				},
			});

		// the model invented a revision ("1") while the run is on rev-0 —
		// the write must be REFUSED so no invisible ledger is created
		const refused = await run('1');
		expect(refused.output).toContain('record refused');

        expect(refused.output).toContain('caller-supplied');
        expect(writes.length).toBe(0);
	});

	test('mentionsProtectedPath catches paths embedded mid-command', () => {
		expect(mentionsProtectedPath("echo hacked > tests/acceptance/manifest.json")).toBe(true);
		expect(mentionsProtectedPath("cat scripts/verify-packet.ts")).toBe(true);
		expect(mentionsProtectedPath('bun test src/')).toBe(false);
	});

	test('mentionsProtectedPath catches a protected DIRECTORY with no trailing slash (bypass regression)', () => {
		// The prefixes carry a trailing slash; a plain includes() let a bare
		// directory target slip through and destroy the whole protected tree.
		expect(mentionsProtectedPath('rm -rf tests/acceptance')).toBe(true);
		expect(mentionsProtectedPath('mv tests/fixtures/forge-task-tracker /tmp/x')).toBe(true);
		expect(mentionsProtectedPath('rm -rf ./tests/acceptance')).toBe(true);
		expect(mentionsProtectedPath('rm .caddie/gates')).toBe(true);
		// A different path that merely SHARES the prefix text is not a false hit.
		expect(mentionsProtectedPath('cat tests/acceptance-notes.md')).toBe(false);
		expect(mentionsProtectedPath('cat tests/unit/app.test.ts')).toBe(false);
	});

	test('assertNotProtectedPath blocks the gate directory for regular agents', () => {
		expect(() => assertNotProtectedPath('.caddie/gates/rev-1.jsonl')).toThrow('PROTECTED_PATH');
	});
});

// ---- skills -------------------------------------------------------------------

describe('P05 packaged skills', () => {
	test('every packaged skill is exported via the flue mechanism', () => {
		const names = Object.keys(PACKAGED_SKILLS);
		expect(names).toContain('planning');
		expect(names).toContain('design'); // the design-step skill (design brief + visual mockup)
		expect(names).toContain('build-verify');
		expect(names).toContain('delivery-checklist');
		expect(names).toContain('submission'); // P13 — judge coaching + submission prep
		for (const name of names) {
			const skill = PACKAGED_SKILLS[name as keyof typeof PACKAGED_SKILLS];
			expect(skill).toBeDefined();
		}
	});

	test('unknown skill lookup is type-unsafe by design (compile-time union)', () => {
		// PackagedSkillName is a union of the known names — a typo fails at
		// compile time, not runtime. (Five since the design-step skill was added.)
		expect(Object.keys(PACKAGED_SKILLS)).toHaveLength(5);
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
		// The literal is the point: a binding records the price list in force on
		// the day it was created, so an accidental change to PRICING_VERSION must
		// fail here rather than silently re-price stored runs.
		expect(binding.pricingVersion).toBe('2026-10-nemotron-listing');
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

	test('repair rounds are run-owned: a cross-project runId is rejected (404)', async () => {
		const otherScope = { actorId: 'user_alice', workspaceId: 'ws_t', projectId: 'proj_other' };
		let error: unknown = null;
		try {
			// runAId is bound to proj_t; recording under proj_other's scope must
			// not write a ledger row for a run the project does not own.
			await runsService.recordRepairRound(d1db as never, otherScope, runAId, {
				issue: 'cross-project',
				round: 'repair_attempt',
				outcome: 'failed',
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ScopeError);
		expect((error as ScopeError).status).toBe(404);
		expect((error as ScopeError).code).toBe('run_not_found');
		// Nothing was written for the foreign run.
		expect(count(`select count(*) as n from "run_rounds" where "runId" = '${runAId}' and "projectId" = 'proj_other'`)).toBe(0);
	});

	test('repair rounds reject an unknown runId (404, nothing written)', async () => {
		let error: unknown = null;
		try {
			await runsService.recordRepairRound(d1db as never, aliceScope!, 'run_missing', {
				issue: 'no-such-run',
				round: 'diagnosis',
				outcome: 'failed',
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ScopeError);
		expect((error as ScopeError).status).toBe(404);
		expect(count(`select count(*) as n from "run_rounds" where "runId" = 'run_missing'`)).toBe(0);
	});

	test('verification records are run-owned: a cross-project runId is rejected (404)', async () => {
		const otherScope = { actorId: 'user_alice', workspaceId: 'ws_t', projectId: 'proj_other' };
		let error: unknown = null;
		try {
			await runsService.recordVerification(d1db as never, otherScope, runAId, {
				check: 'cross-project',
				passed: true,
				evidence: 'must not land',
				planRevision: 'rev-1',
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ScopeError);
		expect((error as ScopeError).status).toBe(404);
		expect((error as ScopeError).code).toBe('run_not_found');
		expect(count(`select count(*) as n from "run_verifications" where "runId" = '${runAId}' and "projectId" = 'proj_other'`)).toBe(0);
		// No checkpoint was created for the foreign pairing either.
		expect(count(`select count(*) as n from "run_checkpoints" where "runId" = '${runAId}' and "projectId" = 'proj_other'`)).toBe(0);
	});

	test('verification records reject an unknown runId (404, nothing written)', async () => {
		let error: unknown = null;
		try {
			await runsService.recordVerification(d1db as never, aliceScope!, 'run_missing', {
				check: 'no-such-run',
				passed: true,
				evidence: 'must not land',
				planRevision: 'rev-1',
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ScopeError);
		expect((error as ScopeError).status).toBe(404);
		expect(count(`select count(*) as n from "run_verifications" where "runId" = 'run_missing'`)).toBe(0);
	});

	test('in-project recording still works after the ownership checks', async () => {
		const round = await runsService.recordRepairRound(d1db as never, aliceScope!, runAId, {
			issue: 'ownership-regression',
			round: 'diagnosis',
			outcome: 'started',
		});
		expect(round.paused).toBe(false);
		await runsService.recordVerification(d1db as never, aliceScope!, runAId, {
			check: 'ownership-regression',
			passed: true,
			evidence: 'bun test exit 0',
			planRevision: 'rev-1',
		});
		const snapshot = await runsService.runSnapshot(d1db as never, aliceScope!, runAId);
		expect(snapshot.verifications.some((v) => v.check === 'ownership-regression')).toBe(true);
	});
});

// ---- bounded revision cache -----------------------------------------------------

describe('P05 bounded currentRevisionCache', () => {
	test('evicts the least-recently-used entry beyond the bound', () => {
		const cache = new LruCache<string, string>(3);
		cache.set('r1', 'rev-1');
		cache.set('r2', 'rev-2');
		cache.set('r3', 'rev-3');
		expect(cache.get('r1')).toBe('rev-1'); // r1 is now most-recent
		cache.set('r4', 'rev-4'); // evicts r2 (least recently used), not r1
		expect(cache.has('r2')).toBe(false);
		expect(cache.has('r1')).toBe(true);
		expect(cache.has('r3')).toBe(true);
		expect(cache.has('r4')).toBe(true);
		expect(cache.size).toBe(3);
	});

	test('re-setting a key refreshes recency and never grows past the bound', () => {
		const cache = new LruCache<string, string>(2);
		cache.set('a', '1');
		cache.set('b', '2');
		cache.set('a', '1b'); // refresh a
		cache.set('c', '3'); // evicts b
		expect(cache.has('a')).toBe(true);
		expect(cache.get('a')).toBe('1b');
		expect(cache.has('b')).toBe(false);
		expect(cache.has('c')).toBe(true);
		cache.set('d', '4'); // the get('a') above refreshed it — c is now the LRU victim
		expect(cache.has('c')).toBe(false);
		expect(cache.has('a')).toBe(true);
		expect(cache.has('d')).toBe(true);
		expect(cache.size).toBe(2);
	});

	test('a get on a missing key does not evict anything', () => {
		const cache = new LruCache<string, string>(1);
		cache.set('a', '1');
		expect(cache.get('missing')).toBeUndefined();
		expect(cache.has('a')).toBe(true);
	});

	test('the production cache is bounded at 128 entries', () => {
		const cache = new LruCache<string, string>(128);
		for (let i = 0; i < 500; i++) cache.set(`run-${i}`, `rev-${i}`);
		expect(cache.size).toBe(128);
		// the OLDEST 372 runs were evicted; the newest survive
		expect(cache.has('run-0')).toBe(false);
		expect(cache.has('run-371')).toBe(false);
		expect(cache.has('run-372')).toBe(true);
		expect(cache.has('run-499')).toBe(true);
	});
});


test('Flue cancellation reaches specialist execution and QA verification', async () => {
  const controller = new AbortController();
  let executionSignal: AbortSignal | undefined;
  let verificationSignal: AbortSignal | undefined;
  const exec = makeSandboxExec({sessionId:'owned-session',runId:'owned-run',driver:{
    execute: async input => {executionSignal=input.signal; return {remoteId:'fixture'};},
    readFile: async () => '', writeFile: async () => {},
  }});
  const verify = makeVerifyBuild({verify: async (_key, signal) => {verificationSignal=signal; return {passed:false};}});
  type RawTool = {run(ctx:{data: Record<string,unknown>;toolCallId:string;signal:AbortSignal}):Promise<unknown>};
  await (exec as unknown as RawTool).run({data:{sessionId:'ignored',command:'bun test src',timeoutMs:1000},toolCallId:'exec-id',signal:controller.signal});
  await (verify as unknown as RawTool).run({data:{},toolCallId:'qa-id',signal:controller.signal});
  expect(executionSignal).toBe(controller.signal);
  expect(verificationSignal).toBe(controller.signal);
});

describe("plans use the app's built-in AI (plan 4.1)", () => {
	// Before plan 4.1 neither the coordinator nor the planners were told that a
	// built app's AI is Caddie's own c.env.CADDIE.ai(...).
	test('one rule names the platform AI and rules out Ollama, local models and AI keys', () => {
		for (const fact of ['c.env.CADDIE.ai(', 'NVIDIA Nemotron', 'Nebius Token Factory', 'no AI key']) expect(PLATFORM_AI_RULE).toContain(fact);
		for (const banned of ['Ollama', 'a local or self-hosted model', 'a third-party AI key']) expect(PLATFORM_AI_RULE).toContain(banned);
	});

	test('the planners and the coordinator (Home proposals and project PRDs alike) are given it', () => {
		expect(SPECIALIST_INSTRUCTIONS.product).toContain(PLATFORM_AI_RULE);
		expect(SPECIALIST_INSTRUCTIONS['tech-lead']).toContain(PLATFORM_AI_RULE);
		const coordinator = readFileSync(new URL('../apps/app/src/agents/coordinator.ts', import.meta.url), 'utf8');
		const shared = coordinator.indexOf('useInstruction(HACKATHON_IDEATION_INSTRUCTION);');
		const rule = coordinator.indexOf('useInstruction(PLATFORM_AI_RULE);');
		const homeOnly = coordinator.indexOf('Your final role is Home intake');
		expect(shared).toBeGreaterThan(0);
		// In the instructions every conversation gets, after the shared ones and before the Home/project split.
		expect(rule).toBeGreaterThan(shared);
		expect(rule).toBeLessThan(homeOnly);
	});
});
