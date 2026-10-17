import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ApprovalIntent, Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { GithubRestClient } from '../apps/app/src/server/adapters/github.ts';
import { recordDecision } from '../apps/app/src/server/approvals.ts';
import { createD1ContentStore } from '../apps/app/src/server/artifacts.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import {
	MergeGateError,
	bindInstallation,
	closeDeliveredPullRequest,
	connectAndLinkRepo,
	mergeDeliveredPullRequest,
	processGithubWebhook,
} from '../apps/app/src/server/repositories.ts';
import { ScopeError, projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { readSourceSave, saveSourceAsPullRequest, sourceDriverFromEnv } from '../apps/app/src/server/source-save.ts';
import { freePort, splitSqlStatements } from './fixtures/controls-harness.ts';
import { GithubStub } from './fixtures/github-stub.ts';
import { SandboxStub } from './fixtures/sandbox-stub.ts';

/**
 * "Save the code to GitHub" + "merge it behind an exact approval", end to end
 * through the production services.
 *
 * Classification: LOCAL VERIFIED against real production migrations over
 * SQLite (D1-shaped), the real GitHub REST client (RS256 App JWT ->
 * installation token) and the real sandbox driver, both talking HTTP to
 * local stubs bound to 127.0.0.1. GitHub and the contree sandbox are
 * SIMULATED: nothing here is evidence about real api.github.com or the real
 * sandbox service (that stays BLOCKED on owner provisioning).
 */

const INSTALLATION = '6100001';
const ACCOUNT = 'octo-farm';
const REPO = `${ACCOUNT}/farm-log`;
const SANDBOX_TOKEN = 'local-source-token';
const SECRET_VALUE = 'nebius-key-that-must-never-leave';
const PRIVATE_KEY_HEADER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0xff]);

function d1Adapter(sqlite: Database): D1Database {
	function statement(sql: string, args: unknown[] = []) {
		return {
			bind(...values: unknown[]) {
				return statement(sql, values);
			},
			all() {
				return { results: sqlite.prepare(sql).all(...(args as never[])), meta: {} };
			},
			run() {
				const result = sqlite.prepare(sql).run(...(args as never[]));
				return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
			},
		};
	}
	return {
		prepare: statement,
		batch(statements: { run(): unknown }[]) {
			return sqlite.transaction(() => statements.map((stmt) => stmt.run()))();
		},
		exec(sql: string) {
			sqlite.exec(sql);
		},
	} as unknown as D1Database;
}

