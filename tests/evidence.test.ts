import { beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Scope } from '@caddie/contracts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import {
	AUTHORITY_VALUES,
	authorityLabel,
	authorityRank,
	isSourceAuthority,
} from '../apps/app/src/server/evidence/authority.ts';
import {
	canonicalizeUrl,
	captureSnapshot,
	getSnapshot,
	getSource,
	listSnapshots,
	registerSource,
	UnsupportedSourceUrlError,
} from '../apps/app/src/server/evidence/sources.ts';
import {
	addClaim,
	getClaim,
	listClaims,
} from '../apps/app/src/server/evidence/claims.ts';

/**
 * P10 — Source evidence and rule normalization (unit).
 *
 * Fixtures are PORTED from the HackSteward reference domain tests (read-only
 * reference, per the workspace rules):
 *   - tests/test_domain_sources.py            → URL canonicalization, authority
 *   - tests/test_domain_discovery.py          → supersession / conflict / instant keys
 *   - tests/test_domain_deadlines.py          → timezone normalization edges
 *
 * Honesty classification for this file: pure functions and the service layer
 * over in-memory SQLite (the same DDL the workerd integration applies) are
 * LOCAL VERIFIED at the unit level; the real workerd + D1 proofs live in
 * tests/evidence.integration.test.ts.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const MIGRATION_PATHS = [
	join(REPO_ROOT, 'apps', 'app', 'migrations', '0001_product.sql'),
	join(REPO_ROOT, 'apps', 'app', 'migrations', '0004_evidence.sql'),
];

// --- in-memory D1 (same wrap pattern as tests/project-isolation.integration.test.ts) --

function wrapSqliteAsD1(sqlite: Database): D1Database {
	return {
		prepare: (query: string) => {
			const stmt = sqlite.prepare(query);
			return {
				bind: (...values: unknown[]) => ({
					run: async () => stmt.run(...(values as never[])),
					all: async () => ({
						results: stmt.all(...(values as never[])) as unknown[],
						meta: {},
					}),
				}),
				run: async () => stmt.run(),
				all: async () => ({ results: stmt.all() as unknown[], meta: {} }),
			};
		},
		batch: async (statements: unknown[]) => {
			const out: unknown[] = [];
			for (const statement of statements as { run(): unknown }[]) {
				out.push(await statement.run());
			}
			return out;
		},
		exec: async (query: string) => sqlite.exec(query),
	} as unknown as D1Database;
}

interface UnitWorld {
	db: D1Database;
	sqlite: Database;
	aliceScope: Scope;
	bobScope: Scope;
}

/**
 * A fresh in-memory database with 0001+0004 applied and two independent
 * membership-backed projects (alice's and bob's) for scope assertions.
 */
function makeEvidenceWorld(): UnitWorld {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON;');
	for (const path of MIGRATION_PATHS) sqlite.exec(readFileSync(path, 'utf8'));
	const iso = '2026-10-04T00:00:00.000Z';
	sqlite.exec(
		`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 values ('unit-alice','Unit Alice','unit-alice@example.com',0,'${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 values ('unit-bob','Unit Bob','unit-bob@example.com',0,'${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspaces" ("id","name","createdAt") values ('unit-ws-a','Alice WS','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
		 values ('unit-mem-a','unit-ws-a','unit-alice','owner','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspaces" ("id","name","createdAt") values ('unit-ws-b','Bob WS','${iso}')`,
	);
	sqlite.exec(
		`insert into "workspace_memberships" ("id","workspaceId","userId","role","createdAt")
		 values ('unit-mem-b','unit-ws-b','unit-bob','owner','${iso}')`,
	);
	sqlite.exec(
		`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
		 values ('unit-proj-a','unit-ws-a','Alice Project','active','${iso}','${iso}')`,
	);
	sqlite.exec(
		`insert into "projects" ("id","workspaceId","name","status","createdAt","updatedAt")
		 values ('unit-proj-b','unit-ws-b','Bob Project','active','${iso}','${iso}')`,
	);
	return {
		sqlite,
		db: wrapSqliteAsD1(sqlite),
		aliceScope: { actorId: 'unit-alice', workspaceId: 'unit-ws-a', projectId: 'unit-proj-a' },
		bobScope: { actorId: 'unit-bob', workspaceId: 'unit-ws-b', projectId: 'unit-proj-b' },
	};
}

