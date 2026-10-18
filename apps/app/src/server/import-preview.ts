import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { SandboxError, type SandboxDriver } from './adapters/sandbox.ts';
import { BUILD_RUNTIME_ENV, DEFAULT_BASE_IMAGE, buildSandboxFromEnv, type BuildSandboxEnv } from './build-sandbox.ts';
import { previewDocument, readBuiltApp } from './built-app.ts';
import { storeImportedOutput } from './build-workflow.ts';
import type { ArtifactsBinding } from './adapters/cloudflare-artifacts.ts';
import type { CodeStore } from './code-store.ts';
import { codeStoreFor } from './code-store-env.ts';
import { readVersionFiles } from './code-versions.ts';
import { checkServerStarts, type WorkerLoaderLike } from './preview-runtime.ts';
import { assertProjectScope, projectScopeForUser } from './scope.ts';
import { SCAFFOLD_COMMANDS } from '../../../../stacks/react-hono/scaffold.ts';

/**
 * "Start from my GitHub repo", the part the user sees first: right after the
 * copy (repo-start.ts), Caddie builds the copied app once — install and build
 * in a sandbox of its own, no AI — so the project card can show the app before
 * anything is planned. The result is an ordinary preview output tied to the
 * imported version, so Versions can go back to it later.
 *
 * The build runs in steps that are safe to repeat. Each sandbox command has a
 * fixed operation key, and the sandbox replays a finished command from its
 * receipt and never dispatches one twice, so a request that is cut off part
 * way loses nothing: the next call (the card, while it shows "checking", or
 * the 5-minute cron for a card nobody has open) carries on where it stopped.
 * A command still running elsewhere answers "busy", and the call just reports
 * "checking".
 */

export type ImportPreviewStatus = 'checking' | 'ready' | 'failed';

export interface ImportPreviewView {
	status: ImportPreviewStatus;
	versionSeq: number;
	repoFullName: string;
	/** The preview output, once ready. */
	outputId: string | null;
	/** The app has a server (its /api calls are relayed in the preview). */
	hasServer: boolean;
	/** Plain words for the card when it failed. */
	message: string | null;
}

export interface ImportPreviewDeps {
	db: D1Database;
	store: CodeStore;
	/** Null when the build sandbox is not configured. */
	driver: Pick<SandboxDriver, 'ensureSession' | 'uploadFiles' | 'execute' | 'reconcileOperation' | 'readFile' | 'pathExists' | 'listEntries' | 'checkpoint'> | null;
	/** The runs-on-Cloudflare check for apps with a server; skipped when absent, as in verify_build. */
	loader?: WorkerLoaderLike;
	baseImage: string;
	now?: () => Date;
}

/** A check still unfinished after this long is given up on, in plain words. */
export const IMPORT_PREVIEW_DEADLINE_MS = 30 * 60_000;
/** Unexplained sandbox errors tolerated before giving up (busy answers never count). */
const MAX_ERRORS = 3;

const saved = (seq: number) => `Your code is saved as version ${seq}. Tell Caddie what you'd like, and it fixes the build first.`;
export const IMPORT_PREVIEW_MESSAGES = {
	noSandbox: (seq: number) => `Caddie can't build apps right now, so there's nothing to try yet. Your code is saved as version ${seq}.`,
	buildFailed: (seq: number) => `Caddie couldn't build this app the way it was copied, so there's nothing to try yet. ${saved(seq)}`,
	serverFailed: (seq: number) => `This app's server doesn't start on Cloudflare, so there's nothing to try yet. ${saved(seq)}`,
	gaveUp: (seq: number) => `Caddie couldn't finish getting this app ready to try. ${saved(seq)}`,
};

interface Row {
	projectId: string;
	actorId: string;
	commitId: string;
	versionSeq: number;
	repoFullName: string;
	status: ImportPreviewStatus;
	outputId: string | null;
	hasServer: number;
	message: string | null;
	errors: number;
	createdAt: string;
}

async function loadRow(db: D1Database, projectId: string): Promise<Row | null> {
	const found = (await db.prepare('select * from "import_previews" where "projectId" = ?').bind(projectId).all()).results?.[0];
	return (found as unknown as Row | undefined) ?? null;
}

function view(row: Row): ImportPreviewView {
	return {
		status: row.status,
		versionSeq: Number(row.versionSeq),
		repoFullName: row.repoFullName,
		outputId: row.outputId,
		hasServer: Number(row.hasServer) === 1,
		message: row.message,
	};
}

