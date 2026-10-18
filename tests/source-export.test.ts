import { describe, expect, test } from 'bun:test';
import { ScopeError } from '../apps/app/src/server/scope.ts';
import {
	classifySourceDirectory,
	classifySourceFile,
	collectSourceSnapshot,
	decodeSourceText,
	findSecretInText,
	type SourceEntry,
	type SourceReader,
} from '../apps/app/src/server/source-export.ts';

/**
 * LOCAL VERIFIED: the "save the code to GitHub" read-side rules and the walker
 * over an in-memory tree that records every listing and read. No sandbox and
 * no network; tests/github-source.test.ts runs the same walker against the
 * contree stub over HTTP.
 *
 * Fake secrets are assembled at runtime so this file never contains a
 * token-shaped literal.
 */

const ROOT = '/workspace/proj_src';
const CAPS = { maxFiles: 200, maxFileBytes: 512 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxDirectories: 400 };
const PRIVATE_KEY_HEADER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

function memoryTree(
	files: Record<string, string | Uint8Array>,
	options: { symlinks?: string[]; listedSize?: Record<string, number> } = {},
) {
	const bytes = new Map<string, Uint8Array>(
		Object.entries(files).map(([path, content]) => [
			`${ROOT}/${path}`,
			typeof content === 'string' ? new TextEncoder().encode(content) : content,
		]),
	);
	const symlinks = new Set((options.symlinks ?? []).map((path) => `${ROOT}/${path}`));
	const listed: string[] = [];
	const read: string[] = [];
	const reader: SourceReader = {
		async list(dir) {
			listed.push(dir);
			const prefix = `${dir}/`;
			const children = new Map<string, SourceEntry>();
			for (const path of [...bytes.keys(), ...symlinks]) {
				if (!path.startsWith(prefix)) continue;
				const [name = '', ...deeper] = path.slice(prefix.length).split('/');
				if (deeper.length > 0) {
					children.set(name, { name, isDir: true, isFile: false, isSymlink: false, size: 0 });
					continue;
				}
				const link = symlinks.has(path);
				const relative = path.slice(ROOT.length + 1);
				children.set(name, {
					name,
					isDir: false,
					isFile: !link,
					isSymlink: link,
					size: options.listedSize?.[relative] ?? bytes.get(path)?.byteLength ?? 0,
				});
			}
			return [...children.values()];
		},
		async read(path) {
			read.push(path);
			const content = bytes.get(path);
			if (!content) throw new Error(`no such file ${path}`);
			return content;
		},
	};
	return { reader, listed, read };
}

async function refusal(task: Promise<unknown>): Promise<ScopeError> {
	try {
		await task;
	} catch (error) {
		expect(error).toBeInstanceOf(ScopeError);
		return error as ScopeError;
	}
	throw new Error('expected a typed refusal, but the snapshot succeeded');
}