async function catchScopeError(run: () => Promise<unknown>): Promise<{ status: number; code: string }> {
	try {
		await run();
	} catch (error) {
		return {
			status: (error as { status?: number }).status ?? 0,
			code: (error as { code?: string }).code ?? '',
		};
	}
	throw new Error('expected the call to throw a ScopeError');
}

const RULES_PAGE = `# Rules

Teams of up to four people. Entries close September 9, 2026 at 5:00 PM PT.
One project per team. `;

// --- slice 1: source identity (canonicalization) ------------------------------------
// Ported from tests/test_domain_sources.py.

describe('P10 slice 1: source identity — equivalent URLs reduce to one source', () => {
	test(
		'scheme/host case, default port, fragment, trailing slash, tracking params, whitespace',
		() => {
			const variants: [string, string][] = [
				['https://Example.COM/rules', 'https://example.com/rules'],
				['HTTPS://example.com/rules', 'https://example.com/rules'],
				['https://example.com/rules/', 'https://example.com/rules'],
				['https://example.com/rules#section-4', 'https://example.com/rules'],
				['https://example.com:443/rules', 'https://example.com/rules'],
				['http://example.com:80/rules', 'http://example.com/rules'],
				['https://example.com/rules?utm_source=twitter', 'https://example.com/rules'],
				['https://example.com/rules?gclid=abc&fbclid=def', 'https://example.com/rules'],
				['  https://example.com/rules  ', 'https://example.com/rules'],
			];
			for (const [variant, expected] of variants) {
				expect(canonicalizeUrl(variant)).toBe(expected);
			}
		},
	);

	test('query parameter order does not create a second source', () => {
		expect(canonicalizeUrl('https://example.com/rules?b=2&a=1')).toBe(
			canonicalizeUrl('https://example.com/rules?a=1&b=2'),
		);
	});

	test('marketing link params (GA linker family, Devpost ref_*) do not create a second source', () => {
		const tracked =
			'https://allthingsagentichackathon.devpost.com/' +
			'?_gl=1*133p64b*_gcl_au*OTMxMJU2NzEz*&_ga=MTYxNjgz' +
			'&_ga_0YHJK3Y10M=czE3ODgxOTc3OA' +
			'&ref_content=Submissions+open&ref_feature=challenge&ref_medium=your-open-hackathons';
		const clean = 'https://allthingsagentichackathon.devpost.com/';
		expect(canonicalizeUrl(tracked)).toBe(canonicalizeUrl(clean));
	});

	test('GA container params are matched by prefix and case cannot smuggle them past the match', () => {
		expect(canonicalizeUrl('https://example.com/rules?_ga_ABC123=js')).toBe(
			'https://example.com/rules',
		);
		expect(canonicalizeUrl('https://example.com/rules?_GL=1*x')).toBe('https://example.com/rules');
	});

	test('meaningful query parameters are preserved (dropping them would merge distinct documents)', () => {
		expect(canonicalizeUrl('https://example.com/rules?track=main')).toBe(
			'https://example.com/rules?track=main',
		);
	});

	test('path case is preserved (path segments are case-sensitive on most servers)', () => {
		expect(canonicalizeUrl('https://example.com/Rules/Section4')).toBe(
			'https://example.com/Rules/Section4',
		);
	});

	test('an empty path becomes root', () => {
		expect(canonicalizeUrl('https://example.com')).toBe('https://example.com/');
	});

	test('non-web URLs can never become sources', () => {
		for (const hostile of [
			'',
			'   ',
			'file:///etc/passwd',
			'javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'mailto:someone@example.com',
			'ftp://example.com/rules',
			'https://',
		]) {
			expect(() => canonicalizeUrl(hostile)).toThrow(UnsupportedSourceUrlError);
		}
	});

	test('embedded credentials are refused (they would be persisted in plain text)', () => {
		expect(() => canonicalizeUrl('https://user:secret@example.com/rules')).toThrow(
			/credentials/,
		);
	});
});

