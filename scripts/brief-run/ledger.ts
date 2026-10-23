/**
 * Lane 8, step 5 — the campaign ledger.
 *
 * A JSON file under `tests/briefs/runs/` (gitignored, cleared between
 * campaigns) that records, AFTER each brief run:
 *   - the run mode (team | baseline), from step 6;
 *   - the campaign cap and what had been spent before this build;
 *   - the brief, its build limit, and the cap decision (allowed / refused);
 *   - this build's own spend and the "complete" verdict.
 *
 * The ledger is how the D5 cap is enforced ACROSS runs without re-reading D1
 * each time, and how a later audit sees exactly which builds spent what. It is
 * append-only within a campaign: `appendRun` reads the file, adds a record and
 * rewrites it, so a crash between runs loses at most the in-flight run.
 *
 * File I/O goes through an injected `LedgerStore`, so the ledger logic is
 * tested with an in-memory store — no disk. The default store reads/writes the
 * real path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunMode } from './mode.ts';

export interface LedgerRunRecord {
	at: string;
	briefId: string;
	size: 'small' | 'medium' | 'big';
	mode: RunMode;
	buildLimitMicros: number;
	capMicros: number;
	/** Spend across the campaign BEFORE this build was allowed to start. */
	spentBeforeMicros: number;
	capAllowed: boolean;
	capReason: string;
	/** This build's own spend, read from D1 after the run (micros). null if the build never started. */
	buildSpentMicros: number | null;
	complete: boolean;
	completeReason: string;
	/** The build's stop reason (phase/detail) from D1. */
	stopReason: string | null;
}

export interface Ledger {
	campaign: string;
	cap_micros: number;
	runs: LedgerRunRecord[];
}

/** A tiny read/write seam so the ledger is tested with no disk. */
export interface LedgerStore {
	read(): Ledger | null;
	write(ledger: Ledger): void;
}

export function emptyLedger(capMicros: number, campaign = 'team-mode-monday'): Ledger {
	return { campaign, cap_micros: capMicros, runs: [] };
}

/** A file-backed store at `path`. Creates the parent dir on first write. */
export function fileLedgerStore(path: string): LedgerStore {
	return {
		read() {
			if (!existsSync(path)) return null;
			try {
				return JSON.parse(readFileSync(path, 'utf8')) as Ledger;
			} catch {
				return null;
			}
		},
		write(ledger) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
		},
	};
}

/** An in-memory store for tests. */
export function memoryLedgerStore(initial?: Ledger): LedgerStore {
	let state: Ledger | null = initial ?? null;
	return {
		read: () => (state ? structuredClone(state) : null),
		write: (ledger) => {
			state = structuredClone(ledger);
		},
	};
}

/** Total campaign spend recorded in the ledger so far (sum of build spend). */
export function ledgerSpentMicros(ledger: Ledger): number {
	return ledger.runs.reduce((sum, r) => sum + (r.buildSpentMicros ?? 0), 0);
}

/**
 * Append one run record, creating the ledger file if it did not exist. Returns
 * the written ledger. The cap on the ledger is pinned on first write; a later
 * run that passes a different cap is an error, so a campaign cannot silently
 * change its own cap mid-run.
 */
export function appendRun(store: LedgerStore, capMicros: number, record: LedgerRunRecord): Ledger {
	const existing = store.read() ?? emptyLedger(capMicros);
	if (existing.cap_micros !== capMicros) {
		throw new Error(
			`ledger cap mismatch: file has ${existing.cap_micros} micros, this run passed ${capMicros}. ` +
				'A campaign keeps one cap; clear tests/briefs/runs/ to start a new campaign.',
		);
	}
	existing.runs.push(record);
	store.write(existing);
	return existing;
}
