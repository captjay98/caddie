// Worker-level Cloudflare code lives here; HTTP routing stays in src/app.ts.
//
//   - Named exports become top-level Worker exports — e.g. application-owned
//     Durable Object classes (declare their bindings in wrangler.jsonc).
//   - An optional default export adds non-HTTP handlers: scheduled (cron),
//     queue consumers, inbound email, etc. (never `fetch`).
//
// https://flueframework.com/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint
//
// P12 schedule dispatch: the default export's `scheduled` handler is the REAL
// cron timer. @flue/vite's generated entry spreads this object into the
// Worker's top-level exports (ahead of its own composed `fetch`), so the
// handler below IS the workerd `scheduled` export — triggered by the
// `"triggers": { "crons": ["*/5 * * * *"] }` block in wrangler.jsonc. It is
// system-level by contract (server/schedules.ts module header): a cron tick
// has no session, so dispatchDueSchedules targets only the schedules' STORED
// project/source/run ids. The tick path is pinned by
// tests/schedules.integration.test.ts (direct service dispatch AND this
// handler over the D1-shaped fixture).

import type { AuthEnv } from './server/auth.ts';
import { dispatchDueSchedules } from './server/schedules.ts';
import { sweepStalledBuilds } from './server/build-workflow.ts';
import { advanceSafetyChecks, recheckLiveApps } from './server/publish.ts';
import { publishDepsFromEnv, type PublishEnv } from './server/publish-env.ts';
import { createWebRisk } from './server/adapters/web-risk.ts';

// Backend previews (docs/plans/2026-10-17-publish): the per-project preview
// database and the RPC gateway an app's preview isolate reaches it through,
// and the outbound gate every fetch the preview's server makes goes through.
export { PreviewDatabase, PreviewDatabaseGateway } from './server/preview-database.ts';
export { PreviewOutbound } from './server/preview-outbound.ts';
export { AppPlatform, PublishedAppPlatform } from './server/app-platform.ts';

/** Structural handler types (this module stays free of extra type deps). */
interface CronController {
	// The cron pattern that fired (the wrangler.jsonc trigger, e.g. a
	// five-minute star-slash-5 expression).
	readonly cron: string;
	/** Epoch ms of the scheduled fire time. */
	readonly scheduledTime: number;
}

export default {
	async scheduled(controller: CronController, env: Pick<AuthEnv, 'DB'> & PublishEnv & { WEB_RISK_API_KEY?: string }, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
		ctx.waitUntil(
			dispatchDueSchedules(env.DB, Date.now()).then((fired) => {
				if (fired > 0) {
					console.log(`[schedules] cron ${controller.cron} dispatched ${fired} occurrence(s)`);
				}
			}),
		);
		// Stall watchdog: a build with no progress for BUILD_STALL_MS is stopped
		// honestly even when no one has the project open. Independent of the
		// schedule dispatch above: a failed sweep is logged, never fails the tick.
		ctx.waitUntil(
			sweepStalledBuilds(env.DB, Date.now())
				.then((stopped) => {
					if (stopped > 0) console.log(`[builds] cron ${controller.cron} stopped ${stopped} stalled build(s)`);
				})
				.catch((error: unknown) => {
					console.error('[builds] stall sweep failed', error instanceof Error ? error.message : error);
				}),
		);
		// Published apps (only when publishing is set up): finish safety scans that
		// outlasted the publish request, and recheck live apps against Web Risk once
		// a day. Each failure is logged; neither ever fails the tick.
		ctx.waitUntil(
			(async () => {
				const deps = await publishDepsFromEnv(env);
				if (!deps) return;
				const settled = await advanceSafetyChecks(env.DB, deps).catch((error: unknown) => {
					console.error('[publish] safety-check sweep failed', error instanceof Error ? error.message : error);
					return 0;
				});
				if (settled > 0) console.log(`[publish] cron ${controller.cron} settled ${settled} safety check(s)`);
				const key = (env.WEB_RISK_API_KEY ?? '').trim();
				if (!key) return;
				const recheck = await recheckLiveApps(env.DB, deps, createWebRisk({ apiKey: key })).catch((error: unknown) => {
					console.error('[publish] web risk recheck failed', error instanceof Error ? error.message : error);
					return null;
				});
				if (recheck && (recheck.flagged > 0 || recheck.failed > 0)) console.log(`[publish] recheck: ${recheck.checked} checked, ${recheck.flagged} taken down, ${recheck.failed} failed`);
			})().catch((error: unknown) => console.error('[publish] cron failed', error instanceof Error ? error.message : error)),
		);
	},
};
