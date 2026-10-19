#!/usr/bin/env bun
/**
 * Live-run receipts (S01; bound to a release by review 2026-10-19 F05).
 *
 * A credential-gated gate may only report PASS when a live run was actually
 * recorded — having a key in `.dev.vars` is provisioning, not proof. So
 * `verify-packet.ts --live` appends a receipt here after every mapped live
 * spec of a packet passes, and `release-check.ts` reads it:
 *
 *   credentials absent                               -> BLOCKED
 *   credentials present, no current receipt          -> PROVISIONED (never PASS)
 *   credentials present + a CURRENT receipt          -> PASS
 *
 * A receipt is evidence about one revision of the code and the specs, run
 * against one target. It records the commit it tested (and whether the tree
 * was clean), a digest of the spec files, the target, the runner and an id.
 * `classifyReceipt` calls it current only while all of those still hold:
 *
 *   - the run was clean (no uncommitted change outside documentation);
 *   - the packet's live specs are the same files, with the same text;
 *   - the target is the one the gate needs;
 *   - no code changed since its commit. Documentation-only commits (anything
 *     under docs/, and top-level markdown such as README.md) do not make it
 *     stale: they cannot change what ran. Markdown under apps/ IS code (the
 *     agents import SKILL.md files).
 *
 * Old receipts that predate these fields are kept as history and read as
 * stale. A receipt holds no secret. It is committed as evidence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const LIVE_RECEIPTS_PATH = join(REPO_ROOT, 'docs/live-receipts.json');

export interface LiveReceipt {
	packet: string;
	files: string[];
	passed: number;
	/** ISO timestamp of the recorded run. */
	at: string;
	/** Stable id of this run. */
	id?: string;
	/** The commit the run tested (git HEAD at the time). */
	commit?: string;
	/** Whether the tree had uncommitted changes outside documentation. */
	dirty?: boolean;
	/** sha256 over the run's spec files (path and contents). */
	specDigest?: string;
	/** What the run hit: 'local', or the deployed origin of a hosted run. */
	target?: string;
	/** The runner, e.g. 'bun 1.4.0'. */
	runtime?: string;
}

/** Changes that cannot alter what a live run exercised. */
export function isDocumentationOnly(path: string): boolean {
	return path.startsWith('docs/') || (!path.includes('/') && /\.md$/i.test(path)) || path === 'LICENSE';
}

function sha256(input: string | Uint8Array): string {
	return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}

/** sha256 over the spec files' paths and contents, in path order. A missing file is part of the digest. */
export function specDigest(root: string, files: readonly string[]): string {
	const hash = new Bun.CryptoHasher('sha256');
	for (const file of [...files].sort()) {
		const path = join(root, file);
		hash.update(`${file}\0`);
		hash.update(existsSync(path) ? readFileSync(path) : '(missing)');
		hash.update('\0');
	}
	return hash.digest('hex');
}

/** HEAD and whether anything outside documentation is uncommitted. */
export function gitState(root: string = REPO_ROOT): { commit: string; dirty: boolean } {
	const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim();
	const changed = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: root })
		.stdout.toString()
		.split('\n')
		.map((line) => line.slice(3).trim().replace(/^"|"$/g, ''))
		.filter(Boolean);
	return { commit, dirty: changed.some((path) => !isDocumentationOnly(path)) };
}

/** Files changed between `commit` and HEAD, or null when `commit` is not in this history. */
export function changedSince(commit: string, root: string = REPO_ROOT): string[] | null {
	const run = Bun.spawnSync(['git', 'diff', '--name-only', `${commit}..HEAD`], { cwd: root });
	if (run.exitCode !== 0) return null;
	return run.stdout.toString().split('\n').filter(Boolean);
}

/** Every recorded receipt, keyed by packet id. A malformed file reads as empty. */
export function readLiveReceipts(path: string = LIVE_RECEIPTS_PATH): Map<string, LiveReceipt> {
	const receipts = new Map<string, LiveReceipt>();
	if (!existsSync(path)) return receipts;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
		if (!Array.isArray(parsed)) return receipts;
		for (const entry of parsed as LiveReceipt[]) {
			if (entry && typeof entry.packet === 'string' && Array.isArray(entry.files)) receipts.set(entry.packet, entry);
		}
	} catch {
		// A corrupt receipts file is an empty one: no receipt, no PASS.
	}
	return receipts;
}

export interface RecordOptions {
	/** Receipts file (default docs/live-receipts.json). */
	path?: string;
	/** Repo root the spec paths are relative to. */
	root?: string;
	/** Commit and cleanliness of the tree that ran (default: read from git). */
	git?: () => { commit: string; dirty: boolean };
}

