import { bytesToBase64 } from './adapters/contree.ts';
import { ScopeError } from './scope.ts';

/**
 * "Save the code to GitHub", read side: collect the source of a verified
 * build from its sandbox image and decide, path by path, what may leave the
 * sandbox. Rules (each has a test in tests/source-export.test.ts):
 *
 *   - dependencies, build output, caches and version-control folders are
 *     never read; their directories are not even listed (node_modules/,
 *     .git/, dist/ at the root, ...);
 *   - secret files are never read: .env (but .env.example is source),
 *     .dev.vars, private keys, .npmrc, credential folders (.ssh/, .aws/);
 *   - symlinks are skipped, never followed;
 *   - every text file is scanned for high-confidence secrets (private key
 *     blocks, AWS / GitHub / Slack / Stripe / OpenAI / Anthropic keys). A hit
 *     refuses the WHOLE save and names the file: dropping that file silently
 *     would ship code that no longer works;
 *   - the caps are hard refusals, checked from the listing before any file is
 *     read, and again against the bytes actually read. A save is never
 *     silently truncated;
 *   - binary files (not valid UTF-8, or containing a NUL byte) travel base64.
 */

export type SourceSkipReason = 'dependencies' | 'build-output' | 'secret' | 'symlink' | 'noise';

export interface SourceEntry {
	name: string;
	isDir: boolean;
	isFile: boolean;
	isSymlink: boolean;
	size: number;
}

/** What the walker needs from the sandbox: one listing per directory, one read per file. */
export interface SourceReader {
	list(absolutePath: string): Promise<SourceEntry[]>;
	read(absolutePath: string): Promise<Uint8Array>;
}

export interface SourceFile {
	/** Repo-relative POSIX path. */
	path: string;
	/** UTF-8 text, or base64 when `encoding` is base64. */
	content: string;
	encoding: 'utf-8' | 'base64';
	size: number;
}

export interface SourceSkip {
	/** Directories end with '/'. */
	path: string;
	reason: SourceSkipReason;
}

export interface SourceSnapshot {
	files: SourceFile[];
	skipped: SourceSkip[];
	totalBytes: number;
}

export interface SourceCaps {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
	/** Bounds the walk itself (one listing request per folder). */
	maxDirectories: number;
}

// Folder names skipped wherever they appear.
const DIRS_ANYWHERE = new Map<string, SourceSkipReason>([
	...['node_modules', 'bower_components', 'jspm_packages', '.pnpm-store', '.yarn', '.venv', 'venv', '.dart_tool', '.pub-cache', '.gradle'].map(
		(name) => [name, 'dependencies'] as const,
	),
	...[
		'.git', '.hg', '.svn', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.cache',
		'.parcel-cache', '.turbo', '.vite', '.wrangler', '.next', '.nuxt', '.svelte-kit', '.output', '.vinxi',
		'.tanstack', '.nyc_output', 'coverage', '.idea', '.terraform', '.expo',
	].map((name) => [name, 'noise'] as const),
	...['.ssh', '.aws', '.gnupg', '.docker', '.azure', '.kube'].map((name) => [name, 'secret'] as const),
]);

// Paths skipped only at the app root (a nested src/build/ is source).
const ROOT_PATHS = new Map<string, SourceSkipReason>([
	['dist', 'build-output'],
	['build', 'build-output'],
	['out', 'build-output'],
	['target', 'build-output'],
	['public/build', 'build-output'],
	['vendor', 'dependencies'],
	['storage/logs', 'noise'],
	['storage/framework', 'noise'],
	['bootstrap/cache', 'noise'],
]);

const SECRET_FILE_NAMES = new Set([
	'.env', '.dev.vars', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.pgpass', '.htpasswd',
	'credentials.json', 'service-account.json', 'serviceaccountkey.json',
	'secrets.json', 'secrets.yml', 'secrets.yaml',
	'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
]);
const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.ppk'];
/** `.env.example` and friends are templates: source, not secrets. */
const ENV_TEMPLATE_SUFFIXES = new Set(['example', 'sample', 'template', 'dist', 'defaults']);

const NOISE_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.eslintcache']);
const NOISE_EXTENSIONS = ['.log', '.tsbuildinfo', '.pyc', '.sqlite', '.sqlite3', '.db', '.swp'];

/** Why a folder is skipped, or null when it is walked. `path` is root-relative. */
export function classifySourceDirectory(path: string): SourceSkipReason | null {
	const name = path.split('/').pop() ?? path;
	return ROOT_PATHS.get(path) ?? DIRS_ANYWHERE.get(name) ?? null;
}

