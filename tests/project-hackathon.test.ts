import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { ensureHomeProject } from '../apps/app/src/server/projects.ts';
import { createRun } from '../apps/app/src/server/runs.ts';
import { findModelRouteForRole } from '../apps/app/src/agents/providers.ts';
import { acceptProposal, proposeProject } from '../apps/app/src/server/project-proposals.ts';
import { createLocalSeedAdapter, runDiscoveryFeed, seedCandidates } from '../apps/app/src/server/discovery.ts';
import { daysUntil, projectHackathon } from '../apps/app/src/server/project-hackathon.ts';
import { projectScopeForUser } from '../apps/app/src/server/scope.ts';

/**
 * The project page's hackathon chips (2026-10-15 redesign, Stage 2). LOCAL
 * VERIFIED over every real migration on SQLite. Bug it fixes: Start dropped
 * the proposal's hackathon, so the project page could not say which event a
 * project is for, how many days are left, or whether the user can enter.
 */
async function world() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys=ON');
	const dir = new URL('../apps/app/migrations/', import.meta.url);
	for (const name of readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()) {
		sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
	}
	const db = {
		prepare(sql: string) {
			const stmt = sqlite.prepare(sql);
			const bound = (args: never[]) => ({
				async all() { return { results: stmt.all(...args) }; },
				async run() { return stmt.run(...args); },
				async first() { return stmt.get(...args); },
			});
			return { bind: (...args: never[]) => bound(args), ...bound([] as never[]) };
		},
		async batch(statements: { run(): unknown }[]) { return Promise.all(statements.map((s) => s.run())); },
	} as unknown as D1Database;
	for (const user of ['alice', 'bob']) {
		sqlite.prepare('insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)')
			.run(user, user, `${user}@example.com`, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z');
	}
	const home = await ensureHomeProject(db, 'alice');
	const homeScope: Scope = { actorId: 'alice', workspaceId: home.workspaceId, projectId: home.id };
	const run = await createRun(db, homeScope, { modelRouteId: findModelRouteForRole('chat').id, payerId: 'alice' });
	async function startFrom(hackathon: { hackathonTitle?: string; hackathonUrl?: string; track?: string }) {
		const proposal = await proposeProject(db, homeScope, {
			name: 'FarmLog AI',
			idea: 'Records and early warnings for catfish and broiler farmers.',
			brief: 'Build FarmLog AI: a daily log with feed-conversion ratios and early-warning alerts.',
			...hackathon,
			sourceConversationId: run.conversationId,
		});
		const started = await acceptProposal(db, homeScope, proposal.id);
		return projectScopeForUser(db, 'alice', started.project.id);
	}
	return { sqlite, db, homeScope, startFrom };
}

const YEAR = new Date().getUTCFullYear() + 1;
const NOW = Date.parse(`${YEAR}-10-15T12:00:00Z`);
const NEBIUS = {
	hackathonTitle: 'Nebius x NVIDIA Global AI Hackathon',
	hackathonUrl: 'https://nebiusglobalaihackathon.devpost.com',
	track: 'Coding and Agentic Engineering Track',
};

describe('project hackathon (header chips)', () => {
	test('a project started from a proposal carries its hackathon, deadline and days left from the stored event', async () => {
		const w = await world();
		try {
			// Caddie found the event earlier: stored in the Home catalogue (note the trailing "/").
			await seedCandidates(w.db, [
				{ source: 'devpost', url: 'https://nebiusglobalaihackathon.devpost.com/', title: 'Nebius x NVIDIA Global AI Hackathon', summary: `By Nebius · Oct 01 - Oct 30, ${YEAR} · 23400 registered · Online` },
			]);
			await runDiscoveryFeed(w.db, w.homeScope, { adapters: [createLocalSeedAdapter(w.db, 'devpost')] });
			const scope = await w.startFrom(NEBIUS);
			const hackathon = await projectHackathon(w.db, scope, NOW);
			expect(hackathon).toEqual({
				title: 'Nebius x NVIDIA Global AI Hackathon',
				url: 'https://nebiusglobalaihackathon.devpost.com',
				track: 'Coding and Agentic Engineering Track',
				deadline: `${YEAR}-10-30`,
				daysLeft: 15,
				ended: false,
				// No official rules read in this world: the checked verdict is honestly unknown, never "eligible".
				eligibility: 'unknown',
			});
		} finally { w.sqlite.close(); }
	});

	test('an event Caddie never stored shows its title and link only: no guessed deadline or verdict', async () => {
		const w = await world();
		try {
			const scope = await w.startFrom(NEBIUS);
			const hackathon = await projectHackathon(w.db, scope, NOW);
			expect(hackathon).toMatchObject({ title: NEBIUS.hackathonTitle, url: NEBIUS.hackathonUrl, track: NEBIUS.track, deadline: null, daysLeft: null, eligibility: 'unknown' });
		} finally { w.sqlite.close(); }
	});

	test('a project with no hackathon gets no chips (null)', async () => {
		const w = await world();
		try {
			const scope = await w.startFrom({});
			expect(await projectHackathon(w.db, scope, NOW)).toBeNull();
		} finally { w.sqlite.close(); }
	});

	test('another user cannot read a project\'s hackathon', async () => {
		const w = await world();
		try {
			const scope = await w.startFrom(NEBIUS);
			await expect(projectHackathon(w.db, { ...scope, actorId: 'bob' }, NOW)).rejects.toThrow();
		} finally { w.sqlite.close(); }
	});
});

describe('daysUntil', () => {
	test('counts whole days to the end of the deadline day and marks a past deadline as ended', () => {
		expect(daysUntil(`${YEAR}-10-30`, NOW)).toEqual({ daysLeft: 15, ended: false });
		expect(daysUntil(`${YEAR}-10-15`, NOW)).toEqual({ daysLeft: 0, ended: false });
		expect(daysUntil(`${YEAR}-10-14`, NOW)).toEqual({ daysLeft: 0, ended: true });
	});
});
