import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Test fixture — a REAL git smart-HTTP v1 server for the Artifacts code store
 * tests (tests/code-store-artifacts.test.ts via the fake binding).
 *
 * Binds 127.0.0.1 only. It bridges HTTP to `git http-backend` (git's own CGI)
 * over bare repositories in a temp dir, so isomorphic-git's push
 * (receive-pack) and fetch (upload-pack) run against a genuine git backend —
 * the write path the Artifacts adapter uses in production, not a mock of it.
 *
 * git http-backend protocol (what we set up): GIT_PROJECT_ROOT points at the
 * dir of bare repos, GIT_HTTP_EXPORT_ALL exports them without the
 * `git-daemon-export-ok` marker, and receive-pack is enabled per-repo
 * (`http.receivepack=true`) so pushes are accepted.
 * Docs (read 2026-10-17): https://git-scm.com/docs/git-http-backend  VERIFIED
 *
 * AUTH: the fake Artifacts binding issues opaque tokens; the real adapter
 * sends them as `Authorization: Bearer <token>` and as a Basic password
 * (onAuth username x-access-token). This server accepts ONLY tokens the test
 * registered (via `allowToken`), as either form, and 401s everything else — so
 * "a push needs a write token the binding minted" is enforced by a real
 * server, not assumed.
 */

export interface GitHttpStubOptions {
	/** Absolute path to the dir holding bare repos (the fake binding owns it). */
	projectRoot: string;
}

const GIT_EXEC_PATH = execFileSync('git', ['--exec-path']).toString().trim();
const GIT_HTTP_BACKEND = join(GIT_EXEC_PATH, 'git-http-backend');

export class GitHttpStub {
	url = '';
	/** Every request line (method + path + whether a valid token was presented). */
	readonly requests: Array<{ method: string; path: string; authorized: boolean }> = [];

	private server: Server | undefined;
	private readonly projectRoot: string;
	private readonly tokens = new Set<string>();
	private readonly anonymousRepos = new Set<string>();

	constructor(options: GitHttpStubOptions) {
		this.projectRoot = options.projectRoot;
	}

	/** Register a token the server will accept (Bearer or Basic password). */
	allowToken(token: string): void {
		this.tokens.add(token);
	}

	/**
	 * Mark a repo path (e.g. `public-seed.git`) as anonymously readable — stands
	 * in for a PUBLIC https remote that `importPublic` clones with no credential.
	 */
	allowAnonymousRepo(repoPath: string): void {
		this.anonymousRepos.add(repoPath.replace(/^\/+/, ''));
	}

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
		return new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
	}

	private tokenFromHeaders(req: IncomingMessage): string | null {
		const header = req.headers.authorization;
		if (!header) return null;
		if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null;
		if (header.startsWith('Basic ')) {
			try {
				const decoded = Buffer.from(header.slice('Basic '.length).trim(), 'base64').toString('utf8');
				// username:password — the password carries the token (username is x-access-token).
				const password = decoded.slice(decoded.indexOf(':') + 1);
				return password || null;
			} catch {
				return null;
			}
		}
		return null;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		const token = this.tokenFromHeaders(req);
		// A repo marked public is readable with no token (import source); every
		// other repo requires a token the binding minted.
		const repoSegment = url.pathname.replace(/^\/+/, '').split('/')[0] ?? '';
		const isAnonymous = this.anonymousRepos.has(repoSegment);
		const authorized = isAnonymous || (token !== null && this.tokens.has(token));
		this.requests.push({ method: req.method ?? 'GET', path: url.pathname, authorized });

		if (!authorized) {
			res.writeHead(401, { 'www-authenticate': 'Basic realm="artifacts"' });
			res.end('authentication required');
			return;
		}

		// Build the CGI environment git-http-backend expects.
		const env: Record<string, string> = {
			...process.env,
			GIT_PROJECT_ROOT: this.projectRoot,
			GIT_HTTP_EXPORT_ALL: '1',
			PATH_INFO: url.pathname,
			QUERY_STRING: url.search.replace(/^\?/, ''),
			REQUEST_METHOD: req.method ?? 'GET',
			GIT_HTTP_BACKEND: GIT_HTTP_BACKEND,
			REMOTE_USER: 'x-access-token',
			REMOTE_ADDR: '127.0.0.1',
		};
		const contentType = req.headers['content-type'];
		if (contentType) env.CONTENT_TYPE = Array.isArray(contentType) ? (contentType[0] ?? '') : contentType;
		const contentLength = req.headers['content-length'];
		if (contentLength) env.CONTENT_LENGTH = Array.isArray(contentLength) ? (contentLength[0] ?? '') : contentLength;

		const child = spawn(GIT_HTTP_BACKEND, { env });
		req.pipe(child.stdin);

		// git-http-backend writes CGI headers then a blank line then the body.
		const chunks: Buffer[] = [];
		child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
		const stderr: Buffer[] = [];
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

		(child as unknown as { on(event: 'close', listener: (code: number | null) => void): void }).on('close', (code: number | null) => {
			const output = Buffer.concat(chunks);
			const separator = output.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
			const splitAt = output.indexOf(separator);
			if (code !== 0 && splitAt < 0) {
				res.writeHead(500, { 'content-type': 'text/plain' });
				res.end(`git-http-backend failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`);
				return;
			}
			const headerText = splitAt >= 0 ? output.subarray(0, splitAt).toString('utf8') : '';
			const body = splitAt >= 0 ? output.subarray(splitAt + separator.length) : output;
			const headers: Record<string, string> = {};
			let status = 200;
			for (const line of headerText.split(/\r?\n/)) {
				const colon = line.indexOf(':');
				if (colon <= 0) continue;
				const name = line.slice(0, colon).trim();
				const value = line.slice(colon + 1).trim();
				if (name.toLowerCase() === 'status') {
					status = Number.parseInt(value, 10) || 200;
				} else {
					headers[name] = value;
				}
			}
			res.writeHead(status, headers);
			res.end(body);
		});
	}
}

/** Make a temp project root for bare repos; caller cleans it up with the returned fn. */
export function makeProjectRoot(prefix = 'caddie-git-http-'): { dir: string; cleanup: () => void } {
	const base = process.env.KIROCREW_SCRATCH?.trim() || tmpdir();
	const dir = mkdtempSync(join(base, prefix));
	return {
		dir,
		cleanup: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		},
	};
}
