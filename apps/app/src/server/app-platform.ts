import { WorkerEntrypoint } from 'cloudflare:workers';
import type { D1Database } from './auth.ts';
import { appAiDepsFromEnv, runAppAi, type AppAiReply } from './app-ai.ts';

/**
 * Caddie's platform services for generated apps, as `env.CADDIE` inside the
 * app's server (stage 9: AI; app logins' email comes later).
 *
 *   AppPlatform           the preview's env.CADDIE. The preview relay passes
 *                         `ctx.exports.AppPlatform({ props: { projectId } })`
 *                         into the app's Worker Loader isolate, so the app can
 *                         call it but can't name another project.
 *   PublishedAppPlatform  for published apps, reached ONLY through the
 *                         dispatch Worker's service binding: its own
 *                         props-bound capability (workers/dispatch) names the
 *                         project from the route record. Published user
 *                         Workers get no binding to it — Caddie writes their
 *                         bindings (D1, keys, assets) — and previews can't
 *                         reach it either.
 *
 * Imports cloudflare:workers, so only workerd loads this module; the service
 * behind it (app-ai.ts) is runtime-neutral and unit-tested under Bun.
 */

export type AppPlatformEnv = { DB: D1Database; NEBIUS_API_KEY?: string; APP_AI_MONTHLY_LIMIT_CENTS?: string };

export class AppPlatform extends WorkerEntrypoint<AppPlatformEnv, { projectId: string }> {
	ai(request: unknown): Promise<AppAiReply> {
		return runAppAi(this.env.DB, appAiDepsFromEnv(this.env), { projectId: this.ctx.props.projectId, mode: 'preview', request });
	}
}

export class PublishedAppPlatform extends WorkerEntrypoint<AppPlatformEnv> {
	async ai(projectId: unknown, request: unknown): Promise<AppAiReply> {
		if (typeof projectId !== 'string' || projectId.length === 0) {
			return { ok: false, reason: 'unavailable', message: "This app isn't published right now." };
		}
		return runAppAi(this.env.DB, appAiDepsFromEnv(this.env), { projectId, mode: 'live', request });
	}
}