describe('save the code to GitHub — what may leave the sandbox', () => {
	test('folder rules: dependencies, caches and VCS anywhere; build output only at the app root', () => {
		expect(classifySourceDirectory('node_modules')).toBe('dependencies');
		expect(classifySourceDirectory('packages/web/node_modules')).toBe('dependencies');
		expect(classifySourceDirectory('.git')).toBe('noise');
		expect(classifySourceDirectory('src/__pycache__')).toBe('noise');
		expect(classifySourceDirectory('dist')).toBe('build-output');
		expect(classifySourceDirectory('public/build')).toBe('build-output');
		expect(classifySourceDirectory('vendor')).toBe('dependencies');
		expect(classifySourceDirectory('.ssh')).toBe('secret');
		// a nested build/ or dist/ is somebody's source, not output
		expect(classifySourceDirectory('src/build')).toBeNull();
		expect(classifySourceDirectory('src/dist')).toBeNull();
		expect(classifySourceDirectory('src')).toBeNull();
	});

	test('file rules: secrets and noise are skipped; templates, lockfiles and dotfiles are source', () => {
		for (const secret of ['.env', '.env.local', '.env.production', 'api/.env', '.dev.vars', '.dev.vars.staging', 'certs/server.pem', 'keys/app.key', 'id_rsa', '.npmrc', 'credentials.json']) {
			expect(classifySourceFile(secret)).toBe('secret');
		}
		for (const noise of ['.DS_Store', 'debug.log', 'tsconfig.tsbuildinfo', 'local.sqlite', 'data/app.db']) {
			expect(classifySourceFile(noise)).toBe('noise');
		}
		for (const source of ['.env.example', '.env.sample', 'id_rsa.pub', 'bun.lock', 'package.json', '.gitignore', 'src/keyboard.ts', 'CHANGELOG.md']) {
			expect(classifySourceFile(source)).toBeNull();
		}
	});

	test('the secret scan finds high-confidence key shapes and leaves ordinary code alone', () => {
		const aws = 'AKIA' + 'Q'.repeat(16);
		const github = 'gh' + 'p_' + 'a1B2'.repeat(9);
		const openai = 'sk-' + 'proj-' + 'x'.repeat(24);
		const stripe = 'sk' + '_live_' + '9'.repeat(24);
		expect(findSecretInText(`const key = "${PRIVATE_KEY_HEADER}\\nMIIE..."`)).toBe('a private key');
		expect(findSecretInText(`aws_access_key_id = ${aws}`)).toBe('an AWS access key');
		expect(findSecretInText(`token: '${github}'`)).toBe('a GitHub token');
		expect(findSecretInText(`OPENAI=${openai}`)).toBe('an OpenAI API key');
		expect(findSecretInText(`stripe(${JSON.stringify(stripe)})`)).toBe('a Stripe secret key');
		for (const ordinary of [
			'export const task = "sk-1";',
			'// AKIA is not a key on its own',
			'const branch = "ghp_short";',
			'const PUBLIC_KEY_HEADER = "-----BEGIN PUBLIC KEY-----";',
			'export function App() { return null; }',
		]) {
			expect(findSecretInText(ordinary)).toBeNull();
		}
	});

	test('text detection: UTF-8 (with a BOM) round-trips; NUL bytes and invalid UTF-8 are binary', () => {
		expect(decodeSourceText(new TextEncoder().encode('héllo — ok\n'))).toBe('héllo — ok\n');
		const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
		const text = decodeSourceText(bom);
		expect(text).not.toBeNull();
		expect(new TextEncoder().encode(text!)).toEqual(bom);
		expect(decodeSourceText(PNG)).toBeNull();
		expect(decodeSourceText(new Uint8Array([0x61, 0xff, 0x62]))).toBeNull();
	});

	test('a real app tree: source and binaries saved, the rest left out without being listed or read', async () => {
		const tree = memoryTree({
			'package.json': '{"name":"farm-log"}\n',
			'bun.lockb': new Uint8Array([0x62, 0x75, 0x6e, 0, 1, 2, 0xff]),
			'.env': 'NEBIUS_API_KEY=value-that-must-stay\n',
			'.env.example': 'NEBIUS_API_KEY=\n',
			'.dev.vars': 'SECRET=1\n',
			'.DS_Store': new Uint8Array([0, 0, 0, 1]),
			'src/App.tsx': 'export const App = () => null;\n',
			'src/build/helpers.ts': 'export const helper = 1;\n',
			'public/logo.png': PNG,
			'keys/server.pem': `${PRIVATE_KEY_HEADER}\n`,
			'node_modules/react/index.js': 'module.exports = {};\n',
			'dist/main.js': 'console.log(1);\n',
			'.git/HEAD': 'ref: refs/heads/main\n',
			'coverage/lcov.info': 'TN:\n',
		});
		const snapshot = await collectSourceSnapshot(tree.reader, ROOT, CAPS);

		expect(snapshot.files.map((f) => f.path).sort()).toEqual([
			'.env.example',
			'bun.lockb',
			'package.json',
			'public/logo.png',
			'src/App.tsx',
			'src/build/helpers.ts',
		]);
		expect(snapshot.skipped).toEqual(
			expect.arrayContaining([
				{ path: '.env', reason: 'secret' },
				{ path: '.dev.vars', reason: 'secret' },
				{ path: 'keys/server.pem', reason: 'secret' },
				{ path: 'node_modules/', reason: 'dependencies' },
				{ path: 'dist/', reason: 'build-output' },
				{ path: '.git/', reason: 'noise' },
				{ path: 'coverage/', reason: 'noise' },
				{ path: '.DS_Store', reason: 'noise' },
			]),
		);
		// never listed: the walk does not even open the skipped folders
		for (const dir of ['node_modules', 'dist', '.git', 'coverage']) {
			expect(tree.listed).not.toContain(`${ROOT}/${dir}`);
		}
		// never read: a secret file's bytes never enter the Worker
		for (const secret of ['.env', '.dev.vars', 'keys/server.pem']) {
			expect(tree.read).not.toContain(`${ROOT}/${secret}`);
		}
		// binaries travel base64 and decode to the exact bytes
		const png = snapshot.files.find((f) => f.path === 'public/logo.png')!;
		expect(png.encoding).toBe('base64');
		expect(new Uint8Array(Buffer.from(png.content, 'base64'))).toEqual(PNG);
		expect(snapshot.files.find((f) => f.path === 'bun.lockb')!.encoding).toBe('base64');
		expect(snapshot.files.find((f) => f.path === 'src/App.tsx')!.encoding).toBe('utf-8');
	});

	test('a symlink is skipped, never followed or read', async () => {
		const tree = memoryTree({ 'src/App.tsx': 'export {};\n', 'src/target.ts': 'export {};\n' }, { symlinks: ['src/link.ts'] });
		const snapshot = await collectSourceSnapshot(tree.reader, ROOT, CAPS);
		expect(snapshot.skipped).toContainEqual({ path: 'src/link.ts', reason: 'symlink' });
		expect(tree.read).not.toContain(`${ROOT}/src/link.ts`);
	});

	test('the caps refuse the whole save from the listing, before any file is read', async () => {
		const many: Record<string, string> = {};
		for (let i = 0; i < 201; i++) many[`src/f${String(i).padStart(3, '0')}.ts`] = `export const n = ${i};\n`;
		const tooMany = memoryTree(many);
		expect((await refusal(collectSourceSnapshot(tooMany.reader, ROOT, CAPS))).code).toBe('source_too_many_files');
		expect(tooMany.read).toHaveLength(0);

		const bigFile = memoryTree({ 'src/App.tsx': 'export {};\n', 'public/video.mp4': new Uint8Array(600 * 1024) });
		const big = await refusal(collectSourceSnapshot(bigFile.reader, ROOT, CAPS));
		expect(big.code).toBe('source_file_too_large');
		expect(big.status).toBe(413);
		expect(big.message).toContain('public/video.mp4');
		expect(bigFile.read).toHaveLength(0);

		const heavy: Record<string, Uint8Array> = {};
		for (let i = 0; i < 17; i++) heavy[`assets/a${i}.bin`] = new Uint8Array(500 * 1024);
		const tooHeavy = memoryTree(heavy);
		expect((await refusal(collectSourceSnapshot(tooHeavy.reader, ROOT, CAPS))).code).toBe('source_too_large');
		expect(tooHeavy.read).toHaveLength(0);
	});

	test('a listing that understates a size is still caught on the bytes actually read', async () => {
		const tree = memoryTree({ 'public/big.bin': new Uint8Array(600 * 1024) }, { listedSize: { 'public/big.bin': 10 } });
		expect((await refusal(collectSourceSnapshot(tree.reader, ROOT, CAPS))).code).toBe('source_file_too_large');
	});

	test('a secret inside a source file refuses the whole save and names the file', async () => {
		const tree = memoryTree({
			'src/App.tsx': 'export {};\n',
			'src/config.ts': `export const key = \`${PRIVATE_KEY_HEADER}\nMIIEvQ\`;\n`,
		});
		const error = await refusal(collectSourceSnapshot(tree.reader, ROOT, CAPS));
		expect(error.code).toBe('source_contains_secret');
		expect(error.status).toBe(422);
		expect(error.message).toContain('src/config.ts');
		expect(error.message).toContain('a private key');
	});

	test('an app with nothing to save is a typed refusal, not an empty pull request', async () => {
		const tree = memoryTree({ 'node_modules/x/index.js': 'x\n', '.env': 'A=1\n' });
		expect((await refusal(collectSourceSnapshot(tree.reader, ROOT, CAPS))).code).toBe('source_empty');
	});
});