async function refusal(task: Promise<unknown>): Promise<Error> {
	try {
		await task;
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a refusal, but the effect succeeded');
}

let sqlite: Database;
let db: D1Database;
let github: GithubStub;
let sandbox: SandboxStub;
let client: GithubRestClient;
let scope: Scope;
let projectId = '';
let outputCounter = 0;

const driver = () =>
	sourceDriverFromEnv({
		DB: db,
		CONTREE_BASE_URL: sandbox.url,
		CONTREE_API_TOKEN: SANDBOX_TOKEN,
		CONTREE_PROJECT_ID: 'local-project',
	});

/** A checked build: its source files in a sandbox image + the workflow_outputs row pointing at it. */
async function checkedBuild(files: Record<string, string | Uint8Array>): Promise<string> {
	const image = sandbox.seedImageWithFiles(
		Object.fromEntries(Object.entries(files).map(([path, content]) => [`/workspace/${projectId}/${path}`, content])),
	);
	outputCounter += 1;
	const outputId = `out_src_${outputCounter}`;
	const content = await createD1ContentStore(db).put(new TextEncoder().encode(`<html>build ${outputCounter}</html>`));
	sqlite
		.prepare('insert into workflow_outputs (id,projectId,runId,planId,image,sha256,createdAt) values (?,?,?,?,?,?,?)')
		.run(outputId, projectId, `run_src_${outputCounter}`, 'plan_src', image, content.contentHash, new Date(Date.now() + outputCounter).toISOString());
	return outputId;
}

const save = (outputId: string) => saveSourceAsPullRequest(db, client, driver(), scope, { outputId });
const mutatingGithubRequests = () => github.mutatingRequests().length;

async function openSave(): Promise<{ number: number; headSha: string; intent: ApprovalIntent; headBranch: string }> {
	const status = await readSourceSave(db, client, scope);
	if (!status.save || !status.pullRequest || !status.mergeIntent) throw new Error('no open saved pull request');
	return {
		number: status.pullRequest.number,
		headSha: status.pullRequest.headSha,
		intent: status.mergeIntent,
		headBranch: status.save.headBranch,
	};
}

beforeAll(async () => {
	sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys=ON');
	for (const migration of [
		'0001_product.sql',
		'0002_controls.sql',
		'0003_artifacts.sql',
		'0005_runs.sql',
		'0006_github.sql',
		'0008_profile.sql',
		'0017_profile_preferences.sql',
		'0011_home_project.sql',
		'0015_plan_decisions.sql',
		'0018_build_workflow.sql',
		'0019_github_project_repo.sql',
		'0022_build_activity.sql',
		'0023_build_features.sql',
		'0024_design_phase.sql',
		'0025_github_source_saves.sql',
	]) {
		const ddl = readFileSync(new URL(`../apps/app/migrations/${migration}`, import.meta.url), 'utf8');
		for (const statement of splitSqlStatements(ddl)) sqlite.exec(statement);
	}
	sqlite
		.prepare('insert into user (id,name,email,emailVerified,createdAt,updatedAt) values (?,?,?,0,?,?)')
		.run('alice', 'alice', 'alice@example.com', '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z');
	db = d1Adapter(sqlite);

	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});
	github = new GithubStub({ appPublicKeyPem: publicKey.toString() });
	await github.start(await freePort());
	github.registerInstallation({
		installationId: INSTALLATION,
		accountLogin: ACCOUNT,
		permissions: { contents: 'write', pull_requests: 'write' },
	});
	github.seedRepo({
		fullName: REPO,
		files: { 'README.md': '# farm-log\n', 'LICENSE': 'MIT\n' },
		accessInstallationId: INSTALLATION,
	});
	sandbox = new SandboxStub({ expectedToken: SANDBOX_TOKEN });
	await sandbox.start();
	client = new GithubRestClient({ appId: '424242', privateKeyPem: privateKey.toString(), webhookSecret: null, baseUrl: github.url });

	const workspace = await createWorkspace(db, 'alice', { name: 'Alice' });
	const workspaceScope = await workspaceScopeForUser(db, 'alice', workspace.id);
	const project = await createProject(db, workspaceScope, { workspaceId: workspace.id, name: 'Farm log' });
	projectId = project.id;
	scope = await projectScopeForUser(db, 'alice', projectId);

	// The same path the product takes: install webhook, explicit bind, repo selected, repo linked.
	await processGithubWebhook(db, {
		event: 'installation',
		deliveryId: 'src-install-1',
		payload: {
			action: 'created',
			installation: { id: Number(INSTALLATION), account: { login: ACCOUNT }, permissions: { contents: 'write', pull_requests: 'write' }, app_slug: 'caddie-forge-app', suspended_at: null },
		},
	});
	await bindInstallation(db, client, workspaceScope, INSTALLATION);
	await processGithubWebhook(db, {
		event: 'installation_repositories',
		deliveryId: 'src-select-1',
		payload: {
			action: 'added',
			installation: { id: Number(INSTALLATION) },
			repositories_added: [{ full_name: REPO }],
			repositories_removed: [],
		},
	});
	await connectAndLinkRepo(db, client, scope, { installationId: INSTALLATION, repoFullName: REPO });
}, 60_000);

afterAll(async () => {
	if (github) await github.stop();
	if (sandbox) await sandbox.stop();
});

