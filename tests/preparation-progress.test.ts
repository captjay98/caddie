import { expect, test } from 'bun:test';
import { preparationLines } from '../apps/app/src/client/project/preparation-progress.ts';
import { preparationProgress } from '../apps/app/src/server/preparation-progress.ts';
import { migratedDatabase } from './fixtures/sqlite-d1.ts';

// Owner 2026-10-29: no progress bar can be honest, but the wait must not be silent.
const at = (minutes: number) => Date.parse('2026-10-29T10:00:00.000Z') + minutes * 60_000;
const base = { step: 'plan' as const, startedAt: '2026-10-29T10:00:00.000Z', typicalMinutes: [3, 8] as const };

test('the owner sees the stage, the time so far and the usual range', () => {
	expect(preparationLines({ ...base, stage: 'writing', pass: 1 }, at(0))).toEqual({ stage: 'Writing your plan', time: 'usually 3–8 min', quiet: false });
	expect(preparationLines({ ...base, stage: 'checking', pass: 1 }, at(4))).toEqual({ stage: 'Checking your plan', time: '4 of about 3–8 min', quiet: false });
	expect(preparationLines({ ...base, stage: 'fixing', pass: 2 }, at(5)).stage).toBe('Fixing your plan');
	expect(preparationLines({ ...base, stage: 'checking', pass: 2 }, at(6)).stage).toBe('Checking your plan again');
	expect(preparationLines({ ...base, stage: 'checking', pass: 3 }, at(12)).time).toBe('12 min · longer than usual');
	// Owner 2026-10-29: "10 of about 5–10 min" — the top of the range is already over.
	expect(preparationLines({ ...base, stage: 'writing', pass: 1 }, at(8)).time).toBe('8 min · longer than usual');
});
test('a step with no recorded work for five minutes says so instead of a clock', () => {
	const quiet = preparationLines({ ...base, stage: 'writing', pass: 1, lastActivityAt: '2026-10-29T10:01:00.000Z' }, at(7));
	expect(quiet).toEqual({ stage: 'Writing your plan', time: 'no update for 6 min', quiet: true });
	expect(preparationLines({ ...base, stage: 'writing', pass: 1, lastActivityAt: '2026-10-29T10:05:00.000Z' }, at(7)).quiet).toBe(false);
});

test('the server reads the stage from recorded drafts and reviews', async () => {
	const { db, sqlite } = await migratedDatabase();
	try {
		const workflow = { projectId: 'p1', phase: 'planning', updatedAt: '2026-10-29T10:00:00.000Z' };
		expect(await preparationProgress(db, { ...workflow, phase: 'review' })).toBeNull();
		expect((await preparationProgress(db, workflow))?.stage).toBe('writing');
		sqlite.exec('pragma foreign_keys = off');
		let round = 0;
		const add = (id: string, status: string, minute: number) => sqlite.exec(`insert into artifact_candidates (id,admissionId,projectId,kind,bodyHash,body,authorRouteId,round,status,createdAt) values ('${id}','a1','p1','prd','h${id}','b','r',${++round},'${status}','2026-10-29T10:0${minute}:00.000Z')`);
		add('c1', 'reviewing', 2);
		expect(await preparationProgress(db, workflow)).toMatchObject({ step: 'plan', stage: 'checking', pass: 1 });
		sqlite.exec("update artifact_candidates set status='revise' where id='c1'");
		expect(await preparationProgress(db, workflow)).toMatchObject({ stage: 'fixing', pass: 2 });
		add('c2', 'pending', 5);
		expect(await preparationProgress(db, workflow)).toMatchObject({ stage: 'checking', pass: 2, lastActivityAt: '2026-10-29T10:05:00.000Z' });
	} finally { sqlite.close(); }
});
