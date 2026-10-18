import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { bytesToBase64 } from './adapters/contree.ts';
import { readWorkflow } from './build-workflow.ts';
import type { CodeStore } from './code-store.ts';
import { listCodeVersions, recordCodeVersion } from './code-versions.ts';
import { beginImportPreview } from './import-preview.ts';
import { ScopeError, assertProjectOwner } from './scope.ts';
import { isProtectedPath } from '../agents/permissions.ts';
import { SCAFFOLD_FILES, SCAFFOLD_PACKAGE } from '../../../../stacks/react-hono/scaffold.ts';

/**
 * "Start from my GitHub repo" (Publish programme stage 1). The repo is copied
 * in through the existing import (repositories.ts importRepoSnapshot: selected
 * repos of an active installation only; dependencies, build output and secrets
 * never copied), then, if Caddie can build it, its files become the project's
 * FIRST VERSION. The first build's working copy starts from that version
 * (working-copy.ts) instead of the empty template, so Caddie continues the app.
 *
 * The stack check is deliberately narrow for now: Caddie builds apps with one
 * recipe (React + Bun, bun.lock pinned), so it continues apps that were made
 * with Caddie (package.json "name": "caddie-project") and still have the parts
 * the recipe needs. Anything else gets a plain explanation and nothing changes.
 * Caddie's own runtime files (caddie/, test/setup/, bunfig.toml, the sign-in
 * tables) are refreshed to the current versions on the way in.
 */

export type RepoStartResult =
	| { ok: true; repoFullName: string; version: { commitId: string; seq: number; fileCount: number } }
	| { ok: false; reason: 'already_started' | 'not_caddie_app' | 'missing_parts' | 'unreadable'; message: string; missing?: string[] };

const NOT_CADDIE_APP =
	"Caddie can continue apps that were made with Caddie and saved to GitHub. This repo was made another way, so Caddie can't build on it yet.";

/** Caddie-owned files every app carries (the protected ones), refreshed on import. */
const RUNTIME_FILES: ReadonlyArray<[string, string]> = Object.entries(SCAFFOLD_FILES).filter(([path]) => isProtectedPath(path));

const PLANNING_PHASES = new Set(['planning', 'review', 'design', 'design-review']);

function asBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (Array.isArray(value)) return Uint8Array.from(value as number[]);
	if (typeof value === 'string') return new TextEncoder().encode(value);
	return null;
}

/** Can Caddie's recipe build this app? Plain words when it can't. */
export function checkCaddieApp(files: ReadonlyMap<string, Uint8Array>): { ok: true } | Extract<RepoStartResult, { ok: false }> {
	const packageJson = files.get('package.json');
	if (!packageJson) return { ok: false, reason: 'not_caddie_app', message: NOT_CADDIE_APP };
	let pkg: { name?: unknown; scripts?: Record<string, unknown>; dependencies?: Record<string, unknown> };
	try {
		pkg = JSON.parse(new TextDecoder().decode(packageJson)) as typeof pkg;
	} catch {
		return { ok: false, reason: 'unreadable', message: "This repo's package.json couldn't be read, so Caddie can't build it." };
	}
	if (pkg?.name !== SCAFFOLD_PACKAGE.name) return { ok: false, reason: 'not_caddie_app', message: NOT_CADDIE_APP };
	const missing: string[] = [];
	if (!files.has('bun.lock')) missing.push('bun.lock (the exact package versions)');
	if (!files.has('src/main.tsx')) missing.push('src/main.tsx (where the app starts)');
	if (typeof pkg.scripts?.['build'] !== 'string') missing.push('the build script in package.json');
	if (!pkg.dependencies?.['react'] || !pkg.dependencies?.['react-dom']) missing.push('React in package.json');
	if (missing.length > 0) {
		return { ok: false, reason: 'missing_parts', message: `This repo is missing parts Caddie needs to build it: ${missing.join('; ')}.`, missing };
	}
	return { ok: true };
}

/**
 * Make a copied repo the app's starting code. Owner-only; only for a project
 * that has no code of its own yet (no version, no build started).
 */
export async function startFromImport(db: D1Database, store: CodeStore, scope: Scope, input: { importId: unknown }): Promise<RepoStartResult> {
	const verified = await assertProjectOwner(db, scope);
	const importId = typeof input.importId === 'string' ? input.importId : '';
	const row = (await db.prepare('select * from "github_imports" where "id" = ? and "projectId" = ?').bind(importId, verified.projectId).all()).results?.[0] as
		| Record<string, unknown>
		| undefined;
	if (!row) throw new ScopeError(404, 'import_not_found', 'No such copy of the repo.');
	if ((await listCodeVersions(db, verified, 1)).length > 0) {
		return { ok: false, reason: 'already_started', message: 'This project already has its own code, so Caddie keeps building on that.' };
	}
	const workflow = await readWorkflow(db, verified);
	if (workflow && !PLANNING_PHASES.has(workflow.phase)) {
		return { ok: false, reason: 'already_started', message: 'Caddie already started building this app, so it keeps that code.' };
	}

	const manifest = JSON.parse(String(row['manifestJson'] ?? '[]')) as Array<{ path: string; contentHash: string }>;
	const files = new Map<string, Uint8Array>();
	for (const entry of manifest) {
		const blob = (await db.prepare('select "bytes" from "content_blobs" where "hash" = ?').bind(entry.contentHash).all()).results?.[0] as
			| { bytes?: unknown }
			| undefined;
		const bytes = asBytes(blob?.bytes);
		if (!bytes) throw new ScopeError(409, 'import_incomplete', 'Part of the copied code is missing. Copy the repo again.');
		files.set(entry.path, bytes);
	}
	const check = checkCaddieApp(files);
	if (!check.ok) return check;
	for (const [path, text] of RUNTIME_FILES) files.set(path, new TextEncoder().encode(text));

	const repoFullName = String(row['repoFullName']);
	const skipped = (JSON.parse(String(row['skippedJson'] ?? '[]')) as Array<{ path: string; reason: string }>).map(({ path, reason }) => ({ path, reason }));
	const { version } = await recordCodeVersion(db, store, verified, {
		kind: 'import',
		title: `Copied from ${repoFullName}`,
		files: [...files].map(([path, bytes]) => ({ path, contentBase64: bytesToBase64(bytes) })),
		skipped,
		actorId: verified.actorId,
	});
	// The planner reads the project's description: say plainly that this app continues the copied code.
	await db
		.prepare('update "projects" set "description" = trim(coalesce("description", \'\') || \' \' || ?) where "id" = ?')
		.bind(`Its code was copied from GitHub (${repoFullName}) as version ${version.seq}; Caddie builds on it.`, verified.projectId)
		.run();
	// The card shows "checking" now and the copied app once it is built (import-preview.ts).
	await beginImportPreview(db, verified, { commitId: version.commitId, versionSeq: version.seq, repoFullName });
	return { ok: true, repoFullName, version: { commitId: version.commitId, seq: version.seq, fileCount: files.size } };
}
