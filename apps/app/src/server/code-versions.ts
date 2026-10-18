/**
 * Code versions (Publish programme, stage 1).
 *
 * Every save point of a project's code — a feature that went green, a checked
 * build, a restore, an import — becomes ONE commit in the project's code store
 * plus one `code_versions` row the Versions list reads. Commits are written
 * only here, on Caddie's server; the build sandbox never sees a credential.
 *
 * `LocalCodeStore` is the D1-backed CodeStore used whenever Cloudflare
 * Artifacts is not configured (local dev, tests, a deployment without it). It
 * keeps complete snapshots whose file bytes live in the content-addressed
 * artifact_content table, so identical files across versions are stored once.
 */
import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { base64ToBytes, bytesToBase64 } from './adapters/contree.ts';
import { createD1ContentStore, sha256Hex, type ArtifactContentStore } from './artifacts.ts';
import {
	CodeStoreError,
	assertValidSnapshot,
	repoNameFor,
	type CodeCommit,
	type CodeCommitInput,
	type CodeFile,
	type CodeStore,
	type CodeTreeEntry,
} from './code-store.ts';
import { assertProjectScope } from './scope.ts';

interface TreeRow {
	path: string;
	size: number;
	sha256: string;
}

async function rows(db: D1Database, sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]> {
	const res = await db.prepare(sql).bind(...params).all();
	return (res.results ?? []) as Record<string, unknown>[];
}

