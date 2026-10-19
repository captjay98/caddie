import { base64ToBytes } from './adapters/contree.ts';
import type { SandboxDriver } from './adapters/sandbox.ts';

/**
 * What `bun run build` left in the app's folder: the browser bundle, and for
 * apps with a server the server bundle and the database migrations. Shared by
 * verify_build (a checked build) and the copied-app preview (import-preview.ts),
 * so both publish exactly the same shape.
 */
export interface BuiltApp {
	js: string;
	css: string;
	/** dist/server.js, or null for an app without a server. */
	server: string | null;
	/** migrations/NNNN_*.sql, only read for an app with a server. */
	migrations: { name: string; sql: string }[];
}

type Reader = Pick<SandboxDriver, 'readFile' | 'pathExists' | 'listEntries'>;

export async function readBuiltApp(driver: Reader, sessionId: string, root: string): Promise<BuiltApp> {
	const readText = async (path: string) => new TextDecoder().decode(base64ToBytes((await driver.readFile(sessionId, path)).contentBase64));
	const js = await readText(`${root}/dist/main.js`);
	const css = (await driver.pathExists(sessionId, `${root}/dist/main.css`)) ? await readText(`${root}/dist/main.css`) : '';
	return { js, css, ...(await readBuiltServer(driver, sessionId, root)) };
}

/**
 * dist/server.js and migrations/NNNN_*.sql: the app's server as built. Web
 * apps and Android apps (Track 3, whose client is Flutter) share it.
 */
export async function readBuiltServer(driver: Reader, sessionId: string, root: string): Promise<Pick<BuiltApp, 'server' | 'migrations'>> {
	const readText = async (path: string) => new TextDecoder().decode(base64ToBytes((await driver.readFile(sessionId, path)).contentBase64));
	const server = (await driver.pathExists(sessionId, `${root}/dist/server.js`)) ? await readText(`${root}/dist/server.js`) : null;
	const migrations: { name: string; sql: string }[] = [];
	if (server !== null && (await driver.pathExists(sessionId, `${root}/migrations`))) {
		for (const entry of await driver.listEntries(sessionId, `${root}/migrations`)) {
			if (entry.isFile && /^\d{4}_[A-Za-z0-9_.-]+\.sql$/.test(entry.name)) {
				migrations.push({ name: entry.name, sql: await readText(`${root}/migrations/${entry.name}`) });
			}
		}
	}
	return { server, migrations };
}

/** The single-file document the preview frame loads (style and script inlined, closing tags escaped). */
export function previewDocument(app: Pick<BuiltApp, 'js' | 'css'>): string {
	return (
		'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your app</title><style>' +
		app.css.replace(/<\/style/gi, '<\\/style') +
		'</style></head><body><div id="root"></div><script type="module">' +
		app.js.replace(/<\/script/gi, '<\\/script') +
		'</script></body></html>'
	);
}