/** Record a passing live run, replacing any earlier receipt for the packet. */
export function recordLiveReceipt(
	input: { packet: string; files: string[]; passed: number; target?: string; at?: Date },
	options: RecordOptions = {},
): LiveReceipt {
	if (!(input.passed > 0)) throw new Error(`a live receipt needs at least one passing test (${input.packet} had ${input.passed})`);
	const root = options.root ?? REPO_ROOT;
	const path = options.path ?? LIVE_RECEIPTS_PATH;
	const { commit, dirty } = (options.git ?? (() => gitState(root)))();
	const files = [...input.files].sort();
	const at = (input.at ?? new Date()).toISOString();
	const digest = specDigest(root, files);
	const target = input.target ?? 'local';
	const receipt: LiveReceipt = {
		packet: input.packet,
		files,
		passed: input.passed,
		at,
		id: `lr_${sha256(`${input.packet}|${commit}|${digest}|${target}|${at}`).slice(0, 16)}`,
		commit,
		dirty,
		specDigest: digest,
		target,
		runtime: `bun ${Bun.version}`,
	};
	const receipts = readLiveReceipts(path);
	receipts.set(receipt.packet, receipt);
	const ordered = [...receipts.values()].sort((a, b) => a.packet.localeCompare(b.packet));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(ordered, null, '\t')}\n`);
	return receipt;
}

/** What a receipt is compared against: the release candidate being checked. */
export interface ReceiptContext {
	/** The packet's mapped live specs now. */
	readonly mappedFiles: readonly string[];
	/** specDigest of those specs now. */
	readonly specDigest: string;
	/** The commit being checked (HEAD). */
	readonly head: string;
	/** Files changed from `commit` to HEAD, or null when `commit` is unknown here. */
	readonly changedSince: (commit: string) => string[] | null;
	/** The target the gate needs ('local' unless a hosted origin is named). */
	readonly expectedTarget: string;
}

export type ReceiptStatus = { readonly status: 'current' } | { readonly status: 'stale'; readonly reason: string };

/** Whether a receipt still proves its gate for the release candidate described by `ctx`. */
export function classifyReceipt(receipt: LiveReceipt, ctx: ReceiptContext): ReceiptStatus {
	const stale = (reason: string): ReceiptStatus => ({ status: 'stale', reason });
	if (!receipt.commit || typeof receipt.dirty !== 'boolean' || !receipt.specDigest || !receipt.target) {
		return stale('it was recorded before receipts named their commit, specs and target');
	}
	if (!(receipt.passed > 0)) return stale('it records no passing test');
	if (receipt.dirty) return stale('it ran with uncommitted changes, so it matches no commit');
	const ran = [...receipt.files].sort().join('\n');
	const mapped = [...ctx.mappedFiles].sort().join('\n');
	if (ran !== mapped) return stale("the packet's live specs are not the ones that ran");
	if (receipt.specDigest !== ctx.specDigest) return stale('the live specs changed since the run');
	if (receipt.target !== ctx.expectedTarget) return stale(`it was recorded against ${receipt.target}, not ${ctx.expectedTarget}`);
	if (receipt.commit !== ctx.head) {
		const changed = ctx.changedSince(receipt.commit);
		if (changed === null) return stale(`its commit ${receipt.commit.slice(0, 12)} is not in this history`);
		const code = changed.filter((path) => !isDocumentationOnly(path));
		if (code.length > 0) {
			return stale(`the code changed since ${receipt.commit.slice(0, 12)} (${code.slice(0, 3).join(', ')}${code.length > 3 ? ', …' : ''})`);
		}
	}
	return { status: 'current' };
}

/**
 * A live gate's status. PASS needs BOTH a current receipt and the credentials
 * still provisioned; a stale receipt is history, and credentials alone are
 * provisioning. The detail says which and why.
 */
export function liveGateStatus(input: {
	readonly configured: boolean;
	readonly env: string;
	readonly packet: string;
	readonly receipt: LiveReceipt | undefined;
	readonly verdict: ReceiptStatus | null;
	readonly mappedLive: number;
}): { status: 'PASS' | 'PROVISIONED' | 'BLOCKED'; detail: string } {
	const { configured, env, packet, receipt, verdict, mappedLive } = input;
	const rerun = mappedLive === 0
		? `${packet} maps no live spec, so only the owner's recorded run (docs/release-evidence.md) can assert this gate`
		: `run \`bun run test:live -- ${packet}\``;
	if (receipt && verdict?.status === 'current') {
		const tested = `live receipt ${receipt.id} at ${receipt.commit!.slice(0, 12)} against ${receipt.target}: ${receipt.files.length} spec(s), ${receipt.passed} test(s) passed (${receipt.at})`;
		return configured
			? { status: 'PASS', detail: tested }
			: { status: 'BLOCKED', detail: `${tested}, but ${env} is no longer provisioned` };
	}
	const history = receipt && verdict?.status === 'stale' ? `stale receipt (${verdict.reason}); ` : '';
	if (!configured) return { status: 'BLOCKED', detail: `${history}BLOCKED — provision ${env} (owner input)` };
	return { status: 'PROVISIONED', detail: `${history}PROVISIONED, never PASS — ${env} is present but no current receipt exists; ${rerun}` };
}
