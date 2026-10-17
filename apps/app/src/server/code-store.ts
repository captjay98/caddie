/**
 * The code store port: where every project's code history lives.
 *
 * One repository per project (`repoNameFor(projectId)`). Each commit is a
 * COMPLETE snapshot of the project's source (no partial writes): files absent
 * from a snapshot are deleted in that commit. Commits are created ONLY by
 * Caddie's server — never by the build sandbox, which holds no credentials.
 *
 * Implementations:
 *   - `adapters/cloudflare-artifacts.ts` — Cloudflare Artifacts (production):
 *     control plane + reads through the Artifacts API, writes as a git push
 *     with a short-lived write token.
 *   - `LocalCodeStore` in `code-versions.ts` — Caddie's own D1 (local dev and
 *     tests, and any deployment without Artifacts configured).
 *
 * Both must pass the same contract tests (tests/code-store.contract.test.ts).
 */

export interface CodeFile {
	/** POSIX path relative to the project root, no leading slash, no `..`. */
	path: string;
	contentBase64: string;
}

export interface CodeAuthor {
	name: string;
	email: string;
}

export interface CodeCommitInput {
	repo: string;
	/** The complete snapshot. Order does not matter; duplicate paths are refused. */
	files: CodeFile[];
	message: string;
	author: CodeAuthor;
	/**
	 * The head this snapshot was based on (optimistic concurrency): `null` only
	 * for a repo's first commit. A different current head refuses the commit
	 * with CodeStoreError('HEAD_MOVED').
	 */
	parent: string | null;
}

export interface CodeCommit {
	/** Commit id (a git SHA-1 hex for Artifacts; an opaque id for the local store). */
	id: string;
	message: string;
	/** ISO time. */
	createdAt: string;
	parents: string[];
}

export interface CodeTreeEntry {
	path: string;
	size: number;
}

export type CodeStoreErrorCode =
	| 'NOT_CONFIGURED'
	| 'REPO_NOT_FOUND'
	| 'COMMIT_NOT_FOUND'
	| 'FILE_NOT_FOUND'
	| 'HEAD_MOVED'
	| 'INVALID_INPUT'
	| 'TOO_LARGE'
	| 'IMPORT_FAILED'
	| 'UPSTREAM';

export class CodeStoreError extends Error {
	constructor(
		readonly code: CodeStoreErrorCode,
		message: string,
		readonly status = 502,
	) {
		super(message);
		this.name = 'CodeStoreError';
	}
}

export interface CodeStore {
	readonly kind: 'artifacts' | 'local';
	/** Create the repo if it does not exist (idempotent). */
	ensureRepo(repo: string): Promise<void>;
	/** Current head commit id of the default branch, or null when empty. */
	head(repo: string): Promise<string | null>;
	commit(input: CodeCommitInput): Promise<CodeCommit>;
	/** Newest first, at most `limit`. */
	log(repo: string, limit: number): Promise<CodeCommit[]>;
	readTree(repo: string, commit: string): Promise<CodeTreeEntry[]>;
	readFile(repo: string, commit: string, path: string): Promise<Uint8Array>;
	/**
	 * Copy a PUBLIC https git remote's branch into a NEW repo (fails when the
	 * repo already has commits). Private remotes are copied by the caller
	 * (read with the GitHub App token, then `commit`).
	 */
	importPublic(repo: string, url: string, branch?: string): Promise<CodeCommit>;
}

/** Size caps shared by every implementation (match source-export.ts caps). */
export const CODE_STORE_CAPS = {
	maxFiles: 400,
	maxFileBytes: 2 * 1024 * 1024,
	maxSnapshotBytes: 24 * 1024 * 1024,
} as const;

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\\]+$/;

export function repoNameFor(projectId: string): string {
	return `p-${projectId.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`.slice(0, 63);
}

/** Validates a snapshot against the shared rules; throws INVALID_INPUT / TOO_LARGE. */
export function assertValidSnapshot(files: readonly CodeFile[]): void {
	if (files.length === 0) throw new CodeStoreError('INVALID_INPUT', 'A snapshot needs at least one file.', 400);
	if (files.length > CODE_STORE_CAPS.maxFiles)
		throw new CodeStoreError('TOO_LARGE', `A snapshot can hold at most ${CODE_STORE_CAPS.maxFiles} files.`, 413);
	const seen = new Set<string>();
	let total = 0;
	for (const file of files) {
		if (!SAFE_PATH.test(file.path) || file.path.endsWith('/') || file.path.split('/').includes('.git'))
			throw new CodeStoreError('INVALID_INPUT', `Unsafe path in snapshot: ${file.path}`, 400);
		if (seen.has(file.path)) throw new CodeStoreError('INVALID_INPUT', `Duplicate path in snapshot: ${file.path}`, 400);
		seen.add(file.path);
		const bytes = Math.floor((file.contentBase64.length * 3) / 4);
		if (bytes > CODE_STORE_CAPS.maxFileBytes)
			throw new CodeStoreError('TOO_LARGE', `${file.path} is larger than ${CODE_STORE_CAPS.maxFileBytes} bytes.`, 413);
		total += bytes;
	}
	if (total > CODE_STORE_CAPS.maxSnapshotBytes)
		throw new CodeStoreError('TOO_LARGE', `The snapshot is larger than ${CODE_STORE_CAPS.maxSnapshotBytes} bytes.`, 413);
}
