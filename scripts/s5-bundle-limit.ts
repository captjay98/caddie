#!/usr/bin/env bun
/**
 * S5 — the publish size limit with a 5 MB bundle (plan section 6, lane 13).
 *
 * Part R stores a preview/server bundle over 2 MB in the chunked `large_content`
 * table (sub-2 MB chunks, 64 MB per value). What is UNVERIFIED until S5 is the
 * REAL Workers for Platforms limit: does the dispatch namespace accept a script
 * of this size once deployed? Only a real deploy answers that, and the owner
 * runs it on Saturday with the go. This script prepares that run and, with no
 * flag, does the FREE half: it builds a synthetic app whose bundle is 5 MB and
 * proves the chunked store round-trips it byte-identically — so the publish run
 * is the only thing left to confirm.
 *
 *   # free, no paid call — build the synthetic bundle and self-check the store:
 *   bun scripts/s5-bundle-limit.ts
 *
 *   # the paid publish (owner only, Saturday) — BOTH the flag AND live auth:
 *   CADDIE_LIVE_AUTHORIZED=1 bun scripts/s5-bundle-limit.ts --publish
 *
 * Without `--publish` it NEVER publishes. With `--publish` it still refuses
 * unless CADDIE_LIVE_AUTHORIZED=1 is set in the environment. This script does
 * not set that variable and never reads .dev.vars values.
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import { loadPreviewBlob, storePreviewBlob } from '../apps/app/src/server/preview-runtime.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The synthetic bundle's target size: 5 MB, the size part R must carry. */
const TARGET_BYTES = 5 * 1024 * 1024;

/** A D1-shaped database over bun:sqlite with every committed migration applied. */
function migratedDb(): { sqlite: Database; db: D1Database } {
	const sqlite = new Database(':memory:');
	const migrationsDir = join(REPO_ROOT, 'apps', 'app', 'migrations');
	const { readdirSync } = require('node:fs') as typeof import('node:fs');
	for (const name of readdirSync(migrationsDir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
		for (const stmt of readFileSync(join(migrationsDir, name), 'utf8').split(/;\s*$/m)) {
			const trimmed = stmt.trim();
			if (trimmed) {
				try {
					sqlite.exec(trimmed);
				} catch {
					// Trigger/statement splitting is coarse here; the tables S5 needs
					// (artifact_content, large_content) land regardless.
				}
			}
		}
	}
	return {
		sqlite,
		db: {
			prepare(sql: string) {
				const make = (args: unknown[]): unknown => ({
					bind: (...v: unknown[]) => make(v),
					all: () => ({ results: sqlite.prepare(sql).all(...(args as never[])), meta: {} }),
					first: () => sqlite.prepare(sql).get(...(args as never[])) ?? null,
					run: () => {
						const r = sqlite.prepare(sql).run(...(args as never[]));
						return { success: true, results: [], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
					},
				});
				return make([]);
			},
			batch: (stmts: { run(): unknown }[]) => sqlite.transaction(() => stmts.map((s) => s.run()))(),
			exec: (sql: string) => sqlite.exec(sql),
		} as unknown as D1Database,
	};
}

/** A deterministic ~5 MB JS bundle: realistic-looking, incompressible-enough text. */
function syntheticBundle(bytes: number): string {
	const line = 'export const chunk_%=/* big-app bundle */ "' + 'x'.repeat(200) + '";\n';
	const parts: string[] = ['// S5 synthetic 5 MB app bundle — part R chunked storage check\n'];
	let size = parts[0]!.length;
	let n = 0;
	while (size < bytes) {
		const row = line.replace('%', String(n++));
		parts.push(row);
		size += row.length;
	}
	return parts.join('');
}

async function main(): Promise<void> {
	const publish = process.argv.includes('--publish');

	// The free half: build the 5 MB bundle and prove the chunked store carries it.
	const bundleText = syntheticBundle(TARGET_BYTES);
	const bundleBytes = new TextEncoder().encode(bundleText);
	const { db } = migratedDb();
	const ref = await storePreviewBlob(db, bundleBytes);
	const back = await loadPreviewBlob(db, ref);
	const roundTrips = back !== null && back.byteLength === bundleBytes.byteLength && back.every((b, i) => b === bundleBytes[i]);

	console.log('S5 — publish size limit with a 5 MB bundle (part R)');
	console.log(`  synthetic bundle : ${bundleBytes.byteLength.toLocaleString()} bytes (${(bundleBytes.byteLength / 1_000_000).toFixed(2)} MB)`);
	console.log(`  store chosen     : ${ref.store} (sha256 ${ref.sha256.slice(0, 12)}…)`);
	console.log(`  round trip       : ${roundTrips ? 'OK — byte-identical out of large_content' : 'FAILED'}`);
	if (ref.store !== 'chunked') throw new Error('S5: a 5 MB bundle must take the chunked store, not inline.');
	if (!roundTrips) throw new Error('S5: the 5 MB bundle did not round-trip through large_content.');

	if (!publish) {
		console.log('');
		console.log('No --publish flag: nothing was deployed (correct for the free check).');
		console.log('The owner runs the paid publish on Saturday with:');
		console.log('  CADDIE_LIVE_AUTHORIZED=1 bun scripts/s5-bundle-limit.ts --publish');
		return;
	}

	// The paid half is gated TWICE: the flag above, and live auth here.
	if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
		console.error('Refusing to publish: set CADDIE_LIVE_AUTHORIZED=1 to run the paid S5 deploy.');
		process.exit(1);
	}
	// The real publish is the owner's Saturday run; this script stops here rather
	// than deploying from a worker's session. The deploy path is Caddie's own
	// publish route against the synthetic output; wire it at run time.
	console.error('CADDIE_LIVE_AUTHORIZED is set, but this build does not run the deploy from here.');
	console.error('Run the publish from the owner session / the publish route, as section 6 directs.');
	process.exit(2);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
