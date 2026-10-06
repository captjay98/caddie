import { createServer, type Server } from 'node:http';
import { createHash, createVerify, randomBytes } from 'node:crypto';

/**
 * P08 test fixture — LOCAL STUB of the GitHub REST API surface the
 * P08 adapter implements (apps/app/src/server/adapters/github.ts).
 *
 * Binds 127.0.0.1 only — no external network. Emulates the documented GitHub
 * App REST shapes this packet needs:
 *
 *   POST /app/installations/{id}/access_tokens        App JWT -> installation token
 *   GET  /app/installations/{id}                      installation metadata
 *   GET  /repos/{owner}/{repo}                        repo metadata (default branch)
 *   GET  /repos/{owner}/{repo}/commits/{ref}          resolve ref -> commit + tree
 *   GET  /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
 *   GET  /repos/{owner}/{repo}/git/blobs/{sha}
 *   GET  /repos/{owner}/{repo}/git/ref/heads/{branch}
 *   POST /repos/{owner}/{repo}/git/refs               create branch
 *   PATCH /repos/{owner}/{repo}/git/refs/heads/{b}    update (records force flag)
 *   POST /repos/{owner}/{repo}/git/blobs
 *   POST /repos/{owner}/{repo}/git/trees
 *   POST /repos/{owner}/{repo}/git/commits
 *   POST /repos/{owner}/{repo}/pulls                  PR (422 when head PR exists)
 *   GET  /repos/{owner}/{repo}/pulls                  open PR lookup by head
 *
 * Behavioral guarantees the tests rely on:
 *   - every request is recorded (method, path, auth kind) so "no mutating call
 *     reached the provider" is stub truth, not a code promise;
 *   - every PATCH records its `force` flag; force:true is counted as a
 *     violation and REJECTED (never-force-push is asserted against this log);
 *   - ref updates are only accepted when the new commit's first parent equals
 *     the recorded branch head (GitHub's fast-forward rule), so overwrite is
 *     impossible even if the adapter tried;
 *   - PR creation is keyed by the head branch: a second POST for a head that
 *     already has an open PR returns GitHub's 422 "already exists" so the
 *     adapter must reconcile to the SAME PR number;
 *   - installation tokens are only minted for a valid RS256 App JWT (verified
 *     against the test's public key), and repo calls must present a token that
 *     maps to the installation that owns the repo.
 */

export interface StubRequest {
	method: string;
	path: string;
	authKind: 'none' | 'app-jwt' | 'installation-token';
	installationId: string | null;
	body: unknown;
}

interface StubBlob {
	sha: string;
	content: Buffer;
}

interface StubTreeEntry {
	path: string;
	mode: string;
	type: 'blob' | 'tree' | 'commit';
	sha: string;
	size: number;
}

interface StubTree {
	sha: string;
	entries: StubTreeEntry[];
}

interface StubCommit {
	sha: string;
	message: string;
	tree: string;
	parents: string[];
}

interface StubBranch {
	name: string;
	sha: string;
}

interface StubRepo {
	owner: string;
	name: string;
	defaultBranch: string;
	blobs: Map<string, StubBlob>;
	trees: Map<string, StubTree>;
	commits: Map<string, StubCommit>;
	branches: Map<string, StubBranch>;
	/** Which installation id may access this repo (token scoping check). */
	accessInstallationId: string;
	pullRequests: Map<string, StubPullRequest>;
	nextPullNumber: number;
	nextCommitNumber: number;
}

export interface StubPullRequest {
	number: number;
	title: string;
	body: string;
	head: string;
	base: string;
	headSha: string;
	state: 'open';
	htmlUrl: string;
}

export interface StubInstallation {
	installationId: string;
	accountLogin: string;
	permissions: Record<string, string>;
	appSlug: string;
	suspended: boolean;
}

interface StubToken {
	token: string;
	installationId: string;
	expiresAt: number;
}