// --- slice 1: the ONE authority vocabulary (storage mirror) -----------------------------

describe('P10 slice 1: one shared authority vocabulary (audit defect #6)', () => {
	test('the vocabulary is ordered strongest-first and unknown stays UNKNOWN (never unverified)', () => {
		expect([...AUTHORITY_VALUES]).toEqual([
			'binding_rules',
			'organizer_message',
			'official_faq',
			'official_overview',
			'sponsor_page',
			'community',
			'unknown',
		]);
		// HackSteward levels preserved: three rule-level sources, overview,
		// promotional, community — with the correction that `unknown` has NO rank
		// (it can never be weighed as "low-confidence verified").
		expect(authorityRank('binding_rules')).toBe(1);
		expect(authorityRank('organizer_message')).toBe(1);
		expect(authorityRank('official_faq')).toBe(1);
		expect(authorityRank('official_overview')).toBe(2);
		expect(authorityRank('sponsor_page')).toBe(3);
		expect(authorityRank('community')).toBe(4);
		expect(authorityRank('unknown')).toBeNull();
	});

	test('every vocabulary entry has a UI label and the guard accepts exactly the vocabulary', () => {
		for (const value of AUTHORITY_VALUES) {
			expect(authorityLabel(value).length).toBeGreaterThan(0);
			expect(isSourceAuthority(value)).toBe(true);
		}
		expect(isSourceAuthority('definitely_made_up')).toBe(false);
		expect(isSourceAuthority(null)).toBe(false);
	});

	test('the 0004 DDL authority check constraint lists EXACTLY the shared vocabulary', () => {
		// ONE vocabulary means storage cannot drift from logic or UI: the check
		// constraint in the migration must enumerate the same values, in the
		// same canonical order, as authority.ts.
		const ddl = readFileSync(
			join(REPO_ROOT, 'apps', 'app', 'migrations', '0004_evidence.sql'),
			'utf8',
		);
		const match = /"authority" text not null check \("authority" in \(([^)]+)\)\)/.exec(ddl);
		expect(match).not.toBeNull();
		const ddlValues = match![1]!
			.split(',')
			.map((raw) => raw.trim().replaceAll("'", ''));
		expect(ddlValues).toEqual([...AUTHORITY_VALUES]);
	});
});

// --- slice 1: snapshots (dedupe by hash, history, placeholders) --------------------------

