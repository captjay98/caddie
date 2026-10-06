/**
 * Journey sandbox — the LOCAL execution driver for the P09 journey.
 *
 * Shells out to the owner-installed contree CLI (the LIVE VERIFIED path,
 * proven in the adjudication reference client
 * nebius-forge-eval/adjudication/shared/contree-async.ts and by the P04 live
 * probe in the execution ledger). Session-keyed like the reference: every
 * invocation is `contree -S <sessionKey> …` against the same image
 * (tag:tt-base:1), so the session (and its evolving image) is the workspace.
 *
 * This fixture is deliberately SEPARATE from the production REST adapter
 * (apps/app/src/server/adapters/sandbox.ts): that adapter's REST endpoint
 * spellings are unverified assumptions (ledger P04-live limitations), while
 * the CLI surface below is the proven transport. No operation keys or
 * persistence ports here — the journey is a linear, human-audited script,
 * not the product runtime.
 *
 * Operations used (all LIVE VERIFIED CLI surface):
 *   - `use`            — idempotent image binding for the session
 *   - `run [-C cwd] -t <sec> -s -- <shell>` — remote exec, JSON receipt
 *   - `file cp <local> <remote>` + a flush `run true` — upload as pending
 *     attachment, injected into the image on the next run
 *   - `cat <remote>`   — read a file out of the image
 *   - `cp <remote> <local>` — copy a file OUT of the image (artifact export)
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CONTREE_BIN =
	process.env.CONTREE_BIN ?? '/Users/captjay98/Library/Python/3.14/bin/contree';

/** bun lives outside the default PATH inside the tt-base image. */
export const BUN_PATH_PREFIX = 'export PATH=/root/.bun/bin:$PATH;';

export interface ExecResult {
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export class JourneySandboxError extends Error {
	constructor(
		readonly operation: string,
		message: string,
		readonly detail: Record<string, unknown> = {},
	) {
		super(message);
		this.name = 'JourneySandboxError';
	}
}

export class JourneySandbox {
	constructor(
		public readonly sessionKey: string,
		public readonly image = 'tag:tt-base:1',
	) {}

	/** One CLI invocation. Never logs argv values (they may embed file content). */
	private async cli(
		args: string[],
		timeoutMs: number,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const proc = Bun.spawn([CONTREE_BIN, '-S', this.sessionKey, ...args], {
			stdout: 'pipe',
			stderr: 'pipe',
			stdin: 'ignore',
			timeout: timeoutMs,
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		return { stdout, stderr, exitCode };
	}

	/** Idempotent image binding: only `use` when the session has no image yet. */
	async init(): Promise<void> {
		const current = await this.cli(['use'], 30_000);
		if (current.exitCode === 0 && current.stdout.includes('CURRENT_IMAGE')) {
			const line = current.stdout.split('\n').find((l) => l.includes(this.sessionKey));
			const bound = line?.split(/\s+/)[2];
			if (bound && bound !== '-') return;
		}
		const used = await this.cli(['use', this.image], 120_000);
		if (used.exitCode !== 0) {
			throw new JourneySandboxError('init', `contree use ${this.image} failed`, {
				stderr: used.stderr.slice(0, 400),
				stdout: used.stdout.slice(0, 400),
			});
		}
	}

	/** Remote shell exec (single expression, joined with `-s`). */
	async exec(
		command: string,
		opts: { cwd?: string; timeoutMs?: number } = {},
	): Promise<ExecResult> {
		const started = Date.now();
		const timeoutMs = opts.timeoutMs ?? 300_000;
		const args = ['run', '-t', String(Math.ceil(timeoutMs / 1000))];
		if (opts.cwd !== undefined) args.push('-C', opts.cwd);
		args.push('-s', '--', `${BUN_PATH_PREFIX} ${command}`);
		const r = await this.cli(['-o', 'json', ...args], timeoutMs + 60_000);
		let parsed: { exit_code?: number; stdout?: string; stderr?: string };
		try {
			parsed = JSON.parse(r.stdout) as typeof parsed;
		} catch {
			throw new JourneySandboxError('exec', `contree returned non-JSON output`, {
				command,
				stdoutHead: r.stdout.slice(0, 200),
				stderrHead: r.stderr.slice(0, 200),
			});
		}
		return {
			command,
			exitCode: parsed.exit_code ?? 1,
			stdout: parsed.stdout ?? '',
			stderr: parsed.stderr ?? '',
			durationMs: Date.now() - started,
		};
	}

	/** Upload text content to a path in the session image, then flush it. */
	async writeFile(remotePath: string, content: string): Promise<void> {
		const dir = await mkdtemp(join(tmpdir(), 'p09-journey-'));
		const local = join(dir, 'file');
		await writeFile(local, content);
		try {
			const r = await this.cli(['file', 'cp', local, remotePath], 60_000);
			if (r.exitCode !== 0) {
				throw new JourneySandboxError('writeFile', `upload of ${remotePath} failed`, {
					stderr: r.stderr.slice(0, 400),
				});
			}
			// A pending attachment is only injected on the next run — flush now so
			// subsequent execs observe the write (same pattern as the reference).
			const flush = await this.exec('true', { timeoutMs: 60_000 });
			if (flush.exitCode !== 0) {
				throw new JourneySandboxError('writeFile', `flush run after uploading ${remotePath} failed`, {
					exitCode: flush.exitCode,
				});
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	/** Read a file's text content out of the session image. */
	async readFile(remotePath: string): Promise<string> {
		const r = await this.cli(['cat', remotePath], 60_000);
		if (r.exitCode !== 0) {
			throw new JourneySandboxError('readFile', `cat ${remotePath} failed`, {
				stderr: r.stderr.slice(0, 400),
			});
		}
		return r.stdout;
	}

	/**
	 * Copy a file OUT of the session image to a local path (artifact export).
	 * Returns the sha256 of the received bytes.
	 */
	async copyFromImage(remotePath: string, localPath: string): Promise<string> {
		const r = await this.cli(['cp', remotePath, localPath], 120_000);
		if (r.exitCode !== 0) {
			throw new JourneySandboxError('copyFromImage', `cp ${remotePath} → local failed`, {
				stderr: r.stderr.slice(0, 400),
			});
		}
		return createHash('sha256')
			.update(new Uint8Array(await Bun.file(localPath).arrayBuffer()))
			.digest('hex');
	}
}
