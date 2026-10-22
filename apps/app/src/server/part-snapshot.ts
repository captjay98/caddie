/**
 * Part-snapshot ports (plan part D, review item 5).
 *
 * The REAL adapters that let `build-steps.ts` read a part's manifest and
 * restore files over the run's sandbox — through Contree's INSPECT API against
 * a given COMMITTED image, never a command in the session. A command would run
 * model-influenced code; inspect reads the committed bytes directly, so a file
 * a build script changed through `sandbox_exec` is seen exactly as a write-tool
 * edit is. That is what makes the part boundary enforceable (part D, review
 * item 5: "a file a script changed through sandbox_exec outside the area is
 * caught end to end").
 *
 * `build-steps.ts` depends only on the tiny `SnapshotReadPort` / `SnapshotWritePort`
 * surfaces (list + sha, readFromStart + writeBatch). This file binds those to
 * the sandbox:
 *   - the READ port walks the workspace with `inspectList` and hashes each
 *     file's bytes from `inspectDownload`, against a specific committed image;
 *   - the WRITE port reads start-image bytes with `inspectDownload` and writes
 *     them back through the driver's own batched `uploadFiles` (one commit).
 *
 * Team mode only. Nothing here runs with team mode off (the build loop never
 * starts a part, so these ports are never constructed).
 *
 * --- One archive instead of a read per file? -------------------------------
 * Contree exposes `inspectArchive(image, dir)` — a POSIX tar of a whole tree in
 * ONE request, versus one `inspectDownload` per file. For a 300-file app that
 * is 1 request instead of ~300. But the manifest needs each file's own path and
 * sha256, so the tar still has to be DECODED member-by-member, and the bytes
 * then hashed — the request count drops but the per-file hashing (the real
 * cost) does not. The per-file `inspectList` + `inspectDownload` path needs no
 * tar reader, is already proven end to end against the driver
 * (tests/sandbox.contract.test.ts), and measures in single-digit milliseconds
 * for 300 files through the stub (the S2 figure the part-boundaries test
 * prints). So the per-file path is the default; `snapshotReadFromArchive` below
 * is the one-request variant, used only where a tar decoder is available.
 */

import type { SnapshotReadPort } from './part-manifests.ts';
import type { SnapshotWritePort } from './build-steps.ts';

/**
 * The minimal image-level inspect surface these ports need — exactly the three
 * methods the real ContreeClient exposes (and the SandboxStub emulates), so the
 * ports are tested against both without a separate fake. Paths are ABSOLUTE
 * inside the image (the workspace root is prepended here).
 */
export interface ImageInspect {
	/** One directory level inside an image; null when the directory is absent. */
	inspectList(
		imageUuid: string,
		dirAbsolutePath: string,
		signal?: AbortSignal,
	): Promise<{ files: Array<{ path: string; isDir: boolean; isRegular: boolean }> } | null>;
	/** Raw bytes of one file inside an image; null when it is absent. */
	inspectDownload(imageUuid: string, absolutePath: string, signal?: AbortSignal): Promise<Uint8Array | null>;
	/** A tar archive of a tree inside an image; null when absent. Used only by the archive variant. */
	inspectArchive(imageUuid: string, absolutePath: string, signal?: AbortSignal): Promise<Uint8Array | null>;
}

/** The driver surface the WRITE port needs: a batched, command-free upload. */
export interface SandboxUpload {
	uploadFiles(
		sessionId: string,
		files: ReadonlyArray<{ path: string; contentBase64: string }>,
	): Promise<{ saved: number }>;
}

/** sha256 (hex) of bytes, matching the driver's own hashing. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const digest = await crypto.subtle.digest('SHA-256', copy);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** Join the workspace root and a workspace-relative path to an absolute image path. */
function absolute(root: string, relative: string): string {
	const base = root.replace(/\/+$/, '');
	const rel = relative.replace(/^\/+/, '');
	return rel === '' ? base || '/' : `${base}/${rel}`;
}

/** Strip the workspace root + leading slash to get a workspace-relative path. */
function relativeTo(root: string, absolutePath: string): string {
	const base = root.replace(/\/+$/, '');
	const stripped = absolutePath.startsWith(`${base}/`) ? absolutePath.slice(base.length + 1) : absolutePath;
	return stripped.replace(/^\/+/, '');
}