/** Called once the copy became the project's first version: the card starts showing "checking". */
export async function beginImportPreview(
	db: D1Database,
	scope: Scope,
	input: { commitId: string; versionSeq: number; repoFullName: string },
	now: Date = new Date(),
): Promise<void> {
	const verified = await assertProjectScope(db, scope);
	const stamp = now.toISOString();
	// delete + insert, not ON CONFLICT: the local D1 emulator mishandles upserts (P08 note).
	await db.batch([
		db.prepare('delete from "import_previews" where "projectId" = ?').bind(verified.projectId),
		db
			.prepare(
				'insert into "import_previews" ("projectId","actorId","commitId","versionSeq","repoFullName","status","createdAt","updatedAt") values (?,?,?,?,?,\'checking\',?,?)',
			)
			.bind(verified.projectId, verified.actorId, input.commitId, input.versionSeq, input.repoFullName, stamp, stamp),
	]);
}

export async function readImportPreview(db: D1Database, scope: Scope): Promise<ImportPreviewView | null> {
	const verified = await assertProjectScope(db, scope);
	const row = await loadRow(db, verified.projectId);
	return row ? view(row) : null;
}

async function settle(
	db: D1Database,
	row: Row,
	result: { status: 'ready'; outputId: string; hasServer: boolean } | { status: 'failed'; message: string; detail?: string },
	now: Date,
): Promise<void> {
	const stamp = now.toISOString();
	if (result.status === 'ready') {
		await db
			.prepare('update "import_previews" set "status" = \'ready\', "outputId" = ?, "hasServer" = ?, "message" = null, "updatedAt" = ? where "projectId" = ? and "status" = \'checking\'')
			.bind(result.outputId, result.hasServer ? 1 : 0, stamp, row.projectId)
			.run();
	} else {
		await db
			.prepare('update "import_previews" set "status" = \'failed\', "message" = ?, "detail" = ?, "updatedAt" = ? where "projectId" = ? and "status" = \'checking\'')
			.bind(result.message, result.detail?.slice(-4000) ?? null, stamp, row.projectId)
			.run();
	}
}

/** Another call holds the sandbox, or the command is still running: try again later. */
function stillRunning(error: unknown): boolean {
	return error instanceof SandboxError && error.status === 409 && ['OPERATION_UNRESOLVED', 'SESSION_BUSY', 'AMBIGUOUS_DISPATCH'].includes(error.code);
}

const logTail = (result: { stdout: string; stderr: string }) => `${result.stdout}\n${result.stderr}`.slice(-4000);

/**
 * Carry the copied app's build as far as it goes now. Returns the card's view;
 * "checking" means a later call finishes it.
 */
