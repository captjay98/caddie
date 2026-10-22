import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { createProject, createPlanDocRevision, createWorkspace } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser, workspaceScopeForUser, ScopeError } from '../apps/app/src/server/scope.ts';
import {
	decideDesign,
	decideWorkflow,
	ensureWorkflow,
	workflowSnapshot,
} from '../apps/app/src/server/build-workflow.ts';
import { getApprovedBlock } from '../apps/app/src/server/architecture-gate.ts';
import { recordArchitectureReview, architectureBlockHash } from '../apps/app/src/server/architecture-review.ts';
import { ARCHITECTURE_BLOCK_INFO, splitArchitectureBlock, type ArchitectureBlock } from '../packages/contracts/src/architecture.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * The design gate (plan part B — "The gate"): in TEAM MODE decideDesign refuses
 * approval while the design's caddie-architecture block is missing, fails the
 * rules, or has open security issues; on approval it stores
 * approvedDesignRevisionId and getApprovedBlock returns that revision's block.
 * With teamMode=0 the design gate behaves exactly as today. LOCAL VERIFIED.
 */

/** A minimal valid SMALL team-mode block (one private table, full CRUD). */
function validBlock(): ArchitectureBlock {
	const crud = (op: ArchitectureBlock['routes'][number]['op'], method: ArchitectureBlock['routes'][number]['method']) => ({
		id: `notes.${op}`,
		module: 'app',
		feature: 'notes',
		op,
		method,
		path: op === 'list' ? '/api/notes' : '/api/notes/:id',
		table: 'notes',
		plain: `${op} a note`,
		access: 'person' as const,
		request: op === 'create' || op === 'update' ? [{ name: 'body', type: 'text' as const, example: 'Buy feed' }] : [],
		response: ['id', 'body'],
	});
	return {
		version: 2,
		signIn: 'required',
		team: null,
		modules: [{ id: 'app', plain: 'The whole app', dependsOn: [] }],
		tables: [{ name: 'notes', module: 'app', plain: 'A note you wrote', owner: 'person', fields: [{ name: 'body', type: 'text', references: null }] }],
		routes: [crud('create', 'POST'), crud('read', 'GET'), crud('list', 'GET'), crud('update', 'PUT'), crud('delete', 'DELETE')],
		screens: [{ id: 'notes', module: 'app', path: '#/notes', plain: 'Your notes', shows: ['notes'] }],
		services: [],
		ai: [],
		payments: null,
		emails: [],
		jobs: [],
		screenOnly: [],
	};
}

