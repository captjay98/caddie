import { WorkerEntrypoint } from 'cloudflare:workers';
import type { D1Database } from './auth.ts';
import { appAiDepsFromEnv, runAppAi, type AppAiReply } from './app-ai.ts';
import { sendAppSignInCode, type AppSignInDeps, type SignInCodeReply } from './app-sign-in.ts';
import { mailerFromEnv } from './notifications.ts';
import { appsDomainOf } from './publish-env.ts';

/**
 * Caddie's platform services for generated apps, as `env.CADDIE` inside the
 * app's server: AI (stage 9) and delivering sign-in codes (stage 7).
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
 * Imports cloudflare:workers, so only workerd loads this module; the services
 * behind it (app-ai.ts, app-sign-in.ts) are runtime-neutral and unit-tested.
 */

export type AppPlatformEnv = {
	DB: D1Database;
	NEBIUS_API_KEY?: string;
	APP_AI_MONTHLY_LIMIT_CENTS?: string;
	RESEND_API_KEY?: string;
	RESEND_FROM?: string;
	APPS_DOMAIN?: string;
	BETTER_AUTH_URL?: string;
};

export function appSignInDepsFromEnv(env: AppPlatformEnv): AppSignInDeps {
	return { mailer: mailerFromEnv(env as unknown as Record<string, unknown>), appsDomain: appsDomainOf(env), caddieOrigin: env.BETTER_AUTH_URL?.trim() || null };
}

const notPublished = { ok: false, reason: 'unavailable', message: "This app isn't published right now." } as const;

export class AppPlatform extends WorkerEntrypoint<AppPlatformEnv, { projectId: string }> {
	ai(request: unknown): Promise<AppAiReply> {
		return runAppAi(this.env.DB, appAiDepsFromEnv(this.env), { projectId: this.ctx.props.projectId, mode: 'preview', request });
	}

	signInCode(request: unknown): Promise<SignInCodeReply> {
		return sendAppSignInCode(this.env.DB, appSignInDepsFromEnv(this.env), { projectId: this.ctx.props.projectId, mode: 'preview', request });
	}
}

export class PublishedAppPlatform extends WorkerEntrypoint<AppPlatformEnv> {
	async ai(projectId: unknown, request: unknown): Promise<AppAiReply> {
		if (typeof projectId !== 'string' || projectId.length === 0) return notPublished;
		return runAppAi(this.env.DB, appAiDepsFromEnv(this.env), { projectId, mode: 'live', request });
	}

	async signInCode(projectId: unknown, request: unknown): Promise<SignInCodeReply> {
		if (typeof projectId !== 'string' || projectId.length === 0) return notPublished;
		return sendAppSignInCode(this.env.DB, appSignInDepsFromEnv(this.env), { projectId, mode: 'live', request });
	}
}