describe('P10 slice 1: immutable snapshots on real D1 DDL (in-memory sqlite)', () => {
	let world: UnitWorld;
	let sourceId = '';

	beforeAll(async () => {
		world = makeEvidenceWorld();
		const source = await registerSource(world.db, world.aliceScope, {
			url: 'https://example.com/rules',
			kind: 'page',
			authority: 'binding_rules',
		});
		sourceId = source.id;
	});

	test('source registration dedupes per project by canonical URL', async () => {
		const again = await registerSource(world.db, world.aliceScope, {
			url: 'https://example.com/rules/?utm_source=x#top',
			kind: 'page',
			authority: 'community', // authority of the FIRST registration wins on dedupe
		});
		expect(again.id).toBe(sourceId);
		expect(again.authority).toBe('binding_rules');
	});

	test('the same canonical URL in a DIFFERENT project is a distinct source (project-scoped registry)', async () => {
		const bobSource = await registerSource(world.db, world.bobScope, {
			url: 'https://example.com/rules',
			kind: 'page',
			authority: 'unknown',
		});
		expect(bobSource.id).not.toBe(sourceId);
	});

	test('authority is validated against the shared vocabulary at registration', async () => {
		const failure = await catchScopeError(() =>
			registerSource(world.db, world.aliceScope, {
				url: 'https://example.com/other',
				kind: 'page',
				authority: 'very_trusted',
			}),
		);
		expect(failure).toMatchObject({ status: 400, code: 'invalid_input' });
	});

	test('capture stores content + sha256 + fetchedAt under a deterministic id', async () => {
		const { snapshot, outcome } = await captureSnapshot(world.db, world.aliceScope, sourceId, {
			content: RULES_PAGE,
			mediaType: 'text/html',
		});
		expect(outcome).toBe('created');
		expect(snapshot.id).toMatch(/^snap_/);
		expect(snapshot.contentHash).toMatch(/^[0-9a-f]{64}$/);
		expect(snapshot.content).toBe(RULES_PAGE);
		expect(snapshot.capturedAt).toBeTruthy();
		expect(snapshot.projectId).toBe('unit-proj-a');
		expect(snapshot.provenance).toBe('original');
	});

	test('repeated capture of unchanged content returns the SAME snapshot (dedupe by hash per source)', async () => {
		const first = await captureSnapshot(world.db, world.aliceScope, sourceId, {
			content: RULES_PAGE,
			mediaType: 'text/html',
		});
		await Bun.sleep(5); // ensure a later fetch timestamp exists
		const second = await captureSnapshot(world.db, world.aliceScope, sourceId, {
			content: RULES_PAGE,
			mediaType: 'text/html',
		});
		expect(second.snapshot.id).toBe(first.snapshot.id);
		expect(second.outcome).toBe('unchanged');
		// capturedAt stays the ORIGINAL observation — re-reading did not re-observe
		expect(second.snapshot.capturedAt).toBe(first.snapshot.capturedAt);
		expect(await listSnapshots(world.db, world.aliceScope, sourceId)).toHaveLength(1);
	});

	test('changed content creates a NEW snapshot and history is retained', async () => {
		const { snapshot: changed, outcome } = await captureSnapshot(
			world.db,
			world.aliceScope,
			sourceId,
			{ content: `${RULES_PAGE}\nUpdate: entries close October 1, 2026.`, mediaType: 'text/html' },
		);
		expect(outcome).toBe('created');
		const history = await listSnapshots(world.db, world.aliceScope, sourceId);
		expect(history).toHaveLength(2);
		expect(history.map((s) => s.id)).toContain(changed.id);
		// newest first
		expect(history[0]!.id).toBe(changed.id);
	});

	test('placeholder snapshots are rejected — a snapshot must carry real content (audit defect #1)', async () => {
		for (const placeholder of ['', '   ', '\n\t ']) {
			const failure = await catchScopeError(() =>
				captureSnapshot(world.db, world.aliceScope, sourceId, {
					content: placeholder,
					mediaType: 'text/html',
				}),
			);
			expect(failure).toMatchObject({ status: 400, code: 'snapshot_content_required' });
		}
	});

	test('processed provenance is distinguished from original and renderer rules hold', async () => {
		const failureNoRenderer = await catchScopeError(() =>
			captureSnapshot(world.db, world.aliceScope, sourceId, {
				content: 'Rendered view of the rules.',
				mediaType: 'text/markdown',
				provenance: 'processed',
			}),
		);
		expect(failureNoRenderer).toMatchObject({ status: 400, code: 'invalid_input' });

		const { snapshot } = await captureSnapshot(world.db, world.aliceScope, sourceId, {
			content: 'Rendered view of the rules.',
			mediaType: 'text/markdown',
			provenance: 'processed',
			renderer: 'parallel_extract',
			rendererRef: 'extract_req_1',
		});
		expect(snapshot.provenance).toBe('processed');
		expect(snapshot.renderer).toBe('parallel_extract');

		const failureRefWithoutRenderer = await catchScopeError(() =>
			captureSnapshot(world.db, world.aliceScope, sourceId, {
				content: 'Another rendered view.',
				mediaType: 'text/markdown',
				provenance: 'processed',
				rendererRef: 'extract_req_2',
			}),
		);
		expect(failureRefWithoutRenderer).toMatchObject({ status: 400, code: 'invalid_input' });
	});

	test('snapshot access is project-scoped: another project cannot read or list it', async () => {
		const history = await listSnapshots(world.db, world.aliceScope, sourceId);
		expect(history.length).toBeGreaterThan(0);
		const cross = await catchScopeError(() =>
			getSnapshot(world.db, world.bobScope, history[0]!.id),
		);
		expect(cross).toMatchObject({ status: 404 });
		// bob cannot even address alice's source
		const bobSeesSource = await getSource(world.db, world.bobScope, sourceId).catch(() => null);
		expect(bobSeesSource).toBeNull();
	});

	test('snapshot dedupe holds at the DDL level too: (sourceId, contentHash) is unique', () => {
		let threw = false;
		try {
			world.sqlite.exec(
				`insert into "evidence_snapshots" ("id","projectId","sourceId","contentHash","mediaType","byteLength","content","capturedAt","capturedBy")
				 select 'snap_forged', "projectId", "sourceId", "contentHash", 'text/html', 1, 'forged', '2026-10-04T00:00:00.000Z', 'unit-alice'
				 from "evidence_snapshots" limit 1`,
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});

// --- slice 1: claims (deterministic identity, defect #1, supersession) -------------------

describe('P10 slice 1: claims — deterministic identity bound to the exact snapshot', () => {
	let world: UnitWorld;
	let sourceId = '';
	let snapA = '';
	let snapB = '';

	beforeAll(async () => {
		world = makeEvidenceWorld();
		const source = await registerSource(world.db, world.aliceScope, {
			url: 'https://example.com/rules',
			kind: 'page',
			authority: 'binding_rules',
		});
		sourceId = source.id;
		const a = await captureSnapshot(world.db, world.aliceScope, sourceId, {
			content: RULES_PAGE,
			mediaType: 'text/html',
		});
		snapA = a.snapshot.id;
		await Bun.sleep(5);
		const b = await captureSnapshot(world.db, world.aliceScope, sourceId, {
			content: `${RULES_PAGE}\nUpdate: entries close October 1, 2026.`,
			mediaType: 'text/html',
		});
		snapB = b.snapshot.id;
	});

	test('deterministic claim identity: repeated extraction of the same reading lands on ONE row', async () => {
		const input = {
			snapshotId: snapA,
			claimType: 'deadline',
			value: '2026-09-10T00:00:00Z',
			quote: 'Entries close September 9, 2026 at 5:00 PM PT.',
			locator: 'rules#deadlines',
			extractionVersion: 'p10-evidence-v1',
		};
		const first = await addClaim(world.db, world.aliceScope, input);
		expect(first.id).toMatch(/^clm_/);
		const second = await addClaim(world.db, world.aliceScope, input);
		expect(second.id).toBe(first.id);
		expect(second.createdAt).toBe(first.createdAt); // no second row was written
		const all = await listClaims(world.db, world.aliceScope, { claimType: 'deadline' });
		expect(all.filter((c) => c.id === first.id)).toHaveLength(1);
	});

	test('the quote attaches to the EXACT fetched snapshot and must exist in its content (defect #1)', async () => {
		const failure = await catchScopeError(() =>
			addClaim(world.db, world.aliceScope, {
				snapshotId: snapA,
				claimType: 'deadline',
				value: '2026-10-01',
				quote: 'Entries close October 1, 2026.', // only true of the NEWER snapshot
				extractionVersion: 'p10-evidence-v1',
			}),
		);
		expect(failure).toMatchObject({ status: 400, code: 'quote_not_in_snapshot' });

		// a blank quote is never a citation
		const blank = await catchScopeError(() =>
			addClaim(world.db, world.aliceScope, {
				snapshotId: snapA,
				claimType: 'deadline',
				value: '2026-09-10T00:00:00Z',
				quote: '   ',
				extractionVersion: 'p10-evidence-v1',
			}),
		);
		expect(blank).toMatchObject({ status: 400, code: 'invalid_input' });
	});

	test('a claim cannot attach to a snapshot outside the caller project (no cross-project pinning)', async () => {
		const bobWorldSource = await registerSource(world.db, world.bobScope, {
			url: 'https://example.com/bob-rules',
			kind: 'page',
			authority: 'unknown',
		});
		const bobSnap = await captureSnapshot(world.db, world.bobScope, bobWorldSource.id, {
			content: 'Bob private rules content.',
			mediaType: 'text/plain',
		});
		const cross = await catchScopeError(() =>
			addClaim(world.db, world.aliceScope, {
				snapshotId: bobSnap.snapshot.id,
				claimType: 'eligibility',
				value: 'bob only',
				quote: 'Bob private rules content.',
				extractionVersion: 'p10-evidence-v1',
			}),
		);
		expect(cross).toMatchObject({ status: 404 });
	});

	test('same-source newer extraction supersedes; history is retained and points at the successor', async () => {
		const oldClaim = await addClaim(world.db, world.aliceScope, {
			snapshotId: snapA,
			claimType: 'deadline',
			value: '2026-09-10T00:00:00Z',
			quote: 'Entries close September 9, 2026 at 5:00 PM PT.',
			extractionVersion: 'p10-evidence-v1',
		});
		const newClaim = await addClaim(world.db, world.aliceScope, {
			snapshotId: snapB,
			claimType: 'deadline',
			value: '2026-10-01T00:00:00Z',
			quote: 'entries close October 1, 2026.',
			extractionVersion: 'p10-evidence-v1',
		});
		expect(newClaim.status).toBe('active');
		// the old reading is history, not a live contradiction of itself
		const rereadOld = await getClaim(world.db, world.aliceScope, oldClaim.id);
		expect(rereadOld.status).toBe('superseded');
		expect(rereadOld.supersededBy).toBe(newClaim.id);
		// history retained: both rows still exist
		const all = await listClaims(world.db, world.aliceScope, { claimType: 'deadline' });
		expect(all.map((c) => c.id)).toEqual(
			expect.arrayContaining([oldClaim.id, newClaim.id]),
		);
	});

	test('extraction version is recorded on every claim (provenance of the reading)', async () => {
		const claim = await addClaim(world.db, world.aliceScope, {
			snapshotId: snapB,
			claimType: 'team_size',
			value: '4',
			quote: 'Teams of up to four people.',
			extractionVersion: 'p10-evidence-v1',
		});
		expect(claim.extractionVersion).toBe('p10-evidence-v1');
		const blank = await catchScopeError(() =>
			addClaim(world.db, world.aliceScope, {
				snapshotId: snapB,
				claimType: 'eligibility',
				value: 'open',
				quote: 'One project per team.',
				extractionVersion: '  ',
			}),
		);
		expect(blank).toMatchObject({ status: 400, code: 'invalid_input' });
	});

	test('a claim re-attached to an OLDER snapshot of the same source does not become current', async () => {
		await Bun.sleep(5);
		const historic = await addClaim(world.db, world.aliceScope, {
			snapshotId: snapA,
			claimType: 'deadline',
			value: '2026-09-10T00:00:00Z',
			quote: 'Entries close September 9, 2026 at 5:00 PM PT.',
			locator: 'history-recheck',
			extractionVersion: 'p10-evidence-v1',
		});
		// different locator → different deterministic id → a new row, but the
		// source's newer word already exists, so this re-read is born superseded
		expect(historic.status).toBe('superseded');
	});

	test('confidence, when recorded, is a number in [0,1] — never a substitute for authority', async () => {
		const failure = await catchScopeError(() =>
			addClaim(world.db, world.aliceScope, {
				snapshotId: snapB,
				claimType: 'prize',
				value: '$10k',
				quote: 'Teams of up to four people.', // unrelated quote would fail first; use a real one
				extractionVersion: 'p10-evidence-v1',
				confidence: 1.5,
			}),
		);
		expect(failure).toMatchObject({ status: 400, code: 'invalid_input' });
	});
});

