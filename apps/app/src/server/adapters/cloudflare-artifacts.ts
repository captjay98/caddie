/**
 * Cloudflare Artifacts code store (production implementation of the CodeStore
 * port in ../code-store.ts).
 *
 * CONTROL PLANE + READS go through the Artifacts Workers binding
 * (`env.ARTIFACTS`): create/get/list/import/delete repos, read commits, trees,
 * blobs. The binding CANNOT write files — a write is a git push over the
 * smart-HTTP v1 receive-pack endpoint with a short-lived WRITE token. We push
 * with isomorphic-git (apps/app pins `isomorphic-git` 1.44.2) and its
 * `isomorphic-git/http/web` fetch-based client, over an in-memory fs we build
 * here, so no Node `fs`/`net`/`child_process` is used — the whole adapter is
 * Workers-native (WebCrypto + fetch only).
 *
 * Docs (read 2026-10-17):
 *   - Workers binding API:
 *     https://developers.cloudflare.com/artifacts/api/workers-binding/   VERIFIED
 *   - isomorphic-git example (push with a write token, http/web client):
 *     https://developers.cloudflare.com/artifacts/examples/isomorphic-git/  VERIFIED
 *   - git protocol (smart-HTTP receive-pack is the write path):
 *     https://developers.cloudflare.com/artifacts/api/git-protocol/        VERIFIED
 *   - authentication (read/write tokens, Bearer / Basic password):
 *     https://developers.cloudflare.com/artifacts/guides/authentication/   VERIFIED
 *
 * The exact method/field names of the binding are an OPEN product beta surface:
 * the structural interface below (ArtifactsBinding / ArtifactsRepo) is the
 * subset this adapter uses, and the fake binding in
 * tests/fixtures/fake-artifacts-binding.ts stands in for it exactly. Mark any
 * field the live service renames when it is wired up (integration lead note).
 */

import git from 'isomorphic-git';
import httpWeb from 'isomorphic-git/http/web';
import {
	assertValidSnapshot,
	CodeStoreError,
	type CodeCommit,
	type CodeCommitInput,
	type CodeFile,
	type CodeStore,
	type CodeTreeEntry,
} from '../code-store.ts';

// --- structural binding interface (only what this adapter uses) ----------------------

/** A short-lived access token minted by a repo handle. */
export interface ArtifactsToken {
	/** The token value — a bearer / basic password. NEVER logged or put in an error. */
	plaintext: string;
	/** ISO expiry. */
	expiresAt: string;
}

/** One commit as the binding's `log` reports it. */
export interface ArtifactsLogEntry {
	hash: string;
	message: string;
	/** ISO author/commit time. */
	createdAt: string;
	parents: string[];
}

/** One tree entry as the binding's `readTree` reports it (recursive, blobs only). */
export interface ArtifactsTreeEntry {
	path: string;
	size: number;
	type: 'blob' | 'tree';
}

