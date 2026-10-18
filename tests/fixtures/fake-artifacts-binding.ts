import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
	ArtifactsBinding,
	ArtifactsLogEntry,
	ArtifactsRepo,
	ArtifactsToken,
	ArtifactsTreeEntry,
} from '../../apps/app/src/server/adapters/cloudflare-artifacts.ts';
import type { GitHttpStub } from './git-http-stub.ts';

/**
 * Test fixture — the Cloudflare Artifacts Workers binding, implemented over
 * BARE git repos with the git CLI, exactly covering the structural interface
 * the adapter uses (ArtifactsBinding / ArtifactsRepo in
 * apps/app/src/server/adapters/cloudflare-artifacts.ts).
 *
 *   create       = `git init --bare` (+ receive-pack enabled for pushes)
 *   import       = `git clone --bare <public url>` (then enable receive-pack)
 *   get          = a handle backed by `git` reads against the bare repo
 *   info/log     = `git symbolic-ref` + `git log`
 *   readTree     = `git ls-tree -r -l`
 *   readFile     = `git cat-file blob`
 *   createToken  = an opaque token registered with the git-http-stub, so a
 *                  push/fetch with it is accepted and anything else 401s
 *   delete       = remove the bare repo dir
 *
 * The remote URL points at the git-http-stub, so the adapter's isomorphic-git
 * push/fetch exercises the real smart-HTTP path. Nothing here reaches the real
 * Cloudflare service — this is the local SIMULATED stand-in.
 */

interface FakeBindingOptions {
	/** Dir holding the bare repos (same dir the git-http-stub serves). */
	projectRoot: string;
	/** The git-http-stub, so minted tokens are accepted by its auth check. */
	httpStub: GitHttpStub;
	/** Default branch for created repos. */
	defaultBranch?: string;
}

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).toString();
}

function gitInDir(dir: string, args: string[]): string {
	return execFileSync('git', ['--git-dir', dir, ...args], { encoding: 'utf8' }).toString();
}

export class FakeArtifactsBinding implements ArtifactsBinding {
	private readonly projectRoot: string;
	private readonly httpStub: GitHttpStub;
	private readonly defaultBranch: string;

	constructor(options: FakeBindingOptions) {
		this.projectRoot = options.projectRoot;
		this.httpStub = options.httpStub;
		this.defaultBranch = options.defaultBranch ?? 'main';
	}

	private repoDir(name: string): string {
		return join(this.projectRoot, `${name}.git`);
	}

	/** The smart-HTTP URL the adapter pushes/fetches against (served by the stub). */
	private remoteUrl(name: string): string {
		return `${this.httpStub.url}/${name}.git`;
	}

	async create(name: string, opts?: { defaultBranch?: string }): Promise<{ name: string; remote: string; defaultBranch: string }> {
		const dir = this.repoDir(name);
		if (existsSync(dir)) throw notFoundLike('already exists', 409);
		mkdirSync(dir, { recursive: true });
		const branch = opts?.defaultBranch ?? this.defaultBranch;
		git(this.projectRoot, ['init', '--bare', '--initial-branch', branch, dir]);
		gitInDir(dir, ['config', 'http.receivepack', 'true']);
		return { name, remote: this.remoteUrl(name), defaultBranch: branch };
	}

	async get(name: string): Promise<ArtifactsRepo> {
		const dir = this.repoDir(name);
		if (!existsSync(dir)) throw notFoundLike(`repo ${name} not found`, 404);
		return new FakeArtifactsRepo(dir, this.remoteUrl(name), this.defaultBranch, this.httpStub);
	}

	async list(): Promise<Array<{ name: string }>> {
		return [];
	}

