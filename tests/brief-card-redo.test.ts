import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, expect } from 'bun:test';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { projectBrief, accountBrief } from '../apps/app/src/server/brief.ts';

/**
 * LOCAL VERIFIED — the Brief-card redo data sources (2026-10-22 lane rules),
 * on the real schema in in-memory SQLite (same wrap pattern as brief.test.ts).
 * Every assertion is paired with a mutation proof in its comment: the exact
 * server edit that makes the test fail, so the test is known to bite.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'apps', 'app', 'migrations');
const MIGRATION_PATHS = readdirSync(MIGRATIONS_DIR)
	.filter((name) => /^\d+_.*\.sql$/.test(name))
	.sort()
	.map((name) => join(MIGRATIONS_DIR, name));

function wrapSqliteAsD1(sqlite: Database): D1Database {
	return {
		prepare: (query: string) => {
			const stmt = sqlite.prepare(query);
			return {
				bind: (...values: unknown[]) => ({
					run: async () => stmt.run(...(values as never[])),
					all: async () => ({ results: stmt.all(...(values as never[])) as unknown[], meta: {} }),
				}),
				run: async () => stmt.run(),
				all: async () => ({ results: stmt.all() as unknown[], meta: {} }),
			};
		},
		batch: async (statements: unknown[]) => {
			const out: unknown[] = [];
			for (const statement of statements as { run(): unknown }[]) out.push(await statement.run());
			return out;
		},
		exec: async (query: string) => sqlite.exec(query),
	} as unknown as D1Database;
}

const ISO = '2026-10-05T00:00:00.000Z';

function makeWorld(): { db: D1Database; sqlite: Database; aliceScope: Scope } {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	for (const path of MIGRATION_PATHS) sqlite.exec(readFileSync(path, 'utf8'));
	sqlite.exec(`
		insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt") values
			('unit-alice','Unit Alice','unit-alice@example.com',0,'${ISO}','${ISO}');
		insert into "workspaces" ("id","name","createdAt") values ('unit-ws-a','Alice WS','${ISO}');
		insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt") values
			('unit-mem-a','unit-ws-a','unit-alice','owner','${ISO}');
		insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt") values
			('unit-proj-a','unit-ws-a','FarmLog AI','active','${ISO}','${ISO}');
	`);
	return { sqlite, db: wrapSqliteAsD1(sqlite), aliceScope: { actorId: 'unit-alice', workspaceId: 'unit-ws-a', projectId: 'unit-proj-a' } };
}

describe('live-build feature feed (step 3)', () => {
	function seedBuilding(sqlite: Database): void {
		sqlite.exec(`
			insert into "build_workflows" (projectId, runId, conversationId, intakeKey, brief, phase, detail, updatedAt)
			 values ('unit-proj-a','unit-run-b','unit-conv-b','unit-intake-b','Farm log.','building','Caddie is implementing your approved plan.','${ISO}');
			insert into "build_features" ("projectId","runId","planId","featureId","position","title","doneWhen","status","attempts","testsPassed","updatedAt") values
				('unit-proj-a','unit-run-b','plan-b','log',1,'Daily activity log','[]','passed',0,4,'2026-10-05T01:00:00.000Z'),
				('unit-proj-a','unit-run-b','plan-b','search',2,'Search and filters','[]','passed',0,6,'2026-10-05T01:00:00.000Z'),
				('unit-proj-a','unit-run-b','plan-b','offline',3,'Save and sync entries','[]','building',0,null,'2026-10-05T02:00:00.000Z'),
				('unit-proj-a','unit-run-b','plan-b','weekly',4,'Weekly summary','[]','pending',0,null,'${ISO}');
		`);
	}

	test('the build card carries each feature with its real state, the current feature, and the built count', async () => {
		const world = makeWorld();
		try {
			seedBuilding(world.sqlite);
			const cards = await projectBrief(world.db, world.aliceScope);
			const build = cards.find((card) => card.id.startsWith('brf_workflow_build_'));
			expect(build).toBeDefined();
			// Mutation proof: drop the `...(build ? {build} : {})` spread in
			// workflowCards and this is undefined.
			expect(build!.build).toBeDefined();
			expect(build!.build!.features).toEqual([
				{ title: 'Daily activity log', state: 'built' },
				{ title: 'Search and filters', state: 'built' },
				{ title: 'Save and sync entries', state: 'building' },
				{ title: 'Weekly summary', state: 'waiting' },
			]);
			// Mutation proof: change `state: 'building'` mapping to always 'built'
			// and `current` becomes undefined (no building row found).
			expect(build!.build!.current).toBe('Save and sync entries');
			// Mutation proof: count `!== 'waiting'` instead of `=== 'built'` and
			// this reads 3, not 2.
			expect(build!.build!.builtCount).toBe(2);
		} finally {
			world.sqlite.close();
		}
	});

	test('a build run with no feature rows carries no build field, so the card keeps its summary', async () => {
		const world = makeWorld();
		try {
			world.sqlite.exec(`insert into "build_workflows" (projectId, runId, conversationId, intakeKey, brief, phase, detail, updatedAt)
			 values ('unit-proj-a','unit-run-b','unit-conv-b','unit-intake-b','Farm log.','building','Caddie is implementing your approved plan.','${ISO}');`);
			const cards = await projectBrief(world.db, world.aliceScope);
			const build = cards.find((card) => card.id.startsWith('brf_workflow_build_'));
			expect(build).toBeDefined();
			expect(build!.build).toBeUndefined();
			expect(build!.summary).toMatch(/implementing/i);
		} finally {
			world.sqlite.close();
		}
	});

	test('the build card footer names the app', async () => {
		const world = makeWorld();
		try {
			seedBuilding(world.sqlite);
			const cards = await projectBrief(world.db, world.aliceScope);
			const build = cards.find((card) => card.id.startsWith('brf_workflow_build_'));
			// Mutation proof: return null from projectAppName and footer is undefined.
			expect(build!.footer).toEqual({ appName: 'FarmLog AI' });
		} finally {
			world.sqlite.close();
		}
	});
});

describe('opportunity fit split from the fit evaluator (step 7)', () => {
	// A saved candidate whose requirement is SUPPORTED by a real evidence claim
	// vs one with no claim (unknown). computeFit reads the same evidence the
	// discovery route does.
	function seedHome(sqlite: Database, withEvidence: boolean): void {
		sqlite.exec(`
			insert into "projects" ("id","workspaceId","name","kind","status","createdAt","updatedAt") values
				('unit-home','unit-ws-a','Home','home','active','${ISO}','${ISO}');
			insert into "discovery_feed_runs" ("id","projectId","requestedBy","requestedAt","candidateCount") values
				('unit-feed','unit-home','unit-alice','${ISO}',1);
			insert into "discovery_candidates" ("id","projectId","source","url","title","summary","requirementsJson","status","feedRunId","firstSeenAt","updatedAt") values
				('cand_fit','unit-home','local-seed','https://contest.example/fit','Farm Innovation Challenge','sample',
				 '[{"text":"Open to your region","claimType":"eligibility.region"},{"text":"A short demo video is required","claimType":"submission.video"}]',
				 'accepted','unit-feed','${ISO}','${ISO}');
		`);
		if (withEvidence) {
			sqlite.exec(`
				insert into "evidence_sources" ("id","projectId","canonicalUrl","kind","authority","displayName","lastOutcome","createdAt","updatedAt") values
					('src-r','unit-home','https://contest.example/rules','page','binding_rules','Rules','succeeded','${ISO}','${ISO}');
				insert into "evidence_snapshots" ("id","projectId","sourceId","contentHash","mediaType","byteLength","content","originalUrl","provenance","capturedAt","capturedBy") values
					('snap-r','unit-home','src-r','hash-r','text/html',10,'rules','https://contest.example/rules','original','${ISO}','unit-alice');
				insert into "evidence_claims" ("id","projectId","sourceId","snapshotId","claimType","value","quote","locator","extractionVersion","confidence","status","snapshotCapturedAt","createdAt") values
					('claim-region','unit-home','src-r','snap-r','eligibility.region','Open worldwide','Open worldwide','s1','p10-evidence-v1',null,'active','${ISO}','${ISO}');
			`);
		}
	}

	test('a supported requirement becomes a "Why it fits" reason; the rest become "Before you commit"', async () => {
		const world = makeWorld();
		try {
			seedHome(world.sqlite, true);
			const brief = await accountBrief(world.db, 'unit-alice');
			const opp = brief.cards.find((card) => card.headline.includes('Farm Innovation Challenge'));
			expect(opp).toBeDefined();
			expect(opp!.fit).toBeDefined();
			// The region requirement has a supporting claim → a reason.
			// Mutation proof: filter reasons on `!== 'supported'` and this is empty.
			expect(opp!.fit!.reasons.length).toBe(1);
			expect(opp!.fit!.reasons[0]).toContain('Open to your region');
			// The video requirement has no claim → a caution (unknown).
			// Mutation proof: filter cautions on `=== 'supported'` and this is empty.
			expect(opp!.fit!.cautions).toContain('A short demo video is required');
			expect(opp!.fit!.cautions).not.toContain('Open to your region');
		} finally {
			world.sqlite.close();
		}
	});

	test('with no supporting evidence, nothing becomes a reason — every requirement is a caution', async () => {
		const world = makeWorld();
		try {
			seedHome(world.sqlite, false);
			const brief = await accountBrief(world.db, 'unit-alice');
			const opp = brief.cards.find((card) => card.headline.includes('Farm Innovation Challenge'));
			expect(opp!.fit!.reasons).toEqual([]);
			expect(opp!.fit!.cautions.sort()).toEqual(['A short demo video is required', 'Open to your region']);
		} finally {
			world.sqlite.close();
		}
	});
});

describe('hackathon deadline card (step 6)', () => {
	// The project is for a hackathon (an accepted proposal) whose stored Home
	// listing carries a parseable date range; projectHackathon reads the
	// deadline from it, never from a schedule.
	function seedHackathon(sqlite: Database): void {
		sqlite.exec(`
			insert into "projects" ("id","workspaceId","name","kind","status","createdAt","updatedAt") values
				('unit-home','unit-ws-a','Home','home','active','${ISO}','${ISO}');
			insert into "discovery_feed_runs" ("id","projectId","requestedBy","requestedAt","candidateCount") values
				('feed-h','unit-home','unit-alice','${ISO}',1);
			insert into "discovery_candidates" ("id","projectId","source","url","title","summary","requirementsJson","status","feedRunId","firstSeenAt","updatedAt") values
				('cand-h','unit-home','local-seed','https://contest.example/fic','Farm Innovation Challenge','Oct 1, 2026 - Oct 23, 2026','[]','accepted','feed-h','${ISO}','${ISO}');
			insert into "project_proposals" ("id","actorId","workspaceId","homeProjectId","sourceConversationId","name","idea","brief","hackathonTitle","hackathonUrl","status","projectId","createdAt","updatedAt") values
				('prop-h','unit-alice','unit-ws-a','unit-home','conv-h','Farm log','idea','brief','Farm Innovation Challenge','https://contest.example/fic','accepted','unit-proj-a','${ISO}','${ISO}');
		`);
	}

	test('the deadline card reads the real hackathon deadline (days left + local-time line), not a schedule', async () => {
		const world = makeWorld();
		try {
			seedHackathon(world.sqlite);
			const cards = await projectBrief(world.db, world.aliceScope);
			const deadline = cards.find((card) => card.id.startsWith('brf_hackathon-deadline_'));
			expect(deadline).toBeDefined();
			expect(deadline!.kind).toBe('deadline');
			// Mutation proof: return [] from hackathonDeadlineCard and this card is
			// absent entirely.
			expect(deadline!.deadline).toBeDefined();
			expect(typeof deadline!.deadline!.daysLeft).toBe('number');
			// The source is the hackathon title, never a schedule name.
			expect(deadline!.deadline!.source).toBe('Farm Innovation Challenge');
			// Mutation proof: drop the localTimeLabel spread and this is undefined.
			expect(deadline!.deadline!.localTimeLabel).toBeDefined();
			// It carries NO schedule field (it is a hackathon, not a schedule).
			expect(deadline!.schedule).toBeUndefined();
		} finally {
			world.sqlite.close();
		}
	});

	test('a project with no hackathon deadline produces no hackathon deadline card', async () => {
		const world = makeWorld();
		try {
			const cards = await projectBrief(world.db, world.aliceScope);
			expect(cards.find((card) => card.id.startsWith('brf_hackathon-deadline_'))).toBeUndefined();
		} finally {
			world.sqlite.close();
		}
	});
});

describe('pending plan card: next step + footer (steps 1-2)', () => {
	function seedPendingPlan(sqlite: Database): void {
		sqlite.exec(`
			insert into "plan_doc_revisions" ("id","projectId","kind","revision","bodyHash","body","createdBy","createdAt") values
				('rev-2','unit-proj-a','prd',2,'hash-rev-2','Daily records plan.','unit-alice','${ISO}');
			insert into "approvals" ("id","projectId","action","resourceId","revisionHash","policyVersion","intentHash","decidedBy","status","expiresAt","createdAt","decidedAt") values
				('ap-live','unit-proj-a','design','rev-2','hash-r2','v1','intent-live',null,'pending','2999-01-01T00:00:00.000Z','${ISO}',null);
		`);
	}

	test('a pending design approval carries the fixed next-step line and a footer of app · Plan v<revision>', async () => {
		const world = makeWorld();
		try {
			seedPendingPlan(world.sqlite);
			const cards = await projectBrief(world.db, world.aliceScope);
			const plan = cards.find((card) => card.kind === 'approval' && card.status === 'needs-you');
			expect(plan).toBeDefined();
			// Mutation proof: delete the `card.nextStep = ...` assignment and this is undefined.
			expect(plan!.nextStep).toBe('Approve this scope and I’ll prepare the design for your review.');
			// Mutation proof: drop the footer assignment and this is undefined;
			// use the wrong revision field and the version is not "Plan v2".
			expect(plan!.footer).toEqual({ appName: 'FarmLog AI', version: 'Plan v2' });
		} finally {
			world.sqlite.close();
		}
	});

	test('a decided (handled) approval carries no next-step line', async () => {
		const world = makeWorld();
		try {
			world.sqlite.exec(`
				insert into "plan_doc_revisions" ("id","projectId","kind","revision","bodyHash","body","createdBy","createdAt") values
					('rev-3','unit-proj-a','prd',3,'hash-rev-3','Plan.','unit-alice','${ISO}');
				insert into "approvals" ("id","projectId","action","resourceId","revisionHash","policyVersion","intentHash","decidedBy","status","expiresAt","createdAt","decidedAt") values
					('ap-done','unit-proj-a','design','rev-3','hash-r3','v1','intent-done','unit-alice','approved','2999-01-01T00:00:00.000Z','${ISO}','${ISO}');
			`);
			const cards = await projectBrief(world.db, world.aliceScope);
			const plan = cards.find((card) => card.kind === 'approval');
			expect(plan).toBeDefined();
			expect(plan!.nextStep).toBeUndefined();
		} finally {
			world.sqlite.close();
		}
	});
});

describe('repair card: body from detail + fixed expectation panel (step 2)', () => {
	// A repairing card: the build is live (phase 'building') and the latest
	// round for the run FAILED. The failed round carries its own `detail`
	// sentence AND an `issue` of the form "<featureId>:<check>" — the two must
	// both reach the card as DISTINCT texts: the body from `detail`, the panel
	// from the check's fixed expectation. Never the same sentence twice.
	function seedRepair(sqlite: Database, issue: string, detail: string): void {
		sqlite.exec(`
			insert into "build_workflows" (projectId, runId, conversationId, intakeKey, brief, phase, detail, updatedAt)
			 values ('unit-proj-a','unit-run-r','unit-conv-r','unit-intake-r','Farm log.','building','Caddie is implementing your approved plan.','${ISO}');
			insert into "build_features" ("projectId","runId","planId","featureId","position","title","doneWhen","status","attempts","testsPassed","updatedAt") values
				('unit-proj-a','unit-run-r','plan-r','log',1,'Daily activity log','[]','passed',0,4,'${ISO}'),
				('unit-proj-a','unit-run-r','plan-r','offline',2,'Save and sync entries','[]','building',0,null,'${ISO}');
			insert into "run_rounds" ("id","runId","projectId","issue","round","outcome","detail","createdAt") values
				('round-r','unit-run-r','unit-proj-a','${issue}','repair_attempt','failed','${detail}','2026-10-05T03:00:00.000Z');
		`);
	}

	test('a round whose detail and issue differ shows BOTH texts, and no line appears twice', async () => {
		const world = makeWorld();
		try {
			const detail = 'An offline entry did not survive reopening the app.';
			// issue check "contract-read" → the fixed "Save something, restart…" expectation.
			seedRepair(world.sqlite, 'offline:contract-read', detail);
			const cards = await projectBrief(world.db, world.aliceScope);
			const repair = cards.find((card) => card.id.startsWith('brf_workflow_repair_'));
			expect(repair).toBeDefined();
			// The body carries the round's own `detail` plus the fixed line.
			// Mutation proof: drop the `summary = <detail> + …` branch and the
			// summary falls back to plainCheck, so this toContain fails.
			expect(repair!.summary).toBe(`${detail} I found it before handing the preview to you.`);
			// The panel is the FIXED expectation for the check, NOT the detail.
			// Mutation proof: drop the `repair` field assignment and this is undefined.
			expect(repair!.repair).toEqual({ expectation: 'Save something, restart the app, and it must still be there.' });
			// No line appears twice: the panel expectation is not the body, and
			// the body does not contain the expectation.
			expect(repair!.repair!.expectation).not.toBe(repair!.summary);
			expect(repair!.summary).not.toContain(repair!.repair!.expectation);
		} finally {
			world.sqlite.close();
		}
	});

	test('an unknown check keeps the plain summary and shows no panel', async () => {
		const world = makeWorld();
		try {
			seedRepair(world.sqlite, 'offline:mystery-check', 'A detail that should be ignored for an unknown check.');
			const cards = await projectBrief(world.db, world.aliceScope);
			const repair = cards.find((card) => card.id.startsWith('brf_workflow_repair_'));
			expect(repair).toBeDefined();
			// Mutation proof: make the check map return a default for unknown
			// checks and `repair` becomes defined, failing this.
			expect(repair!.repair).toBeUndefined();
			// The summary keeps the plain fallback (plainCheck), not the detail body.
			expect(repair!.summary).not.toContain('I found it before handing the preview to you.');
		} finally {
			world.sqlite.close();
		}
	});
});
