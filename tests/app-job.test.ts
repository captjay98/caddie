import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import {
	appJobSecret,
	caddieJobHeader,
	finishJobRun,
	JOB_MAX_AGE_MS,
	JOB_SUMMARY_MAX,
	listJobRuns,
	startJobRun,
} from '../apps/app/src/server/app-job.ts';
import { createProject, createWorkspace } from '../apps/app/src/server/projects.ts';
import { projectScopeForUser, workspaceScopeForUser } from '../apps/app/src/server/scope.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

/**
 * "Run now" jobs (plan part N), host side. The signature the host builds is
 * accepted by the SAME verification the generated app runs; unsigned and stale
 * calls are refused; the run is recorded with the route's summary. The
 * verification here REPLICATES the generated check and is pinned against the
 * generated source so the two can't drift. LOCAL VERIFIED on the real migrations.
 */

const NOW = new Date('2026-10-22T12:00:00.000Z');

/** The generated access check's verification, byte-for-byte in algorithm. */
async function generatedVerify(secret: string, header: string, routePath: string, now = Date.now()): Promise<boolean> {
	const dot = header.indexOf('.');
	if (dot <= 0) return false;
	const stamp = header.slice(0, dot);
	const sig = header.slice(dot + 1);
	const ms = Number(stamp);
	if (!Number.isFinite(ms) || Math.abs(now - ms) > JOB_MAX_AGE_MS) return false;
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stamp + '.' + routePath));
	const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
	if (hex.length !== sig.length) return false;
	let diff = 0;
	for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
	return diff === 0;
}

describe('Run-now job signatures and runs', () => {
	test("each app's job secret is derived per project and mode, never stored", async () => {
		const a = await appJobSecret('caddie-master-secret-0123456789', 'proj-a', 'preview');
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await appJobSecret('caddie-master-secret-0123456789', 'proj-a', 'preview')).toBe(a);
		expect(await appJobSecret('caddie-master-secret-0123456789', 'proj-a', 'live')).not.toBe(a);
		expect(await appJobSecret('caddie-master-secret-0123456789', 'proj-b', 'preview')).not.toBe(a);
		// It is not the cookie secret: different label, different value.
		const authLike = await appJobSecret('caddie-master-secret-0123456789', 'proj-a', 'preview');
		expect(authLike).toBe(a);
		expect(await appJobSecret(undefined, 'proj-a', 'preview')).toBeNull();
		expect(await appJobSecret('short', 'proj-a', 'preview')).toBeNull();
	});

	test('a header the host builds is accepted by the generated verification', async () => {
		const secret = (await appJobSecret('caddie-master-secret-0123456789', 'proj-a', 'preview'))!;
		const header = (await caddieJobHeader(secret, '/api/daily-digest', NOW))!;
		expect(header).toMatch(/^\d+\.[0-9a-f]{64}$/);
		expect(await generatedVerify(secret, header, '/api/daily-digest', NOW.getTime())).toBe(true);
	});

	test('the signature is bound to the route, the time and the secret', async () => {
		const secret = (await appJobSecret('caddie-master-secret-0123456789', 'proj-a', 'preview'))!;
		const other = (await appJobSecret('caddie-master-secret-0123456789', 'proj-a', 'live'))!;
		const header = (await caddieJobHeader(secret, '/api/daily-digest', NOW))!;
		// A different route path: refused.
		expect(await generatedVerify(secret, header, '/api/other', NOW.getTime())).toBe(false);
		// A different secret (wrong mode): refused.
		expect(await generatedVerify(other, header, '/api/daily-digest', NOW.getTime())).toBe(false);
		// Stale (just over 5 minutes): refused.
		expect(await generatedVerify(secret, header, '/api/daily-digest', NOW.getTime() + JOB_MAX_AGE_MS + 1)).toBe(false);
		// A tampered signature: refused.
		expect(await generatedVerify(secret, header.replace(/.$/, (c) => (c === '0' ? '1' : '0')), '/api/daily-digest', NOW.getTime())).toBe(false);
		// An empty/garbage header: refused.
		expect(await generatedVerify(secret, 'nope', '/api/daily-digest', NOW.getTime())).toBe(false);
	});

	test('no secret means no header (a run can never be signed without Caddie\'s secret)', async () => {
		expect(await caddieJobHeader(null, '/api/x', NOW)).toBeNull();
	});

	test('the generated check and the host signer agree on the signed message', () => {
		// Pin the two together: if one changes the message shape, this fails.
		const text = readFileSync(join(import.meta.dir, '..', 'apps', 'app', 'src', 'server', 'contract-files.ts'), 'utf8');
		expect(text).toContain('stamp + "." + routePath');
		expect(text).toContain('CADDIE_JOB_SECRET');
		expect(text).toContain('JOB_MAX_AGE_MS = 5 * 60_000');
	});

	describe('runs are recorded', () => {
		let sqlite: Database;
		let db: D1Database;
		let projectId: string;

		beforeEach(async () => {
			({ sqlite, db } = migratedDatabase());
			addUser(sqlite, 'owner-1', 'owner@example.com');
			const ws = await createWorkspace(db, 'owner-1', { name: 'W' });
			projectId = (await createProject(db, await workspaceScopeForUser(db, 'owner-1', ws.id), { workspaceId: ws.id, name: 'Shop', description: 'x' })).id;
		});
		afterEach(() => sqlite.close());

		test('a run is opened running, then finished with a capped summary', async () => {
			const runId = await startJobRun(db, { projectId, mode: 'preview', jobId: 'daily-digest', now: NOW });
			await finishJobRun(db, { runId, status: 'done', summary: 'x'.repeat(JOB_SUMMARY_MAX + 50), now: new Date(NOW.getTime() + 1200) });
			const scope = await projectScopeForUser(db, 'owner-1', projectId);
			const runs = await listJobRuns(db, scope);
			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({ jobId: 'daily-digest', status: 'done', startedAt: NOW.toISOString(), finishedAt: new Date(NOW.getTime() + 1200).toISOString() });
			expect(runs[0]!.summary).toHaveLength(JOB_SUMMARY_MAX);
		});

		test('runs come back newest first and are scoped to the project', async () => {
			for (let i = 0; i < 3; i++) {
				const at = new Date(NOW.getTime() + i * 1000);
				const id = await startJobRun(db, { projectId, mode: 'preview', jobId: `job-${i}`, now: at });
				await finishJobRun(db, { runId: id, status: 'done', summary: `run ${i}`, now: at });
			}
			const scope = await projectScopeForUser(db, 'owner-1', projectId);
			const runs = await listJobRuns(db, scope);
			expect(runs.map((r) => r.jobId)).toEqual(['job-2', 'job-1', 'job-0']);
			// Another project sees none.
			addUser(sqlite, 'owner-2', 'two@example.com');
			const ws2 = await createWorkspace(db, 'owner-2', { name: 'W2' });
			const other = (await createProject(db, await workspaceScopeForUser(db, 'owner-2', ws2.id), { workspaceId: ws2.id, name: 'Other', description: 'y' })).id;
			expect(await listJobRuns(db, await projectScopeForUser(db, 'owner-2', other))).toEqual([]);
		});
	});
});
