import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { SandboxError, type SandboxDriver } from './adapters/sandbox.ts';
import type { CodeStore } from './code-store.ts';
import { listCodeVersions, readVersionFiles } from './code-versions.ts';
import { buildSessionOverride, listBuildFeatures } from './build-features.ts';
import { recordBuildActivity } from './build-activity.ts';
import { readWorkflow } from './build-workflow.ts';
import { runVerifiedInstall } from './verified-install.ts';

/**
 * Working copies that are no longer kept (Publish programme stage 1).
 *
 * The sandbox keeps each build's working copy (an image) for a limited time.
 * When a build resumes and its working copy is gone, Caddie starts a new one
 * from the newest saved version of the code — after a Restore that is the
 * restored code, since Restore saves it as the newest version — and installs
 * the dependencies again (versions never keep them). Features whose code was
 * not in that version (they passed after it was saved, or were still being
 * built) go back to pending so the builder makes them again. With no saved
 * version at all the workspace starts empty and every feature is pending.
 *
 * Nothing here deletes a saved version or app data, and a flaky sandbox never
 * discards a working copy: only a definite "this image is gone" starts again.
 */

/** A working copy not touched for this long is checked before it is used. */
export const WORKING_COPY_RECHECK_MS = 60 * 60_000;

/** Override reasons while a new working copy is being filled, and once it is. */
const FILLING = 'seed:';
const FILLED = 'seeded:';
const CHANGE_FILLING = 'change-filling:';
const CHANGE_FILLED = 'change-restored:';

export interface WorkingCopyContext {
	db: D1Database;
	store: CodeStore;
	driver: Pick<SandboxDriver, 'workingCopyAvailable' | 'hasSession' | 'ensureSession' | 'uploadFiles' | 'execute' | 'listEntries' | 'removePath'>;
	scope: Scope;
	runId: string;
	/** The run's own session key. */
	sessionKey: string;
	/** The image every new working copy starts from (the sandbox base). */
	baseImage: string;
	/** The app's folder in the sandbox. */
	root: string;
	env: Record<string, string>;
}

const now = () => new Date().toISOString();

/** The timeline line when a project's first build starts from code copied from GitHub. */
export const IMPORT_NOTE = 'Started from your code on GitHub';

/** The plain line the build timeline shows for a new working copy. */
export function workingCopyNote(seq: number | null, rebuilt: number): string {
	if (seq === null) return 'Started again from your plan';
	return rebuilt > 0 ? `Continued from version ${seq}; ${rebuilt} feature${rebuilt === 1 ? '' : 's'} built again` : `Continued from version ${seq}`;
}

/**
 * Open the working copy the build continues in and return its session id.
 * When work was lost (features went back to pending) the call that finishes
 * the new working copy throws WORKING_COPY_REPLACED once, so the builder
 * re-reads the feature list instead of acting on files that are gone. When
 * nothing was lost the switch is invisible to the builder.
 */
export async function openWorkingCopy(ctx: WorkingCopyContext): Promise<string> {
	const { db, driver, scope, runId } = ctx;
	const override = await buildSessionOverride(db, scope.projectId, runId);
	if (override?.reason.startsWith(FILLING)) return fillWorkingCopy(ctx, override.sessionKey, override.reason);
	if (override?.reason.startsWith(CHANGE_FILLING)) return fillChangeWorkingCopy(ctx, override.sessionKey, override.reason);
	// The first build of a project that already has saved code (copied from
	// GitHub, repo-start.ts) starts from that code, not the empty template.
	if (!override && !(await driver.hasSession(ctx.sessionKey)) && (await listCodeVersions(db, scope, 1)).length > 0) {
		return startAgain(ctx, { fresh: true });
	}
	const target = { sessionKey: override?.sessionKey ?? ctx.sessionKey, image: override?.image ?? ctx.baseImage };
	if (await driver.workingCopyAvailable({ ...target, recheckAfterMs: WORKING_COPY_RECHECK_MS })) {
		return (await driver.ensureSession({ ...target, projectId: scope.projectId, runId })).sessionId;
	}
	if (override && (override.reason.startsWith('change:') || override.reason.startsWith(CHANGE_FILLED))) {
		return restoreChangeWorkingCopy(ctx, override);
	}
	return startAgain(ctx, { fresh: false });
}

