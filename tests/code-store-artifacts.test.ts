import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactsCodeStore } from '../apps/app/src/server/adapters/cloudflare-artifacts.ts';
import { CodeStoreError } from '../apps/app/src/server/code-store.ts';
import { FakeArtifactsBinding } from './fixtures/fake-artifacts-binding.ts';
import { GitHttpStub, makeProjectRoot } from './fixtures/git-http-stub.ts';
import { freePort } from './fixtures/controls-harness.ts';
import { runCodeStoreContract } from './fixtures/code-store-contract.ts';

/**
 * ArtifactsCodeStore — the Cloudflare Artifacts code store.
 *
 * Classification: LOCAL VERIFIED against the real adapter
 * (apps/app/src/server/adapters/cloudflare-artifacts.ts), real isomorphic-git
 * (1.44.2) pushing over a real `git http-backend` smart-HTTP server bound to
 * 127.0.0.1, over bare git repos driven by the git CLI. Cloudflare Artifacts
 * itself is SIMULATED by the fake binding — nothing here is evidence about the
 * live Artifacts service (that stays BLOCKED on owner provisioning).
 */

const AUTHOR = { name: 'Caddie', email: 'caddie@example.com' };

/** Make a public (anonymous) seed repo served by the stub, for importPublic. */
function seedPublicRepo(root: string, stub: GitHttpStub): { url: string; branch: string; expectFile: { path: string; text: string } } {
	const bareName = 'public-seed.git';
	const bareDir = join(root, bareName);
	mkdirSync(bareDir, { recursive: true });
	execFileSync('git', ['init', '--bare', '--initial-branch', 'main', bareDir]);
	// Populate it from a throwaway working clone.
	const work = join(root, 'public-seed-work');
	execFileSync('git', ['clone', bareDir, work]);
	writeFileSync(join(work, 'index.html'), '<h1>seed</h1>\n');
	for (const args of [
		['config', 'user.email', 'seed@example.com'],
		['config', 'user.name', 'Seed'],
		['add', '-A'],
		['commit', '-m', 'seed commit'],
		['push', 'origin', 'main'],
	]) {
		execFileSync('git', args, { cwd: work });
	}
	stub.allowAnonymousRepo(bareName);
	return { url: `${stub.url}/${bareName}`, branch: 'main', expectFile: { path: 'index.html', text: '<h1>seed</h1>\n' } };
}

let projectRoot: { dir: string; cleanup: () => void };
let stub: GitHttpStub;
let binding: FakeArtifactsBinding;
let publicRemote: { url: string; branch: string; expectFile: { path: string; text: string } };

beforeAll(async () => {
	projectRoot = makeProjectRoot();
	stub = new GitHttpStub({ projectRoot: projectRoot.dir });
	await stub.start(await freePort());
	binding = new FakeArtifactsBinding({ projectRoot: projectRoot.dir, httpStub: stub });
	publicRemote = seedPublicRepo(projectRoot.dir, stub);
}, 60_000);

afterAll(async () => {
	if (stub) await stub.stop();
	if (projectRoot) projectRoot.cleanup();
});

// The shared contract — every CodeStore must pass this. Each case uses its own
// repo name, so one shared binding/server serves them all.
runCodeStoreContract('ArtifactsCodeStore', async () => ({
	store: new ArtifactsCodeStore(binding),
	cleanup: async () => {},
	publicRemote,
}));

describe('ArtifactsCodeStore — adapter specifics', () => {
	test('a token never appears in a thrown error', async () => {
		// Point the store at a binding whose write path will be rejected, and make
		// the token value distinctive so we can assert it is never surfaced.
		const repo = 'repo-token-safety';
		const store = new ArtifactsCodeStore(binding);
		await store.ensureRepo(repo);
		const first = await store.commit({
			repo,
			files: [{ path: 'a.ts', contentBase64: Buffer.from('1\n').toString('base64') }],
			message: 'first',
			author: AUTHOR,
			parent: null,
		});
		// Force a rejected push by committing against a stale parent after a real
		// move; the error must be the typed HEAD_MOVED and must not leak a token.
		await store.commit({
			repo,
			files: [{ path: 'a.ts', contentBase64: Buffer.from('2\n').toString('base64') }],
			message: 'second',
			author: AUTHOR,
			parent: first.id,
		});
		let thrown: unknown;
		try {
			await store.commit({
				repo,
				files: [{ path: 'a.ts', contentBase64: Buffer.from('3\n').toString('base64') }],
				message: 'stale',
				author: AUTHOR,
				parent: first.id,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CodeStoreError);
		expect((thrown as CodeStoreError).code).toBe('HEAD_MOVED');
		// No minted token (prefix art_write_ / art_read_) in the message.
		expect((thrown as Error).message).not.toMatch(/art_(write|read)_[0-9a-f]+/);
	});

	test("someone else's push between the read and ours is refused with HEAD_MOVED", async () => {
		const repo = 'repo-concurrent';
		const store = new ArtifactsCodeStore(binding);
		await store.ensureRepo(repo);
		const base = await store.commit({
			repo,
			files: [{ path: 'app.ts', contentBase64: Buffer.from('export const v = 1;\n').toString('base64') }],
			message: 'base',
			author: AUTHOR,
			parent: null,
		});

		// Simulate another writer landing a commit on the default branch directly
		// (a real git push into the bare repo), moving the head past `base`.
		const bareDir = join(projectRoot.dir, `${repo}.git`);
		const work = join(projectRoot.dir, `${repo}-other-writer`);
		execFileSync('git', ['clone', bareDir, work]);
		writeFileSync(join(work, 'app.ts'), 'export const v = 2; // by someone else\n');
		for (const args of [
			['config', 'user.email', 'other@example.com'],
			['config', 'user.name', 'Other'],
			['commit', '-am', 'outside push'],
			['push', 'origin', 'main'],
		]) {
			execFileSync('git', args, { cwd: work });
		}

		// Our commit still believes `base` is the head: refused before (or at) push.
		let thrown: unknown;
		try {
			await store.commit({
				repo,
				files: [{ path: 'app.ts', contentBase64: Buffer.from('export const v = 3; // caddie\n').toString('base64') }],
				message: 'caddie on stale base',
				author: AUTHOR,
				parent: base.id,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CodeStoreError);
		expect((thrown as CodeStoreError).code).toBe('HEAD_MOVED');
		expect((thrown as CodeStoreError).status).toBe(409);

		// The outside writer's commit is still the head — ours never overwrote it.
		const head = await store.head(repo);
		const current = await store.readFile(repo, head!, 'app.ts');
		expect(new TextDecoder().decode(current)).toBe('export const v = 2; // by someone else\n');
	});

	test('reading a repo that does not exist is REPO_NOT_FOUND', async () => {
		const store = new ArtifactsCodeStore(binding);
		let thrown: unknown;
		try {
			await store.head('repo-never-created');
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(CodeStoreError);
		expect((thrown as CodeStoreError).code).toBe('REPO_NOT_FOUND');
	});

	test('importPublic refuses a non-https source before any clone', async () => {
		const store = new ArtifactsCodeStore(binding);
		let thrown: unknown;
		try {
			await store.importPublic('repo-bad-import', 'git://evil.example/x.git');
		} catch (error) {
			thrown = error;
		}
		expect((thrown as CodeStoreError).code).toBe('INVALID_INPUT');
	});
});