	async import(args: {
		source: { url: string; branch?: string; depth?: number };
		target: { name: string; opts?: { defaultBranch?: string } };
	}): Promise<{ name: string; remote: string; defaultBranch: string }> {
		const dir = this.repoDir(args.target.name);
		if (existsSync(dir)) throw notFoundLike('already exists', 409);
		try {
			const cloneArgs = ['clone', '--bare'];
			if (args.source.branch) cloneArgs.push('--branch', args.source.branch, '--single-branch');
			if (args.source.depth) cloneArgs.push('--depth', String(args.source.depth));
			cloneArgs.push(args.source.url, dir);
			// Asynchronous on purpose: the public remote is often the in-process
			// git HTTP stub, which cannot answer while a synchronous child blocks
			// the event loop (that deadlock hung this test before).
			const child = Bun.spawn(['git', ...cloneArgs], { cwd: this.projectRoot, stdout: 'ignore', stderr: 'pipe' });
			const code = await child.exited;
			if (code !== 0) throw new Error(`git clone exited ${code}: ${(await new Response(child.stderr).text()).slice(0, 300)}`);
		} catch (error) {
			throw notFoundLike(`import failed: ${String(error)}`, 502);
		}
		gitInDir(dir, ['config', 'http.receivepack', 'true']);
		const branch = currentBranch(dir) ?? args.target.opts?.defaultBranch ?? this.defaultBranch;
		return { name: args.target.name, remote: this.remoteUrl(args.target.name), defaultBranch: branch };
	}

	async delete(name: string): Promise<void> {
		// Tests clean the project root wholesale; nothing to do per-repo.
	}
}

class FakeArtifactsRepo implements ArtifactsRepo {
	constructor(
		private readonly dir: string,
		private readonly remote: string,
		private readonly fallbackBranch: string,
		private readonly httpStub: GitHttpStub,
	) {}

	async info(): Promise<{ remote: string; defaultBranch: string; head: string | null }> {
		const branch = currentBranch(this.dir) ?? this.fallbackBranch;
		let head: string | null = null;
		try {
			head = gitInDir(this.dir, ['rev-parse', branch]).trim();
		} catch {
			head = null; // no commits yet
		}
		return { remote: this.remote, defaultBranch: branch, head };
	}

	async createToken(scope: 'read' | 'write', _ttlSeconds: number): Promise<ArtifactsToken> {
		const plaintext = `art_${scope}_${randomBytes(12).toString('hex')}`;
		this.httpStub.allowToken(plaintext);
		return { plaintext, expiresAt: new Date(Date.now() + _ttlSeconds * 1000).toISOString() };
	}

	async log(opts: { limit: number }): Promise<ArtifactsLogEntry[]> {
		const branch = currentBranch(this.dir) ?? this.fallbackBranch;
		let raw = '';
		try {
			// %H hash, %P parents, %cI committer ISO date, then the subject.
			raw = gitInDir(this.dir, [
				'log',
				`--max-count=${opts.limit}`,
				'--pretty=format:%H%x1f%P%x1f%cI%x1f%s',
				branch,
			]);
		} catch {
			return [];
		}
		if (!raw.trim()) return [];
		return raw.split('\n').map((line) => {
			const [hash = '', parents = '', createdAt = '', message = ''] = line.split('\x1f');
			return {
				hash,
				message,
				createdAt,
				parents: parents.trim() ? parents.trim().split(/\s+/) : [],
			};
		});
	}

	async readTree(hash: string): Promise<ArtifactsTreeEntry[]> {
		let raw = '';
		try {
			raw = gitInDir(this.dir, ['ls-tree', '-r', '-l', hash]);
		} catch (error) {
			throw notFoundLike(`commit ${hash} not found`, 404);
		}
		const entries: ArtifactsTreeEntry[] = [];
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			// <mode> SP <type> SP <oid> SP <size> TAB <path>
			const [meta = '', path = ''] = line.split('\t');
			const parts = meta.trim().split(/\s+/);
			const size = Number.parseInt(parts[3] ?? '0', 10);
			entries.push({ path, size: Number.isNaN(size) ? 0 : size, type: 'blob' });
		}
		return entries;
	}

	async readFile(args: { commit: string; path: string }): Promise<Uint8Array> {
		try {
			const buffer = execFileSync('git', ['--git-dir', this.dir, 'cat-file', 'blob', `${args.commit}:${args.path}`], {
				maxBuffer: 64 * 1024 * 1024,
			});
			return new Uint8Array(buffer);
		} catch (error) {
			throw notFoundLike(`file ${args.path} at ${args.commit} not found`, 404);
		}
	}
}

function currentBranch(dir: string): string | null {
	try {
		return gitInDir(dir, ['symbolic-ref', '--short', 'HEAD']).trim() || null;
	} catch {
		return null;
	}
}

/** An error shaped like the binding's not-found so the adapter maps it to a typed code. */
function notFoundLike(message: string, status: number): Error & { code: string; status: number } {
	const error = new Error(message) as Error & { code: string; status: number };
	error.code = status === 404 ? 'NotFoundError' : 'ArtifactsError';
	error.status = status;
	return error;
}
