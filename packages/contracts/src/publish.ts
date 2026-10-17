/**
 * Publish contracts shared by Caddie's server and the dispatch Worker
 * (apps/dispatch). Serializable data only.
 *
 * Caddie's server writes one AppRoute per hostname into the routing KV
 * namespace (key: `route:<hostname>`); the dispatch Worker reads it on every
 * request to pick the user Worker in the dispatch namespace, or to answer
 * with a takedown / not-found page. Hostnames are lower-case, no port.
 */

/** live = serve; blocked = taken down for abuse (451); paused = unpublished by its owner (404). */
export type AppRouteStatus = 'live' | 'blocked' | 'paused';

export interface AppRoute {
	/** Route record format version. */
	v: 1;
	/** User Worker script name inside the dispatch namespace. */
	script: string;
	projectId: string;
	/** Public slug (`<slug>.<apps-domain>`), also used in the report link. */
	slug: string;
	status: AppRouteStatus;
	/** Per-request limits the dispatch Worker applies to the user Worker. */
	limits: { cpuMs: number; subRequests: number };
	/** Whether the app has server code; static-only apps never reach `/api/*`. */
	hasServer: boolean;
	/** ISO time of the publish that wrote this record. */
	updatedAt: string;
}

export const ROUTE_KEY_PREFIX = 'route:';

export function routeKey(hostname: string): string {
	return `${ROUTE_KEY_PREFIX}${hostname.toLowerCase()}`;
}

/** Defaults the publish service writes unless a plan raises them. */
export const DEFAULT_APP_LIMITS = { cpuMs: 50, subRequests: 50 } as const;
