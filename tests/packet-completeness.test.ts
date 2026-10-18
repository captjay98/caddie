import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
	PACKET_KEYS,
	PACKET_MAP,
	type PacketCategory,
} from '../scripts/packet-list.ts';

/**
 * NET (S01) — the packet-completeness net.
 *
 * `scripts/packet-list.ts` is the single source of truth for which test file
 * belongs to which packet. CI used to run a hand-written list of packet ids, so
 * a test file that was never assigned to a packet never ran: 76 unit/integration
 * files and 6 browser/live specs sat in no packet at all. This file is the net
 * that catches that. It walks the filesystem and asserts (1) every candidate
 * test file is mapped into at least one packet+category, (2) every mapped path
 * exists on disk, (3) each mapping uses the runner category that the file's
 * directory and extension imply, (4) no path is duplicated inside a single
 * packet+category, (5) `PACKET_KEYS` mirrors `PACKET_MAP`, and (6) this net is
 * itself mapped in NET.
 *
 * Deliberate exclusion: `tests/fixtures/**` (for example
 * tests/fixtures/forge-task-tracker/src/routes.test.ts) holds fixture assets for
 * GENERATED apps, not Caddie tests. `bun test tests/` happens to load some of
 * them, but they are not candidates for packet membership.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const TESTS_DIR = join(REPO_ROOT, 'tests');
const FIXTURES_DIR = join(TESTS_DIR, 'fixtures');
const SELF_PATH = 'tests/packet-completeness.test.ts';

const CATEGORIES = ['tests', 'browser', 'live'] as const satisfies readonly PacketCategory[];

/** Recursively collect files under `dir` whose basename matches `predicate`. */
function walk(dir: string, predicate: (name: string) => boolean): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			// tests/fixtures/** is fixture data for generated apps, not Caddie
			// tests — never a candidate for packet membership.
			if (full === FIXTURES_DIR) continue;
			found.push(...walk(full, predicate));
		} else if (entry.isFile() && predicate(entry.name)) {
			found.push(full);
		}
	}
	return found;
}

/** A repo-root-relative POSIX path, matching how PACKET_MAP spells paths. */
function repoPath(absolute: string): string {
	return relative(REPO_ROOT, absolute).split(sep).join('/');
}

/**
 * Candidates are read from the filesystem, never a literal list: every
 * `tests/*.test.ts` (top level only) plus every `*.spec.ts` anywhere under
 * `tests/` (including the nested `tests/live/stacks/` specs).
 */
const CANDIDATES: readonly string[] = [
	...readdirSync(TESTS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
		.map((entry) => repoPath(join(TESTS_DIR, entry.name))),
	...walk(TESTS_DIR, (name) => name.endsWith('.spec.ts')).map(repoPath),
].sort();

interface MappedEntry {
	packetId: string;
	category: PacketCategory;
	path: string;
}

const MAPPED: MappedEntry[] = [];
for (const packetId of PACKET_KEYS) {
	const categories = PACKET_MAP[packetId];
	if (!categories) continue;
	for (const category of CATEGORIES) {
		for (const path of categories[category] ?? []) {
			MAPPED.push({ packetId, category, path });
		}
	}
}

const MAPPED_PATHS = new Set(MAPPED.map((entry) => entry.path));

/** The category a file's directory implies (tests/browser/ → browser, etc). */
function locationCategory(path: string): PacketCategory {
	if (path.startsWith('tests/browser/')) return 'browser';
	if (path.startsWith('tests/live/')) return 'live';
	return 'tests';
}

describe('NET: packet table completeness', () => {
	test('every candidate test file is mapped into at least one packet (rule 1)', () => {
		const unmapped = CANDIDATES.filter((path) => !MAPPED_PATHS.has(path));
		expect(
			unmapped,
			`unmapped test files — add each to a packet in scripts/packet-list.ts:\n${unmapped.join('\n')}`,
		).toEqual([]);
	});

	test('every path mapped in PACKET_MAP exists on disk (rule 2)', () => {
		const missing = MAPPED.map((entry) => entry.path).filter(
			(path) => !existsSync(join(REPO_ROOT, path)),
		);
		expect(
			missing,
			`PACKET_MAP names files that do not exist — fix or remove these mappings:\n${missing.join('\n')}`,
		).toEqual([]);
	});

	test('each mapping uses the category its directory and extension imply (rule 3)', () => {
		const wrong: string[] = [];
		for (const { category, path, packetId } of MAPPED) {
			const implied = locationCategory(path);
			if (implied !== category) {
				wrong.push(
					`${packetId}/${category}: ${path} — a file under ${implied === 'tests' ? 'tests/' : `${implied}/`} must be mapped as ${implied}, not ${category}`,
				);
			}
			// A .spec.ts in the `tests` category would be run by `bun test`
			// instead of Playwright/bun-spec, and a .test.ts in browser/live
			// would be run by the wrong runner.
			if (path.endsWith('.spec.ts') && category === 'tests') {
				wrong.push(`${packetId}/tests: ${path} — .spec.ts must not be a bun-test entry`);
			}
			if (path.endsWith('.test.ts') && category !== 'tests') {
				wrong.push(`${packetId}/${category}: ${path} — .test.ts must not be a ${category} entry`);
			}
		}
		expect(
			wrong,
			`category/location mismatches — the file would run under the wrong runner:\n${wrong.join('\n')}`,
		).toEqual([]);
	});

	test('no path is duplicated inside one packet+category (rule 4)', () => {
		// Deliberately NOT "exactly one packet": the SAME file legitimately
		// appears in TWO DIFFERENT packets (a few specs are the evidence for two
		// packets — e.g. tests/browser/workspace.spec.ts covers P06 and U01).
		// Deduplicating those mappings would silently drop coverage.
		const duplicated: string[] = [];
		for (const packetId of PACKET_KEYS) {
			const categories = PACKET_MAP[packetId];
			if (!categories) continue;
			for (const category of CATEGORIES) {
				const seen = new Set<string>();
				for (const path of categories[category] ?? []) {
					if (seen.has(path)) duplicated.push(`${packetId}/${category}: ${path}`);
					seen.add(path);
				}
			}
		}
		expect(
			duplicated,
			`the same file is listed twice in one packet+category (copy-paste bug):\n${duplicated.join('\n')}`,
		).toEqual([]);
	});

	test('PACKET_KEYS is exactly Object.keys(PACKET_MAP) with no duplicates (rule 5)', () => {
		expect([...PACKET_KEYS], 'PACKET_KEYS must mirror PACKET_MAP exactly').toEqual(
			Object.keys(PACKET_MAP),
		);
		const duplicates = PACKET_KEYS.filter((key, index) => PACKET_KEYS.indexOf(key) !== index);
		expect(duplicates, 'duplicate packet ids in PACKET_KEYS:').toEqual([]);
	});

	test('this net is itself mapped in NET (rule 6)', () => {
		expect(
			PACKET_MAP.NET?.tests ?? [],
			`${SELF_PATH} must be listed in PACKET_MAP.NET.tests so the net cannot be quietly unmapped`,
		).toContain(SELF_PATH);
	});
});
