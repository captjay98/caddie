import { describe, expect, test } from 'bun:test';
import type { ArchitectureBlock } from '../packages/contracts/src/architecture.ts';
import type { DesignReviewFindings } from '../packages/contracts/src/experience.ts';
import type { ModuleRow } from '../apps/app/src/server/module-slots.ts';
import type { BuildWorkflow } from '../apps/app/src/server/build-workflow.ts';
import {
	designOverviewFrom,
	moduleBoardToProgress,
	moduleProgressState,
	spendStopFrom,
	SPEND_STOP_SENTINEL,
} from '../apps/app/src/server/project-experience.ts';

/**
 * LOCAL VERIFIED (plan section 7, screens 1 and 2): the pure projectors that
 * turn the real architecture block, the architect review, the module board and
 * the workflow stop into the plain-words shapes the Design review and build-
 * progress screens read. No I/O: block/rows/workflow in, serializable shape out.
 */

/** A small app: one module, one private table, sign-in, a service, AI, test-mode. */
function smallBlock(): ArchitectureBlock {
	return {
		version: 2,
		signIn: 'required',
		team: null,
		modules: [{ id: 'app', plain: 'The whole app', dependsOn: [] }],
		tables: [{ name: 'notes', module: 'app', plain: 'A note you wrote', owner: 'person', fields: [{ name: 'body', type: 'text', references: null }] }],
		routes: [
			{ id: 'notes.create', module: 'app', feature: 'notes', op: 'create', method: 'POST', path: '/api/notes', table: 'notes', plain: 'add a note', access: 'person', request: [{ name: 'body', type: 'text', example: 'Buy feed' }], response: ['id'] },
		],
		screens: [{ id: 'notes', module: 'app', path: '#/notes', plain: 'Your notes', shows: ['notes'] }],
		services: [{ id: 'weather', plain: 'weather for the farm', keyName: 'WEATHER_API_KEY', keyPage: 'https://example.com/keys' }],
		ai: [{ id: 'summary-ai', plain: 'explains the week', route: 'notes.create', tier: 'fast', images: false }],
		payments: { currency: 'USD', plans: [{ id: 'pro', plain: 'Pro', priceMinor: 900, interval: 'month' }], locked: [] },
		emails: [{ id: 'invite', plain: 'invites someone to the farm', route: 'notes.create', to: 'person' }],
		jobs: [],
		screenOnly: [],
	};
}

/** A big app: three modules (core, feed depends on core, money depends on feed) + a team. */
function bigBlock(): ArchitectureBlock {
	return {
		version: 2,
		signIn: 'required',
		team: { table: 'farms', plain: 'A farm and the people on it', roles: ['owner', 'worker'], creatorRole: 'owner' },
		modules: [
			{ id: 'core', plain: 'Farms, people and roles', dependsOn: [] },
			{ id: 'feed', plain: 'Feed stock and use', dependsOn: ['core'] },
			{ id: 'money', plain: 'Money in and out', dependsOn: ['feed'] },
		],
		tables: [
			{ name: 'farms', module: 'core', plain: 'Each farm', owner: 'team', fields: [{ name: 'name', type: 'text', references: null }] },
			{ name: 'feed_stock', module: 'feed', plain: 'Feed in stock', owner: 'team', fields: [{ name: 'kg', type: 'real', references: null }] },
		],
		routes: [
			{ id: 'farms.create', module: 'core', feature: 'farms', op: 'create', method: 'POST', path: '/api/teams/:teamId/farms', table: 'farms', plain: 'add a farm', access: 'team-role:owner', request: [{ name: 'name', type: 'text', example: 'Hill Farm' }], response: ['id'] },
		],
		screens: [
			{ id: 'farms', module: 'core', path: '#/farms', plain: 'Your farms', shows: ['farms'] },
			{ id: 'feed', module: 'feed', path: '#/feed', plain: 'Feed stock', shows: ['feed_stock'] },
		],
		services: [],
		ai: [],
		payments: null,
		emails: [],
		jobs: [],
		screenOnly: [],
	};
}

function moduleRow(moduleId: string, status: ModuleRow['status'], dependsOn: string[] = []): ModuleRow {
	return {
		id: `bm_${moduleId}`,
		projectId: 'proj',
		buildSeq: 1,
		moduleId,
		status,
		sessionKey: null,
		checkpointRef: null,
		builderId: null,
		attempts: 0,
		dependsOn,
		payerId: null,
		createdAt: '2026-10-22T00:00:00.000Z',
		updatedAt: '2026-10-22T00:00:00.000Z',
	};
}