export async function checkImportedApp(deps: ImportPreviewDeps, scope: Scope): Promise<ImportPreviewView | null> {
	const { db } = deps;
	const verified = await assertProjectScope(db, scope);
	const now = deps.now?.() ?? new Date();
	const row = await loadRow(db, verified.projectId);
	if (!row || row.status !== 'checking') return row ? view(row) : null;
	const seq = Number(row.versionSeq);
	const finish = async (result: Parameters<typeof settle>[2]) => {
		await settle(db, row, result, now);
		return view((await loadRow(db, row.projectId))!);
	};
	if (now.getTime() - Date.parse(row.createdAt) > IMPORT_PREVIEW_DEADLINE_MS) {
		return finish({ status: 'failed', message: IMPORT_PREVIEW_MESSAGES.gaveUp(seq), detail: 'deadline passed' });
	}
	const { driver } = deps;
	if (!driver) return finish({ status: 'failed', message: IMPORT_PREVIEW_MESSAGES.noSandbox(seq), detail: 'sandbox not configured' });
	await db.prepare('update "import_previews" set "updatedAt" = ? where "projectId" = ?').bind(now.toISOString(), row.projectId).run();

	const root = `/workspace/${row.projectId}`;
	const sessionKey = `import:${row.projectId}:${row.commitId}`;
	const installKey = `import-install:${sessionKey}`;
	const buildKey = `import-build:${sessionKey}`;
	try {
		const { sessionId } = await driver.ensureSession({ sessionKey, image: deps.baseImage, projectId: row.projectId, runId: `import:${row.commitId}` });
		// The files go in once, before the install is ever dispatched; after that
		// the install replays (or is still running, which reads as busy).
		const installSeen = await driver.reconcileOperation(installKey).then(
			() => true,
			(error: unknown) => {
				if (error instanceof SandboxError && error.code === 'OPERATION_NOT_RECORDED') return false;
				throw error;
			},
		);
		if (!installSeen) {
			const files = await readVersionFiles(deps.store, row.projectId, row.commitId);
			await driver.uploadFiles(sessionId, files.map((file) => ({ path: `${root}/${file.path}`, contentBase64: file.contentBase64 })));
		}
		const command = { sessionId, cwd: root, env: BUILD_RUNTIME_ENV };
		const install = await driver.execute({ ...command, command: SCAFFOLD_COMMANDS.install.join(' && '), operationKey: installKey, timeoutMs: 300_000 });
		if (install.exitCode !== 0) return finish({ status: 'failed', message: IMPORT_PREVIEW_MESSAGES.buildFailed(seq), detail: logTail(install) });
		const build = await driver.execute({ ...command, command: SCAFFOLD_COMMANDS.build.join(' && '), operationKey: buildKey, timeoutMs: 120_000 });
		if (build.exitCode !== 0) return finish({ status: 'failed', message: IMPORT_PREVIEW_MESSAGES.buildFailed(seq), detail: logTail(build) });

		const app = await readBuiltApp(driver, sessionId, root);
		if (app.server !== null && deps.loader) {
			const started = await checkServerStarts(deps.loader, app.server);
			if (!started.ok) return finish({ status: 'failed', message: IMPORT_PREVIEW_MESSAGES.serverFailed(seq), detail: started.reason });
		}
		const { checkpointRef: image } = await driver.checkpoint(sessionId);
		const output = await storeImportedOutput(db, verified, {
			html: previewDocument(app),
			image,
			commitId: row.commitId,
			bundle: { server: app.server, migrations: app.migrations, client: { js: app.js, css: app.css } },
		});
		// The imported version gets its preview, so Versions can go back to it.
		await db
			.prepare('update "code_versions" set "outputId" = ?, "image" = ? where "projectId" = ? and "commitId" = ? and "outputId" is null')
			.bind(output.outputId, image, row.projectId, row.commitId)
			.run();
		return finish({ status: 'ready', outputId: output.outputId, hasServer: app.server !== null });
	} catch (error) {
		if (stillRunning(error)) return view(row);
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		console.error('[import-preview] check failed:', detail);
		if (Number(row.errors) + 1 >= MAX_ERRORS) return finish({ status: 'failed', message: IMPORT_PREVIEW_MESSAGES.gaveUp(seq), detail });
		await db.prepare('update "import_previews" set "errors" = "errors" + 1, "detail" = ? where "projectId" = ?').bind(detail.slice(-4000), row.projectId).run();
		return view(row);
	}
}

export interface ImportPreviewEnv extends BuildSandboxEnv {
	ARTIFACTS?: ArtifactsBinding;
	LOADER?: WorkerLoaderLike;
}

/** Routes and the cron build the same dependencies from the Worker's env. */
export function importPreviewDepsFromEnv(env: ImportPreviewEnv): ImportPreviewDeps {
	return {
		db: env.DB,
		store: codeStoreFor(env),
		driver: buildSandboxFromEnv(env),
		...(env.LOADER ? { loader: env.LOADER } : {}),
		baseImage: env.CONTREE_IMAGE ?? DEFAULT_BASE_IMAGE,
	};
}

/**
 * The 5-minute cron: finish checks nobody is driving (the user closed the
 * tab right after the copy). Rows touched in the last two minutes are left to
 * whoever is advancing them. Returns how many settled.
 */
export async function advanceImportPreviews(
	deps: ImportPreviewDeps,
	options: { idleMs?: number; limit?: number } = {},
): Promise<number> {
	const now = deps.now?.() ?? new Date();
	const before = new Date(now.getTime() - (options.idleMs ?? 2 * 60_000)).toISOString();
	const rows = ((await deps.db
		.prepare('select "projectId", "actorId" from "import_previews" where "status" = \'checking\' and "updatedAt" < ? order by "updatedAt" limit ?')
		.bind(before, options.limit ?? 5)
		.all()).results ?? []) as { projectId: string; actorId: string }[];
	let settled = 0;
	for (const pending of rows) {
		try {
			const scope = await projectScopeForUser(deps.db, pending.actorId, pending.projectId);
			const result = await checkImportedApp(deps, scope);
			if (result && result.status !== 'checking') settled += 1;
		} catch (error) {
			console.error('[import-preview] cron check failed:', error instanceof Error ? error.message : error);
		}
	}
	return settled;
}