/** Recover only the version bound to the preview the user reviewed. */
async function restoreChangeWorkingCopy(ctx: WorkingCopyContext, override: { sessionKey: string; reason: string }): Promise<string> {
	const { db, scope, runId } = ctx;
	const restored = override.reason.startsWith(CHANGE_FILLED);
	const parts = override.reason.slice(restored ? CHANGE_FILLED.length : 'change:'.length).split(':');
	const outputId = parts[0];
	const priorCommit = restored ? parts[1] : null;
	if (!outputId) throw new SandboxError(409, 'CHANGE_BASE_UNAVAILABLE', 'The checked workspace for this change is unavailable. Your previous preview is still here.');
	const found = await db.prepare('select commitId,seq from code_versions where projectId=? and outputId=? and (? is null or commitId=?) order by seq desc limit 1')
		.bind(scope.projectId, outputId, priorCommit, priorCommit).all<{ commitId: string; seq: number }>();
	const version = found.results[0];
	if (!version) throw new SandboxError(409, 'CHANGE_BASE_UNAVAILABLE', 'The checked workspace and its saved source are unavailable. Your previous preview is still here.');
	const sessionKey = `change-seed:${runId}:${crypto.randomUUID()}`;
	const reason = `${CHANGE_FILLING}${outputId}:${version.commitId}:${version.seq}`;
	const changed = await db.prepare('update build_sandbox_sessions set sessionKey=?,image=?,reason=?,updatedAt=? where projectId=? and runId=? and sessionKey=? and reason=?')
		.bind(sessionKey, ctx.baseImage, reason, now(), scope.projectId, runId, override.sessionKey, override.reason).run();
	if (Number((changed as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1)
		throw new SandboxError(409, 'CHANGE_BASE_MOVED', 'The change workspace moved. Try again.');
	return fillChangeWorkingCopy(ctx, sessionKey, reason);
}

/** Resume an interrupted exact-version restore without choosing a newer version. */
async function fillChangeWorkingCopy(ctx: WorkingCopyContext, sessionKey: string, reason: string): Promise<string> {
	const { db, driver, scope, runId } = ctx;
	const [outputId, commitId, seq] = reason.slice(CHANGE_FILLING.length).split(':');
	if (!outputId || !commitId || !seq) throw new SandboxError(409, 'CHANGE_BASE_UNAVAILABLE', 'The checked source could not be identified. Your previous preview is still here.');
	const version = (await db.prepare('select 1 from code_versions where projectId=? and outputId=? and commitId=?').bind(scope.projectId, outputId, commitId).all()).results[0];
	if (!version) throw new SandboxError(409, 'CHANGE_BASE_UNAVAILABLE', 'The checked source is no longer available. Your previous preview is still here.');
	const started = now();
	const { sessionId } = await driver.ensureSession({ sessionKey, image: ctx.baseImage, projectId: scope.projectId, runId });
	const files = await readVersionFiles(ctx.store, scope.projectId, commitId);
	if (files.length === 0) throw new SandboxError(409, 'CHANGE_BASE_UNAVAILABLE', 'The checked source is empty. Your previous preview is still here.');
	// The base runtime image is not an app snapshot. Remove its workspace
	// contents in this newly created session before restoring the exact source;
	// otherwise leftover base files could silently enter the changed app.
	for (const entry of await driver.listEntries(sessionId, ctx.root)) {
		if (!entry.name || entry.name === '.' || entry.name === '..' || /[/\\\x00-\x1f\x7f]/.test(entry.name))
			throw new SandboxError(409, 'CHANGE_BASE_UNAVAILABLE', 'The clean workspace could not be verified. Your previous preview is still here.');
		await driver.removePath(sessionId, `${ctx.root}/${entry.name}`, { recursive: true });
	}
	await driver.uploadFiles(sessionId, files.map(file => ({ path: `${ctx.root}/${file.path}`, contentBase64: file.contentBase64 })));
	const install = await runVerifiedInstall(driver, { sessionId, cwd: ctx.root, env: ctx.env, operationKey: `seed-install:${sessionKey}` });
	if (install.exitCode !== 0) throw new SandboxError(409, 'CHANGE_BASE_UNAVAILABLE', 'Caddie could not prepare the checked source. Your previous preview is still here.');
	const changed = await db.prepare('update build_sandbox_sessions set reason=?,updatedAt=? where projectId=? and runId=? and sessionKey=? and reason=?')
		.bind(`${CHANGE_FILLED}${outputId}:${commitId}:${seq}`, now(), scope.projectId, runId, sessionKey, reason).run();
	if (Number((changed as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1)
		throw new SandboxError(409, 'CHANGE_BASE_MOVED', 'The change workspace moved. Try again.');
	await recordBuildActivity(db, { projectId: scope.projectId, runId, kind: 'setup', subject: `Continued from version ${seq}`, outcome: 'ok', startedAt: started, finishedAt: now(), key: `setup:${sessionKey}` });
	return sessionId;
}

/** `fresh`: no working copy ever existed for this build, so nothing can have been lost. */
async function startAgain(ctx: WorkingCopyContext, options: { fresh: boolean }): Promise<string> {
	const { db, scope, runId } = ctx;
	const workflow = await readWorkflow(db, scope);
	const [version] = await listCodeVersions(db, scope, 1);
	// Features whose code went with the old working copy.
	const features = workflow?.planId && !options.fresh ? await listBuildFeatures(db, scope.projectId, workflow.planId) : [];
	const lost = features.filter((row) => row.status !== 'pending' && (!version || row.passedAt === null || row.passedAt > version.createdAt));
	const rebuilt = lost.filter((row) => row.status === 'passed').length;
	const stamp = now();
	const sessionKey = `seed:${runId}:${Date.now().toString(36)}`;
	const reason = `${FILLING}${version?.commitId ?? 'none'}:${version?.seq ?? 0}:${rebuilt}:${lost.length}:${version?.kind ?? 'none'}`;
	await db.batch([
		...lost.map((row) =>
			db
				.prepare('update "build_features" set "status" = \'pending\', "attempts" = 0, "testsPassed" = null, "checkpointRef" = null, "passedAt" = null, "updatedAt" = ? where "projectId" = ? and "planId" = ? and "featureId" = ?')
				.bind(stamp, row.projectId, row.planId, row.featureId),
		),
		// delete + insert, not ON CONFLICT: the local D1 emulator mishandles upserts (P08 note).
		db.prepare('delete from "build_sandbox_sessions" where "projectId" = ?').bind(scope.projectId),
		db
			.prepare('insert into "build_sandbox_sessions" ("projectId","runId","sessionKey","image","reason","updatedAt") values (?,?,?,?,?,?)')
			.bind(scope.projectId, runId, sessionKey, ctx.baseImage, reason, stamp),
	]);
	return fillWorkingCopy(ctx, sessionKey, reason);
}

/** Fill a new working copy from the saved version. Safe to repeat: an interrupted fill resumes on the next call. */
async function fillWorkingCopy(ctx: WorkingCopyContext, sessionKey: string, reason: string): Promise<string> {
	const { db, driver, scope, runId } = ctx;
	const [commitId = 'none', seqText = '0', rebuiltText = '0', lostText = '0', kind = 'build'] = reason.slice(FILLING.length).split(':');
	const seq = commitId === 'none' ? null : Number(seqText);
	const rebuilt = Number(rebuiltText);
	const started = now();
	const { sessionId } = await driver.ensureSession({ sessionKey, image: ctx.baseImage, projectId: scope.projectId, runId });
	let installed: boolean | null = null;
	if (commitId !== 'none') {
		const files = await readVersionFiles(ctx.store, scope.projectId, commitId);
		if (files.length > 0) {
			await driver.uploadFiles(sessionId, files.map((file) => ({ path: `${ctx.root}/${file.path}`, contentBase64: file.contentBase64 })));
		}
		// A failed install is not fatal: the code is right, and the next check installs again and reports.
		// THE verified install step: every pinned tarball is fetched, checked
		// against its sha512 in bun.lock and extracted before the frozen install.
		const install = await runVerifiedInstall(driver, {
			sessionId,
			cwd: ctx.root,
			env: ctx.env,
			operationKey: `seed-install:${sessionKey}`,
		});
		installed = install.exitCode === 0;
	}
	await db
		.prepare('update "build_sandbox_sessions" set "reason" = ?, "updatedAt" = ? where "projectId" = ? and "sessionKey" = ?')
		.bind(`${FILLED}${commitId}`, now(), scope.projectId, sessionKey)
		.run();
	await recordBuildActivity(db, {
		projectId: scope.projectId,
		runId,
		kind: 'setup',
		subject: kind === 'import' && rebuilt === 0 ? IMPORT_NOTE : workingCopyNote(seq, rebuilt),
		outcome: installed === false ? 'failed' : 'ok',
		startedAt: started,
		finishedAt: now(),
		key: `setup:${sessionKey}`,
	});
	if (Number(lostText) > 0) {
		throw new SandboxError(
			409,
			'WORKING_COPY_REPLACED',
			seq === null
				? "The app's earlier working copy was no longer kept and no checked version was saved, so the workspace starts empty again and every feature is pending. Call build_next_feature to start from the first feature."
				: `The app's earlier working copy was no longer kept, so the host started a new one from version ${seq}, the newest saved version. Features whose code was not in it are pending again. Call build_next_feature to see what to build next.`,
		);
	}
	return sessionId;
}
