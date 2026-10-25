import { test, expect } from 'bun:test';
import { evictWarm } from '../apps/app/src/client/conversation/agent-keeper.tsx';

const MINUTE = 60_000;

test('evictWarm keeps conversations that still have a consumer', () => {
	const refs = new Map([['a', 1]]);
	const lastUsed = new Map([['a', 0]]);
	// Far past the idle grace, but refcount 1: never dropped.
	expect(evictWarm(refs, lastUsed, 60 * MINUTE, { idleMs: 5 * MINUTE, cap: 4 })).toEqual([]);
});

test('evictWarm drops zero-ref conversations only after the idle grace', () => {
	const refs = new Map([['a', 0]]);
	const lastUsed = new Map([['a', 3 * MINUTE]]);
	const now = 10 * MINUTE;
	// 7 minutes idle: past the 5-minute grace.
	expect(evictWarm(refs, lastUsed, now, { idleMs: 5 * MINUTE, cap: 4 })).toEqual(['a']);

	const lastUsedRecent = new Map([['a', 8 * MINUTE]]);
	// 2 minutes idle: inside the grace.
	expect(evictWarm(refs, lastUsedRecent, now, { idleMs: 5 * MINUTE, cap: 4 })).toEqual([]);
});

test('evictWarm enforces the LRU cap by evicting the least-recently-used free session', () => {
	const refs = new Map([['active', 1], ['old', 0], ['recent', 0]]);
	const lastUsed = new Map([['active', 5], ['old', 1], ['recent', 4]]);
	const now = 10;
	// Over cap (3 > 2): drop the zero-ref LRU ('old'), never the held one.
	expect(evictWarm(refs, lastUsed, now, { idleMs: 5 * MINUTE, cap: 2 })).toEqual(['old']);
});

test('evictWarm evicts nothing when at or under cap with recent use', () => {
	const refs = new Map([['a', 0], ['b', 0], ['c', 0]]);
	const lastUsed = new Map([['a', 1], ['b', 2], ['c', 3]]);
	expect(evictWarm(refs, lastUsed, 4, { idleMs: 5 * MINUTE, cap: 3 })).toEqual([]);
});
