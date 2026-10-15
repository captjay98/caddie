import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { ensureHomeProject } from '../apps/app/src/server/projects.ts';
import { createRun } from '../apps/app/src/server/runs.ts';
import { findModelRouteForRole } from '../apps/app/src/agents/providers.ts';
import { acceptProposal, dismissProposal, getProposal, proposeProject } from '../apps/app/src/server/project-proposals.ts';

/**
 * Caddie proposes, the user creates. LOCAL VERIFIED against every real
 * migration over SQLite: a proposal is only a row; the project, run and
 * planning intake exist only after acceptProposal (the "Start this project"
 * route), and "Keep refining" creates nothing.
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
			return {
				bind(...args: never[]) {
					return {
						async all() { return { results: stmt.all(...args) }; },
						async run() { return stmt.run(...args); },
						async first() { return stmt.get(...args); },
					};
				},
			};
		},
		async batch(statements: { run(): unknown }[]) { return Promise.all(statements.map((s) => s.run())); },
	} as unknown as D1Database;
	for (const user of ['alice', 'bob']) {
		sqlite.prepare('insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)')
			.run(user, user, `${user}@example.com`, '2026-10-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z');
	}
	const home = await ensureHomeProject(db, 'alice');
	const scope: Scope = { actorId: 'alice', workspaceId: home.workspaceId, projectId: home.id };
	const run = await createRun(db, scope, { modelRouteId: findModelRouteForRole('chat').id, payerId: 'alice' });
	const projectCount = () => Number((sqlite.prepare("select count(*) as n from projects where kind = 'standard'").get() as { n: number }).n);
	const workflowCount = () => Number((sqlite.prepare('select count(*) as n from build_workflows').get() as { n: number }).n);
	return { sqlite, db, scope, conversationId: run.conversationId, projectCount, workflowCount };
}

const IDEA = {
	name: 'HerdWatch',
	idea: 'A voice-first early-warning helper for smallholder livestock farmers in Nigeria.',
	brief: 'Build HerdWatch: farmers send a voice note about a sick animal and get advice back in Hausa.',
	hackathonTitle: 'Nebius x NVIDIA Global AI Hackathon',
	hackathonUrl: 'https://nebiusglobalaihackathon.devpost.com',
	track: 'Personal AI',
	firstStep: 'A voice note in, a spoken next step out — for one common illness.',
};

describe('project proposals: Caddie proposes, the user creates', () => {
	test('proposing stores a card and creates NO project, run or planning intake', async () => {
		const w = await world();
		try {
			const proposal = await proposeProject(w.db, w.scope, { ...IDEA, sourceConversationId: w.conversationId });
			expect(proposal.status).toBe('proposed');
			expect(proposal.projectId).toBeNull();
			expect(proposal.track).toBe('Personal AI');
			expect(w.projectCount()).toBe(0);
			expect(w.workflowCount()).toBe(0);
		} finally { w.sqlite.close(); }
	});

	test('"Keep refining" creates nothing; the user can still start it later', async () => {
		const w = await world();
		try {
			const proposal = await proposeProject(w.db, w.scope, { ...IDEA, sourceConversationId: w.conversationId });
			const dismissed = await dismissProposal(w.db, w.scope, proposal.id);
			expect(dismissed.status).toBe('dismissed');
			expect(w.projectCount()).toBe(0);
			expect(w.workflowCount()).toBe(0);
			const started = await acceptProposal(w.db, w.scope, proposal.id);
			expect(started.proposal.status).toBe('accepted');
			expect(w.projectCount()).toBe(1);
		} finally { w.sqlite.close(); }
	});

	test('"Start this project" creates exactly one project with a planning intake; a double click reuses it', async () => {
		const w = await world();
		try {
			const proposal = await proposeProject(w.db, w.scope, { ...IDEA, sourceConversationId: w.conversationId });
			const first = await acceptProposal(w.db, w.scope, proposal.id);
			expect(first.project.name).toBe('HerdWatch');
			expect(first.proposal.projectId).toBe(first.project.id);
			const workflow = w.sqlite.prepare('select phase, pendingKey, brief from build_workflows where projectId = ?').get(first.project.id) as { phase: string; pendingKey: string; brief: string };
			expect(workflow.phase).toBe('planning');
			expect(workflow.pendingKey).toStartWith('intake:');
			expect(workflow.brief).toContain('voice note');
			const again = await acceptProposal(w.db, w.scope, proposal.id);
			expect(again.project.id).toBe(first.project.id);
			expect(w.projectCount()).toBe(1);
			await expect(dismissProposal(w.db, w.scope, proposal.id)).rejects.toThrow('already been started');
		} finally { w.sqlite.close(); }
	});

	test('another user can neither read nor act on the proposal; bad input is refused', async () => {
		const w = await world();
		try {
			const proposal = await proposeProject(w.db, w.scope, { ...IDEA, sourceConversationId: w.conversationId });
			const bob: Scope = { ...w.scope, actorId: 'bob' };
			await expect(getProposal(w.db, bob, proposal.id)).rejects.toThrow();
			await expect(acceptProposal(w.db, bob, proposal.id)).rejects.toThrow();
			expect(w.projectCount()).toBe(0);
			await expect(proposeProject(w.db, w.scope, { ...IDEA, idea: '  ', sourceConversationId: w.conversationId })).rejects.toThrow('needs a name');
			await expect(proposeProject(w.db, w.scope, { ...IDEA, hackathonUrl: 'javascript:alert(1)', sourceConversationId: w.conversationId })).rejects.toThrow('http(s)');
		} finally { w.sqlite.close(); }
	});
});