export interface SeedRepoOptions {
	fullName: string;
	defaultBranch?: string;
	/** Regular files: path -> text content. */
	files?: Record<string, string>;
	/** Symlink entries (mode 120000): path -> target text. */
	symlinks?: Record<string, string>;
	/** Submodule entries (type "commit"): path -> fake gitlink sha. */
	submodules?: Record<string, string>;
	/** Raw tree entries for tests that need malformed/dangerous paths. */
	rawEntries?: Array<{ path: string; mode?: string; type?: 'blob' | 'commit'; content?: string }>;
	accessInstallationId: string;
}

export interface GithubStubOptions {
	/** PEM public key: App JWTs presented for token minting must verify. */
	appPublicKeyPem: string;
	/** Injectable clock (epoch ms). Defaults to Date.now. */
	nowMs?: () => number;
}

type AuthResult = { kind: 'app-jwt' } | { kind: 'installation-token'; installationId: string } | null;

function sha1Hex(input: string | Buffer): string {
	return createHash('sha1').update(input).digest('hex');
}

function base64UrlToBuffer(input: string): Buffer {
	return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

function safeJson(buf: Buffer): unknown {
	try {
		return JSON.parse(buf.toString('utf8'));
	} catch {
		return buf.toString('utf8');
	}
}


/** Real-GitHub PR JSON shape (head/base objects, snake_case url). */
function serializePullRequest(pr: StubPullRequest): Record<string, unknown> {
	return {
		number: pr.number,
		title: pr.title,
		body: pr.body,
		state: pr.state,
		head: { ref: pr.head, sha: pr.headSha },
		base: { ref: pr.base },
		html_url: pr.htmlUrl,
	};
}

export class GithubStub {
	readonly requests: StubRequest[] = [];
	/** Every ref update ATTEMPT, with the requested force flag. */
	readonly refUpdates: Array<{ repo: string; branch: string; force: boolean; accepted: boolean }> = [];
	/** Count of force:true update attempts (must stay 0 in every suite). */
	forceViolations = 0;
	url = '';

	private server: Server | undefined;
	private repos = new Map<string, StubRepo>();
	private installations = new Map<string, StubInstallation>();
	private tokens = new Map<string, StubToken>();
	private appPublicKeyPem: string;
	private now: () => number;
	private tokenCounter = 0;

	constructor(options: GithubStubOptions) {
		this.appPublicKeyPem = options.appPublicKeyPem;
		this.now = options.nowMs ?? (() => Date.now());
	}

	// --- seeding ----------------------------------------------------------------

	registerInstallation(input: {
		installationId: string;
		accountLogin: string;
		permissions?: Record<string, string>;
		appSlug?: string;
	}): void {
		this.installations.set(String(input.installationId), {
			installationId: String(input.installationId),
			accountLogin: input.accountLogin,
			permissions: input.permissions ?? { contents: 'read', pull_requests: 'write' },
			appSlug: input.appSlug ?? 'caddie-forge-app',
			suspended: false,
		});
	}

	getInstallation(installationId: string): StubInstallation | undefined {
		return this.installations.get(String(installationId));
	}

	seedRepo(options: SeedRepoOptions): StubRepo {
		const [owner, ...rest] = options.fullName.split('/');
		const name = rest.join('/');
		const blobs = new Map<string, StubBlob>();
		const entries: StubTreeEntry[] = [];
		for (const [path, content] of Object.entries(options.files ?? {})) {
			const contentBuf = Buffer.from(content, 'utf8');
			const sha = sha1Hex(contentBuf);
			blobs.set(sha, { sha, content: contentBuf });
			entries.push({ path, mode: '100644', type: 'blob', sha, size: contentBuf.length });
		}
		for (const [path, target] of Object.entries(options.symlinks ?? {})) {
			const contentBuf = Buffer.from(target, 'utf8');
			const sha = sha1Hex(contentBuf);
			blobs.set(sha, { sha, content: contentBuf });
			entries.push({ path, mode: '120000', type: 'blob', sha, size: contentBuf.length });
		}
		for (const [path, gitlink] of Object.entries(options.submodules ?? {})) {
			entries.push({ path, mode: '160000', type: 'commit', sha: gitlink, size: 0 });
		}
		for (const raw of options.rawEntries ?? []) {
			const contentBuf = Buffer.from(raw.content ?? '', 'utf8');
			const sha = sha1Hex(contentBuf);
			blobs.set(sha, { sha, content: contentBuf });
			entries.push({
				path: raw.path,
				mode: raw.mode ?? '100644',
				type: raw.type ?? 'blob',
				sha,
				size: contentBuf.length,
			});
		}
		entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const treeSha = `tree-${sha1Hex(entries.map((e) => `${e.mode} ${e.type} ${e.sha} ${e.path}`).join('\n'))}`;
		const trees = new Map<string, StubTree>();
		trees.set(treeSha, { sha: treeSha, entries });
		const commitSha = `seeded-${sha1Hex(`${options.fullName}@seed`)}`;
		const commits = new Map<string, StubCommit>();
		commits.set(commitSha, { sha: commitSha, message: 'seed', tree: treeSha, parents: [] });
		const branches = new Map<string, StubBranch>();
		const defaultBranch = options.defaultBranch ?? 'main';
		branches.set(defaultBranch, { name: defaultBranch, sha: commitSha });
		const repo: StubRepo = {
			owner,
			name,
			defaultBranch,
			blobs,
			trees,
			commits,
			branches,
			accessInstallationId: options.accessInstallationId,
			pullRequests: new Map(),
			nextPullNumber: 100,
			nextCommitNumber: 1,
		};
		this.repos.set(options.fullName, repo);
		return repo;
	}

	getRepo(fullName: string): StubRepo | undefined {
		return this.repos.get(fullName);
	}

	/** Current recorded head of a branch (or null). */
	branchHead(fullName: string, branch: string): string | null {
		return this.repos.get(fullName)?.branches.get(branch)?.sha ?? null;
	}

	/** Open PR for (repo, head branch), if any. */
	openPullRequest(fullName: string, headBranch: string): StubPullRequest | undefined {
		for (const pr of this.repos.get(fullName)?.pullRequests.values() ?? []) {
			if (pr.head === headBranch && pr.state === 'open') return pr;
		}
		return undefined;
	}

	/** Requests that would have mutated provider state (token minting excluded). */
	mutatingRequests(): StubRequest[] {
		return this.requests.filter((r) => {
			if (r.method === 'POST' && r.path.endsWith('/access_tokens')) return false;
			return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method);
		});
	}

	// --- lifecycle ----------------------------------------------------------------

	start(port: number): Promise<void> {
		const server = createServer((req, res) => {
			void this.handle(req, res);
		});
		this.server = server;
		return new Promise((resolve, reject) => {
			server.once('error', reject);
			server.listen(port, '127.0.0.1', () => {
				this.url = `http://127.0.0.1:${port}`;
				resolve();
			});
		});
	}

	stop(): Promise<void> {
		return new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	// --- auth ---------------------------------------------------------------------

	private authFromHeader(header: string | undefined): AuthResult {
		if (!header?.startsWith('Bearer ')) return null;
		const token = header.slice('Bearer '.length).trim();
		if (!token) return null;
		if (token.startsWith('ghs_')) {
			const stub = this.tokens.get(token);
			if (!stub || stub.expiresAt <= this.now()) return null;
			return { kind: 'installation-token', installationId: stub.installationId };
		}
		// App JWT: header.payload.signature — verify RS256 against the public key.
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		try {
			const verified = createVerify('RSA-SHA256')
				.update(`${parts[0]}.${parts[1]}`)
				.verify(this.appPublicKeyPem, base64UrlToBuffer(parts[2] ?? ''));
			if (!verified) return null;
			const claims = JSON.parse(base64UrlToBuffer(parts[1] ?? '').toString('utf8')) as {
				iss?: string;
				exp?: number;
			};
			if (!claims.iss || claims.exp === undefined || claims.exp * 1000 <= this.now()) return null;
			return { kind: 'app-jwt' };
		} catch {
			return null;
		}
	}

	// --- helpers --------------------------------------------------------------------

	private json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	}

	private resolveCommit(repo: StubRepo, refOrSha: string): StubCommit | null {
		const branch = repo.branches.get(refOrSha);
		if (branch) return repo.commits.get(branch.sha) ?? null;
		return repo.commits.get(refOrSha) ?? null;
	}

	private buildTree(repo: StubRepo, baseTreeSha: string | undefined, entries: StubTreeEntry[]): StubTree {
		const merged = new Map<string, StubTreeEntry>();
		const baseTree = baseTreeSha ? repo.trees.get(baseTreeSha) : undefined;
		if (baseTree) for (const entry of baseTree.entries) merged.set(entry.path, { ...entry });
		for (const entry of entries) merged.set(entry.path, { ...entry });
		const list = [...merged.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const sha = `tree-${sha1Hex(list.map((e) => `${e.mode} ${e.type} ${e.sha} ${e.path}`).join('\n') + this.now())}`;
		const tree = { sha, entries: list };
		repo.trees.set(sha, tree);
		return tree;
	}

	// --- request handling ------------------------------------------------------------

	private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const path = decodeURIComponent(url.pathname);
		const method = (req.method ?? 'GET').toUpperCase();
		const bodyBuf = await readBody(req);
		const body = bodyBuf.length > 0 ? safeJson(bodyBuf) : null;
		const auth = this.authFromHeader(req.headers.authorization);
		this.requests.push({
			method,
			path,
			authKind: auth === null ? 'none' : auth.kind,
			installationId: auth?.kind === 'installation-token' ? auth.installationId : null,
			body,
		});

		try {
			// --- App installation surface (App JWT auth) ---------------------------
			const tokenMintMatch = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
			if (method === 'POST' && tokenMintMatch) {
				if (auth?.kind !== 'app-jwt') return this.json(res, 401, { message: 'Bad credentials' });
				const installation = this.installations.get(tokenMintMatch[1] ?? '');
				if (!installation) return this.json(res, 404, { message: 'Not Found' });
				const token = `ghs_test_${(this.tokenCounter += 1)}_${randomBytes(6).toString('hex')}`;
				const expiresAt = this.now() + 10 * 60_000;
				this.tokens.set(token, { token, installationId: installation.installationId, expiresAt });
				return this.json(res, 201, {
					token,
					expires_at: new Date(expiresAt).toISOString(),
					permissions: installation.permissions,
				});
			}

			const installationMatch = path.match(/^\/app\/installations\/(\d+)$/);
			if (method === 'GET' && installationMatch) {
				if (auth?.kind !== 'app-jwt') return this.json(res, 401, { message: 'Bad credentials' });
				const installation = this.installations.get(installationMatch[1] ?? '');
				if (!installation) return this.json(res, 404, { message: 'Not Found' });
				return this.json(res, 200, {
					id: Number(installation.installationId),
					account: { login: installation.accountLogin },
					permissions: installation.permissions,
					app_slug: installation.appSlug,
					suspended_at: installation.suspended ? new Date(this.now()).toISOString() : null,
				});
			}

			// --- repo surface (installation token auth) -----------------------------
			const repoMatch = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
			if (!repoMatch) return this.json(res, 404, { message: `stub: no route for ${method} ${path}` });
			const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
			const repo = this.repos.get(fullName);
			if (!repo) return this.json(res, 404, { message: 'Not Found' });
			const sub = repoMatch[3] ?? '';

			if (auth?.kind !== 'installation-token') {
				return this.json(res, 401, { message: 'Requires an installation token' });
			}
			if (auth.installationId !== repo.accessInstallationId) {
				return this.json(res, 403, {
					message: `Resource not accessible by installation (${fullName} belongs to another installation)`,
				});
			}

			if (method === 'GET' && sub === '') {
				return this.json(res, 200, {
					name: repo.name,
					full_name: fullName,
					owner: { login: repo.owner },
					default_branch: repo.defaultBranch,
					html_url: `https://github.example/${fullName}`,
				});
			}

			const commitRefMatch = sub.match(/^\/commits\/(.+)$/);
			if (method === 'GET' && commitRefMatch) {
				const commit = this.resolveCommit(repo, commitRefMatch[1] ?? '');
				if (!commit) return this.json(res, 422, { message: `No commit found for SHA: ${commitRefMatch[1]}` });
				return this.json(res, 200, {
					sha: commit.sha,
					commit: { message: commit.message, tree: { sha: commit.tree } },
					parents: commit.parents.map((sha) => ({ sha })),
				});
			}

			const treeMatch = sub.match(/^\/git\/trees\/([0-9a-zA-Z-]+)$/);
			if (method === 'GET' && treeMatch) {
				const tree = repo.trees.get(treeMatch[1] ?? '');
				if (!tree) return this.json(res, 404, { message: 'Not Found' });
				return this.json(res, 200, { sha: tree.sha, tree: tree.entries, truncated: false });
			}

			const blobMatch = sub.match(/^\/git\/blobs\/([0-9a-zA-Z-]+)$/);
			if (method === 'GET' && blobMatch) {
				const blob = repo.blobs.get(blobMatch[1] ?? '');
				if (!blob) return this.json(res, 404, { message: 'Not Found' });
				return this.json(res, 200, {
					sha: blob.sha,
					content: blob.content.toString('base64'),
					encoding: 'base64',
				});
			}

			const refGetMatch = sub.match(/^\/git\/ref\/heads\/(.+)$/);
			if (method === 'GET' && refGetMatch) {
				const branch = repo.branches.get(refGetMatch[1] ?? '');
				if (!branch) return this.json(res, 404, { message: 'Not Found' });
				return this.json(res, 200, {
					ref: `refs/heads/${branch.name}`,
					object: { sha: branch.sha, type: 'commit' },
				});
			}

			if (method === 'POST' && sub === '/git/refs') {
				const payload = (body ?? {}) as { ref?: string; sha?: string };
				const branchName = String(payload.ref ?? '').replace(/^refs\/heads\//, '');
				if (!branchName || !payload.sha) return this.json(res, 422, { message: 'Validation Failed' });
				if (repo.branches.has(branchName)) {
					return this.json(res, 422, { message: 'Reference already exists' });
				}
				repo.branches.set(branchName, { name: branchName, sha: String(payload.sha) });
				return this.json(res, 201, { ref: `refs/heads/${branchName}`, object: { sha: String(payload.sha) } });
			}

			const refPatchMatch = sub.match(/^\/git\/refs\/heads\/(.+)$/);
			if (method === 'PATCH' && refPatchMatch) {
				const branchName = refPatchMatch[1] ?? '';
				const payload = (body ?? {}) as { sha?: string; force?: boolean };
				const force = payload.force === true;
				this.refUpdates.push({ repo: fullName, branch: branchName, force, accepted: false });
				if (force) {
					this.forceViolations += 1;
					return this.json(res, 422, { message: 'Rejected: force updates are not permitted (stub policy)' });
				}
				const branch = repo.branches.get(branchName);
				if (!branch) return this.json(res, 422, { message: 'Reference does not exist' });
				const commit = repo.commits.get(String(payload.sha ?? ''));
				if (!commit) return this.json(res, 422, { message: 'Object does not exist' });
				// GitHub enforces fast-forward when force is false.
				if (commit.parents[0] !== branch.sha) {
					return this.json(res, 422, { message: 'Update is not a fast forward' });
				}
				branch.sha = String(payload.sha);
				const update = this.refUpdates[this.refUpdates.length - 1];
				if (update) update.accepted = true;
				return this.json(res, 200, { ref: `refs/heads/${branchName}`, object: { sha: branch.sha } });
			}

			if (method === 'POST' && sub === '/git/blobs') {
				const payload = (body ?? {}) as { content?: string; encoding?: string };
				const content =
					payload.encoding === 'base64'
						? Buffer.from(String(payload.content ?? ''), 'base64')
						: Buffer.from(String(payload.content ?? ''), 'utf8');
				const sha = sha1Hex(content);
				repo.blobs.set(sha, { sha, content });
				return this.json(res, 201, { sha });
			}

			if (method === 'POST' && sub === '/git/trees') {
				const payload = (body ?? {}) as {
					base_tree?: string;
					tree?: Array<{ path: string; sha: string; mode?: string }>;
				};
				const provided: StubTreeEntry[] = [];
				for (const item of payload.tree ?? []) {
					const blob = item.sha ? repo.blobs.get(item.sha) : undefined;
					provided.push({
						path: String(item.path),
						mode: item.mode ?? '100644',
						type: 'blob',
						sha: String(item.sha ?? ''),
						size: blob?.content.length ?? 0,
					});
				}
				const tree = this.buildTree(repo, payload.base_tree, provided);
				return this.json(res, 201, { sha: tree.sha });
			}

			if (method === 'POST' && sub === '/git/commits') {
				const payload = (body ?? {}) as { message?: string; tree?: string; parents?: string[] };
				const parents = payload.parents ?? [];
				const sha = `c${(repo.nextCommitNumber += 1)}-${sha1Hex(
					`${payload.message ?? ''}:${payload.tree ?? ''}:${parents.join(',')}:${this.now()}`,
				)}`;
				repo.commits.set(sha, {
					sha,
					message: String(payload.message ?? ''),
					tree: String(payload.tree ?? ''),
					parents,
				});
				return this.json(res, 201, {
					sha,
					commit: { message: payload.message, tree: { sha: payload.tree } },
					parents: parents.map((p) => ({ sha: p })),
				});
			}

			if (method === 'POST' && sub === '/pulls') {
				const payload = (body ?? {}) as { title?: string; head?: string; base?: string; body?: string };
				const headBranch = String(payload.head ?? '');
				for (const pr of repo.pullRequests.values()) {
					if (pr.head === headBranch && pr.state === 'open') {
						return this.json(res, 422, {
							message: 'Validation Failed',
							errors: [{ message: `A pull request already exists for ${repo.owner}:${headBranch}.` }],
						});
					}
				}
				const number = (repo.nextPullNumber += 1);
				const headSha = repo.branches.get(headBranch)?.sha ?? '';
				const pr: StubPullRequest = {
					number,
					title: String(payload.title ?? ''),
					body: String(payload.body ?? ''),
					head: headBranch,
					base: String(payload.base ?? ''),
					headSha,
					state: 'open',
					htmlUrl: `https://github.example/${fullName}/pull/${number}`,
				};
				repo.pullRequests.set(`pr-${number}`, pr);
				// Wire shape mirrors the real GitHub PR object (head/base objects).
				return this.json(res, 201, serializePullRequest(pr));
			}

			if (method === 'GET' && sub === '/pulls') {
				const head = url.searchParams.get('head') ?? '';
				const state = url.searchParams.get('state') ?? 'open';
				const headBranch = head.includes(':') ? (head.split(':')[1] ?? '') : head;
				const list = [...repo.pullRequests.values()].filter(
					(pr) => pr.head === headBranch && (state === 'all' || pr.state === state),
				);
				return this.json(res, 200, list.map(serializePullRequest));
			}

			return this.json(res, 404, { message: `stub: no route for ${method} ${path}` });
		} catch (error) {
			return this.json(res, 500, { message: `stub error: ${String(error)}` });
		}
	}
}