describe('save the code to GitHub as a pull request', () => {
	let firstOutput = '';
	let firstNumber = 0;

	test('the checked build becomes a PR: source only, binaries intact, secrets never read or sent, main untouched', async () => {
		const mainBefore = github.branchHead(REPO, 'main');
		firstOutput = await checkedBuild({
			'package.json': '{"name":"farm-log"}\n',
			'src/App.tsx': 'export const App = () => null;\n',
			'src/old.ts': 'export const old = 1;\n',
			'public/logo.png': PNG,
			'.env.example': 'NEBIUS_API_KEY=\n',
			'.env': `NEBIUS_API_KEY=${SECRET_VALUE}\n`,
			'node_modules/react/index.js': 'module.exports = {};\n',
			'dist/main.js': 'console.log(1);\n',
		});
		const result = await save(firstOutput);
		expect(result.reconciled).toBe(false);
		expect(result.save.outputId).toBe(firstOutput);
		expect(result.save.headBranch).toMatch(/^caddie\/source-[0-9a-f]{12}$/);
		expect(result.save.fileCount).toBe(5);
		expect(result.save.deleted).toEqual([]);
		expect(result.save.skipped).toEqual(
			expect.arrayContaining([
				{ path: '.env', reason: 'secret' },
				{ path: 'node_modules/', reason: 'dependencies' },
				{ path: 'dist/', reason: 'build-output' },
			]),
		);
		firstNumber = result.save.pullRequestNumber!;
		expect(firstNumber).toBeGreaterThan(0);

		// What GitHub now shows on the PR branch: base files kept, source added, nothing else.
		const branch = github.branchFiles(REPO, result.save.headBranch);
		expect([...branch.keys()].sort()).toEqual(['.env.example', 'LICENSE', 'README.md', 'package.json', 'public/logo.png', 'src/App.tsx', 'src/old.ts']);
		expect(new Uint8Array(branch.get('public/logo.png')!)).toEqual(PNG);
		expect(branch.get('src/App.tsx')!.toString('utf8')).toBe('export const App = () => null;\n');
		const pr = github.pullRequest(REPO, firstNumber)!;
		expect(pr.state).toBe('open');
		expect(pr.base).toBe('main');
		expect(pr.title).toBe('Save Farm log code from Caddie');
		expect(pr.body).toContain('5 files');
		expect(pr.body).toContain('`.env` (secret, never read)');

		// The default branch was never written, and nothing was force-pushed.
		expect(github.branchHead(REPO, 'main')).toBe(mainBefore);
		expect(github.refUpdates.filter((u) => u.branch === 'main')).toHaveLength(0);
		expect(github.forceViolations).toBe(0);

		// The secret never left: not read from the sandbox, not in any GitHub request (raw or base64).
		const root = `/workspace/${projectId}`;
		expect(sandbox.downloadedPaths()).not.toContain(`${root}/.env`);
		expect(sandbox.listedPaths()).not.toContain(`${root}/node_modules`);
		expect(sandbox.listedPaths()).not.toContain(`${root}/dist`);
		const wire = JSON.stringify(github.requests.map((r) => r.body));
		expect(wire).not.toContain(SECRET_VALUE);
		expect(wire).not.toContain(Buffer.from(`NEBIUS_API_KEY=${SECRET_VALUE}\n`).toString('base64'));
	});

	test('saving the same build again replays the same PR with no new GitHub writes', async () => {
		const before = mutatingGithubRequests();
		const again = await save(firstOutput);
		expect(again.reconciled).toBe(true);
		expect(again.save.pullRequestNumber).toBe(firstNumber);
		expect(mutatingGithubRequests()).toBe(before);
		const saves = sqlite.query('select count(*) as n from github_source_saves').get() as { n: number };
		expect(saves.n).toBe(1);
	});

	test('the status read reports the live PR and the exact approval a merge needs', async () => {
		const status = await readSourceSave(db, client, scope);
		expect(status.save?.outputId).toBe(firstOutput);
		expect(status.pullRequest).toMatchObject({ number: firstNumber, state: 'open', mergeable: true, baseBranch: 'main' });
		expect(status.mergeIntent).toEqual({
			projectId,
			action: 'merge-default-branch',
			resourceId: `${REPO}#${firstNumber}`,
			revisionHash: status.pullRequest!.headSha,
			policyVersion: 'policies/2026-10-05',
		});
		// GitHub not configured: the save is still reported, the live state honestly is not.
		const offline = await readSourceSave(db, null, scope);
		expect(offline.save?.pullRequestNumber).toBe(firstNumber);
		expect(offline.pullRequest).toBeNull();
		expect(offline.mergeIntent).toBeNull();
		expect(offline.pullRequestError).toContain('not configured');
	});
});

