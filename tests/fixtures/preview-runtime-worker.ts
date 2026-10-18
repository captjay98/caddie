// Fixture Worker for tests/preview-runtime.integration.test.ts: the REAL
// preview runtime (Worker Loader + PreviewDatabase Durable Object + gateway +
// outbound gate) under real workerd via `wrangler dev`. Test-only; never
// deployed.
import { bridgeRequestToRequest, checkServerStarts, runPreviewApp, type WorkerLoaderLike } from '../../apps/app/src/server/preview-runtime.ts';
import { previewDatabaseFor, type PreviewDatabaseEnv } from '../../apps/app/src/server/preview-database.ts';
import { PreviewOutbound } from '../../apps/app/src/server/preview-outbound.ts';

export { PreviewDatabase, PreviewDatabaseGateway } from '../../apps/app/src/server/preview-database.ts';

/**
 * The real gate (policy, redirect handling, logging) with the internet swapped
 * for a canned upstream, so the test never leaves the machine.
 */
export class TestOutbound extends PreviewOutbound {
	protected override async forward(request: Request): Promise<Response> {
		if (request.url === 'https://bounce.example.com/') return new Response(null, { status: 302, headers: { location: 'http://10.1.2.3/' } });
		return new Response(`upstream saw ${request.method} ${request.url} auth=${request.headers.get('authorization')}`);
	}
}

type Env = PreviewDatabaseEnv & { LOADER: WorkerLoaderLike };
type Ctx = {
	exports: {
		PreviewDatabaseGateway(options: { props: { projectId: string } }): unknown;
		TestOutbound(options: { props: { projectId: string } }): unknown;
	};
};

export default {
	async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/__test/health') return Response.json({ ok: true, loader: Boolean(env.LOADER), db: Boolean(env.PREVIEW_DB) });
		const body = (await request.json()) as Record<string, any>;
		try {
			if (url.pathname === '/check') return Response.json(await checkServerStarts(env.LOADER, body.serverSource));
			if (url.pathname === '/reset') {
				await previewDatabaseFor(env, body.projectId).reset();
				return Response.json({ ok: true });
			}
			if (url.pathname === '/run') {
				const db = previewDatabaseFor(env, body.projectId);
				const migrations = body.migrations ? await db.applyMigrations(body.migrations) : { applied: [] };
				const relayed = await runPreviewApp({
					loader: env.LOADER,
					projectId: body.projectId,
					outputId: body.outputId,
					serverSource: body.serverSource,
					vars: body.vars ?? {},
					database: ctx.exports.PreviewDatabaseGateway({ props: { projectId: body.projectId } }),
					globalOutbound: body.egress === 'gate' ? ctx.exports.TestOutbound({ props: { projectId: body.projectId } }) : null,
					request: bridgeRequestToRequest(body.request),
				});
				return Response.json({ migrations, relayed });
			}
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
		}
		return new Response('not found', { status: 404 });
	},
};
