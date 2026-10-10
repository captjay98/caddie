/**
 * The honest output-stack catalog — one source of truth for the Settings
 * stack panel and the conversation's list_stacks tool (product charter: the
 * chat answers "what stacks are available" from this registry, never from
 * invention). Statuses state reality: one proving stack, everything else
 * visibly planned.
 */

import type { D1Database } from './auth.ts';
import { createNotification } from './notifications.ts';

export interface StackCatalogEntry {
	id: string;
	status: 'enabled' | 'planned';
	note?: string;
}

export const STACK_CATALOG: readonly StackCatalogEntry[] = [
	{ id: 'react-hono', status: 'enabled', note: 'proving in the forge' },
	{ id: 'tanstack-start', status: 'planned' },
	{ id: 'laravel-inertia', status: 'planned' },
	{ id: 'fastapi-react', status: 'planned' },
	{ id: 'flutter', status: 'planned' },
];

// --- B03: "Tell me when it's ready" -------------------------------------------------

/** One actor's subscription for a planned stack. */
export interface StackNotifySubscription {
	readonly actorId: string;
	readonly stackId: string;
	readonly createdAt: string;
}

export class StackNotifyError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

function requireActor(actorId: unknown): string {
	if (typeof actorId !== 'string' || actorId.trim().length === 0) {
		throw new StackNotifyError(400, 'invalid_request', 'actorId is required');
	}
	return actorId;
}

/** Subscribe an actor to a stack's availability notification. Subscribing to
 *  an ALREADY-ENABLED stack is rejected — the notification would never fire
 *  and the toggle would lie. */
export async function subscribeStackNotify(
	db: D1Database,
	actorId: string,
	stackId: string,
): Promise<StackNotifySubscription> {
	const actor = requireActor(actorId);
	if (typeof stackId !== 'string' || stackId.trim().length === 0) {
		throw new StackNotifyError(400, 'invalid_request', 'stackId is required');
	}
	const entry = STACK_CATALOG.find((candidate) => candidate.id === stackId);
	if (!entry) {
		throw new StackNotifyError(404, 'stack_not_found', `no such stack: ${stackId}`);
	}
	if (entry.status === 'enabled') {
		throw new StackNotifyError(
			409,
			'stack_already_enabled',
			`${stackId} is already enabled — it is being proven first, not awaiting a release`,
		);
	}
	const now = new Date().toISOString();
	await db
		.prepare(
			'insert or ignore into "stack_notify_subscriptions" ("actorId","stackId","createdAt") values (?,?,?)',
		)
		.bind(actor, stackId, now)
		.run();
	const rows = await db
		.prepare('select "actorId","stackId","createdAt" from "stack_notify_subscriptions" where "actorId" = ? and "stackId" = ?')
		.bind(actor, stackId)
		.all();
	const row = (rows.results ?? [])[0] as Record<string, unknown> | undefined;
	return {
		actorId: String(row?.['actorId']),
		stackId: String(row?.['stackId']),
		createdAt: String(row?.['createdAt']),
	};
}

export async function unsubscribeStackNotify(db: D1Database, actorId: string, stackId: string): Promise<{ removed: boolean }> {
	const actor = requireActor(actorId);
	const res = (await db
		.prepare('delete from "stack_notify_subscriptions" where "actorId" = ? and "stackId" = ?')
		.bind(actor, stackId)
		.run()) as { meta?: { changes?: number } };
	return { removed: (res.meta?.changes ?? 0) > 0 };
}

export async function listStackNotifySubscriptions(db: D1Database, actorId: string): Promise<StackNotifySubscription[]> {
	const actor = requireActor(actorId);
	const res = await db
		.prepare('select "actorId","stackId","createdAt" from "stack_notify_subscriptions" where "actorId" = ? order by "createdAt" asc')
		.bind(actor)
		.all();
	return (res.results ?? []).map((row) => ({
		actorId: String(row['actorId']),
		stackId: String(row['stackId']),
		createdAt: String(row['createdAt']),
	})) as StackNotifySubscription[];
}

/**
 * Fired by the operator when a stack's catalog entry flips to `enabled`
 * (the catalog is code-defined, so the flip is a deploy; this helper is
 * called from the deploy path / smoke script, never from a client route).
 * One notification per subscriber, deduped per (stack, flip) by the unique
 * dedupeKey.
 */
export async function notifyStackEnabled(db: D1Database, stackId: string): Promise<{ notified: number }> {
	const entry = STACK_CATALOG.find((candidate) => candidate.id === stackId);
	if (!entry || entry.status !== 'enabled') {
		throw new StackNotifyError(409, 'stack_not_enabled', `${stackId} is not enabled in the catalog`);
	}
	const subs = await db
		.prepare('select "actorId" from "stack_notify_subscriptions" where "stackId" = ?')
		.bind(stackId)
		.all();
	let notified = 0;
	for (const row of (subs.results ?? []) as Record<string, unknown>[]) {
		const userId = String(row['actorId']);
		const { created } = await createNotification(db, {
			userId,
			projectId: null,
			kind: 'stack_enabled',
			title: `${stackId} is ready to build with`,
			body: `The build tool you asked about passed its live test and is open for new projects. Start one from Projects and pick ${stackId}.`,
			dedupeKey: `stack_enabled:${stackId}:${userId}`,
		});
		if (created) notified += 1;
	}
	return { notified };
}