/** Why a file is skipped, or null when it is saved. `path` is root-relative. */
export function classifySourceFile(path: string): SourceSkipReason | null {
	const name = (path.split('/').pop() ?? path).toLowerCase();
	if (SECRET_FILE_NAMES.has(name)) return 'secret';
	if (name.startsWith('.env.')) {
		return ENV_TEMPLATE_SUFFIXES.has(name.slice('.env.'.length)) ? null : 'secret';
	}
	if (name.startsWith('.dev.vars.')) return 'secret';
	if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'secret';
	if (NOISE_FILE_NAMES.has(name)) return 'noise';
	if (NOISE_EXTENSIONS.some((ext) => name.endsWith(ext))) return 'noise';
	return null;
}

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
	{ label: 'a private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
	{ label: 'an AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ label: 'a GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/ },
	{ label: 'a Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
	{ label: 'a Stripe secret key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
	{ label: 'an OpenAI API key', pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
	{ label: 'an Anthropic API key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
];

/** The kind of secret a text contains (first match), or null. High-confidence shapes only. */
export function findSecretInText(text: string): string | null {
	for (const { label, pattern } of SECRET_PATTERNS) if (pattern.test(text)) return label;
	return null;
}

/** Decode bytes that are text; null for binary (NUL byte, invalid UTF-8, or bytes that would not round-trip). */
export function decodeSourceText(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) return null;
	let text: string;
	try {
		// ignoreBOM keeps a byte-order mark in the string, so the bytes round-trip exactly.
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
	return new TextEncoder().encode(text).byteLength === bytes.byteLength ? text : null;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function unsupportedName(name: string): boolean {
	return name === '' || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name);
}

/**
 * Walk `root` breadth-first, listing only folders the rules allow, then read
 * the included files. Throws a typed ScopeError (413 / 422) instead of ever
 * returning a partial snapshot.
 */
export async function collectSourceSnapshot(
	reader: SourceReader,
	root: string,
	caps: SourceCaps,
): Promise<SourceSnapshot> {
	const base = root.replace(/\/+$/, '');
	const included: Array<{ path: string; size: number }> = [];
	const skipped: SourceSkip[] = [];
	const queue: string[] = [''];
	let directories = 0;
	let listedBytes = 0;
	while (queue.length > 0) {
		const dir = queue.shift()!;
		directories += 1;
		if (directories > caps.maxDirectories) {
			throw new ScopeError(
				413,
				'source_too_large',
				`The app has more than ${caps.maxDirectories} folders to save. Nothing was sent to GitHub.`,
			);
		}
		const entries = await reader.list(dir ? `${base}/${dir}` : base);
		const ordered = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of ordered) {
			const path = dir ? `${dir}/${entry.name}` : entry.name;
			if (unsupportedName(entry.name)) {
				skipped.push({ path, reason: 'noise' });
				continue;
			}
			if (entry.isSymlink) {
				skipped.push({ path, reason: 'symlink' });
				continue;
			}
			if (entry.isDir) {
				const reason = classifySourceDirectory(path);
				if (reason) skipped.push({ path: `${path}/`, reason });
				else queue.push(path);
				continue;
			}
			if (!entry.isFile) {
				skipped.push({ path, reason: 'noise' });
				continue;
			}
			const reason = classifySourceFile(path);
			if (reason) {
				skipped.push({ path, reason });
				continue;
			}
			if (entry.size > caps.maxFileBytes) {
				throw new ScopeError(
					413,
					'source_file_too_large',
					`${path} is ${formatBytes(entry.size)}, above the ${formatBytes(caps.maxFileBytes)} limit for one file. Nothing was sent to GitHub.`,
				);
			}
			included.push({ path, size: entry.size });
			if (included.length > caps.maxFiles) {
				throw new ScopeError(
					413,
					'source_too_many_files',
					`The app has more than ${caps.maxFiles} files to save (dependencies and build output already left out). Nothing was sent to GitHub.`,
				);
			}
			listedBytes += entry.size;
			if (listedBytes > caps.maxTotalBytes) {
				throw new ScopeError(
					413,
					'source_too_large',
					`The app's files add up to more than ${formatBytes(caps.maxTotalBytes)}. Nothing was sent to GitHub.`,
				);
			}
		}
	}

	const files: SourceFile[] = [];
	let totalBytes = 0;
	for (const item of included) {
		const bytes = await reader.read(`${base}/${item.path}`);
		// The listing is a hint; the caps hold for the bytes actually read.
		if (bytes.byteLength > caps.maxFileBytes) {
			throw new ScopeError(
				413,
				'source_file_too_large',
				`${item.path} is ${formatBytes(bytes.byteLength)}, above the ${formatBytes(caps.maxFileBytes)} limit for one file. Nothing was sent to GitHub.`,
			);
		}
		totalBytes += bytes.byteLength;
		if (totalBytes > caps.maxTotalBytes) {
			throw new ScopeError(
				413,
				'source_too_large',
				`The app's files add up to more than ${formatBytes(caps.maxTotalBytes)}. Nothing was sent to GitHub.`,
			);
		}
		const text = decodeSourceText(bytes);
		if (text === null) {
			files.push({ path: item.path, content: bytesToBase64(bytes), encoding: 'base64', size: bytes.byteLength });
			continue;
		}
		const secret = findSecretInText(text);
		if (secret) {
			throw new ScopeError(
				422,
				'source_contains_secret',
				`${item.path} appears to contain ${secret}. Move it out of the code (into the app's environment settings) and save again. Nothing was sent to GitHub.`,
			);
		}
		files.push({ path: item.path, content: text, encoding: 'utf-8', size: bytes.byteLength });
	}
	if (files.length === 0) {
		throw new ScopeError(422, 'source_empty', 'The build has no source files to save.');
	}
	return { files, skipped, totalBytes };
}