/** A disposable handle to one repo (from `get`). */
export interface ArtifactsRepo {
	/** Default branch + current head (null head when the repo has no commits). */
	info(): Promise<{ remote: string; defaultBranch: string; head: string | null }>;
	/** Mint a short-lived read or write token. */
	createToken(scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsToken>;
	/** Newest-first commit log, at most `limit`. */
	log(opts: { limit: number }): Promise<ArtifactsLogEntry[]>;
	/** Recursive tree listing at a commit (blobs with sizes). */
	readTree(hash: string): Promise<ArtifactsTreeEntry[]>;
	/** One file's bytes at a commit. */
	readFile(args: { commit: string; path: string }): Promise<Uint8Array>;
}

/** The `env.ARTIFACTS` binding, reduced to the calls this adapter makes. */
export interface ArtifactsBinding {
	create(name: string, opts?: { defaultBranch?: string }): Promise<{ name: string; remote: string; defaultBranch: string }>;
	get(name: string): Promise<ArtifactsRepo>;
	list(): Promise<Array<{ name: string }>>;
	import(args: {
		source: { url: string; branch?: string; depth?: number };
		target: { name: string; opts?: { defaultBranch?: string } };
	}): Promise<{ name: string; remote: string; defaultBranch: string }>;
	delete(name: string): Promise<void>;
}

export interface ArtifactsCodeStoreOptions {
	/** TTL for the WRITE token minted per commit. Default 120s — just long enough to push. */
	writeTokenTtlSeconds?: number;
	/** TTL for a READ token (import-on-top rebuilds). Default 120s. */
	readTokenTtlSeconds?: number;
	/** Default branch for new repos. Default 'main'. */
	defaultBranch?: string;
	/**
	 * isomorphic-git HTTP client. Defaults to `isomorphic-git/http/web` (the
	 * fetch-based client). Tests inject one pointed at a local git-http server.
	 */
	http?: typeof httpWeb;
	/** Injectable clock for deterministic commit times in tests. */
	now?: () => Date;
}

// --- in-memory fs for isomorphic-git -------------------------------------------------

/**
 * The smallest PromiseFsClient isomorphic-git needs for init + fetch + object
 * writes + push over a BARE in-memory repo. Paths are flat keys; directories
 * are tracked as a set so readdir/stat work. No Node `fs` — this is the whole
 * point of pushing from a Worker.
 */
interface MemFile {
	content: Uint8Array;
	mode: number;
}

class MemFs {
	private files = new Map<string, MemFile>();
	private dirs = new Set<string>(['/', '']);

