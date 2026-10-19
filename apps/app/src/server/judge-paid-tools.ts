import type { Scope } from '@caddie/contracts';
import type { CoordinatorHostContext } from '../agents/coordinator.ts';
import type { D1Database } from './auth.ts';
import { discoverForActor, hackathonDetailsForActor, researchForActor } from './coordinator-context.ts';
import { admitJudgeDiscovery } from './judge-limits.ts';

/** What the chat's paid discovery tools need from the Worker env. */
export interface PaidToolEnv {
	readonly DB: D1Database;
	readonly TAVILY_API_KEY?: string;
	readonly NEBIUS_API_KEY?: string;
	/** The judge discovery limit (judge-limits.ts reads it from the same env). */
	readonly JUDGE_MAX_DISCOVERY_PER_DAY?: string | number;
}

/**
 * The chat's three paid discovery tools: find hackathons (Tavily + Nebius),
 * research a page (Tavily) and one hackathon's details (a Nebius digest on a
 * cache miss). For a judge each spends one discovery lookup BEFORE any
 * provider call, the same budget as the Discover page's two buttons (review
 * F02: the chat used to call these with no limit). The details tool spends one
 * only when the digest is not cached; at the limit it answers without the
 * digest. Everyone else passes straight through.
 */
export function paidDiscoveryTools(
	env: PaidToolEnv,
	scope: Scope,
): Pick<CoordinatorHostContext, 'discover' | 'research' | 'hackathonDetails'> {
	const admit = () => admitJudgeDiscovery(env.DB, scope.actorId, env);
	return {
		discover: async (input) => {
			await admit();
			return discoverForActor(env.DB, scope, input, { tavilyApiKey: env.TAVILY_API_KEY, nebiusApiKey: env.NEBIUS_API_KEY });
		},
		research: async (input) => {
			await admit();
			return researchForActor(env.DB, scope, input, { tavilyApiKey: env.TAVILY_API_KEY });
		},
		hackathonDetails: (input) =>
			hackathonDetailsForActor(env.DB, scope, input, { nebiusApiKey: env.NEBIUS_API_KEY, admitDigest: admit }),
	};
}
