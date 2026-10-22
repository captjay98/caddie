/**
 * Part boundaries (plan part D) — a builder changes only its own part, and the
 * check is on the SAVED FILES, not on what tool a model happened to call. The
 * host records a manifest (path + sha256) of the app's source folders from the
 * committed snapshot through Contree's inspect API when a part STARTS, and
 * compares the snapshot against that manifest when the part FINISHES. Because
 * the check is on the result, a change made by a Node, Python or package
 * script is caught the same way a write-tool edit is.
 *
 * This file is the PURE core: which paths a role may touch (`areaFor`), how a
 * manifest is built by walking the source folders (`buildManifest`), and how a
 * snapshot is diffed against a manifest (`diffAgainstManifest`). It talks to
 * the sandbox only through a tiny read port (list + read), so it is tested
 * against the local contree stub with no running build. The DB-backed
 * orchestration (start_part / finish_part / restore_files) lives in
 * `build-steps.ts`, and the agent tools in `agents/tools.ts`.
 *
 * Team mode only: with teamMode = 0 none of this runs, so today's behaviour is
 * unchanged (the build loop never calls startPart).
 */

import {
	type ArchitectureBlock,
	CORE_MODULE,
	SMALL_APP_MODULE,
} from '@caddie/contracts';

/** A build role that owns an area. The three write roles plus 'other'. */
export const AREA_ROLES = ['backend', 'frontend', 'mobile', 'other'] as const;
export type AreaRole = (typeof AREA_ROLES)[number];

/**
 * The source folders a manifest covers. Everything under `src/`, plus a
 * mobile app's `lib/` and `test/app/`, plus `migrations/` (the backend area
 * for a small app). Generated and protected trees are never in an area, so
 * they are excluded from the manifest entirely (a change to them is neither
 * attributed to a role nor refused by the part check — they have their own
 * protected-path guard).
 */
export const MANIFEST_ROOTS: readonly string[] = ['src', 'migrations', 'lib', 'test/app'];

/**
 * Paths that are generated or protected: never part of any role's area, and
 * excluded from a manifest so the part check neither attributes nor refuses a
 * change to them. Mirrors the plan's "Generated and protected" list under
 * part D (not the broader acceptance-harness guard in permissions.ts).
 */
export const GENERATED_PREFIXES: readonly string[] = [
	'caddie/',
	'test/setup/',
	'migrations/0000_',
	'migrations/0001_schema.sql',
];

/** A single area matcher: a change is in-area when it matches one of these. */
export interface Area {
	role: AreaRole;
	/** Module id this area belongs to (big apps); the small-app module otherwise. */
	moduleId: string;
	/**
	 * Path prefixes (directory areas, each ends with `/`) and exact file paths
	 * (no trailing slash) this role may change. A path is in-area when it
	 * equals an exact entry or starts with a prefix entry.
	 */
	allow: readonly string[];
}

/** Is `path` a generated/protected path (never in any area, never manifested)? */
export function isGeneratedPath(path: string): boolean {
	const p = normalizePath(path);
	return GENERATED_PREFIXES.some((prefix) =>
		prefix.endsWith('/') ? p === prefix.replace(/\/$/, '') || p.startsWith(prefix) : p === prefix || p.startsWith(prefix),
	);
}

/** Normalize to forward slashes, no leading `./`, no leading/trailing slash. */
export function normalizePath(path: string): string {
	return path
		.replaceAll('\\', '/')
		.split('/')
		.reduce<string[]>((parts, part) => {
			if (part === '..') parts.pop();
			else if (part && part !== '.') parts.push(part);
			return parts;
		}, [])
		.join('/');
}

/** True when an app is a big (multi-module) app, which changes the areas. */
export function isBigApp(block: ArchitectureBlock): boolean {
	return block.modules.length > 1;
}

/**
 * The area a (role, module) owns, exactly as plan part D lists it.
 *
 * Small apps (one module):
 *   - backend : `src/server.ts`, `src/server/**`, `src/server.test.ts`, and
 *               `migrations/**` except protected files;
 *   - frontend: the rest of `src/`;
 *   - mobile  : `lib/` and `test/app/`;
 *   - other   : nothing.
 *
 * Big apps, per module:
 *   - backend : `src/server/<module>/**`;
 *   - frontend: `src/screens/<module>/**`; core's frontend ALSO owns
 *               `src/App.tsx`, `src/main.tsx` and `src/styles.css`;
 *   - mobile  : nothing (Flutter stays on today's pipeline — team mode off);
 *   - other   : nothing.
 */
export function areaFor(block: ArchitectureBlock, role: AreaRole, moduleId?: string): Area {
	if (role === 'other') return { role, moduleId: moduleId ?? SMALL_APP_MODULE, allow: [] };

	if (!isBigApp(block)) {
		const mod = SMALL_APP_MODULE;
		if (role === 'backend')
			return { role, moduleId: mod, allow: ['src/server.ts', 'src/server.test.ts', 'src/server/', 'migrations/'] };
		if (role === 'mobile') return { role, moduleId: mod, allow: ['lib/', 'test/app/'] };
		// frontend: the rest of src/. Expressed as "src/ minus the backend files",
		// resolved at match time (see inArea); the allow list is the whole of src/.
		return { role, moduleId: mod, allow: ['src/'] };
	}

	const mod = moduleId ?? CORE_MODULE;
	if (role === 'backend') return { role, moduleId: mod, allow: [`src/server/${mod}/`] };
	if (role === 'mobile') return { role, moduleId: mod, allow: [] };
	// frontend
	const allow = [`src/screens/${mod}/`];
	if (mod === CORE_MODULE) allow.push('src/App.tsx', 'src/main.tsx', 'src/styles.css');
	return { role, moduleId: mod, allow };
}