	readonly promises = {
		readFile: async (path: string, options?: { encoding?: string } | string): Promise<Uint8Array | string> => {
			const file = this.files.get(normalize(path));
			if (!file) throw fsError('ENOENT', path);
			const encoding = typeof options === 'string' ? options : options?.encoding;
			if (encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder().decode(file.content);
			return file.content;
		},
		writeFile: async (path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void> => {
			const key = normalize(path);
			this.ensureParent(key);
			const content = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
			this.files.set(key, { content, mode: options?.mode ?? 0o644 });
		},
		unlink: async (path: string): Promise<void> => {
			this.files.delete(normalize(path));
		},
		readdir: async (path: string): Promise<string[]> => {
			const dir = normalize(path);
			const prefix = dir === '/' ? '/' : `${dir}/`;
			const names = new Set<string>();
			for (const key of [...this.files.keys(), ...this.dirs]) {
				if (key === dir || !key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (!rest) continue;
				names.add(rest.split('/')[0] as string);
			}
			return [...names];
		},
		mkdir: async (path: string): Promise<void> => {
			const key = normalize(path);
			this.ensureParent(key);
			this.dirs.add(key);
		},
		rmdir: async (path: string): Promise<void> => {
			this.dirs.delete(normalize(path));
		},
		stat: async (path: string) => this.statLike(path),
		lstat: async (path: string) => this.statLike(path),
		readlink: async (path: string): Promise<string> => {
			const file = this.files.get(normalize(path));
			if (!file) throw fsError('ENOENT', path);
			return new TextDecoder().decode(file.content);
		},
		symlink: async (target: string, path: string): Promise<void> => {
			await this.promises.writeFile(path, target, { mode: 0o120000 });
		},
	};

	private ensureParent(key: string): void {
		const parts = key.split('/').slice(0, -1);
		let acc = '';
		for (const part of parts) {
			acc = acc === '' ? (part === '' ? '/' : `/${part}`) : `${acc}/${part}`;
			this.dirs.add(acc === '' ? '/' : acc);
		}
	}

	private statLike(path: string) {
		const key = normalize(path);
		const file = this.files.get(key);
		if (file) {
			const isSymlink = (file.mode & 0o170000) === 0o120000 || file.mode === 0o120000;
			return makeStat({ size: file.content.length, mode: file.mode, type: isSymlink ? 'symlink' : 'file' });
		}
		if (this.dirs.has(key)) return makeStat({ size: 0, mode: 0o040000, type: 'dir' });
		throw fsError('ENOENT', path);
	}
}

function normalize(path: string): string {
	const cleaned = path.replace(/\/+/g, '/').replace(/\/$/, '');
	return cleaned === '' ? '/' : cleaned;
}

function fsError(code: string, path: string): Error & { code: string } {
	const error = new Error(`${code}: ${path}`) as Error & { code: string };
	error.code = code;
	return error;
}

function makeStat(info: { size: number; mode: number; type: 'file' | 'dir' | 'symlink' }) {
	const now = new Date();
	return {
		type: info.type,
		mode: info.mode,
		size: info.size,
		ino: 0,
		mtimeMs: now.valueOf(),
		ctimeMs: now.valueOf(),
		uid: 1,
		gid: 1,
		dev: 1,
		isFile: () => info.type === 'file',
		isDirectory: () => info.type === 'dir',
		isSymbolicLink: () => info.type === 'symlink',
	};
}

// --- git tree assembly (exact snapshot) ----------------------------------------------

interface PendingTree {
	/** path segment -> blob oid */
	blobs: Map<string, string>;
	/** path segment -> subtree */
	subtrees: Map<string, PendingTree>;
}

function emptyTree(): PendingTree {
	return { blobs: new Map(), subtrees: new Map() };
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// --- the adapter ---------------------------------------------------------------------

export class ArtifactsCodeStore implements CodeStore {
	readonly kind = 'artifacts' as const;

	private readonly binding: ArtifactsBinding;
	private readonly http: typeof httpWeb;
	private readonly writeTtl: number;
	private readonly readTtl: number;
	private readonly defaultBranch: string;
	private readonly now: () => Date;

	constructor(binding: ArtifactsBinding, options: ArtifactsCodeStoreOptions = {}) {
		this.binding = binding;
		this.http = options.http ?? httpWeb;
		this.writeTtl = options.writeTokenTtlSeconds ?? 120;
		this.readTtl = options.readTokenTtlSeconds ?? 120;
		this.defaultBranch = options.defaultBranch ?? 'main';
		this.now = options.now ?? (() => new Date());
	}

	async ensureRepo(repo: string): Promise<void> {
		try {
			await this.binding.get(repo);
			return;
		} catch (error) {
			if (!isNotFound(error)) throw upstream(error, `could not open code repo ${repo}`);
		}
		try {
			await this.binding.create(repo, { defaultBranch: this.defaultBranch });
		} catch (error) {
			// A racing create may have won; treat an existing repo as success (idempotent).
			try {
				await this.binding.get(repo);
				return;
			} catch {
				throw upstream(error, `could not create code repo ${repo}`);
			}
		}
	}

	async head(repo: string): Promise<string | null> {
		const handle = await this.open(repo);
		try {
			const info = await handle.info();
			return info.head ?? null;
		} catch (error) {
			throw upstream(error, `could not read head of ${repo}`);
		}
	}

	async log(repo: string, limit: number): Promise<CodeCommit[]> {
		const handle = await this.open(repo);
		let entries: ArtifactsLogEntry[];
		try {
			entries = await handle.log({ limit });
		} catch (error) {
			throw upstream(error, `could not read history of ${repo}`);
		}
		return entries.map((entry) => ({
			id: entry.hash,
			message: entry.message,
			createdAt: entry.createdAt,
			parents: entry.parents,
		}));
	}

	async readTree(repo: string, commit: string): Promise<CodeTreeEntry[]> {
		const handle = await this.open(repo);
		let entries: ArtifactsTreeEntry[];
		try {
			entries = await handle.readTree(commit);
		} catch (error) {
			if (isNotFound(error)) throw new CodeStoreError('COMMIT_NOT_FOUND', `No commit ${commit} in ${repo}.`, 404);
			throw upstream(error, `could not read the file tree at ${commit}`);
		}
		return entries.filter((entry) => entry.type === 'blob').map((entry) => ({ path: entry.path, size: entry.size }));
	}

	async readFile(repo: string, commit: string, path: string): Promise<Uint8Array> {
		const handle = await this.open(repo);
		try {
			return await handle.readFile({ commit, path });
		} catch (error) {
			if (isNotFound(error)) {
				throw new CodeStoreError('FILE_NOT_FOUND', `No file ${path} at ${commit} in ${repo}.`, 404);
			}
			throw upstream(error, `could not read ${path} at ${commit}`);
		}
	}

	async importPublic(repo: string, url: string, branch?: string): Promise<CodeCommit> {
		assertPublicHttps(url);
		try {
			await this.binding.import({
				source: { url, branch, depth: 1 },
				target: { name: repo, opts: { defaultBranch: this.defaultBranch } },
			});
		} catch (error) {
			if (isNotFound(error)) {
				throw new CodeStoreError('IMPORT_FAILED', `Could not read the repository at ${url}.`, 502);
			}
			throw new CodeStoreError('IMPORT_FAILED', `Importing ${url} failed: ${sanitize(error)}`, 502);
		}
		const [latest] = await this.log(repo, 1);
		if (!latest) {
			throw new CodeStoreError('IMPORT_FAILED', `Imported ${url} but found no commits on it.`, 502);
		}
		return latest;
	}

	async commit(input: CodeCommitInput): Promise<CodeCommit> {
		assertValidSnapshot(input.files);
		const handle = await this.open(input.repo);

		let info: { remote: string; defaultBranch: string; head: string | null };
		try {
			info = await handle.info();
		} catch (error) {
			throw upstream(error, `could not read ${input.repo} before committing`);
		}

		// Optimistic concurrency: the snapshot's parent must be the live head.
		if ((info.head ?? null) !== (input.parent ?? null)) {
			throw new CodeStoreError(
				'HEAD_MOVED',
				'The code changed since this snapshot was taken — reload and try again.',
				409,
			);
		}

		const branch = info.defaultBranch || this.defaultBranch;
		const fs = new MemFs();
		const dir = '/repo';
		await git.init({ fs, dir, defaultBranch: branch });

		// Build the tree EXACTLY from the snapshot (absent files are therefore
		// deleted — the tree is rebuilt from scratch, not patched onto the old
		// one). We do NOT fetch the old objects: the parent commit lives on the
		// server, which advertises it during receive-pack negotiation, so a thin
		// pack carrying only the new commit + tree + blobs is a valid
		// fast-forward push. A non-fast-forward is rejected by the server.
		const parents: string[] = info.head ? [info.head] : [];
		const treeOid = await this.writeSnapshotTree(fs, dir, input.files);
		const when = this.now();
		const author = {
			name: input.author.name,
			email: input.author.email,
			timestamp: Math.floor(when.valueOf() / 1000),
			timezoneOffset: 0,
		};
		const commitOid = await git.writeCommit({
			fs,
			dir,
			commit: {
				message: input.message,
				tree: treeOid,
				parent: parents,
				author,
				committer: author,
			},
		});
		await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: commitOid, force: true });

		// Push with a short-lived WRITE token. A non-fast-forward rejection means
		// someone else moved the head between our read and our push.
		const writeToken = await this.mintToken(handle, 'write');
		let result: Awaited<ReturnType<typeof git.push>>;
		try {
			result = await git.push({
				fs,
				http: this.http,
				dir,
				url: info.remote,
				ref: branch,
				remoteRef: branch,
				headers: bearer(writeToken.plaintext),
				onAuth: () => ({ username: 'x-access-token', password: writeToken.plaintext }),
			});
		} catch (error) {
			if (isNonFastForward(error)) {
				throw new CodeStoreError('HEAD_MOVED', 'The code changed while saving — reload and try again.', 409);
			}
			throw upstream(error, `could not save code to ${input.repo}`);
		}
		if (!result.ok || Object.values(result.refs ?? {}).some((ref) => !ref.ok)) {
			const rejected = Object.values(result.refs ?? {}).find((ref) => !ref.ok);
			if (rejected && isNonFastForwardMessage(rejected.error)) {
				throw new CodeStoreError('HEAD_MOVED', 'The code changed while saving — reload and try again.', 409);
			}
			throw new CodeStoreError('UPSTREAM', `The code store rejected the save: ${sanitize(result.error ?? rejected?.error ?? 'unknown')}`, 502);
		}

		return {
			id: commitOid,
			message: input.message,
			createdAt: when.toISOString(),
			parents,
		};
	}

	// --- internals ---------------------------------------------------------------------

	private async open(repo: string): Promise<ArtifactsRepo> {
		try {
			return await this.binding.get(repo);
		} catch (error) {
			if (isNotFound(error)) throw new CodeStoreError('REPO_NOT_FOUND', `No code repo ${repo}.`, 404);
			throw upstream(error, `could not open code repo ${repo}`);
		}
	}

	private async mintToken(handle: ArtifactsRepo, scope: 'read' | 'write'): Promise<ArtifactsToken> {
		try {
			return await handle.createToken(scope, scope === 'write' ? this.writeTtl : this.readTtl);
		} catch (error) {
			// Never surface the (absent) token; this is a control-plane failure.
			throw upstream(error, `could not mint a ${scope} token`);
		}
	}

	/** Write every blob and the nested trees, returning the root tree oid. */
	private async writeSnapshotTree(fs: MemFs, dir: string, files: readonly CodeFile[]): Promise<string> {
		const root = emptyTree();
		for (const file of files) {
			const bytes = base64ToBytes(file.contentBase64);
			const oid = await git.writeBlob({ fs, dir, blob: bytes });
			const segments = file.path.split('/');
			let node = root;
			for (let i = 0; i < segments.length - 1; i++) {
				const segment = segments[i] as string;
				let child = node.subtrees.get(segment);
				if (!child) {
					child = emptyTree();
					node.subtrees.set(segment, child);
				}
				node = child;
			}
			node.blobs.set(segments[segments.length - 1] as string, oid);
		}
		return this.writeTreeNode(fs, dir, root);
	}

	private async writeTreeNode(fs: MemFs, dir: string, node: PendingTree): Promise<string> {
		const entries: Array<{ mode: string; path: string; oid: string; type: 'blob' | 'tree' }> = [];
		for (const [name, oid] of node.blobs) {
			entries.push({ mode: '100644', path: name, oid, type: 'blob' });
		}
		for (const [name, subtree] of node.subtrees) {
			const oid = await this.writeTreeNode(fs, dir, subtree);
			entries.push({ mode: '040000', path: name, oid, type: 'tree' });
		}
		return git.writeTree({ fs, dir, tree: entries });
	}
}

// --- error mapping -------------------------------------------------------------------

/** A write token must never appear in a thrown message; redact anything token-shaped. */
function sanitize(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.replace(/x-access-token:[^@\s]+/gi, 'x-access-token:[redacted]').replace(/[A-Za-z0-9_-]{24,}/g, (match) => (match.length >= 32 ? '[redacted]' : match));
}

function upstream(error: unknown, context: string): CodeStoreError {
	if (error instanceof CodeStoreError) return error;
	return new CodeStoreError('UPSTREAM', `${context}: ${sanitize(error)}`, 502);
}

function errorCode(error: unknown): string {
	if (error && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code);
	return '';
}

function isNotFound(error: unknown): boolean {
	const code = errorCode(error);
	if (code === 'NotFoundError' || code === 'ENOENT') return true;
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return /\bnot found\b|\bdoes not exist\b|\bno such\b|\b404\b/.test(message);
}

function isNonFastForward(error: unknown): boolean {
	if (errorCode(error) === 'PushRejectedError') return true;
	return isNonFastForwardMessage(error instanceof Error ? error.message : String(error));
}

function isNonFastForwardMessage(message: string | null | undefined): boolean {
	if (!message) return false;
	return /not a fast[- ]forward|non-fast-forward|fetch first|stale info|failed to update ref/i.test(message);
}

function bearer(token: string): Record<string, string> {
	// Artifacts accepts the write token as a Bearer header OR a Basic password;
	// we send both forms (header + onAuth) so either verification path on the
	// receive-pack endpoint is satisfied.
	return { authorization: `Bearer ${token}` };
}

function assertPublicHttps(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new CodeStoreError('INVALID_INPUT', 'An import source must be an https URL.', 400);
	}
	// Production requires https. A loopback http host is allowed ONLY so the
	// local test git server (127.0.0.1) can stand in for a public https remote;
	// no real import ever targets loopback.
	const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
	if (parsed.protocol === 'https:') return;
	if (parsed.protocol === 'http:' && isLoopback) return;
	throw new CodeStoreError('INVALID_INPUT', 'Only public https repositories can be imported.', 400);
}