describe('merge a Caddie PR behind an exact approval', () => {
	test('without an approval the merge is refused with the exact intent, and no merge call is made', async () => {
		const open = await openSave();
		const error = await refusal(
			mergeDeliveredPullRequest(db, client, scope, { repoFullName: REPO, pullRequestNumber: open.number, headSha: open.headSha }),
		);
		expect(error).toBeInstanceOf(MergeGateError);
		expect((error as MergeGateError).gate.code).toBe('STALE_APPROVAL');
		expect((error as MergeGateError).intent).toEqual(open.intent);
		expect(github.merges).toHaveLength(0);
	});

	test('after approving that commit, the merge runs once, pinned to it, and settles the ledger', async () => {
		const open = await openSave();
		await recordDecision(db, 'alice', { intent: open.intent, decision: 'approved' });
		const result = await mergeDeliveredPullRequest(db, client, scope, {
			repoFullName: REPO,
			pullRequestNumber: open.number,
			headSha: open.headSha,
		});
		expect(result.reconciled).toBe(false);
		expect(result.pullRequest).toMatchObject({ merged: true, baseBranch: 'main', pullRequestNumber: open.number });
		expect(github.merges).toEqual([{ repo: REPO, number: open.number, sha: open.headSha, method: 'squash' }]);
		expect(result.pullRequest.mergeCommitSha).toBe(github.branchHead(REPO, 'main'));
		expect([...github.branchFiles(REPO, 'main').keys()]).toContain('src/App.tsx');
		const ledger = sqlite
			.query(`select status, receiptId from external_operations where operationKey like 'github:merge-pull-request:%'`)
			.all() as Array<{ status: string; receiptId: string }>;
		expect(ledger).toEqual([{ status: 'succeeded', receiptId: `merge-pr:${result.pullRequest.mergeCommitSha}` }]);
		const status = await readSourceSave(db, client, scope);
		expect(status.pullRequest?.state).toBe('merged');
		expect(status.mergeIntent).toBeNull();
	});

	test('merging again reconciles from GitHub with no second merge call', async () => {
		const status = await readSourceSave(db, client, scope);
		const again = await mergeDeliveredPullRequest(db, client, scope, {
			repoFullName: REPO,
			pullRequestNumber: status.pullRequest!.number,
			headSha: status.pullRequest!.headSha,
		});
		expect(again.reconciled).toBe(true);
		expect(github.merges).toHaveLength(1);
	});

	test('a later save removes files the build deleted, and never touches files Caddie did not save', async () => {
		const second = await checkedBuild({
			'package.json': '{"name":"farm-log","version":"2.0.0"}\n',
			'src/App.tsx': 'export const App = () => "v2";\n',
			'public/logo.png': PNG,
			'.env.example': 'NEBIUS_API_KEY=\n',
		});
		const result = await save(second);
		expect(result.reconciled).toBe(false);
		expect(result.save.deleted).toEqual(['src/old.ts']);
		const branch = github.branchFiles(REPO, result.save.headBranch);
		expect(branch.has('src/old.ts')).toBe(false);
		// never Caddie's: kept exactly
		expect(branch.get('README.md')?.toString('utf8')).toBe('# farm-log\n');
		expect(branch.get('LICENSE')?.toString('utf8')).toBe('MIT\n');
		expect(branch.get('src/App.tsx')?.toString('utf8')).toBe('export const App = () => "v2";\n');
		const status = await readSourceSave(db, client, scope);
		expect(status.save?.outputId).toBe(second);
		expect(status.pullRequest?.state).toBe('open');
	});

	test('a push after the approval is refused: the merge stays pinned to the approved commit', async () => {
		const approved = await openSave();
		await recordDecision(db, 'alice', { intent: approved.intent, decision: 'approved' });
		github.pushToBranch(REPO, approved.headBranch, { 'NOTES.md': 'pushed after the approval\n' });
		const error = await refusal(
			mergeDeliveredPullRequest(db, client, scope, { repoFullName: REPO, pullRequestNumber: approved.number, headSha: approved.headSha }),
		);
		expect(error).toBeInstanceOf(ScopeError);
		expect((error as ScopeError).code).toBe('pull_request_head_moved');
		expect(github.merges).toHaveLength(1);
		// The new head needs its own approval: the old one does not carry over.
		const moved = await openSave();
		expect(moved.headSha).not.toBe(approved.headSha);
		const gated = await refusal(
			mergeDeliveredPullRequest(db, client, scope, { repoFullName: REPO, pullRequestNumber: moved.number, headSha: moved.headSha }),
		);
		expect(gated).toBeInstanceOf(MergeGateError);
		expect(github.merges).toHaveLength(1);
	});

	test('a PR GitHub reports as conflicting is refused before any merge call', async () => {
		const open = await openSave();
		await recordDecision(db, 'alice', { intent: open.intent, decision: 'approved' });
		github.setPullRequestMergeable(REPO, open.number, false);
		const error = await refusal(
			mergeDeliveredPullRequest(db, client, scope, { repoFullName: REPO, pullRequestNumber: open.number, headSha: open.headSha }),
		);
		expect((error as ScopeError).code).toBe('pull_request_not_mergeable');
		expect(github.merges).toHaveLength(1);
		github.setPullRequestMergeable(REPO, open.number, true);
	});

	test('a closed PR and a PR Caddie did not open are refused', async () => {
		const open = await openSave();
		await closeDeliveredPullRequest(db, client, scope, { repoFullName: REPO, pullRequestNumber: open.number });
		const closed = await refusal(
			mergeDeliveredPullRequest(db, client, scope, { repoFullName: REPO, pullRequestNumber: open.number, headSha: open.headSha }),
		);
		expect((closed as ScopeError).code).toBe('pull_request_closed');
		const foreign = await refusal(
			mergeDeliveredPullRequest(db, client, scope, { repoFullName: REPO, pullRequestNumber: 999, headSha: open.headSha }),
		);
		expect((foreign as ScopeError).code).toBe('pull_request_not_delivered');
		expect(github.merges).toHaveLength(1);
		const status = await readSourceSave(db, client, scope);
		expect(status.pullRequest?.state).toBe('closed');
		expect(status.mergeIntent).toBeNull();
	});
});

