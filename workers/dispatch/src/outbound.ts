/**
 * Caddie's outbound Worker for published apps (Workers for Platforms
 * "outbound" on the dispatch namespace binding). Every fetch() a published
 * app's server makes arrives here; raw TCP (connect()) is disabled by the
 * platform once an outbound Worker is set. The policy is the same one the
 * preview isolates use (apps/app/src/server/outbound-policy.ts): web schemes
 * only, no private or local addresses, no loops into Caddie or other apps,
 * every redirect hop checked, credentials dropped across origins.
 *
 * `projectId` and `slug` arrive as outbound parameters from the dispatch
 * Worker (wrangler: dispatch_namespaces[].outbound.parameters). One JSON log
 * line per hop: project, slug, method, host, decision — never paths, query
 * strings, headers or bodies.
 */
import { egressDenyHosts, fetchWithPolicy } from '../../../apps/app/src/server/outbound-policy.ts';

export { outboundDecision } from '../../../apps/app/src/server/outbound-policy.ts';

export interface OutboundEnv {
	/** Outbound parameters from the dispatch Worker. */
	projectId?: string;
	slug?: string;
	/** Operator additions, comma-separated: exact host or any subdomain. */
	DENY_HOSTS?: string;
	/** Caddie's own origin and the apps domain are always denied (no loops). */
	CADDIE_ORIGIN?: string;
	APPS_DOMAIN?: string;
}

export function handleOutbound(
	request: Request,
	env: OutboundEnv,
	upstream: (request: Request) => Promise<Response> = (outgoing) => fetch(outgoing),
	log: (line: string) => void = (line) => console.log(line),
): Promise<Response> {
	return fetchWithPolicy(request, {
		denyHosts: egressDenyHosts({ BETTER_AUTH_URL: env.CADDIE_ORIGIN, APPS_DOMAIN: env.APPS_DOMAIN, EGRESS_DENY_HOSTS: env.DENY_HOSTS }),
		upstream,
		log: (entry) => log(JSON.stringify({ kind: 'app-egress', projectId: env.projectId ?? null, slug: env.slug ?? null, ...entry })),
	});
}

export default {
	fetch(request: Request, env: OutboundEnv): Promise<Response> {
		return handleOutbound(request, env);
	},
};
