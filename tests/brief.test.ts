import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeParse } from 'valibot';
import type { Scope } from '@caddie/contracts';
import { DecisionCardSchema } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { projectBrief } from '../apps/app/src/server/brief.ts';

/**
 * UI review board phase 2 — the brief feed (unit level, in-memory SQLite on
 * the same DDL the workerd integration applies; the wrap pattern follows
 * tests/evidence.test.ts).
 *
 * Honest classification: LOCAL VERIFIED at the unit level — the service layer
 * over the real schema. The composed /api route is exercised by the browser
 * suite; nothing here is LIVE VERIFIED.
 *
 * The feed's contract with the UI: every card is derived from a real row,
 * ranked needs-you → changed → blocked → handled, and a foreign project's
 * rows can never leak into another actor's brief.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const MIGRATION_PATHS = [
	'0001_product.sql',
	'0002_controls.sql',
	'0003_artifacts.sql',
	'0004_evidence.sql',
	'0005_runs.sql',
	'0007_schedules.sql',
	'0009_discovery.sql',
	'0010_judge.sql',
	'0011_home_project.sql',
	'0012_brief_read.sql',
].map((name) => join(REPO_ROOT, 'apps', 'app', 'migrations', name));

function wrapSqliteAsD1(sqlite: Database): D1Database {
	return {
		prepare: (query: string) => {
			const stmt = sqlite.prepare(query);
			return {
				bind: (...values: unknown[]) => ({
					run: async () => stmt.run(...(values as never[])),
					all: async () => ({
						results: stmt.all(...(values as never[])) as unknown[],
						meta: {},
					}),
				}),
				run: async () => stmt.run(),
				all: async () => ({ results: stmt.all() as unknown[], meta: {} }),
			};
		},
		batch: async (statements: unknown[]) => {
			const out: unknown[] = [];
			for (const statement of statements as { run(): unknown }[]) {
				out.push(await statement.run());
			}
			return out;
		},
		exec: async (query: string) => sqlite.exec(query),
	} as unknown as D1Database;
}

const ISO = '2026-10-05T00:00:00.000Z';

interface World {
	db: D1Database;
	sqlite: Database;
	aliceScope: Scope;
	bobScope: Scope;
}

function makeWorld(): World {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	for (const path of MIGRATION_PATHS) sqlite.exec(readFileSync(path, 'utf8'));
	const seed = `
		insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt") values
			('unit-alice','Unit Alice','unit-alice@example.com',0,'${ISO}','${ISO}'),
			('unit-bob','Unit Bob','unit-bob@example.com',0,'${ISO}','${ISO}');
		insert into "workspaces" ("id","name","createdAt") values
			('unit-ws-a','Alice WS','${ISO}'),
			('unit-ws-b','Bob WS','${ISO}');
		insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt") values
			('unit-mem-a','unit-ws-a','unit-alice','owner','${ISO}'),
			('unit-mem-b','unit-ws-b','unit-bob','owner','${ISO}');
		insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt") values
			('unit-proj-a','unit-ws-a','Alice Project','active','${ISO}','${ISO}'),
			('unit-proj-b','unit-ws-b','Bob Project','active','${ISO}','${ISO}');
	`;
	sqlite.exec(seed);
	return {
		sqlite,
		db: wrapSqliteAsD1(sqlite),
		aliceScope: { actorId: 'unit-alice', workspaceId: 'unit-ws-a', projectId: 'unit-proj-a' },
		bobScope: { actorId: 'unit-bob', workspaceId: 'unit-ws-b', projectId: 'unit-proj-b' },
	};
}

function seedAliceState(sqlite: Database): void {
	sqlite.exec(`
		-- approvals: one live pending, one expired pending, one already decided
		insert into "approvals" ("id","projectId","action","resourceId","revisionHash","policyVersion","intentHash","decidedBy","status","expiresAt","createdAt","decidedAt") values
			('unit-ap-live','unit-proj-a','design','plan-r4','hash-r4','v1','intent-live',null,'pending','2999-01-01T00:00:00.000Z','2026-10-04T10:00:00.000Z',null),
			('unit-ap-expired','unit-proj-a','design','plan-r2','hash-r2','v1','intent-exp',null,'pending','2020-01-01T00:00:00.000Z','2026-10-01T10:00:00.000Z',null),
			('unit-ap-done','unit-proj-a','design','plan-r3','hash-r3','v1','intent-done','unit-alice','approved','2999-01-01T00:00:00.000Z','2026-10-02T10:00:00.000Z','2026-10-02T11:00:00.000Z');

		-- artifacts: content row first (FK), then one stale + one current revision
		insert into "artifact_content" ("contentHash","bytes","size","createdAt") values
			('hash-stale', x'00', 1, '${ISO}'),
			('hash-current', x'01', 1, '${ISO}');
		insert into "project_artifacts" ("id","projectId","kind","planRevision","sha256","size","contentType","filename","status","createdBy","createdAt") values
			('unit-art-stale','unit-proj-a','plan',2,'hash-stale',1,'text/markdown','plan-r2.md','stale','unit-alice','2026-10-03T10:00:00.000Z'),
			('unit-art-current','unit-proj-a','plan',4,'hash-current',1,'text/markdown','plan-r4.md','current','unit-alice','2026-10-04T10:00:00.000Z');

		-- failed repair rounds: two for one run (only the newest is a card), one for another
		insert into "run_rounds" ("id","runId","projectId","issue","round","outcome","detail","createdAt") values
			('unit-rr-1','unit-run-1','unit-proj-a','preview check failed','repair_attempt','failed',null,'2026-10-04T09:00:00.000Z'),
			('unit-rr-2','unit-run-1','unit-proj-a','preview check failed again','repair_attempt','failed',null,'2026-10-04T09:05:00.000Z'),
			('unit-rr-3','unit-run-2','unit-proj-a','build failed at step 7','repair_attempt','failed',null,'2026-10-04T08:00:00.000Z');

		-- schedules: one armed, one paused
		insert into "schedules" ("id","projectId","name","cron","timezone","nextRunAt","lastResult","lastResultAt","paused","payload","createdBy","createdAt","updatedAt") values
			('unit-sch-armed','unit-proj-a','Weekly discovery sweep','0 7 * * 1','Africa/Lagos','2026-10-06T07:00:00.000Z',null,null,0,'{}','unit-alice','${ISO}','${ISO}'),
			('unit-sch-paused','unit-proj-a','Rules re-read','*/6 * * * *','Africa/Lagos','2026-10-06T12:00:00.000Z',null,null,1,'{}','unit-alice','${ISO}','${ISO}');
	`);
}

function seedConflictEvidence(sqlite: Database): void {
	sqlite.exec(`
		insert into "evidence_sources" ("id","projectId","canonicalUrl","kind","authority","displayName","lastOutcome","createdAt","updatedAt") values
			('unit-src-1','unit-proj-a','https://rules.example/page','page','binding_rules','Rules page','succeeded','${ISO}','${ISO}'),
			('unit-src-2','unit-proj-a','https://organizer.example/mail','message','organizer_message','Organizer mail','succeeded','${ISO}','${ISO}');
		insert into "evidence_snapshots" ("id","projectId","sourceId","contentHash","mediaType","byteLength","content","originalUrl","provenance","capturedAt","capturedBy") values
			('unit-snap-1','unit-proj-a','unit-src-1','hash-snap-1','text/html',10,'rules body','https://rules.example/page','original','2026-10-04T12:00:00.000Z','unit-alice'),
			('unit-snap-2','unit-proj-a','unit-src-2','hash-snap-2','text/html',10,'mail body','https://organizer.example/mail','original','2026-10-04T13:00:00.000Z','unit-alice');
		insert into "evidence_claims" ("id","projectId","sourceId","snapshotId","claimType","value","quote","locator","extractionVersion","confidence","status","snapshotCapturedAt","createdAt") values
			('unit-claim-1','unit-proj-a','unit-src-1','unit-snap-1','deadline','14 Oct 23:59 UTC','14 Oct 23:59 UTC','section 2','p10-evidence-v1',null,'active','2026-10-04T12:00:00.000Z','2026-10-04T12:00:00.000Z'),
			('unit-claim-2','unit-proj-a','unit-src-2','unit-snap-2','deadline','12 Oct 23:59 UTC','12 Oct 23:59 UTC',null,'p10-evidence-v1',null,'active','2026-10-04T13:00:00.000Z','2026-10-04T13:00:00.000Z');
	`);
}

describe('brief feed (projectBrief)', () => {
	test('a live project produces ranked, contract-valid decision cards', async () => {
		const world = makeWorld();
		seedAliceState(world.sqlite);
		seedConflictEvidence(world.sqlite);
		const cards = await projectBrief(world.db, world.aliceScope);

		// Every card parses against the frozen DecisionCard contract.
		for (const card of cards) {
			const parsed = safeParse(DecisionCardSchema, card);
			expect(parsed.success).toBe(true);
		}

		const statuses = cards.map((card) => card.status);
		const rankOf = (status: string) =>
			({ 'needs-you': 0, changed: 1, blocked: 2, handled: 3 })[status] ?? 99;
		for (let i = 1; i < statuses.length; i++) {
			expect(rankOf(statuses[i]!)).toBeGreaterThanOrEqual(rankOf(statuses[i - 1]!));
		}

		// Pending approval → exactly one needs-you card (expired + decided stay out).
		const needsYou = cards.filter((card) => card.status === 'needs-you');
		expect(needsYou.length).toBe(1);
		expect(needsYou[0]!.kind).toBe('approval');
		expect(needsYou[0]!.summary).toContain('Approving this authorises');
		expect(needsYou[0]!.primaryAction).toEqual({
			label: 'Review the design',
			kind: 'review',
			targetId: 'unit-ap-live',
		});

		// Changed: one retained conflict + one stale artifact.
		const changed = cards.filter((card) => card.status === 'changed');
		expect(changed.length).toBe(2);
		const conflictCard = changed.find((card) => card.evidenceIds.length > 0);
		expect(conflictCard).toBeDefined();
		expect(conflictCard!.headline).toContain('deadline');
		expect(conflictCard!.headline).toContain('retained');
		expect([...conflictCard!.evidenceIds].sort()).toEqual(['unit-claim-1', 'unit-claim-2']);
		expect(conflictCard!.primaryAction).toEqual({
			label: 'Read the conflict',
			kind: 'inspect',
			targetId: 'deadline',
		});
		const staleCard = changed.find((card) => card.evidenceIds.length === 0);
		expect(staleCard!.headline).toContain('plan-r2.md');
		expect(staleCard!.primaryAction).toEqual({
			label: 'View the diff',
			kind: 'inspect',
			targetId: 'unit-art-stale',
		});

		// Blocked: newest failed round per run — two runs, two cards.
		const blocked = cards.filter((card) => card.status === 'blocked');
		expect(blocked.length).toBe(2);
		const run1 = blocked.find((card) => card.primaryAction.targetId === 'unit-run-1');
		expect(run1!.headline).toContain('preview check failed again');
		expect(blocked.every((card) => card.kind === 'result')).toBe(true);

		// Handled: armed schedules only.
		const handled = cards.filter((card) => card.status === 'handled');
		expect(handled.length).toBe(1);
		expect(handled[0]!.kind).toBe('deadline');
		expect(handled[0]!.headline).toContain('Weekly discovery sweep');
		expect(handled[0]!.primaryAction.targetId).toBe('unit-sch-armed');
	});

	test('an empty project yields an honest empty feed — no invented cards', async () => {
		const world = makeWorld();
		const cards = await projectBrief(world.db, world.aliceScope);
		expect(cards.length).toBe(0);
	});

	test('rows never cross projects, and a foreign actor cannot read the brief', async () => {
		const world = makeWorld();
		seedAliceState(world.sqlite);
		// Bob's own project sees nothing of Alice's state.
		const bobCards = await projectBrief(world.db, world.bobScope);
		expect(bobCards.length).toBe(0);

		// Bob's scope against Alice's project is refused at the boundary.
		await expect(
			projectBrief(world.db, { actorId: 'unit-bob', workspaceId: 'unit-ws-b', projectId: 'unit-proj-a' }),
		).rejects.toThrow();
	});
});
// --- ACCOUNT BRIEF (approved navigation 2026-10-09) ------------------------------

import { accountBrief, markBriefRead } from '../apps/app/src/server/brief.ts';
import type { AccountBriefPayload, DecisionCard as AccountCard } from '@caddie/contracts';

/** Alice's second build project + a Home project (account scope) with a
 *  saved discovery candidate, plus previews and a submission package. */
function seedAccountState(sqlite: Database): void {
	sqlite.exec(`
		insert into "projects" ("id","workspaceId","name","kind","status","createdAt","updatedAt") values
			('unit-proj-a2','unit-ws-a','Alice Project Two','standard','active','${ISO}','${ISO}'),
			('unit-home-a','unit-ws-a','Home','home','active','${ISO}','${ISO}');
		insert into "approvals" ("id","projectId","action","resourceId","revisionHash","policyVersion","intentHash","decidedBy","status","expiresAt","createdAt","decidedAt") values
			('unit-ap-a2','unit-proj-a2','feature-review','build-r1','hash-b1','v1','intent-a2',null,'pending','2999-01-01T00:00:00.000Z','2026-10-04T12:00:00.000Z',null);
		-- account scope: one saved candidate + one brand-new candidate
		insert into "discovery_feed_runs" ("id","projectId","requestedBy","requestedAt","candidateCount") values
			('unit-feed-a','unit-home-a','unit-alice','2026-10-04T14:00:00.000Z',1);
		insert into "discovery_candidates" ("id","projectId","source","url","title","summary","requirementsJson","status","feedRunId","firstSeenAt","updatedAt") values
			('cand_unit_saved','unit-home-a','local-seed','https://contest.example/solar','Solar Hackweek','Build a climate dashboard in a weekend.','[]','accepted','unit-feed-a','2026-10-04T14:00:00.000Z','2026-10-04T14:00:00.000Z'),
			('cand_unit_new','unit-home-a','local-seed','https://contest.example/other','Other Contest','Not saved yet.','[]','new','unit-feed-a','2026-10-04T14:00:00.000Z','2026-10-04T14:00:00.000Z');
		-- previews: one live, one revoked (never a card)
		insert into "preview_tokens" ("id","projectId","revisionId","tokenHash","createdBy","expiresAt","revokedAt","createdAt") values
			('unit-pvw-live','unit-proj-a','unit-art-current','hash-pvw-live','unit-alice','2999-01-01T00:00:00.000Z',null,'2026-10-04T15:00:00.000Z'),
			('unit-pvw-revoked','unit-proj-a','unit-art-current','hash-pvw-rev','unit-alice','2999-01-01T00:00:00.000Z','2026-10-04T16:00:00.000Z','2026-10-04T15:30:00.000Z');
		-- submission package with one unresolved checklist item
		insert into "submission_packages" ("id","projectId","title","descriptionJson","reuseRequired","reuseState","requirementsVersion","createdBy","createdAt") values
			('unit-pkg-1','unit-proj-a','Submission Package','{}',0,'unconfirmed','v1','unit-alice','2026-10-04T17:00:00.000Z');
		insert into "submission_checklist_items" ("id","packageId","projectId","kind","requirementText","citationClaimId","citationQuote","citationUrl","status","evidenceJson","createdAt") values
			('unit-item-1','unit-pkg-1','unit-proj-a','video','Demo video must be recorded','unit-claim-1','14 Oct 23:59 UTC','https://rules.example/page','missing','[]','2026-10-04T17:00:00.000Z');
	`);
}

describe('account brief (accountBrief)', () => {
	test('aggregates every authorised project, keyed and unseen, with project names', async () => {
		const world = makeWorld();
		seedAliceState(world.sqlite);
		seedConflictEvidence(world.sqlite);
		seedAccountState(world.sqlite);

		const brief: AccountBriefPayload = await accountBrief(world.db, 'unit-alice');

		// Every card parses against the extended contract and carries key+seen.
		for (const card of brief.cards) {
			const parsed = safeParse(DecisionCardSchema, card);
			expect(parsed.success).toBe(true);
			expect(typeof card.key).toBe('string');
			expect(card.seen).toBe(false);
		}

		// Cards from BOTH build projects plus the account-scope opportunity.
		const projectIds = new Set(brief.cards.map((card) => card.projectId));
		expect(projectIds.has('unit-proj-a')).toBe(true);
		expect(projectIds.has('unit-proj-a2')).toBe(true);
		expect(projectIds.has('unit-home-a')).toBe(true);

		// Project names travel for grouping UI.
		const names = new Map(brief.projects.map((p) => [p.id, p.name]));
		expect(names.get('unit-proj-a')).toBe('Alice Project');
		expect(names.get('unit-proj-a2')).toBe('Alice Project Two');
		expect(names.get('unit-home-a')).toBe('Home');

		// Needs-you first: the two live approvals AND the unresolved submission
		// rank above everything else (3 needs-you cards, newest first).
		const needsYou = brief.cards.filter((card) => card.status === 'needs-you');
		expect(needsYou.length).toBe(3);
		const approvalProjects = needsYou.filter((card) => card.kind === 'approval').map((card) => card.projectId).sort();
		expect(approvalProjects).toEqual(['unit-proj-a', 'unit-proj-a2']);
		expect(brief.cards[0]!.status).toBe('needs-you');
		expect(brief.unseenCount).toBe(brief.cards.length);
	});

	test('saved opportunities carry the local-seed limitation; previews and submissions surface honestly', async () => {
		const world = makeWorld();
		seedAliceState(world.sqlite);
		seedConflictEvidence(world.sqlite);
		seedAccountState(world.sqlite);

		const brief: AccountBriefPayload = await accountBrief(world.db, 'unit-alice');

		// Exactly ONE opportunity card — the saved candidate; the new one is not a card.
		const opportunities = brief.cards.filter((card) => card.primaryAction.kind === 'inspect' && card.projectId === 'unit-home-a');
		expect(opportunities.length).toBe(1);
		expect(opportunities[0]!.headline).toContain('Solar Hackweek');
		expect(opportunities[0]!.summary).toContain('local seed');
		expect(opportunities[0]!.summary).toContain('not connected yet');

		// The LIVE preview is a card; the revoked one is not.
		const previews = brief.cards.filter((card) => card.primaryAction.kind === 'preview');
		expect(previews.length).toBe(1);
		expect(previews[0]!.primaryAction.targetId).toBe('unit-pvw-live');

		// The unresolved submission package is a needs-you card; no package
		// exists for proj-a2, so no card is invented there.
		const submissions = brief.cards.filter((card) => card.primaryAction.label === 'Prepare submission');
		expect(submissions.length).toBe(1);
		expect(submissions[0]!.projectId).toBe('unit-proj-a');
		expect(submissions[0]!.status).toBe('needs-you');
		expect(submissions[0]!.primaryAction.targetId).toBe('unit-pkg-1');
	});

	test('read state is actor-scoped, idempotent, and never resolves the underlying work', async () => {
		const world = makeWorld();
		seedAliceState(world.sqlite);
		seedConflictEvidence(world.sqlite);
		seedAccountState(world.sqlite);

		const before = await accountBrief(world.db, 'unit-alice');
		const approvalCard = before.cards.find((card) => card.kind === 'approval' && card.projectId === 'unit-proj-a') as AccountCard;
		expect(approvalCard).toBeDefined();

		// Explicit action marks ONE card read; the approval row stays pending.
		await markBriefRead(world.db, 'unit-alice', [approvalCard.key!]);
		const after = await accountBrief(world.db, 'unit-alice');
		const reread = after.cards.find((card) => card.key === approvalCard.key)!;
		expect(reread.seen).toBe(true);
		expect(after.unseenCount).toBe(before.unseenCount - 1);

		// The underlying approval is untouched — projectBrief still demands it.
		const projectCards = await projectBrief(world.db, world.aliceScope);
		expect(projectCards.some((card) => card.kind === 'approval' && card.status === 'needs-you')).toBe(true);

		// Idempotent: marking again changes nothing.
		await markBriefRead(world.db, 'unit-alice', [approvalCard.key!]);
		const twice = await accountBrief(world.db, 'unit-alice');
		expect(twice.unseenCount).toBe(after.unseenCount);

		// Alice's read state never leaks to Bob: his own brief has no cards,
		// and a second actor's reads cannot be written by Bob (actor-scoped key).
		const bobBrief = await accountBrief(world.db, 'unit-bob');
		expect(bobBrief.unseenCount).toBe(0);
		await markBriefRead(world.db, 'unit-bob', [approvalCard.key!]);
		const aliceAgain = await accountBrief(world.db, 'unit-alice');
		expect(aliceAgain.cards.find((card) => card.key === approvalCard.key)!.seen).toBe(true);
	});
});
