#!/usr/bin/env bun
/**
 * Live-run receipts (S01).
 *
 * A credential-gated gate may only report PASS when a live run was actually
 * recorded — having a key in `.dev.vars` is provisioning, not proof. So
 * `verify-packet.ts --live` appends a receipt here after every mapped live
 * spec of a packet passes, and `release-check.ts` reads it:
 *
 *   credentials absent                          -> BLOCKED
 *   credentials present, no receipt             -> PROVISIONED (never PASS)
 *   credentials present + a receipt for packet  -> PASS
 *
 * A receipt holds no secret: packet id, the spec files that ran, the pass
 * count and when. It is committed as evidence; delete a packet's entry to
 * withdraw a stale claim.
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
}

/** Every recorded receipt, keyed by packet id. A malformed file reads as empty. */
export function readLiveReceipts(): Map<string, LiveReceipt> {
	const receipts = new Map<string, LiveReceipt>();
	if (!existsSync(LIVE_RECEIPTS_PATH)) return receipts;
	try {
		const parsed: unknown = JSON.parse(readFileSync(LIVE_RECEIPTS_PATH, 'utf8'));
		if (!Array.isArray(parsed)) return receipts;
		for (const entry of parsed as LiveReceipt[]) {
			if (entry && typeof entry.packet === 'string' && Array.isArray(entry.files)) receipts.set(entry.packet, entry);
		}
	} catch {
		// A corrupt receipts file is an empty one: no receipt, no PASS.
	}
	return receipts;
}

/** Record a passing live run, replacing any earlier receipt for the packet. */
export function recordLiveReceipt(input: { packet: string; files: string[]; passed: number; at?: Date }): LiveReceipt {
	const receipt: LiveReceipt = {
		packet: input.packet,
		files: [...input.files].sort(),
		passed: input.passed,
		at: (input.at ?? new Date()).toISOString(),
	};
	const receipts = readLiveReceipts();
	receipts.set(receipt.packet, receipt);
	const ordered = [...receipts.values()].sort((a, b) => a.packet.localeCompare(b.packet));
	mkdirSync(dirname(LIVE_RECEIPTS_PATH), { recursive: true });
	writeFileSync(LIVE_RECEIPTS_PATH, `${JSON.stringify(ordered, null, '\t')}\n`);
	return receipt;
}