function blocked(detail: string): BuildWorkflow {
	return {
		projectId: 'proj', runId: 'run-1', conversationId: 'conv-1', sourceConversationId: null,
		brief: 'Build it.', phase: 'blocked', planId: 'plan-1', previewId: null,
		pendingKey: null, pendingBody: null, detail, updatedAt: '2026-10-22T00:00:00.000Z',
	};
}

describe('designOverviewFrom (screen 1 — How your app works)', () => {
	test('a small app is "small", carries the plain sections and screens, and no modules', () => {
		const overview = designOverviewFrom(smallBlock(), null);
		expect(overview.app).toBe('small');
		// what it stores / who can see what / sign-in / services / AI / test-mode.
		expect(overview.sections.map((s) => s.key)).toEqual(['saves', 'access', 'sign-in', 'services', 'ai', 'test-mode']);
		expect(overview.screens).toEqual([{ plain: 'Your notes', module: 'app' }]);
		expect(overview.modules).toBeUndefined();
	});

	test('a big app is "big" and lists its parts (modules) side by side', () => {
		const overview = designOverviewFrom(bigBlock(), null);
		expect(overview.app).toBe('big');
		expect(overview.modules).toEqual([
			{ id: 'core', plain: 'Farms, people and roles' },
			{ id: 'feed', plain: 'Feed stock and use' },
			{ id: 'money', plain: 'Money in and out' },
		]);
		// Screens carry their module so a big app can group them.
		expect(overview.screens).toEqual([
			{ plain: 'Your farms', module: 'core' },
			{ plain: 'Feed stock', module: 'feed' },
		]);
	});

	test('the architect review is carried through, security apart from advisory', () => {
		const review: DesignReviewFindings = { blocks: true, security: ['Anyone could read another person’s notes.'], advisory: ['Consider a search screen.'] };
		const overview = designOverviewFrom(smallBlock(), review);
		expect(overview.review).toEqual(review);
	});

	test('with no review yet the field is absent, never an empty panel', () => {
		expect(designOverviewFrom(smallBlock(), null).review).toBeUndefined();
	});
});

describe('moduleProgressState (screen 2 — the plain state word)', () => {
	test('each stored status maps to the word the person reads', () => {
		expect(moduleProgressState('pending')).toBe('waiting');
		expect(moduleProgressState('building')).toBe('building');
		expect(moduleProgressState('passed')).toBe('joined');
		expect(moduleProgressState('merged')).toBe('joined');
		expect(moduleProgressState('not-merged')).toBe('not-joined');
		expect(moduleProgressState('stopped')).toBe('stopped');
	});
});

describe('moduleBoardToProgress (screen 2 — parts side by side)', () => {
	test('each module gets its plain name and state, and a waiting one names what it waits for', () => {
		const rows = [moduleRow('core', 'merged'), moduleRow('feed', 'building', ['core']), moduleRow('money', 'pending', ['feed'])];
		const board = moduleBoardToProgress(rows, bigBlock());
		expect(board).toEqual([
			{ id: 'core', plain: 'Farms, people and roles', state: 'joined' },
			{ id: 'feed', plain: 'Feed stock and use', state: 'building' },
			{ id: 'money', plain: 'Money in and out', state: 'waiting', waitingFor: ['Feed stock and use'] },
		]);
	});

	test('a waiting module whose dependency is finished lists no waitingFor', () => {
		const rows = [moduleRow('core', 'merged'), moduleRow('feed', 'pending', ['core'])];
		const board = moduleBoardToProgress(rows, bigBlock());
		expect(board[1]).toEqual({ id: 'feed', plain: 'Feed stock and use', state: 'waiting' });
	});

	test('a stopped module reads "stopped" and never blocks reading the rest', () => {
		const rows = [moduleRow('core', 'merged'), moduleRow('feed', 'stopped', ['core'])];
		const board = moduleBoardToProgress(rows, bigBlock());
		expect(board.map((m) => m.state)).toEqual(['joined', 'stopped']);
	});
});

describe('spendStopFrom (screen 2 — the spending-limit stop)', () => {
	test('a build stopped at its limit shows the limit message and what is saved', () => {
		const stop = spendStopFrom(blocked(`This build ${SPEND_STOP_SENTINEL} of $5.00.`), 5_000_000);
		expect(stop).toEqual({ message: 'This build reached its spending limit of $5.00.', saved: 'Your plan and files are saved.' });
	});

	test('an ordinary stop (not the spend limit) is not a spend stop', () => {
		expect(spendStopFrom(blocked('Stop requested.'), 5_000_000)).toBeNull();
	});

	test('a building (not blocked) workflow is never a spend stop', () => {
		const building: BuildWorkflow = { ...blocked(`${SPEND_STOP_SENTINEL}`), phase: 'building' };
		expect(spendStopFrom(building, 5_000_000)).toBeNull();
	});
});
