import type { ApprovalIntent, Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { base64ToBytes } from './adapters/contree.ts';
import { GithubError, type GithubRestClient } from './adapters/github.ts';
import { SandboxDriver } from './adapters/sandbox.ts';
import { D1SandboxPersistence } from './adapters/sandbox-persistence.ts';
import {
	DEFAULT_IMPORT_CAPS,
	deliverPatch,
	deliveryContentHash,
	getProjectRepo,
	pullRequestMergeIntent,
	requireActiveInstallation,
	requireSelectedRepo,
} from './repositories.ts';
import { ScopeError, assertProjectScope } from './scope.ts';
import { collectSourceSnapshot, type SourceSkip, type SourceSnapshot } from './source-export.ts';

/**
 * "Save the code to GitHub": the verified build's SOURCE, opened as a pull
 * request on the project's repo.
 *
 *   - The server reads the files, never the browser, and it reads them from
 *     the build output's own sandbox image: the checkpoint the preview was
 *     made from. Later edits in the build session cannot leak into the save,
 *     and the code saved is exactly the code behind the preview the user saw.
 *   - What may leave the sandbox is decided by source-export.ts (no
 *     dependencies, build output or secrets; hard caps; secret scan).
 *   - Each save is a pull request on its own `caddie/source-<hash>` branch off
 *     the default branch, so it never writes the default branch and needs no
 *     approval; merging it is the separate, approval-gated step.
 *   - The same build saved twice is the same logical delivery (same content
 *     hash, branch and operation key), so it replays the same pull request.
 *   - A file an earlier save put in the repo that the build has since deleted
 *     is removed in the new pull request. Files Caddie never saved (a README,
 *     the user's own workflows) are never touched.
 */

export interface SourceSandboxEnv {
	DB: D1Database;
	CONTREE_BASE_URL?: string;
	CONTREE_API_TOKEN?: string;
	CONTREE_PROJECT_ID?: string;
}

export interface SourceSaveView {
	outputId: string;
	repoFullName: string;
	headBranch: string;
	pullRequestNumber: number | null;
	htmlUrl: string | null;
	fileCount: number;
	skipped: SourceSkip[];
	/** Paths this save removed because the build deleted them since an earlier save. */
	deleted: string[];
	createdAt: string;
}

export interface SourcePullRequestState {
	number: number;
	state: 'open' | 'closed' | 'merged';
	/** GitHub's mergeability check; null while GitHub is still computing it. */
	mergeable: boolean | null;
	headSha: string;
	baseBranch: string;
	htmlUrl: string | null;
}

const SOURCE_CAPS = { ...DEFAULT_IMPORT_CAPS, maxDirectories: 400 };
const BRANCH_PREFIX = 'caddie/source-';
/** Earlier saves consulted for deletions (bounded; newest first). */
const PREVIOUS_SAVES_CONSULTED = 50;

/** The sandbox the build ran in, configured exactly like the build session's (coordinator-host.ts). */
export function sourceDriverFromEnv(env: SourceSandboxEnv): SandboxDriver {
	if (!env.CONTREE_BASE_URL || !env.CONTREE_API_TOKEN || !env.CONTREE_PROJECT_ID) {
		throw new ScopeError(503, 'SANDBOX_NOT_CONFIGURED', 'The build sandbox is not configured, so the code cannot be read.');
	}
	return new SandboxDriver(
		{
			contree: {
				baseUrl: env.CONTREE_BASE_URL,
				apiToken: env.CONTREE_API_TOKEN,
				platformProjectId: env.CONTREE_PROJECT_ID,
			},
			quotas: {
				maxCommandTimeoutMs: 15 * 60_000,
				maxOutputBytes: 5 * 1024 * 1024,
				maxUploadBytes: 20 * 1024 * 1024,
			},
			workspaceRoot: '/workspace',
		},
		new D1SandboxPersistence(env.DB),
	);
}

async function rows(db: D1Database, sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

function requireOutputId(input: unknown): string {
	const value = input && typeof input === 'object' ? (input as Record<string, unknown>)['outputId'] : undefined;
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
		throw new ScopeError(400, 'invalid_request', 'outputId is required');
	}
	return value;
}

interface ManifestJson {
	files?: Array<{ path?: unknown }>;
	skipped?: SourceSkip[];
	deleted?: string[];
}

function parseManifest(raw: unknown): ManifestJson {
	try {
		const parsed = JSON.parse(String(raw)) as ManifestJson;
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

function pullRequestUrl(repoHtmlUrl: string, number: number | null): string | null {
	return number !== null && repoHtmlUrl ? `${repoHtmlUrl.replace(/\/+$/, '')}/pull/${number}` : null;
}

function saveFromRow(row: Record<string, unknown>, repoHtmlUrl: string): SourceSaveView {
	const manifest = parseManifest(row['manifestJson']);
	const number = row['pullRequestNumber'] === null || row['pullRequestNumber'] === undefined ? null : Number(row['pullRequestNumber']);
	return {
		outputId: String(row['outputId']),
		repoFullName: String(row['repoFullName']),
		headBranch: String(row['headBranch']),
		pullRequestNumber: number,
		htmlUrl: pullRequestUrl(repoHtmlUrl, number),
		fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
		skipped: Array.isArray(manifest.skipped) ? manifest.skipped : [],
		deleted: Array.isArray(manifest.deleted) ? manifest.deleted : [],
		createdAt: String(row['createdAt']),
	};
}

/** Every path an earlier save of this project put on this repo. */
async function pathsSavedBefore(db: D1Database, projectId: string, repoFullName: string): Promise<Set<string>> {
	const saved = await rows(
		db,
		'select "manifestJson" from "github_source_saves" where "projectId" = ? and "repoFullName" = ? order by "createdAt" desc limit ?',
		projectId,
		repoFullName,
		PREVIOUS_SAVES_CONSULTED,
	);
	const paths = new Set<string>();
	for (const row of saved) {
		for (const file of parseManifest(row['manifestJson']).files ?? []) {
			if (typeof file.path === 'string') paths.add(file.path);
		}
	}
	return paths;
}

const SKIP_LABEL: Record<SourceSkip['reason'], string> = {
	dependencies: 'dependencies',
	'build-output': 'build output',
	secret: 'secret, never read',
	symlink: 'link',
	noise: 'generated',
	scratch: "Caddie's scratch files",
};

function pullRequestBody(snapshot: SourceSnapshot, outputId: string): string {
	const leftOut = snapshot.skipped.slice(0, 12).map((skip) => `\`${skip.path}\` (${SKIP_LABEL[skip.reason]})`);
	const more = snapshot.skipped.length - leftOut.length;
	return [
		'The code of the app Caddie built and checked, saved from Caddie.',
		'',
		`- ${snapshot.files.length} files from the checked build (\`${outputId}\`)`,
		...(leftOut.length > 0 ? [`- Left out: ${leftOut.join(', ')}${more > 0 ? `, and ${more} more` : ''}`] : []),
		'',
		'Nothing changes on the default branch until this pull request is merged.',
	].join('\n');
}

/**
 * Save the source of build output `outputId` as a pull request. Scope,
 * repo link, installation and selection are checked before the sandbox is
 * read; nothing reaches GitHub unless the whole snapshot passed the rules.
 */
export async function saveSourceAsPullRequest(
	db: D1Database,
	client: GithubRestClient,
	driver: SandboxDriver,
	scope: Scope,
	input: unknown,
): Promise<{ save: SourceSaveView; reconciled: boolean }> {
	const verified = await assertProjectScope(db, scope);
	const outputId = requireOutputId(input);
	const output = (
		await rows(db, 'select "runId", "image" from "workflow_outputs" where "id" = ? and "projectId" = ?', outputId, verified.projectId)
	)[0];
	if (!output) throw new ScopeError(404, 'build_output_not_found', 'No such checked build in this project.');
	const repo = await getProjectRepo(db, verified);
	if (!repo) {
		throw new ScopeError(409, 'repo_not_linked', 'Connect a GitHub repo for this project first.');
	}
	await requireActiveInstallation(db, verified, repo.installationId);
	await requireSelectedRepo(db, repo.installationId, repo.repoFullName);

	const runId = String(output['runId']);
	// A read-only binding to the build output's image: no instance runs, nothing is written in the sandbox.
	const { sessionId } = await driver.restore({
		checkpointRef: String(output['image']),
		projectId: verified.projectId,
		runId,
	});
	const snapshot = await collectSourceSnapshot(
		{
			list: (path) => driver.listEntries(sessionId, path),
			read: async (path) => base64ToBytes((await driver.readFile(sessionId, path)).contentBase64),
		},
		`/workspace/${verified.projectId}`,
		SOURCE_CAPS,
	);

	const current = new Set(snapshot.files.map((file) => file.path));
	const deletePaths = [...(await pathsSavedBefore(db, verified.projectId, repo.repoFullName))]
		.filter((path) => !current.has(path))
		.sort();
	const files = snapshot.files.map(({ path, content, encoding }) => ({ path, content, encoding }));
	const contentHash = await deliveryContentHash(files, deletePaths);
	const headBranch = `${BRANCH_PREFIX}${contentHash.slice(0, 12)}`;
	const project = (await rows(db, 'select "name" from "projects" where "id" = ?', verified.projectId))[0];
	const projectName = String(project?.['name'] ?? 'the app');

	const result = await deliverPatch(db, client, scope, {
		mode: 'pull-request',
		runId,
		installationId: repo.installationId,
		repoFullName: repo.repoFullName,
		headBranch,
		title: `Save ${projectName} code from Caddie`,
		body: pullRequestBody(snapshot, outputId),
		files,
		deletePaths,
	});

	const manifestJson = JSON.stringify({
		files: snapshot.files.map(({ path, size, encoding }) => ({ path, size, encoding })),
		skipped: snapshot.skipped,
		// A replay reports no deletions of its own; the first save's list is kept.
		deleted: result.deleted ?? [],
	});
	// select-then-write, not `on conflict do update`: the local D1 emulator
	// silently no-ops upserts with bound parameters (see processGithubWebhook).
	const operationKey = result.delivery.operationKey;
	const recorded = (await rows(db, 'select "id" from "github_source_saves" where "operationKey" = ?', operationKey))[0];
	const updateNumber = () =>
		db
			.prepare('update "github_source_saves" set "pullRequestNumber" = ? where "operationKey" = ?')
			.bind(result.delivery.pullRequestNumber, operationKey)
			.run();
	if (recorded) {
		await updateNumber();
	} else {
		try {
			await db
				.prepare(
					`insert into "github_source_saves"
					   ("id","operationKey","projectId","outputId","repoFullName","headBranch","pullRequestNumber","manifestJson","createdBy","createdAt")
					 values (?,?,?,?,?,?,?,?,?,?)`,
				)
				.bind(
					`srcsave_${crypto.randomUUID()}`,
					operationKey,
					verified.projectId,
					outputId,
					repo.repoFullName,
					headBranch,
					result.delivery.pullRequestNumber,
					manifestJson,
					verified.actorId,
					new Date().toISOString(),
				)
				.run();
		} catch (error) {
			// A concurrent save of the same build won the insert: keep its row.
			if (!String(error).includes('UNIQUE constraint failed')) throw error;
			await updateNumber();
		}
	}
	const stored = (await rows(db, 'select * from "github_source_saves" where "operationKey" = ?', operationKey))[0];
	if (!stored) throw new Error('the source save was not recorded');
	const save = saveFromRow(stored, repo.htmlUrl);
	return {
		save: { ...save, htmlUrl: result.delivery.htmlUrl ?? save.htmlUrl },
		reconciled: result.reconciled,
	};
}

/**
 * The latest source save for the project's linked repo, with the pull
 * request's LIVE state and, while it is open, the exact approval a merge at
 * its current head needs. GitHub being unreachable is reported, not hidden.
 */
export async function readSourceSave(
	db: D1Database,
	client: GithubRestClient | null,
	scope: Scope,
): Promise<{
	save: SourceSaveView | null;
	pullRequest: SourcePullRequestState | null;
	pullRequestError: string | null;
	mergeIntent: ApprovalIntent | null;
}> {
	const verified = await assertProjectScope(db, scope);
	const repo = await getProjectRepo(db, verified);
	if (!repo) return { save: null, pullRequest: null, pullRequestError: null, mergeIntent: null };
	const latest = (
		await rows(
			db,
			'select * from "github_source_saves" where "projectId" = ? and "repoFullName" = ? order by "createdAt" desc, "rowid" desc limit 1',
			verified.projectId,
			repo.repoFullName,
		)
	)[0];
	if (!latest) return { save: null, pullRequest: null, pullRequestError: null, mergeIntent: null };
	const save = saveFromRow(latest, repo.htmlUrl);
	if (save.pullRequestNumber === null) return { save, pullRequest: null, pullRequestError: null, mergeIntent: null };
	if (!client) {
		return { save, pullRequest: null, pullRequestError: 'GitHub is not configured on this server.', mergeIntent: null };
	}
	try {
		const installation = await requireActiveInstallation(db, verified, repo.installationId);
		const pr = await client.getPullRequest(installation.installationId, repo.repoFullName, save.pullRequestNumber);
		const state: SourcePullRequestState = {
			number: save.pullRequestNumber,
			state: pr.merged ? 'merged' : pr.state,
			mergeable: pr.mergeable,
			headSha: pr.headSha,
			baseBranch: pr.base,
			htmlUrl: pr.htmlUrl || save.htmlUrl,
		};
		return {
			save,
			pullRequest: state,
			pullRequestError: null,
			mergeIntent:
				state.state === 'open' && pr.headSha
					? pullRequestMergeIntent(verified.projectId, repo.repoFullName, save.pullRequestNumber, pr.headSha)
					: null,
		};
	} catch (error) {
		if (error instanceof GithubError || error instanceof ScopeError) {
			return { save, pullRequest: null, pullRequestError: error.message, mergeIntent: null };
		}
		throw error;
	}
}
