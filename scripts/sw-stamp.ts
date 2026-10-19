import { createHash } from 'node:crypto';

/**
 * The service worker's build id (apps/app/public/sw.js).
 *
 * The worker names its caches after the build, so each deploy installs a new
 * worker that keeps the new shell and drops the old build's files. Vite copies
 * public/sw.js as-is; scripts/compose-assets.ts then replaces the placeholder
 * with buildStamp(<the composed app/index.html>). The shell names the hashed
 * JS and CSS files, and the CSS names the hashed fonts, so any change to the
 * built files changes the shell's bytes and therefore the stamp.
 */

export const BUILD_PLACEHOLDER = '__CADDIE_BUILD__';

/** First 12 hex digits of the shell's sha256. */
export function buildStamp(shell: Uint8Array): string {
	return createHash('sha256').update(shell).digest('hex').slice(0, 12);
}

/** Replace the one placeholder in the worker source; anything else is a build error. */
export function stampServiceWorker(source: string, stamp: string): string {
	const count = source.split(BUILD_PLACEHOLDER).length - 1;
	if (count !== 1) {
		throw new Error(`sw.js must contain the build placeholder exactly once (found ${count})`);
	}
	if (!/^[0-9a-z]+$/i.test(stamp)) throw new Error('the build stamp must be alphanumeric');
	return source.replace(BUILD_PLACEHOLDER, stamp);
}
