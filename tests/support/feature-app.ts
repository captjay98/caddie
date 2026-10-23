// Lane 9 test support: materialise a REAL react-hono starter app (the same
// SCAFFOLD_BASE_FILES the host writes) with the generated feature files under
// test — payments (part J), files (part L) and/or the kit recipes (part O) —
// plus a small app server + screen that USE them, then
// `bun install --frozen-lockfile` once and run route/screen tests inside it
// with the scaffold's own D1 harness.
//
// Why materialise instead of importing the generated strings directly: the
// generated code is real TypeScript that depends on hono, react and the
// scaffold's caddie/ runtime. Running it inside a materialised app is the only
// way the ROUTES are actually exercised (D10 card outcomes, 402 before
// checkout, chunked uploads, sha256 refusal, owner privacy) rather than merely
// grepped. Same approach as the S4 spike (tests/support/contract-restart-app.ts).
//
// The caller passes the generated file maps it needs, so a part's test depends
// only on its own generated module.
//
// LOCAL VERIFIED: no paid calls, no sandbox, no network.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCAFFOLD_BASE_FILES } from '../../stacks/react-hono/scaffold.ts';
import { SCAFFOLD_LOCKFILE } from '../../stacks/react-hono/scaffold-lock.ts';

const bun = process.execPath;

export interface FeatureApp {
	dir: string;
	cleanup(): void;
}

function write(dir: string, path: string, text: string): void {
	const full = join(dir, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

/**
 * Materialise the starter + the given generated file maps (payments/files/kit)
 * + any extra files (an app server that mounts them, a test file), then install
 * once. Every map and `extra` is keyed by project-relative path; later maps win
 * on a collision, so `extra` can override a generated file if a test needs to.
 */
export function materializeFeatureApp(generated: Array<Record<string, string>>, extra: Record<string, string> = {}): FeatureApp {
	if (!SCAFFOLD_LOCKFILE) throw new Error('scaffold-lock.ts is empty; run scripts/refresh-scaffold-lock.ts first');
	const dir = mkdtempSync(join(tmpdir(), 'caddie-feat-'));
	for (const [path, text] of Object.entries(SCAFFOLD_BASE_FILES)) write(dir, path, text);
	write(dir, 'bun.lock', SCAFFOLD_LOCKFILE);
	for (const map of generated) for (const [path, text] of Object.entries(map)) write(dir, path, text);
	for (const [path, text] of Object.entries(extra)) write(dir, path, text);

	const install = spawnSync(bun, ['install', '--frozen-lockfile'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
	if ((install.status ?? 1) !== 0) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(`bun install --frozen-lockfile failed:\n${install.stdout}\n${install.stderr}`);
	}
	return {
		dir,
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** Run `bun test <file>` inside the app. Returns ok + combined output. */
export function runFeatureTest(app: FeatureApp, testFile: string): { ok: boolean; out: string } {
	const result = spawnSync(bun, ['test', testFile], { cwd: app.dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
	return { ok: (result.status ?? 1) === 0, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}