const designBody = (block: ArchitectureBlock | null) =>
	block === null
		? '# Design brief\n\nScreens and states, but no architecture block.'
		: `# Design brief\n\nScreens and states.\n\n\`\`\`${ARCHITECTURE_BLOCK_INFO}\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;

const blockHashOf = (body: string) => architectureBlockHash(splitArchitectureBlock(body).raw ?? '');

describe('decideDesign team-mode architecture gate', () => {
	let sqlite: Database;
	let db: D1Database;
	let scope: Awaited<ReturnType<typeof projectScopeForUser>>;
	let projectId: string;

	/** Drive a project to design-review with the given design body, stamping team mode. */
	async function toDesignReview(body: string, teamEnv: Record<string, string>): Promise<{ designId: string }> {
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		const project = await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Notes', description: 'A notes app' });
		projectId = project.id;
		scope = await projectScopeForUser(db, 'owner-1', project.id);
		await ensureWorkflow(db, scope, teamEnv); // stamps teamMode
		const plan = await createPlanDocRevision(db, scope, { kind: 'prd', body: '# Notes\n\nAdd, see, change and delete notes.' });
		await workflowSnapshot(db, scope); // planning -> review
		await decideWorkflow(db, scope, { planId: plan.id, decision: 'approved' }); // review -> design
		const design = await createPlanDocRevision(db, scope, { kind: 'design', body });
		await workflowSnapshot(db, scope); // design -> design-review
		return { designId: design.id };
	}

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
	});
	afterEach(() => sqlite.close());

	test('team mode: approval is refused while the block is missing', async () => {
		const { designId } = await toDesignReview(designBody(null), { TEAM_MODE: 'on' });
		await expect(decideDesign(db, scope, { designId, decision: 'approved' })).rejects.toMatchObject({ code: 'ARCHITECTURE_UNSAFE' });
		// Still not building, and nothing bound.
		const snap = await workflowSnapshot(db, scope);
		expect(snap.workflow?.phase).toBe('design-review');
	});

	test('team mode: approval is refused while the block fails the deterministic rules', async () => {
		const bad = validBlock();
		bad.routes = bad.routes.filter((r) => r.op !== 'delete'); // private table missing delete
		const { designId } = await toDesignReview(designBody(bad), { TEAM_MODE: 'on' });
		await expect(decideDesign(db, scope, { designId, decision: 'approved' })).rejects.toMatchObject({ code: 'ARCHITECTURE_UNSAFE' });
	});

	test('team mode: approval is refused while a security issue is open, and lists its sentence', async () => {
		const body = designBody(validBlock());
		const { designId } = await toDesignReview(body, { TEAM_MODE: 'on' });
		// Record a security finding on the exact block the design carries.
		await recordArchitectureReview(db, projectId, {
			blockHash: blockHashOf(body),
			round: 1,
			issues: [{ severity: 'security', path: 'routes.0.access', message: 'Anyone could read another person\'s notes.' }],
		});
		await expect(decideDesign(db, scope, { designId, decision: 'approved' })).rejects.toMatchObject({ code: 'ARCHITECTURE_UNSAFE' });
		try {
			await decideDesign(db, scope, { designId, decision: 'approved' });
		} catch (error) {
			expect((error as ScopeError).message).toContain("Anyone could read another person's notes.");
		}
	});

	test('team mode: a design whose exact block was never reviewed is refused', async () => {
		const body = designBody(validBlock());
		const { designId } = await toDesignReview(body, { TEAM_MODE: 'on' });
		// A clean review of a DIFFERENT block (an earlier revision) does not count for this one.
		await recordArchitectureReview(db, projectId, { blockHash: architectureBlockHash('{"version":2,"other":true}'), issues: [] });
		let code = '';
		let message = '';
		try {
			await decideDesign(db, scope, { designId, decision: 'approved' });
		} catch (error) {
			code = (error as ScopeError).code;
			message = (error as ScopeError).message;
		}
		expect(code).toBe('ARCHITECTURE_UNSAFE');
		expect(message).toContain('has not run on this design');
		expect((await workflowSnapshot(db, scope)).workflow?.phase).toBe('design-review');
	});

	test('team mode: after two security rounds the reason is change-plan', async () => {
		const body = designBody(validBlock());
		const { designId } = await toDesignReview(body, { TEAM_MODE: 'on' });
		const blockHash = blockHashOf(body);
		await recordArchitectureReview(db, projectId, { blockHash, round: 1, issues: [{ severity: 'security', path: 'x', message: 'Not safe.' }] });
		await recordArchitectureReview(db, projectId, { blockHash, round: 2, issues: [{ severity: 'security', path: 'x', message: 'Still not safe.' }] });
		await expect(decideDesign(db, scope, { designId, decision: 'approved' })).rejects.toMatchObject({ code: 'ARCHITECTURE_CHANGE_PLAN' });
	});

	test('team mode: a clean review lets the design through, binds the revision, and getApprovedBlock reads it', async () => {
		const body = designBody(validBlock());
		const { designId } = await toDesignReview(body, { TEAM_MODE: 'on' });
		await recordArchitectureReview(db, projectId, { blockHash: blockHashOf(body), round: 1, issues: [] });
		const snapshot = await decideDesign(db, scope, { designId, decision: 'approved' });
		expect(snapshot.workflow?.phase).toBe('building');
		// The approved revision id is stored on the workflow.
		const stored = sqlite.prepare('select approvedDesignRevisionId from build_workflows where projectId = ?').get(projectId) as { approvedDesignRevisionId: string };
		expect(stored.approvedDesignRevisionId).toBe(designId);
		// getApprovedBlock returns that revision's block (for lanes E and P).
		const block = await getApprovedBlock(db, projectId);
		expect(block?.tables[0]?.name).toBe('notes');
	});

	test('team mode: an advisory-only review does not block approval', async () => {
		const body = designBody(validBlock());
		const { designId } = await toDesignReview(body, { TEAM_MODE: 'on' });
		await recordArchitectureReview(db, projectId, { blockHash: blockHashOf(body), round: 1, issues: [{ severity: 'advisory', path: 'screens.0', message: 'A search box would help.' }] });
		const snapshot = await decideDesign(db, scope, { designId, decision: 'approved' });
		expect(snapshot.workflow?.phase).toBe('building');
	});

	test('getApprovedBlock reads ONLY the approved revision (a later unapproved design does not leak)', async () => {
		const body = designBody(validBlock());
		const { designId } = await toDesignReview(body, { TEAM_MODE: 'on' });
		await recordArchitectureReview(db, projectId, { blockHash: blockHashOf(body), round: 1, issues: [] });
		await decideDesign(db, scope, { designId, decision: 'approved' });
		// A NEW design revision is written (not yet approved) with a different table name.
		const other = validBlock();
		other.tables[0]!.name = 'tasks';
		other.tables[0]!.plain = 'A task';
		other.routes = other.routes.map((r) => ({ ...r, table: 'tasks', id: r.id.replace('notes', 'tasks') }));
		other.screens[0]!.shows = ['tasks'];
		await createPlanDocRevision(db, scope, { kind: 'design', body: designBody(other) });
		// getApprovedBlock still returns the APPROVED revision's block, not the new one.
		const block = await getApprovedBlock(db, projectId);
		expect(block?.tables[0]?.name).toBe('notes');
	});
});

describe('teamMode=0: the design gate behaves exactly as today', () => {
	let sqlite: Database;
	let db: D1Database;

	beforeEach(() => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'owner-1', 'owner@example.com');
	});
	afterEach(() => sqlite.close());

	test('a design with NO architecture block and NO review still approves (no gate)', async () => {
		const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
		const project = await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Plain', description: 'A plain app' });
		const scope = await projectScopeForUser(db, 'owner-1', project.id);
		await ensureWorkflow(db, scope, { TEAM_MODE: 'off' });
		const plan = await createPlanDocRevision(db, scope, { kind: 'prd', body: '# Plain\n\nAdd and see items.' });
		await workflowSnapshot(db, scope);
		await decideWorkflow(db, scope, { planId: plan.id, decision: 'approved' });
		const design = await createPlanDocRevision(db, scope, { kind: 'design', body: '# Design brief\n\nTwo screens, no architecture block.' });
		await workflowSnapshot(db, scope);
		const snapshot = await decideDesign(db, scope, { designId: design.id, decision: 'approved' });
		expect(snapshot.workflow?.phase).toBe('building');
		// approvedDesignRevisionId is still stored (the binding is not team-mode gated).
		const stored = sqlite.prepare('select approvedDesignRevisionId from build_workflows where projectId = ?').get(project.id) as { approvedDesignRevisionId: string };
		expect(stored.approvedDesignRevisionId).toBe(design.id);
	});
});