function parseTree(raw: unknown): TreeRow[] {
	try {
		const parsed = JSON.parse(String(raw)) as TreeRow[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export class LocalCodeStore implements CodeStore {
	readonly kind = 'local' as const;
	private readonly content: ArtifactContentStore;

	constructor(private readonly db: D1Database, content?: ArtifactContentStore) {
		this.content = content ?? createD1ContentStore(db);
	}

	async ensureRepo(repo: string): Promise<void> {
		await this.db
			.prepare('insert or ignore into "local_code_heads" ("repo","head","updatedAt") values (?,null,?)')
			.bind(repo, new Date().toISOString())
			.run();
	}

	async head(repo: string): Promise<string | null> {
		const found = (await rows(this.db, 'select "head" from "local_code_heads" where "repo" = ?', repo))[0];
		return found && found['head'] !== null && found['head'] !== undefined ? String(found['head']) : null;
	}

	async commit(input: CodeCommitInput): Promise<CodeCommit> {
		assertValidSnapshot(input.files);
		await this.ensureRepo(input.repo);
		if ((await this.head(input.repo)) !== input.parent) {
			throw new CodeStoreError('HEAD_MOVED', 'The code changed since this version was prepared. Try again.', 409);
		}
		const tree: TreeRow[] = [];
		for (const file of [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
			const bytes = base64ToBytes(file.contentBase64);
			const stored = await this.content.put(bytes);
			tree.push({ path: file.path, size: bytes.byteLength, sha256: stored.contentHash });
		}
		const createdAt = new Date().toISOString();
		const treeJson = JSON.stringify(tree);
		const id = (
			await sha256Hex(
				new TextEncoder().encode(JSON.stringify([input.repo, input.parent, treeJson, input.message, input.author, createdAt])),
			)
		).slice(0, 40);
		const results = await this.db.batch([
			this.db
				.prepare(
					'insert into "local_code_commits" ("repo","id","parentId","message","authorName","authorEmail","tree","createdAt") values (?,?,?,?,?,?,?,?)',
				)
				.bind(input.repo, id, input.parent, input.message, input.author.name, input.author.email, treeJson, createdAt),
			// Compare-and-set on the head: a concurrent commit loses instead of forking history.
			this.db
				.prepare('update "local_code_heads" set "head" = ?, "updatedAt" = ? where "repo" = ? and "head" is ?')
				.bind(id, createdAt, input.repo, input.parent),
		]);
		const changed = Number((results[1] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
		if (changed !== 1 && (await this.head(input.repo)) !== id) {
			throw new CodeStoreError('HEAD_MOVED', 'The code changed since this version was prepared. Try again.', 409);
		}
		return { id, message: input.message, createdAt, parents: input.parent ? [input.parent] : [] };
	}

	async log(repo: string, limit: number): Promise<CodeCommit[]> {
		const out: CodeCommit[] = [];
		let cursor = await this.head(repo);
		while (cursor && out.length < Math.max(0, limit)) {
			const row = (
				await rows(this.db, 'select "id","parentId","message","createdAt" from "local_code_commits" where "repo" = ? and "id" = ?', repo, cursor)
			)[0];
			if (!row) break;
			const parent = row['parentId'] === null || row['parentId'] === undefined ? null : String(row['parentId']);
			out.push({ id: String(row['id']), message: String(row['message']), createdAt: String(row['createdAt']), parents: parent ? [parent] : [] });
			cursor = parent;
		}
		return out;
	}

	private async treeOf(repo: string, commit: string): Promise<TreeRow[]> {
		const row = (await rows(this.db, 'select "tree" from "local_code_commits" where "repo" = ? and "id" = ?', repo, commit))[0];
		if (!row) {
			const known = (await rows(this.db, 'select 1 from "local_code_heads" where "repo" = ?', repo))[0];
			throw known
				? new CodeStoreError('COMMIT_NOT_FOUND', 'That version does not exist.', 404)
				: new CodeStoreError('REPO_NOT_FOUND', 'This project has no saved code yet.', 404);
		}
		return parseTree(row['tree']);
	}

	async readTree(repo: string, commit: string): Promise<CodeTreeEntry[]> {
		return (await this.treeOf(repo, commit)).map(({ path, size }) => ({ path, size }));
	}

	async readFile(repo: string, commit: string, path: string): Promise<Uint8Array> {
		const entry = (await this.treeOf(repo, commit)).find((item) => item.path === path);
		if (!entry) throw new CodeStoreError('FILE_NOT_FOUND', `${path} is not in that version.`, 404);
		const bytes = await this.content.get(entry.sha256);
		if (!bytes) throw new CodeStoreError('UPSTREAM', `${path} could not be read.`, 502);
		return bytes;
	}

	async importPublic(): Promise<CodeCommit> {
		throw new CodeStoreError(
			'NOT_CONFIGURED',
			'Copying straight from a git address needs Cloudflare Artifacts, which is not connected here.',
			503,
		);
	}
}

// --- versions ----------------------------------------------------------------

export type CodeVersionKind = 'feature' | 'build' | 'restore' | 'import';

export interface CodeVersionView {
	commitId: string;
	seq: number;
	kind: CodeVersionKind;
	title: string;
	fileCount: number;
	totalBytes: number;
	featureId: string | null;
	outputId: string | null;
	/** Whether the sandbox image is recorded (the fast path for Restore). */
	hasImage: boolean;
	skipped: Array<{ path: string; reason: string }>;
	createdAt: string;
	createdBy: string;
}

export interface RecordVersionInput {
	kind: CodeVersionKind;
	title: string;
	files: CodeFile[];
	skipped?: Array<{ path: string; reason: string }>;
	featureId?: string | null;
	planId?: string | null;
	image?: string | null;
	outputId?: string | null;
	actorId: string;
}

const CADDIE_AUTHOR = { name: 'Caddie', email: 'builds@caddie.invalid' } as const;

function versionFromRow(row: Record<string, unknown>): CodeVersionView {
	let skipped: CodeVersionView['skipped'] = [];
	try {
		const parsed = JSON.parse(String(row['skipped'] ?? '[]'));
		if (Array.isArray(parsed)) skipped = parsed;
	} catch {
		skipped = [];
	}
	const text = (key: string) => (row[key] === null || row[key] === undefined ? null : String(row[key]));
	return {
		commitId: String(row['commitId']),
		seq: Number(row['seq']),
		kind: String(row['kind']) as CodeVersionKind,
		title: String(row['title']),
		fileCount: Number(row['fileCount']),
		totalBytes: Number(row['totalBytes']),
		featureId: text('featureId'),
		outputId: text('outputId'),
		hasImage: text('image') !== null,
		skipped,
		createdAt: String(row['createdAt']),
		createdBy: String(row['createdBy']),
	};
}

/** Files of a snapshot in a stable order, for "did anything change?" checks. */
export async function snapshotDigest(files: readonly CodeFile[]): Promise<string> {
	const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const parts: string[] = [];
	for (const file of ordered) parts.push(`${file.path}\u0000${await sha256Hex(base64ToBytes(file.contentBase64))}`);
	return sha256Hex(new TextEncoder().encode(parts.join('\n')));
}

/**
 * Record one version. When the snapshot is identical to the latest version
 * and that version is still the store's head, the store is left alone and the
 * latest version is returned (linking the build output to it when one is
 * given), so a feature save point followed by an unchanged checked build does
 * not produce two identical versions.
 */
export async function recordCodeVersion(
	db: D1Database,
	store: CodeStore,
	scope: Scope,
	input: RecordVersionInput,
): Promise<{ version: CodeVersionView; created: boolean }> {
	const verified = await assertProjectScope(db, scope);
	const repo = repoNameFor(verified.projectId);
	await store.ensureRepo(repo);
	const head = await store.head(repo);
	const digest = await snapshotDigest(input.files);
	if (head) {
		const latest = (
			await rows(db, 'select * from "code_versions" where "projectId" = ? and "commitId" = ?', verified.projectId, head)
		)[0];
		if (latest && latest['digest'] === digest) {
			if (input.outputId && latest['outputId'] === null) {
				await db
					.prepare('update "code_versions" set "outputId" = ? where "projectId" = ? and "commitId" = ?')
					.bind(input.outputId, verified.projectId, head)
					.run();
				latest['outputId'] = input.outputId;
			}
			return { version: versionFromRow(latest), created: false };
		}
	}
	const commit = await store.commit({
		repo,
		files: input.files,
		message: input.title,
		author: CADDIE_AUTHOR,
		parent: head,
	});
	const totalBytes = input.files.reduce((sum, file) => sum + Math.floor((file.contentBase64.length * 3) / 4), 0);
	const next = Number((await rows(db, 'select coalesce(max("seq"), 0) + 1 as "next" from "code_versions" where "projectId" = ?', verified.projectId))[0]?.['next'] ?? 1);
	await db
		.prepare(
			'insert into "code_versions" ("projectId","commitId","seq","kind","title","store","featureId","planId","image","outputId","fileCount","totalBytes","digest","skipped","createdBy","createdAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
		)
		.bind(
			verified.projectId,
			commit.id,
			next,
			input.kind,
			input.title.slice(0, 200),
			store.kind,
			input.featureId ?? null,
			input.planId ?? null,
			input.image ?? null,
			input.outputId ?? null,
			input.files.length,
			totalBytes,
			digest,
			JSON.stringify(input.skipped ?? []),
			input.actorId,
			commit.createdAt,
		)
		.run();
	const row = (await rows(db, 'select * from "code_versions" where "projectId" = ? and "commitId" = ?', verified.projectId, commit.id))[0];
	return { version: versionFromRow(row!), created: true };
}

/** Newest first. */
export async function listCodeVersions(db: D1Database, scope: Scope, limit = 50): Promise<CodeVersionView[]> {
	const verified = await assertProjectScope(db, scope);
	return (
		await rows(db, 'select * from "code_versions" where "projectId" = ? order by "seq" desc limit ?', verified.projectId, Math.min(Math.max(limit, 1), 200))
	).map(versionFromRow);
}

export async function getCodeVersion(db: D1Database, scope: Scope, commitId: string): Promise<CodeVersionView & { image: string | null; planId: string | null }> {
	const verified = await assertProjectScope(db, scope);
	const row = (await rows(db, 'select * from "code_versions" where "projectId" = ? and "commitId" = ?', verified.projectId, commitId))[0];
	if (!row) throw new CodeStoreError('COMMIT_NOT_FOUND', 'That version does not exist.', 404);
	return {
		...versionFromRow(row),
		image: row['image'] === null || row['image'] === undefined ? null : String(row['image']),
		planId: row['planId'] === null || row['planId'] === undefined ? null : String(row['planId']),
	};
}

/** Every file of a version, for seeding a sandbox or saving elsewhere. */
export async function readVersionFiles(store: CodeStore, projectId: string, commitId: string): Promise<CodeFile[]> {
	const repo = repoNameFor(projectId);
	const tree = await store.readTree(repo, commitId);
	const files: CodeFile[] = [];
	for (const entry of tree) {
		files.push({ path: entry.path, contentBase64: bytesToBase64(await store.readFile(repo, commitId, entry.path)) });
	}
	return files;
}
