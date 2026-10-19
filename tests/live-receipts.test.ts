import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type ReceiptContext,
	classifyReceipt,
	isDocumentationOnly,
	liveGateStatus,
	readLiveReceipts,
	recordLiveReceipt,
	specDigest,
} from '../scripts/live-receipts.ts';

/**
 * Review 2026-10-19 F05: a live receipt is evidence about one revision of the
 * code and specs, against one target. It used to hold only packet, files,
 * pass count and time, and release-check passed any receipt, so an old run
 * kept a gate PASS after the code, the specs or the target changed. All local:
 * temporary receipt files and an injected git view, never the real
 * docs/live-receipts.json.
 */

const ROOT = join(import.meta.dir, '..');
const SPECS = ['tests/live/release.spec.ts'];
const HEAD = 'a'.repeat(40);

function tempReceipts(): string {
	return join(mkdtempSync(join(tmpdir(), 'caddie-receipts-')), 'live-receipts.json');
}

function context(overrides: Partial<ReceiptContext> = {}): ReceiptContext {
	return {
		mappedFiles: SPECS,
		specDigest: specDigest(ROOT, SPECS),
		head: HEAD,
		changedSince: (commit) => (commit === HEAD ? [] : null),
		expectedTarget: 'local',
		...overrides,
	};
}

function record(path: string, overrides: { dirty?: boolean; commit?: string; target?: string; passed?: number } = {}) {
	return recordLiveReceipt(
		{ packet: 'P17', files: SPECS, passed: overrides.passed ?? 5, target: overrides.target ?? 'local' },
		{ path, root: ROOT, git: () => ({ commit: overrides.commit ?? HEAD, dirty: overrides.dirty ?? false }) },
	);
}

describe('F05 live receipts name the code, specs and target they tested', () => {
	test('a fresh receipt records its commit, a clean tree, the spec digest, the target and an id', () => {
		const path = tempReceipts();
		const receipt = record(path);
		expect(receipt).toMatchObject({ packet: 'P17', files: SPECS, passed: 5, commit: HEAD, dirty: false, target: 'local' });
		expect(receipt.specDigest).toBe(specDigest(ROOT, SPECS));
		expect(receipt.id).toMatch(/^lr_[0-9a-f]{16}$/);
		expect(receipt.runtime).toBe(`bun ${Bun.version}`);
		expect(readLiveReceipts(path).get('P17')).toEqual(receipt);
		expect(classifyReceipt(receipt, context())).toEqual({ status: 'current' });
	});

	test('a run with no passing tests is never recorded', () => {
		expect(() => record(tempReceipts(), { passed: 0 })).toThrow(/at least one/);
	});

	test('changed code, a changed spec set or spec text, another target or a dirty run make it stale', () => {
		const receipt = record(tempReceipts());
		const stale = (ctx: ReceiptContext) => classifyReceipt(receipt, ctx);

		expect(stale(context({ head: 'b'.repeat(40), changedSince: () => ['apps/app/src/app.ts', 'README.md'] }))).toEqual({
			status: 'stale',
			reason: `the code changed since ${HEAD.slice(0, 12)} (apps/app/src/app.ts)`,
		});
		expect(stale(context({ mappedFiles: [...SPECS, 'tests/live/preview.spec.ts'] })).status).toBe('stale');
		expect(stale(context({ specDigest: 'f'.repeat(64) }))).toEqual({ status: 'stale', reason: 'the live specs changed since the run' });
		expect(stale(context({ expectedTarget: 'https://caddie.example.com' }))).toEqual({
			status: 'stale',
			reason: 'it was recorded against local, not https://caddie.example.com',
		});
		expect(stale(context({ head: 'c'.repeat(40), changedSince: () => null }))).toEqual({
			status: 'stale',
			reason: `its commit ${HEAD.slice(0, 12)} is not in this history`,
		});
		const dirty = record(tempReceipts(), { dirty: true });
		expect(classifyReceipt(dirty, context())).toEqual({ status: 'stale', reason: 'it ran with uncommitted changes, so it matches no commit' });
	});

	test('documentation-only commits since the run keep it current (the explicit policy)', () => {
		const receipt = record(tempReceipts());
		const docsOnly = context({ head: 'd'.repeat(40), changedSince: () => ['docs/release-evidence.md', 'README.md', 'docs/live-receipts.json'] });
		expect(classifyReceipt(receipt, docsOnly)).toEqual({ status: 'current' });
		expect(isDocumentationOnly('docs/runbooks/production-deploy.md')).toBe(true);
		expect(isDocumentationOnly('README.md')).toBe(true);
		// Markdown under apps/ is code: the agents import their skills from SKILL.md files.
		expect(isDocumentationOnly('apps/app/src/agents/skills/planning/SKILL.md')).toBe(false);
		expect(isDocumentationOnly('tests/live/release.spec.ts')).toBe(false);
		expect(isDocumentationOnly('scripts/release-check.ts')).toBe(false);
	});

	test('a gate passes only with credentials AND a current receipt; a stale one is named, never PASS', () => {
		const receipt = record(tempReceipts());
		const gate = { env: 'NEBIUS_API_KEY', packet: 'P17', receipt, mappedLive: 1 };
		const current = { status: 'current' } as const;
		const old = { status: 'stale', reason: 'the live specs changed since the run' } as const;
		expect(liveGateStatus({ ...gate, configured: true, verdict: current }).status).toBe('PASS');
		expect(liveGateStatus({ ...gate, configured: false, verdict: current }).status).toBe('BLOCKED');
		const stale = liveGateStatus({ ...gate, configured: true, verdict: old });
		expect(stale.status).toBe('PROVISIONED');
		expect(stale.detail).toContain('stale receipt (the live specs changed since the run)');
		expect(liveGateStatus({ ...gate, configured: false, verdict: old }).status).toBe('BLOCKED');
		expect(liveGateStatus({ ...gate, receipt: undefined, configured: true, verdict: null }).status).toBe('PROVISIONED');
	});

	test('an old-format or malformed receipt is kept as history but never current', () => {
		const path = tempReceipts();
		writeFileSync(
			path,
			JSON.stringify([
				{ packet: 'P05', files: ['tests/live/flue-lifecycle.spec.ts'], passed: 3, at: '2026-10-06T10:00:00.000Z' },
				{ packet: 'P04', files: ['tests/live/sandbox.spec.ts'], passed: 0, at: '2026-10-06T10:00:00.000Z', commit: HEAD, dirty: false, specDigest: 'x', target: 'local' },
			]),
		);
		const receipts = readLiveReceipts(path);
		expect([...receipts.keys()].sort()).toEqual(['P04', 'P05']);
		expect(classifyReceipt(receipts.get('P05')!, context({ mappedFiles: ['tests/live/flue-lifecycle.spec.ts'] }))).toEqual({
			status: 'stale',
			reason: 'it was recorded before receipts named their commit, specs and target',
		});
		expect(classifyReceipt(receipts.get('P04')!, context({ mappedFiles: ['tests/live/sandbox.spec.ts'] }))).toEqual({
			status: 'stale',
			reason: 'it records no passing test',
		});
		expect(readFileSync(path, 'utf8')).toContain('"P05"');
	});
});