/**
 * A `SnapshotReadPort` reading a COMMITTED image through inspect. `list` returns
 * one directory level with each child's name + isDir; `sha256` downloads a
 * file's bytes and hashes them. All against the one `image` the part started
 * from (start) or the current session image (finish) — the caller passes which.
 */
export function snapshotReadPort(
	inspect: ImageInspect,
	image: string,
	workspaceRoot: string,
	signal?: AbortSignal,
): SnapshotReadPort & { image: string } {
	return {
		image,
		async list(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
			const listing = await inspect.inspectList(image, absolute(workspaceRoot, dir), signal);
			if (!listing) return [];
			// Contree returns each entry's NAME in `path`, relative to the dir.
			return listing.files.map((entry) => ({ name: entry.path, isDir: entry.isDir }));
		},
		async sha256(path: string): Promise<string> {
			const bytes = await inspect.inspectDownload(image, absolute(workspaceRoot, path), signal);
			if (bytes === null) throw new Error(`part-snapshot: ${path} is gone from image ${image}`);
			return sha256Hex(bytes);
		},
	};
}

/**
 * A `SnapshotWritePort` for restore_files: read start-image bytes through
 * inspect, and write them back through the driver's batched `uploadFiles` (one
 * commit, no model-influenced command). It deliberately provides NO
 * `deleteBatch`: the driver has no command-free delete (every write commits
 * through a `true` run; a delete would need a model-visible `rm`), so
 * `restoreFiles` REPORTS an out-of-area add for the builder to remove rather
 * than running a command — exactly what review item 4 asks for.
 */
export function snapshotWritePort(
	inspect: ImageInspect,
	startImage: string,
	driver: SandboxUpload,
	sessionId: string,
	workspaceRoot: string,
	signal?: AbortSignal,
): SnapshotWritePort {
	return {
		async readFromStart(path: string): Promise<string> {
			const bytes = await inspect.inspectDownload(startImage, absolute(workspaceRoot, path), signal);
			if (bytes === null) throw new Error(`part-snapshot: ${path} is gone from the start image ${startImage}`);
			// Base64, as uploadFiles expects.
			let binary = '';
			for (const byte of bytes) binary += String.fromCharCode(byte);
			return btoa(binary);
		},
		async writeBatch(files: Array<{ path: string; contentBase64: string }>): Promise<void> {
			if (files.length === 0) return;
			await driver.uploadFiles(sessionId, files);
		},
		// deleteBatch intentionally omitted — see the docstring above.
	};
}

/**
 * The one-request archive variant of the read port (see the file header). It
 * fetches the whole workspace tree as a tar in a single `inspectArchive` call
 * and hands the raw bytes to `decodeTar`, which the caller supplies (a tar
 * reader is not in this module's dependencies). Not the default; kept so a
 * big-app manifest can switch to it without changing `build-steps.ts`.
 */
export function snapshotReadFromArchive(
	inspect: ImageInspect,
	image: string,
	workspaceRoot: string,
	decodeTar: (bytes: Uint8Array) => Array<{ path: string; bytes: Uint8Array }>,
	signal?: AbortSignal,
): SnapshotReadPort & { image: string } {
	let cache: Map<string, Uint8Array> | null = null;
	const load = async (): Promise<Map<string, Uint8Array>> => {
		if (cache) return cache;
		const tar = await inspect.inspectArchive(image, workspaceRoot.replace(/\/+$/, ''), signal);
		cache = new Map((tar ? decodeTar(tar) : []).map((m) => [relativeTo(workspaceRoot, m.path), m.bytes]));
		return cache;
	};
	return {
		image,
		async list(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
			const files = await load();
			const prefix = dir === '' ? '' : `${relativeTo(workspaceRoot, absolute(workspaceRoot, dir))}/`;
			const names = new Map<string, boolean>();
			for (const path of files.keys()) {
				if (prefix && !path.startsWith(prefix)) continue;
				const rest = path.slice(prefix.length);
				if (rest === '') continue;
				const slash = rest.indexOf('/');
				if (slash === -1) names.set(rest, false);
				else names.set(rest.slice(0, slash), true);
			}
			return [...names.entries()].map(([name, isDir]) => ({ name, isDir }));
		},
		async sha256(path: string): Promise<string> {
			const files = await load();
			const bytes = files.get(relativeTo(workspaceRoot, absolute(workspaceRoot, path)));
			if (bytes === undefined) throw new Error(`part-snapshot(archive): ${path} is not in image ${image}`);
			return sha256Hex(bytes);
		},
	};
}
