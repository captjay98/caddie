import { Hono } from 'hono';
export { androidQrSvg } from './android-qr.ts';
import { createD1ContentStore } from './artifacts.ts';
import type { D1Database } from './auth.ts';
import { LARGE_MAX_BYTES, getLarge, putLarge } from './large-content.ts';
import type { SandboxDriver } from './adapters/sandbox.ts';
import { base64ToBytes } from './adapters/contree.ts';
import { flutterApkCommand, FLUTTER_APK_PATH } from '../../../../stacks/flutter/scaffold.ts';
import { ScopeError, assertProjectScope } from './scope.ts';
import type { Scope } from '@caddie/contracts';
import { appsDomainOf } from './publish-env.ts';

/**
 * Android apps (Track 3, stage E).
 *
 * The APK is built with a server address baked in. That address is a stable
 * Caddie one, `<Caddie>/a/<projectId>`, not the app's own: it forwards the
 * app's /api calls to the published app while it is live, so an APK keeps
 * working when it was built before publishing or the app's address changes.
 *
 *   GET  /a/<project>/app.apk     the APK: with a signed link (?t=, 30 min,
 *                                 for one version), or openly while published
 *   ANY  /a/<project>/api/...     forwarded to https://<slug>.<apps domain>;
 *                                 a plain 503 while the app is not published
 *
 * Forwarding never carries cookies either way: Caddie's own would leak to the
 * app, and the app's would land on Caddie's origin. APKs sign users in with
 * a bearer token instead of a cookie (stated in the Flutter recipe).
 */

export const APK_LINK_TTL_MS = 30 * 60_000;
const MIN_APK_BYTES = 1_000_000;

