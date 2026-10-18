import { describe, expect, test } from 'bun:test';
import type { CodeFile, CodeStore } from '../../apps/app/src/server/code-store.ts';
import { CodeStoreError } from '../../apps/app/src/server/code-store.ts';

/**
 * The CodeStore contract — the shared, reusable bun:test suite EVERY CodeStore
 * implementation must pass (the Cloudflare Artifacts adapter, the local D1
 * store). The port guarantees identical behavior; this suite is what makes
 * that true. One suite, two backends, so a bug that only one backend has is
 * caught against the common contract rather than per adapter.
 *
 * Classification: LOCAL VERIFIED for whichever `makeStore` is handed in. For
 * the Artifacts adapter the store talks to a real git backend over a local
 * smart-HTTP server (SIMULATED Cloudflare: nothing here is evidence about the
 * real Artifacts service).
 */

const AUTHOR = { name: 'Caddie', email: 'caddie@example.com' };

function file(path: string, text: string): CodeFile {
	return { path, contentBase64: Buffer.from(text, 'utf8').toString('base64') };
}

function binFile(path: string, bytes: Uint8Array): CodeFile {
	return { path, contentBase64: Buffer.from(bytes).toString('base64') };
}

function treePaths(entries: Array<{ path: string }>): string[] {
	return entries.map((entry) => entry.path).sort();
}

async function refusal(task: Promise<unknown>): Promise<Error> {
	try {
		await task;
	} catch (error) {
		return error as Error;
	}
	throw new Error('expected a refusal, but the effect succeeded');
}

export interface ContractHarness {
	store: CodeStore;
	cleanup(): Promise<void>;
	/**
	 * A PUBLIC https remote with at least one commit on `branch`, for the
	 * importPublic case. The contract runs the import case only when provided.
	 */
	publicRemote?: { url: string; branch: string; expectFile: { path: string; text: string } };
}