describe('a save that breaks the rules sends nothing', () => {
	test('a secret in the code or too many files refuses the whole save before any GitHub write', async () => {
		const before = mutatingGithubRequests();
		const leaky = await checkedBuild({
			'src/App.tsx': 'export {};\n',
			'src/config.ts': `export const key = \`${PRIVATE_KEY_HEADER}\nMIIEvQ\`;\n`,
		});
		const secret = await refusal(save(leaky));
		expect((secret as ScopeError).code).toBe('source_contains_secret');
		expect(secret.message).toContain('src/config.ts');

		const many: Record<string, string> = {};
		for (let i = 0; i < 201; i++) many[`src/f${String(i).padStart(3, '0')}.ts`] = `export const n = ${i};\n`;
		const tooMany = await refusal(save(await checkedBuild(many)));
		expect((tooMany as ScopeError).code).toBe('source_too_many_files');

		expect(mutatingGithubRequests()).toBe(before);
	});

	test('a build output that is not this project’s is refused before the sandbox is read', async () => {
		const reads = sandbox.downloadedPaths().length;
		const missing = await refusal(save('out_not_mine'));
		expect((missing as ScopeError).code).toBe('build_output_not_found');
		expect(sandbox.downloadedPaths().length).toBe(reads);
	});

	test('without the App’s Contents write permission, saving and merging are refused before any write', async () => {
		// An open PR with an approved head, made while the App still had write.
		await save(
			await checkedBuild({
				'package.json': '{"name":"farm-log"}\n',
				'src/App.tsx': 'export const App = () => "v3";\n',
				'public/logo.png': PNG,
				'.env.example': 'NEBIUS_API_KEY=\n',
			}),
		);
		const open = await openSave();
		await recordDecision(db, 'alice', { intent: open.intent, decision: 'approved' });

		const installation = github.getInstallation(INSTALLATION)!;
		installation.permissions = { contents: 'read', pull_requests: 'write' };
		try {
			const writesBefore = mutatingGithubRequests();
			const mergesBefore = github.merges.length;
			const deniedSave = await refusal(save(await checkedBuild({ 'src/App.tsx': 'export const App = () => "v4";\n' })));
			expect((deniedSave as ScopeError).code).toBe('github_contents_write_required');
			expect(deniedSave.message).toContain('Contents: Read and write');
			const deniedMerge = await refusal(
				mergeDeliveredPullRequest(db, client, scope, { repoFullName: REPO, pullRequestNumber: open.number, headSha: open.headSha }),
			);
			expect((deniedMerge as ScopeError).code).toBe('github_contents_write_required');
			expect(mutatingGithubRequests()).toBe(writesBefore);
			expect(github.merges.length).toBe(mergesBefore);
		} finally {
			installation.permissions = { contents: 'write', pull_requests: 'write' };
		}
	});
});