/** The address an APK calls; null when Caddie is not on https (an APK needs it). */
export function androidApiBase(caddieOrigin: string, projectId: string): string | null {
	let url: URL;
	try {
		url = new URL(caddieOrigin);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:') return null;
	return `${url.origin}/a/${projectId}`;
}

/** Null when the bytes are an APK worth keeping; otherwise why not. */
export function checkApk(bytes: Uint8Array): string | null {
	if (bytes.byteLength > LARGE_MAX_BYTES) return 'The Android build is larger than 64 MB, the most Caddie can keep.';
	if (bytes.byteLength < MIN_APK_BYTES) return 'The Android build is too small to be a working app.';
	if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return 'The Android build is not an Android app package.';
	return null;
}

/** A failed native check never prevents the checked browser preview from landing. */
export async function buildAndroidPackage(driver: SandboxDriver, input: {
  origin: string; projectId: string; runId: string; sessionId: string; root: string;
  operationKey: string; env: Record<string, string>; signal?: AbortSignal; expectedInputImage?: string;
}): Promise<{ apk: Uint8Array | null; apiBase: string | null; image: string | null; message: string; evidence: string }> {
  const apiBase = androidApiBase(input.origin, input.projectId);
  const unavailable = (message: string, evidence = '') => ({ apk: null, apiBase, image: null, message, evidence });
  if (!apiBase) return unavailable('The Android package needs Caddie to have an HTTPS address. You can still try the browser preview.');
  const command = flutterApkCommand(apiBase);
  const expectedCwd = new URL(input.root.startsWith("/") ? `file://${input.root}` : `file:///workspace/${input.projectId}/${input.root}`).pathname.replace(/\/+$/, "");
  try {
    input.signal?.throwIfAborted();
    const startingImage = (await driver.checkpoint(input.sessionId)).checkpointRef;
    if (input.expectedInputImage && startingImage !== input.expectedInputImage) return unavailable('The app changed after its browser checks. The Android package was not built.');
    await driver.execute({ sessionId: input.sessionId, command, operationKey: input.operationKey, cwd: input.root, env: input.env, timeoutMs: 10 * 60_000, ...(input.signal ? { signal: input.signal } : {}) });
    const receipt = await driver.getOperationReceipt(input.operationKey);
    const evidence = JSON.stringify(receipt);
    if (!receipt || receipt.projectId !== input.projectId || receipt.runId !== input.runId || receipt.sessionId !== input.sessionId || receipt.operationKey !== input.operationKey || receipt.command !== command || receipt.cwd !== expectedCwd || receipt.inputImage !== startingImage || receipt.state !== 'succeeded' || receipt.exitCode !== 0 || receipt.timedOut || receipt.outputTruncated || !receipt.resultImage) {
      return unavailable('The Android package did not finish successfully. The browser preview is still available.', evidence);
    }
    if ((await driver.checkpoint(input.sessionId)).checkpointRef !== receipt.resultImage) return unavailable('The Android build changed before it could be saved.', evidence);
    const file = await driver.readFile(input.sessionId, `${input.root}/${FLUTTER_APK_PATH}`);
    const apk = base64ToBytes(file.contentBase64);
    if ((await driver.checkpoint(input.sessionId)).checkpointRef !== receipt.resultImage) return unavailable('The Android build changed while it was being saved.', evidence);
    const problem = checkApk(apk);
    if (problem) return unavailable(problem, evidence);
    return { apk, apiBase, image: receipt.resultImage, message: 'Android package built and checked. Its server works after you publish the app.', evidence };
  } catch (error) {
    input.signal?.throwIfAborted();
    return unavailable('The Android package could not be built. The browser preview is still available.', JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}

export interface AndroidDownloadView {
  outputId: string | null; bytes: number | null; url: string | null; expiresAt: string | null;
  backendLive: boolean; message: string;
}

/** Owner/session-scoped metadata. Tokens are minted only on an explicit POST. */
export async function androidDownloadView(db: D1Database, scope: Scope, origin: string, secret: string, mint = false): Promise<AndroidDownloadView | null> {
  await assertProjectScope(db, scope);
  const row = await first(db, `select o.id, o.apkBytes, o.apkSha256, o.manifestSha256 from build_workflows w join workflow_outputs o on o.id = w.previewId and o.projectId = w.projectId where w.projectId = ?`, scope.projectId);
  if (!row) return null;
  const manifestBytes = row.manifestSha256 ? await createD1ContentStore(db).get(String(row.manifestSha256)) : null;
  const manifest = manifestBytes ? JSON.parse(new TextDecoder().decode(manifestBytes)) as { flutterWeb?: unknown; android?: { sha256: string; bytes: number } } : null;
  if (!manifest?.flutterWeb) return null;
  const publication = await livePublication(db, scope.projectId);
  const backendLive = Boolean(publication);
  const hasApk = Boolean(manifest.android && manifest.android.sha256 === row.apkSha256 && manifest.android.bytes === row.apkBytes);
  const base = androidApiBase(origin, scope.projectId);
  const stamp = Date.now();
  const url = mint && hasApk && secret && base ? `${base}/app.apk?t=${encodeURIComponent(await apkDownloadToken(secret, scope.projectId, String(row.id), stamp))}` : null;
  if (mint && !url) throw new ScopeError(409, 'APK_UNAVAILABLE', 'This build has no checked Android package yet. You can still try it in the browser.');
  return { outputId: String(row.id), bytes: hasApk ? Number(row.apkBytes) : null, url, expiresAt: url ? new Date(stamp + APK_LINK_TTL_MS).toISOString() : null, backendLive,
    message: hasApk ? backendLive ? 'Android app ready to download.' : 'You can download the Android app. Its server works after you publish; until then, try it in the browser. Judge accounts can use the browser preview but cannot publish.' : 'The Android package is unavailable for this build. You can still try the browser preview. Judge accounts cannot publish a live server.' };
}

async function sign(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
	return [...signature].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `<outputId>.<expiresAtMs>.<hmac>`: one version of one project's APK, for 30 minutes. */
export async function apkDownloadToken(secret: string, projectId: string, outputId: string, now = Date.now()): Promise<string> {
	const expires = now + APK_LINK_TTL_MS;
	return `${outputId}.${expires}.${await sign(secret, `apk:${projectId}:${outputId}:${expires}`)}`;
}

/** The version a link is for, or null when it is forged, for another project, or expired. */
export async function verifyApkDownloadToken(secret: string, projectId: string, token: string, now = Date.now()): Promise<string | null> {
	const [outputId, expires, signature, extra] = token.split('.');
	if (extra !== undefined || !outputId || !expires || !signature || !/^[A-Za-z0-9_-]{1,80}$/.test(outputId) || !/^\d{1,16}$/.test(expires)) return null;
	if (Number(expires) <= now) return null;
	const expected = await sign(secret, `apk:${projectId}:${outputId}:${expires}`);
	if (expected.length !== signature.length) return null;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	return diff === 0 ? outputId : null;
}

/** Keep a checked build's APK (large-file store) and record it on the build output. */
export async function saveAndroidApp(db: D1Database, projectId: string, outputId: string, bytes: Uint8Array): Promise<{ sha256: string; bytes: number }> {
	const problem = checkApk(bytes);
	if (problem) throw new Error(problem);
	const stored = await putLarge(db, bytes);
  const existing = await first(db, 'select "apkSha256" from "workflow_outputs" where "id" = ? and "projectId" = ?', outputId, projectId);
  if (!existing) throw new ScopeError(404, 'APK_OUTPUT_NOT_FOUND', 'No such Android build in this project.');
  if (existing['apkSha256'] && existing['apkSha256'] !== stored.sha256) throw new ScopeError(409, 'APK_IMMUTABLE', 'A checked Android package cannot be replaced. Build a new version.');
	await db.prepare('update "workflow_outputs" set "apkSha256" = ?, "apkBytes" = ? where "id" = ? and "projectId" = ?').bind(stored.sha256, stored.bytes, outputId, projectId).run();
	return { sha256: stored.sha256, bytes: stored.bytes };
}

async function first(db: D1Database, sql: string, ...args: unknown[]): Promise<Record<string, unknown> | null> {
	return ((await db.prepare(sql).bind(...args).all<Record<string, unknown>>()).results ?? [])[0] ?? null;
}

const livePublication = (db: D1Database, projectId: string) =>
	first(db, `select "slug","outputId" from "app_publications" where "projectId" = ? and "status" = 'live'`, projectId);

function fileName(projectName: unknown): string {
	const slug = String(projectName ?? '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40);
	return `${slug || 'app'}.apk`;
}

export interface AndroidAppEnv {
	DB: D1Database;
	BETTER_AUTH_SECRET?: string;
	APPS_DOMAIN?: string;
	/** Test seam; production uses global fetch. */
	fetchImpl?: typeof fetch;
}

const notFound = () => Response.json({ error: 'not_found', message: 'There is no Android app here.' }, { status: 404, headers: { 'cache-control': 'no-store' } });

export function createAndroidAppRouter() {
	const router = new Hono<{ Bindings: AndroidAppEnv }>();

	router.get('/a/:projectId/app.apk', async (c) => {
		const projectId = c.req.param('projectId');
		const token = c.req.query('t');
		const secret = c.env.BETTER_AUTH_SECRET ?? '';
		const version = c.req.query('v');
		const outputId = token
			? secret
				? await verifyApkDownloadToken(secret, projectId, token)
				: null
			: ((await livePublication(c.env.DB, projectId))?.['outputId'] as string | null | undefined) ?? null;
		if (!outputId || (!token && version && version !== outputId)) return notFound();
		const row = await first(
			c.env.DB,
			'select o."apkSha256", o."apkBytes", o."manifestSha256", p."name" from "workflow_outputs" o join "projects" p on p."id" = o."projectId" where o."id" = ? and o."projectId" = ?',
			outputId,
			projectId,
		);
    // A signed link names an immutable output. Its metadata must still agree
    // with that output's content-addressed manifest before any bytes leave.
    if (!row?.['manifestSha256']) return notFound();
    const manifestBytes = await createD1ContentStore(c.env.DB).get(String(row['manifestSha256']));
    if (!manifestBytes) return notFound();
    let manifest: { v?: number; android?: { sha256: string; bytes: number } };
    try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)); } catch { return notFound(); }
    if (manifest.v !== 1 || !manifest.android || manifest.android.sha256 !== row['apkSha256'] || manifest.android.bytes !== Number(row['apkBytes'])) return notFound();
		const apk = row?.['apkSha256'] ? await getLarge(c.env.DB, String(row['apkSha256'])) : null;
		if (!apk) return notFound();
		return new Response(apk.slice().buffer as ArrayBuffer, {
			headers: {
				'content-type': 'application/vnd.android.package-archive',
				'content-disposition': `attachment; filename="${fileName(row?.['name'])}"`,
				'content-length': String(apk.byteLength),
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, no-store',
			},
		});
	});

	router.all('/a/:projectId/api/*', async (c) => {
		const projectId = c.req.param('projectId');
		const publication = await livePublication(c.env.DB, projectId);
		const domain = appsDomainOf(c.env);
		if (!publication || !domain) {
			return Response.json({ error: 'app_not_published', message: "This app's server isn't on the web right now." }, { status: 503, headers: { 'cache-control': 'no-store' } });
		}
		const incoming = new URL(c.req.url);
		const target = `https://${String(publication['slug'])}.${domain}${incoming.pathname.slice(`/a/${projectId}`.length)}${incoming.search}`;
		const headers = new Headers(c.req.raw.headers);
		for (const name of ['cookie', 'host', 'x-forwarded-for', 'x-real-ip']) headers.delete(name);
		const method = c.req.method;
		const forwarded = await (c.env.fetchImpl ?? fetch)(
			new Request(target, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : await c.req.raw.arrayBuffer(), redirect: 'manual' }),
		);
		const out = new Headers(forwarded.headers);
		out.delete('set-cookie');
		out.set('x-content-type-options', 'nosniff');
		return new Response(forwarded.body, { status: forwarded.status, headers: out });
	});

	router.all('/a/*', () => notFound());
	return router;
}
