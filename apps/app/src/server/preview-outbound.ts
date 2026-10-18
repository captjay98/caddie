import { WorkerEntrypoint } from 'cloudflare:workers';
import { egressDenyHosts, fetchWithPolicy } from './outbound-policy.ts';

/**
 * The preview isolate's way out to the internet. Worker Loader sends every
 * fetch() the app's server makes to the Fetcher given as `globalOutbound`;
 * Caddie passes `ctx.exports.PreviewOutbound({ props: { projectId } })`, so
 * each request is checked against the egress policy (outbound-policy.ts)
 * before it leaves, redirects included. Raw TCP (connect()) has no route at
 * all. One JSON log line per hop: project, method, host, decision.
 *
 * Imports cloudflare:workers, so only workerd loads this module; the policy
 * itself is runtime-neutral and unit-tested under Bun.
 */

export type PreviewOutboundEnv = { BETTER_AUTH_URL?: string; APPS_DOMAIN?: string; EGRESS_DENY_HOSTS?: string };

export class PreviewOutbound extends WorkerEntrypoint<PreviewOutboundEnv, { projectId: string }> {
	async fetch(request: Request): Promise<Response> {
		const projectId = this.ctx.props.projectId;
		return fetchWithPolicy(request, {
			denyHosts: egressDenyHosts(this.env),
			upstream: (outgoing) => this.forward(outgoing),
			log: (entry) => console.log(JSON.stringify({ kind: 'preview-egress', projectId, ...entry })),
		});
	}

	/** The real internet. A test fixture overrides this to stay offline. */
	protected forward(request: Request): Promise<Response> {
		return fetch(request);
	}
}