/**
 * The small-app BACKEND paths, used to carve them out of the frontend's
 * "rest of src/" area so one file is never owned by two roles.
 */
const SMALL_BACKEND_IN_SRC = ['src/server.ts', 'src/server.test.ts', 'src/server/'];

/**
 * Is a changed path inside an area? A generated/protected path is never
 * in-area (it is handled by its own guard and excluded from manifests). For
 * the small-app frontend, the backend files inside `src/` are carved out.
 */
export function inArea(area: Area, path: string): boolean {
	const p = normalizePath(path);
	if (isGeneratedPath(p)) return false;
	const matches = (entry: string): boolean =>
		entry.endsWith('/') ? p.startsWith(entry) : p === entry;
	if (!area.allow.some(matches)) return false;
	// Small-app frontend owns "the rest of src/": exclude the backend files.
	if (area.role === 'frontend' && area.allow.length === 1 && area.allow[0] === 'src/') {
		if (SMALL_BACKEND_IN_SRC.some(matches)) return false;
	}
	return true;
}

// --- manifest ----------------------------------------------------------------

/** One file in a manifest: its workspace-relative path and content sha256. */
export interface ManifestEntry {
	path: string;
	sha256: string;
}

/** A manifest of the app's source folders at a point in time. */
export interface PartManifest {
	/** The roots that were walked (a subset of MANIFEST_ROOTS that existed). */
	roots: string[];
	/** Every source file, sorted by path. */
	files: ManifestEntry[];
}

/**
 * The minimal snapshot-read surface this module needs. The real driver
 * (SandboxDriver) satisfies it via `listEntries` and `readFile`; the tests
 * satisfy it against the contree stub. Paths are workspace-relative.
 */
export interface SnapshotReadPort {
	/** One directory level: each child's name and whether it is a directory. */
	list(dir: string): Promise<Array<{ name: string; isDir: boolean }>>;
	/** The sha256 (hex) of a file's bytes. */
	sha256(path: string): Promise<string>;
}

/** A directory that does not exist yields an empty listing rather than throwing. */
async function safeList(
	port: SnapshotReadPort,
	dir: string,
): Promise<Array<{ name: string; isDir: boolean }>> {
	try {
		return await port.list(dir);
	} catch {
		return [];
	}
}

/**
 * Walk the app's source folders and record every file's path + sha256. Reads
 * only through the snapshot port (the committed image's inspect API), so a
 * file written by ANY means — a write tool, or a Node / Python / package
 * script — is seen identically. Generated and protected paths are skipped.
 */
export async function buildManifest(port: SnapshotReadPort): Promise<PartManifest> {
	const files: ManifestEntry[] = [];
	const roots: string[] = [];
	for (const root of MANIFEST_ROOTS) {
		const top = await safeList(port, root);
		if (top.length === 0) continue;
		roots.push(root);
		await walk(port, root, top, files);
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { roots, files };
}

async function walk(
	port: SnapshotReadPort,
	dir: string,
	entries: Array<{ name: string; isDir: boolean }>,
	out: ManifestEntry[],
): Promise<void> {
	for (const entry of entries) {
		const childPath = `${dir}/${entry.name}`;
		if (isGeneratedPath(childPath)) continue;
		if (entry.isDir) {
			await walk(port, childPath, await safeList(port, childPath), out);
		} else {
			out.push({ path: normalizePath(childPath), sha256: await port.sha256(childPath) });
		}
	}
}

// --- diff --------------------------------------------------------------------

/** A single out-of-area change found when a part finishes. */
export interface OutOfAreaChange {
	path: string;
	/** What changed about it relative to the start-of-part manifest. */
	kind: 'added' | 'modified' | 'deleted';
}

/**
 * Compare the current snapshot manifest with the start-of-part manifest and
 * return every change that falls OUTSIDE the part's area. An in-area change is
 * fine (that is the builder's own work); an out-of-area add, edit or delete is
 * refused. Generated/protected paths never appear (they are not manifested).
 */
export function diffAgainstManifest(
	area: Area,
	start: PartManifest,
	current: PartManifest,
): OutOfAreaChange[] {
	const startBy = new Map(start.files.map((f) => [f.path, f.sha256]));
	const currentBy = new Map(current.files.map((f) => [f.path, f.sha256]));
	const changes: OutOfAreaChange[] = [];
	for (const [path, sha] of currentBy) {
		const before = startBy.get(path);
		if (before === undefined) changes.push({ path, kind: 'added' });
		else if (before !== sha) changes.push({ path, kind: 'modified' });
	}
	for (const path of startBy.keys()) {
		if (!currentBy.has(path)) changes.push({ path, kind: 'deleted' });
	}
	return changes
		.filter((change) => !inArea(area, change.path))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The manifest's paths that fall inside an area (what restore_files may touch). */
export function inAreaPaths(area: Area, manifest: PartManifest): string[] {
	return manifest.files.filter((f) => inArea(area, f.path)).map((f) => f.path);
}
