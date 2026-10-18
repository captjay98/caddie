import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { decideDesign, decideWorkflow, readWorkflow, startProjectFromChat, storeBuildOutput, workflowSnapshot } from '../apps/app/src/server/build-workflow.ts';
import { LocalCodeStore, listCodeVersions, readVersionFiles, recordCodeVersion } from '../apps/app/src/server/code-versions.ts';
import { createPlanDocRevision, ensureHomeProject } from '../apps/app/src/server/projects.ts';
import { createVersionsRouter } from '../apps/app/src/server/routes/versions.ts';
import { createRun } from '../apps/app/src/server/runs.ts';
import { ScopeError, projectScopeForUser } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * Versions and Restore. LOCAL VERIFIED in-process: the router, the real
 * migrations over SQLite and the local (D1) code store. Each "checked build"
 * here is a real stored output plus the version verify_build records for it
 * (verify_build's own recording is covered in build-workflow.test.ts).
 */

const f = (path: string, text: string) => ({ path, contentBase64: Buffer.from(text, 'utf8').toString('base64') });

describe('versions and restore', () => {
	let sqlite: Database;
	let db: D1Database;
	let store: LocalCodeStore;
	let scope: Scope;
	let planId = '';
	let runId = '';

	const router = createVersionsRouter({
		scopeFor: async (env, request, id) => {
			const user = request.headers.get('x-test-user');
			if (!user) throw new ScopeError(401, 'unauthenticated', 'a verified session is required');
			return projectScopeForUser(env.DB, user, id);
		},
		storeFor: () => store,
	});
	const call = (path: string, init: RequestInit & { user?: string } = {}) =>
		router.request(path, { ...init, headers: { 'x-test-user': init.user ?? 'alice', 'content-type': 'application/json', ...(init.headers ?? {}) } }, { DB: db } as never);

	/** A checked build: the stored output and the version verify_build records for it. */
	async function checkedBuild(image: string, files: ReturnType<typeof f>[], title: string): Promise<{ outputId: string; commitId: string }> {
		sqlite.prepare('update build_workflows set phase = ? where projectId = ?').run('building', scope.projectId);
		const output = await storeBuildOutput(db, scope, { html: `<!doctype html><html><body>${title}</body></html>`, image, planId, runId, bundle: { server: null, migrations: [], client: { js: title, css: '' } } });
		const { version } = await recordCodeVersion(db, store, scope, { kind: 'build', title, files, planId, image, outputId: output.outputId, actorId: 'alice' });
		return { outputId: output.outputId, commitId: version.commitId };
	}

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		store = new LocalCodeStore(db);
		addUser(sqlite, 'alice', 'alice@example.com');
		addUser(sqlite, 'bob', 'bob@example.com');
		const home = await ensureHomeProject(db, 'alice');
		const homeScope = await projectScopeForUser(db, 'alice', home.id);
		const homeRun = await createRun(db, homeScope, { modelRouteId: 'nemotron-3-super', payerId: 'alice', conversationId: 'conv-home' });
		const started = await startProjectFromChat(db, homeScope, { name: 'Farm Log', description: 'x', brief: 'Build a farm log. Show me the plan first.', operationKey: 'create-farm', sourceConversationId: homeRun.conversationId });
		scope = await projectScopeForUser(db, 'alice', started.project.id);
		runId = started.workflow.runId as string;
		const plan = await createPlanDocRevision(db, scope, { kind: 'prd', body: '# Farm log\n\nLog feed.' });
		planId = plan.id;
		await workflowSnapshot(db, scope);
		await decideWorkflow(db, scope, { planId, decision: 'approved' });
		const design = await createPlanDocRevision(db, scope, { kind: 'design', body: '# Design\n\nOne screen.' });
		await workflowSnapshot(db, scope);
		await decideDesign(db, scope, { designId: design.id, decision: 'approved' });
	});

	afterEach(() => sqlite.close());

	test('the list shows every checked version newest first, marks the current one, and offers Restore for the others', async () => {
		const v1 = await checkedBuild('img-1', [f('src/App.tsx', 'one')], 'Log daily feed');
		const v2 = await checkedBuild('img-2', [f('src/App.tsx', 'two'), f('src/Totals.tsx', 'totals')], 'Log daily feed, See totals');
		const res = await call(`/projects/${scope.projectId}/versions`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = (await res.json()) as { versions: Array<{ commitId: string; seq: number; current: boolean; restorable: boolean; title: string }>; blockedReason: string | null };
		expect(body.blockedReason).toBeNull();
		expect(body.versions.map((v) => [v.seq, v.title, v.current, v.restorable])).toEqual([
			[2, 'Log daily feed, See totals', true, false],
			[1, 'Log daily feed', false, true],
		]);
		expect(body.versions.map((v) => v.commitId)).toEqual([v2.commitId, v1.commitId]);
	});

	test('restoring makes the earlier version the app you try, as a new version, and the next build starts from it', async () => {
		const v1 = await checkedBuild('img-1', [f('src/App.tsx', 'one')], 'Log daily feed');
		await checkedBuild('img-2', [f('src/App.tsx', 'two')], 'Log daily feed, See totals');
		const res = await call(`/projects/${scope.projectId}/versions/${v1.commitId}/restore`, { method: 'POST', body: JSON.stringify({ key: 'restore-click-1' }) });
		expect(res.status).toBe(200);
		const workflow = await readWorkflow(db, scope);
		expect(workflow).toMatchObject({ phase: 'ready', previewId: v1.outputId });
		expect(workflow!.detail).toBe("Restored version 1. You're trying it below. Publish it to put it on the web.");
		expect(sqlite.prepare('select sessionKey, image, reason from build_sandbox_sessions').get()).toEqual({ sessionKey: `restore:${runId}:restore-click-1`, image: 'img-1', reason: `restore:${v1.commitId}` });

		// History only moves forward: version 3 holds version 1's files.
		const versions = await listCodeVersions(db, scope);
		expect(versions.map((v) => [v.seq, v.kind, v.title])).toEqual([
			[3, 'restore', 'Restored version 1'],
			[2, 'build', 'Log daily feed, See totals'],
			[1, 'build', 'Log daily feed'],
		]);
		expect(await readVersionFiles(store, scope.projectId, versions[0]!.commitId)).toEqual([f('src/App.tsx', 'one')]);

		// The same click again changes nothing.
		const again = await call(`/projects/${scope.projectId}/versions/${v1.commitId}/restore`, { method: 'POST', body: JSON.stringify({ key: 'restore-click-1' }) });
		expect(again.status).toBe(200);
		expect((await listCodeVersions(db, scope)).length).toBe(3);

		const list = (await (await call(`/projects/${scope.projectId}/versions`)).json()) as { versions: Array<{ seq: number; current: boolean }> };
		expect(list.versions.filter((v) => v.current).map((v) => v.seq)).toEqual([3]);
	});

	test('what cannot be restored says why', async () => {
		const v1 = await checkedBuild('img-1', [f('src/App.tsx', 'one')], 'Log daily feed');
		const current = await call(`/projects/${scope.projectId}/versions/${v1.commitId}/restore`, { method: 'POST', body: JSON.stringify({ key: 'restore-current' }) });
		expect(current.status).toBe(409);
		expect(await current.json()).toEqual({ error: 'ALREADY_CURRENT', message: "This is the version you're looking at." });

		const v2 = await checkedBuild('img-2', [f('src/App.tsx', 'two')], 'Second');
		sqlite.prepare('update build_workflows set phase = ? where projectId = ?').run('building', scope.projectId);
		const running = await call(`/projects/${scope.projectId}/versions/${v1.commitId}/restore`, { method: 'POST', body: JSON.stringify({ key: 'restore-running' }) });
		expect(running.status).toBe(409);
		expect(((await running.json()) as { error: string }).error).toBe('BUILD_RUNNING');
		expect(((await (await call(`/projects/${scope.projectId}/versions`)).json()) as { blockedReason: string }).blockedReason).toBe('Restoring waits until the current build finishes.');
		sqlite.prepare('update build_workflows set phase = ? where projectId = ?').run('ready', scope.projectId);

		// Without its working copy a version is still restorable: the build starts from its saved files.
		sqlite.prepare('update code_versions set image = null where commitId = ?').run(v1.commitId);
		const noCopy = await call(`/projects/${scope.projectId}/versions/${v1.commitId}/restore`, { method: 'POST', body: JSON.stringify({ key: 'restore-no-copy' }) });
		expect(noCopy.status).toBe(200);
		expect(sqlite.prepare('select image, reason from build_sandbox_sessions').get()).toEqual({ image: '', reason: `restore:${v1.commitId}` });

		// Without its checked preview it is not.
		sqlite.prepare('update build_workflows set previewId = ? where projectId = ?').run(v2.outputId, scope.projectId);
		sqlite.prepare('update code_versions set outputId = ? where commitId = ?').run('gone-output', v1.commitId);
		const noPreview = await call(`/projects/${scope.projectId}/versions/${v1.commitId}/restore`, { method: 'POST', body: JSON.stringify({ key: 'restore-no-preview' }) });
		expect(noPreview.status).toBe(409);
		expect(((await noPreview.json()) as { message: string }).message).toBe("This version can't be restored: its checked preview is no longer kept.");

		expect((await call(`/projects/${scope.projectId}/versions/${'0'.repeat(40)}/restore`, { method: 'POST', body: JSON.stringify({ key: 'restore-missing' }) })).status).toBe(404);
		expect((await call(`/projects/${scope.projectId}/versions/${v1.commitId}/restore`, { method: 'POST', body: JSON.stringify({ key: 'x' }) })).status).toBe(400);
	});

	test('only the owner restores; strangers cannot even list', async () => {
		const v1 = await checkedBuild('img-1', [f('src/App.tsx', 'one')], 'Log daily feed');
		await checkedBuild('img-2', [f('src/App.tsx', 'two')], 'Second');
		expect((await call(`/projects/${scope.projectId}/versions`, { user: 'bob' })).status).toBe(403);
		sqlite
			.prepare('insert into workspace_memberships (id, workspaceId, userId, role, createdAt) values (?,?,?,?,?)')
			.run('mem-bob', scope.workspaceId, 'bob', 'member', new Date().toISOString());
		expect((await call(`/projects/${scope.projectId}/versions`, { user: 'bob' })).status).toBe(200);
		const refused = await call(`/projects/${scope.projectId}/versions/${v1.commitId}/restore`, { method: 'POST', user: 'bob', body: JSON.stringify({ key: 'restore-by-bob' }) });
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe('not_project_owner');
	});
});
