/**
 * The honest output-stack catalog — one source of truth for the Settings
 * stack panel and the conversation's list_stacks tool (product charter: the
 * chat answers "what stacks are available" from this registry, never from
 * invention). Statuses state reality: one proving stack, everything else
 * visibly planned.
 */

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
