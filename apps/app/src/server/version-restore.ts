import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { CodeStoreError, type CodeStore } from './code-store.ts';
import { getCodeVersion, listCodeVersions, readVersionFiles, recordCodeVersion, type CodeVersionView } from './code-versions.ts';
import { buildSessionOverride } from './build-features.ts';
import { readWorkflow, workflowSnapshot } from './build-workflow.ts';
import { ScopeError, assertProjectOwner, assertProjectScope } from './scope.ts';

/**
 * Versions and Restore (Publish programme stage 1). Every checked build is a
 * version in the project's code store (recorded by verify_build). Restore
 * makes an earlier version the app you try again: its code becomes a new
 * version at the top of the history (nothing is deleted), the next build step
 * starts from its working copy, and its checked preview is shown — so it can
 * be published in one click. App data is never touched.
 */

export interface VersionListItem extends CodeVersionView {
	/** The version shown in the project card right now. */
	current: boolean;
	/** Restore is offered: a checked build with its working copy, not the current one, while nothing runs. */
	restorable: boolean;
}

export interface VersionsView {
	versions: VersionListItem[];
	/** Why Restore is unavailable for every version right now (a build is running), or null. */
	blockedReason: string | null;
}

const now = () => new Date().toISOString();

async function outputExists(db: D1Database, projectId: string, outputId: string | null): Promise<boolean> {
	if (!outputId) return false;
	const rows = (await db.prepare('select 1 from "workflow_outputs" where "id" = ? and "projectId" = ?').bind(outputId, projectId).all()).results ?? [];
	return rows.length > 0;
}

export async function listVersions(db: D1Database, scope: Scope): Promise<VersionsView> {
	const verified = await assertProjectScope(db, scope);
	const workflow = await readWorkflow(db, verified);
	const idle = workflow?.phase === 'ready' || workflow?.phase === 'blocked';
	const currentOutput = workflow?.phase === 'ready' ? workflow.previewId : null;
	const versions = await listCodeVersions(db, verified, 30);
	// The newest version showing a given output is "current"; older duplicates are not.
	let currentMarked = false;
	const items: VersionListItem[] = [];
	for (const version of versions) {
		const current = !currentMarked && currentOutput !== null && version.outputId === currentOutput;
		if (current) currentMarked = true;
		const restorable = idle && !current && version.hasImage && (await outputExists(db, verified.projectId, version.outputId));
		items.push({ ...version, current, restorable });
	}
	return { versions: items, blockedReason: idle || !workflow ? null : 'Restoring waits until the current build finishes.' };
}

/**
 * Restore an earlier checked version. Owner-only, only while nothing runs,
 * idempotent on `key` (a repeated click restores once).
 */
export async function restoreVersion(db: D1Database, store: CodeStore, scope: Scope, input: { commitId: unknown; key: unknown }) {
	const verified = await assertProjectOwner(db, scope);
	if (typeof input.key !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(input.key)) {
		throw new ScopeError(400, 'invalid_restore_key', 'An idempotent restore key is required.');
	}
	if (typeof input.commitId !== 'string' || !/^[0-9a-f]{40}$/.test(input.commitId)) {
		throw new ScopeError(400, 'invalid_input', 'No such version.');
	}
	const workflow = await readWorkflow(db, verified);
	if (!workflow?.planId) throw new ScopeError(404, 'workflow_not_found', 'No build exists.');
	const sessionKey = `restore:${workflow.runId}:${input.key}`;
	const replay = await buildSessionOverride(db, verified.projectId, workflow.runId);
	if (replay?.sessionKey === sessionKey) return workflowSnapshot(db, verified);
	if (workflow.phase !== 'ready' && workflow.phase !== 'blocked') {
		throw new ScopeError(409, 'BUILD_RUNNING', 'Restoring waits until the current build finishes.');
	}

	let version: Awaited<ReturnType<typeof getCodeVersion>>;
	try {
		version = await getCodeVersion(db, verified, input.commitId);
	} catch (error) {
		if (error instanceof CodeStoreError && error.code === 'COMMIT_NOT_FOUND') throw new ScopeError(404, 'version_not_found', 'No such version.');
		throw error;
	}
	if (!version.image || !(await outputExists(db, verified.projectId, version.outputId))) {
		throw new ScopeError(409, 'VERSION_NOT_RESTORABLE', "This version can't be restored: its working copy is no longer kept.");
	}
	if (workflow.phase === 'ready' && workflow.previewId === version.outputId) {
		throw new ScopeError(409, 'ALREADY_CURRENT', "This is the version you're looking at.");
	}

	// The code history moves forward: the restored files become the newest version.
	const files = await readVersionFiles(store, verified.projectId, version.commitId);
	await recordCodeVersion(db, store, verified, {
		kind: 'restore',
		title: `Restored version ${version.seq}`,
		files,
		skipped: version.skipped,
		planId: version.planId,
		image: version.image,
		outputId: version.outputId,
		actorId: verified.actorId,
	});

	const stamp = now();
	const earlierPlan = version.planId !== null && version.planId !== workflow.planId;
	const detail = `Restored version ${version.seq}. You're trying it below${earlierPlan ? '; features added after it are not in this version' : ''}. Publish it to put it on the web.`;
	await db.batch([
		// delete + insert, not ON CONFLICT: the local D1 emulator mishandles upserts (P08 note).
		db.prepare('delete from "build_sandbox_sessions" where "projectId" = ?').bind(verified.projectId),
		db
			.prepare('insert into "build_sandbox_sessions" ("projectId","runId","sessionKey","image","reason","updatedAt") values (?,?,?,?,?,?)')
			.bind(verified.projectId, workflow.runId, sessionKey, version.image, `restore:${version.commitId}`, stamp),
		db
			.prepare("update build_workflows set phase = 'ready', previewId = ?, pendingKey = null, pendingBody = null, detail = ?, updatedAt = ? where projectId = ? and phase in ('ready','blocked')")
			.bind(version.outputId, detail, stamp, verified.projectId),
	]);
	return workflowSnapshot(db, verified);
}
