import type { D1Database } from './auth.ts';
import { readBuildOutput, readPublishBundle, storeImportedOutput } from './build-workflow.ts';
import type { CodeStore } from './code-store.ts';
import { readVersionFiles, recordCodeVersion } from './code-versions.ts';
import { EXAMPLE_PREFIX } from './copied-app-origin.ts';
import { recordExamplePreview } from './import-preview.ts';
import { createGivenProject } from './projects.ts';
import { projectScopeForUser, ScopeError } from './scope.ts';

/**
 * S07b: a finished example in every judge's workspace, so a judge has a
 * working app to try in their first minute, before they start their own.
 *
 * At judge start, the owner's demo project (JUDGE_EXAMPLE_PROJECT_ID) is copied
 * into a new project in the judge's own workspace:
 *   - its newest CHECKED version's files become the example's version 1
 *     (recordCodeVersion), so asking Caddie for a change builds on that code;
 *   - that version's checked output (preview document, client files, server and
 *     migrations) is stored again for the example (storeImportedOutput; the
 *     content store dedupes, so no bytes are duplicated), so it is ready to try
 *     without running a build;
 *   - an import preview row, already ready, puts it on the project card.
 *
 * Nothing runs in a sandbox and no model is called, so seeding spends nothing.
 * The example is not one of the judge's own projects: it is left out of the
 * judge's project allowance (judge-limits.ts). It is best-effort: a judge
 * start never fails because of it, and a half-made example is removed.
 */

export type SeedJudgeExampleResult =
	| { status: 'seeded'; projectId: string; versionSeq: number }
	| {
			status: 'skipped';
			reason: 'not_configured' | 'demo_not_found' | 'no_checked_version' | 'not_publishable' | 'already_seeded';
	  };

export interface JudgeExampleDeps {
	db: D1Database;
	store: CodeStore;
	/** JUDGE_EXAMPLE_PROJECT_ID: the owner's demo project, by id. Unset means no example. */
	demoProjectId: string | undefined;
	now?: () => Date;
}

/** What the example's name shows in the judge's project list. */
export const exampleProjectName = (demoName: string) => `${demoName} (example)`;

/** What the planner reads about the example (projects.description). */
export const EXAMPLE_DESCRIPTION =
	'An example app Caddie built, copied into this workspace so it can be tried right away. Its code is version 1; Caddie builds on it when asked for changes.';

async function rows(db: D1Database, sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
	return ((await db.prepare(sql).bind(...params).all()).results ?? []) as Record<string, unknown>[];
}

const skipped = (reason: Extract<SeedJudgeExampleResult, { status: 'skipped' }>['reason']): SeedJudgeExampleResult => ({ status: 'skipped', reason });

/** True when the judge already has an example in one of their workspaces. */
async function hasExample(db: D1Database, userId: string): Promise<boolean> {
	const found = await rows(
		db,
		`select 1 as "x" from "import_previews" x
		 join "projects" p on p."id" = x."projectId"
		 join "workspace_memberships" m on m."workspaceId" = p."workspaceId"
		 where m."userId" = ? and x."repoFullName" like ? limit 1`,
		userId,
		`${EXAMPLE_PREFIX}%`,
	);
	return found.length > 0;
}

/** Remove a half-made example: its output rows first (no cascade), then the project (cascades the rest). */
async function removeExample(db: D1Database, projectId: string): Promise<void> {
	await db.prepare('delete from "workflow_outputs" where "projectId" = ?').bind(projectId).run();
	await db.prepare('delete from "projects" where "id" = ?').bind(projectId).run();
}

export async function seedJudgeExample(deps: JudgeExampleDeps, judgeUserId: string): Promise<SeedJudgeExampleResult> {
	const demoProjectId = deps.demoProjectId?.trim();
	if (!demoProjectId) return skipped('not_configured');
	const { db, store } = deps;

	// The demo is read as its own workspace's owner: naming it in
	// JUDGE_EXAMPLE_PROJECT_ID is the owner's consent to copy it.
	const owner = (
		await rows(
			db,
			`select m."userId" as "userId", p."name" as "name" from "projects" p
			 join "workspace_memberships" m on m."workspaceId" = p."workspaceId"
			 where p."id" = ? and p."kind" = 'standard' and m."role" = 'owner'
			 order by m."createdAt" asc limit 1`,
			demoProjectId,
		)
	)[0];
	if (!owner) return skipped('demo_not_found');
	if (await hasExample(db, judgeUserId)) return skipped('already_seeded');

	const demoScope = await projectScopeForUser(db, String(owner['userId']), demoProjectId);
	const checked = (
		await rows(
			db,
			'select "commitId", "outputId" from "code_versions" where "projectId" = ? and "outputId" is not null order by "seq" desc limit 1',
			demoProjectId,
		)
	)[0];
	if (!checked) return skipped('no_checked_version');
	const outputId = String(checked['outputId']);
	let bundle: Awaited<ReturnType<typeof readPublishBundle>>;
	try {
		bundle = await readPublishBundle(db, demoScope, outputId);
	} catch (error) {
		// Checked before client files were kept: there is nothing complete to copy.
		if (error instanceof ScopeError && error.code === 'REBUILD_TO_PUBLISH') return skipped('not_publishable');
		throw error;
	}
	const html = new TextDecoder().decode(await readBuildOutput(db, demoScope, outputId));
	const image = String((await rows(db, 'select "image" from "workflow_outputs" where "id" = ? and "projectId" = ?', outputId, demoProjectId))[0]?.['image'] ?? '');
	const files = await readVersionFiles(store, demoProjectId, String(checked['commitId']));
	const name = String(owner['name']);

	const project = await createGivenProject(db, judgeUserId, { name: exampleProjectName(name), description: EXAMPLE_DESCRIPTION });
	try {
		const scope = await projectScopeForUser(db, judgeUserId, project.id);
		const { version } = await recordCodeVersion(db, store, scope, {
			kind: 'import',
			title: `Example app: ${name}`,
			files,
			skipped: [],
			actorId: judgeUserId,
		});
		const output = await storeImportedOutput(db, scope, {
			html,
			image,
			commitId: version.commitId,
			bundle: {
				server: bundle.server,
				migrations: bundle.migrations.map((migration) => ({ name: migration.name, sql: migration.sql })),
				client: { js: bundle.js, css: bundle.css },
			},
		});
		// The example's version 1 has its checked preview, like a copied app once it is built.
		await db
			.prepare('update "code_versions" set "outputId" = ? where "projectId" = ? and "commitId" = ?')
			.bind(output.outputId, project.id, version.commitId)
			.run();
		await recordExamplePreview(
			db,
			scope,
			{ commitId: version.commitId, versionSeq: version.seq, name, outputId: output.outputId, hasServer: bundle.server !== null },
			deps.now?.() ?? new Date(),
		);
		return { status: 'seeded', projectId: project.id, versionSeq: version.seq };
	} catch (error) {
		await removeExample(db, project.id).catch(() => undefined);
		throw error;
	}
}