export function runCodeStoreContract(label: string, makeStore: () => Promise<ContractHarness>): void {
	describe(`CodeStore contract — ${label}`, () => {
		test('an empty repo has a null head', async () => {
			const harness = await makeStore();
			try {
				await harness.store.ensureRepo('repo-empty');
				expect(await harness.store.head('repo-empty')).toBeNull();
			} finally {
				await harness.cleanup();
			}
		});

		test('ensureRepo is idempotent', async () => {
			const harness = await makeStore();
			try {
				await harness.store.ensureRepo('repo-idem');
				await harness.store.ensureRepo('repo-idem');
				await harness.store.ensureRepo('repo-idem');
				expect(await harness.store.head('repo-idem')).toBeNull();
			} finally {
				await harness.cleanup();
			}
		});

		test('the first commit uses parent null and becomes the head', async () => {
			const harness = await makeStore();
			try {
				const repo = 'repo-first';
				await harness.store.ensureRepo(repo);
				const commit = await harness.store.commit({
					repo,
					files: [file('README.md', '# hi\n'), file('src/app.ts', 'export const x = 1;\n')],
					message: 'first',
					author: AUTHOR,
					parent: null,
				});
				expect(commit.id).toBeTruthy();
				expect(commit.message).toBe('first');
				expect(commit.parents).toEqual([]);
				expect(await harness.store.head(repo)).toBe(commit.id);
				expect(treePaths(await harness.store.readTree(repo, commit.id))).toEqual(['README.md', 'src/app.ts']);
			} finally {
				await harness.cleanup();
			}
		});

		test('a second commit that drops a file removes it from the tree', async () => {
			const harness = await makeStore();
			try {
				const repo = 'repo-delete';
				await harness.store.ensureRepo(repo);
				const first = await harness.store.commit({
					repo,
					files: [file('keep.ts', 'export const keep = 1;\n'), file('drop.ts', 'export const drop = 2;\n')],
					message: 'both',
					author: AUTHOR,
					parent: null,
				});
				const second = await harness.store.commit({
					repo,
					// drop.ts is absent -> it must be gone in this commit (full-snapshot semantics).
					files: [file('keep.ts', 'export const keep = 1;\n')],
					message: 'drop one',
					author: AUTHOR,
					parent: first.id,
				});
				expect(second.parents).toEqual([first.id]);
				expect(treePaths(await harness.store.readTree(repo, second.id))).toEqual(['keep.ts']);
				// The older commit still has both — history is intact.
				expect(treePaths(await harness.store.readTree(repo, first.id))).toEqual(['drop.ts', 'keep.ts']);
			} finally {
				await harness.cleanup();
			}
		});

		test('a stale parent is refused with HEAD_MOVED', async () => {
			const harness = await makeStore();
			try {
				const repo = 'repo-stale';
				await harness.store.ensureRepo(repo);
				const first = await harness.store.commit({
					repo,
					files: [file('a.ts', 'export const a = 1;\n')],
					message: 'first',
					author: AUTHOR,
					parent: null,
				});
				await harness.store.commit({
					repo,
					files: [file('a.ts', 'export const a = 2;\n')],
					message: 'second',
					author: AUTHOR,
					parent: first.id,
				});
				// Base the next commit on the OLD head: the head moved underneath it.
				const error = await refusal(
					harness.store.commit({
						repo,
						files: [file('a.ts', 'export const a = 3;\n')],
						message: 'stale',
						author: AUTHOR,
						parent: first.id,
					}),
				);
				expect(error).toBeInstanceOf(CodeStoreError);
				expect((error as CodeStoreError).code).toBe('HEAD_MOVED');
				expect((error as CodeStoreError).status).toBe(409);
			} finally {
				await harness.cleanup();
			}
		});

		test('log is newest-first with messages and ISO createdAt', async () => {
			const harness = await makeStore();
			try {
				const repo = 'repo-log';
				await harness.store.ensureRepo(repo);
				const first = await harness.store.commit({
					repo,
					files: [file('f.ts', '1\n')],
					message: 'one',
					author: AUTHOR,
					parent: null,
				});
				const second = await harness.store.commit({
					repo,
					files: [file('f.ts', '2\n')],
					message: 'two',
					author: AUTHOR,
					parent: first.id,
				});
				const third = await harness.store.commit({
					repo,
					files: [file('f.ts', '3\n')],
					message: 'three',
					author: AUTHOR,
					parent: second.id,
				});
				const log = await harness.store.log(repo, 10);
				expect(log.map((c) => c.id)).toEqual([third.id, second.id, first.id]);
				expect(log.map((c) => c.message)).toEqual(['three', 'two', 'one']);
				for (const commit of log) {
					expect(Number.isNaN(Date.parse(commit.createdAt))).toBe(false);
				}
				// limit is honored
				expect((await harness.store.log(repo, 2)).map((c) => c.id)).toEqual([third.id, second.id]);
			} finally {
				await harness.cleanup();
			}
		});

		test('readTree and readFile work at an OLDER commit', async () => {
			const harness = await makeStore();
			try {
				const repo = 'repo-older';
				await harness.store.ensureRepo(repo);
				const first = await harness.store.commit({
					repo,
					files: [file('note.txt', 'first version\n')],
					message: 'v1',
					author: AUTHOR,
					parent: null,
				});
				const second = await harness.store.commit({
					repo,
					files: [file('note.txt', 'second version\n')],
					message: 'v2',
					author: AUTHOR,
					parent: first.id,
				});
				const old = await harness.store.readFile(repo, first.id, 'note.txt');
				expect(new TextDecoder().decode(old)).toBe('first version\n');
				const current = await harness.store.readFile(repo, second.id, 'note.txt');
				expect(new TextDecoder().decode(current)).toBe('second version\n');
			} finally {
				await harness.cleanup();
			}
		});

		test('binary bytes round-trip exactly', async () => {
			const harness = await makeStore();
			try {
				const repo = 'repo-binary';
				await harness.store.ensureRepo(repo);
				const bytes = new Uint8Array(256);
				for (let i = 0; i < 256; i++) bytes[i] = i;
				const commit = await harness.store.commit({
					repo,
					files: [binFile('logo.bin', bytes), file('readme.md', 'x\n')],
					message: 'binary',
					author: AUTHOR,
					parent: null,
				});
				const read = await harness.store.readFile(repo, commit.id, 'logo.bin');
				expect(read.length).toBe(256);
				expect([...read]).toEqual([...bytes]);
				const sizes = Object.fromEntries((await harness.store.readTree(repo, commit.id)).map((e) => [e.path, e.size]));
				expect(sizes['logo.bin']).toBe(256);
			} finally {
				await harness.cleanup();
			}
		});

		test('invalid snapshots are refused: empty, unsafe path, duplicate, oversize', async () => {
			const harness = await makeStore();
			try {
				const repo = 'repo-invalid';
				await harness.store.ensureRepo(repo);

				const empty = await refusal(harness.store.commit({ repo, files: [], message: 'm', author: AUTHOR, parent: null }));
				expect((empty as CodeStoreError).code).toBe('INVALID_INPUT');

				const unsafe = await refusal(
					harness.store.commit({ repo, files: [file('../escape.ts', 'x')], message: 'm', author: AUTHOR, parent: null }),
				);
				expect((unsafe as CodeStoreError).code).toBe('INVALID_INPUT');

				const dup = await refusal(
					harness.store.commit({
						repo,
						files: [file('a.ts', '1'), file('a.ts', '2')],
						message: 'm',
						author: AUTHOR,
						parent: null,
					}),
				);
				expect((dup as CodeStoreError).code).toBe('INVALID_INPUT');

				const bigText = 'x'.repeat(3 * 1024 * 1024);
				const oversize = await refusal(
					harness.store.commit({ repo, files: [file('big.ts', bigText)], message: 'm', author: AUTHOR, parent: null }),
				);
				expect((oversize as CodeStoreError).code).toBe('TOO_LARGE');

				// No invalid snapshot moved the head.
				expect(await harness.store.head(repo)).toBeNull();
			} finally {
				await harness.cleanup();
			}
		});

		test('importPublic copies a public remote, then a commit lands on top', async () => {
			const harness = await makeStore();
			try {
				if (!harness.publicRemote) {
					// No public remote wired for this backend; the case is not applicable.
					expect(harness.publicRemote).toBeUndefined();
					return;
				}
				const repo = 'repo-import';
				const imported = await harness.store.importPublic(repo, harness.publicRemote.url, harness.publicRemote.branch);
				expect(imported.id).toBeTruthy();
				expect(await harness.store.head(repo)).toBe(imported.id);
				const seeded = await harness.store.readFile(repo, imported.id, harness.publicRemote.expectFile.path);
				expect(new TextDecoder().decode(seeded)).toBe(harness.publicRemote.expectFile.text);

				// A commit on top keeps the imported file and adds a new one.
				const onTop = await harness.store.commit({
					repo,
					files: [
						file(harness.publicRemote.expectFile.path, harness.publicRemote.expectFile.text),
						file('added-by-caddie.ts', 'export const added = true;\n'),
					],
					message: 'build on the imported repo',
					author: AUTHOR,
					parent: imported.id,
				});
				expect(onTop.parents).toEqual([imported.id]);
				expect(treePaths(await harness.store.readTree(repo, onTop.id))).toEqual(
					[harness.publicRemote.expectFile.path, 'added-by-caddie.ts'].sort(),
				);
			} finally {
				await harness.cleanup();
			}
		});
	});
}
