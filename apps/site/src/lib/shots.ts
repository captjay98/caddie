import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Real product screenshots live in `public/shots/` as
 * `<name>-<device>-<theme>.webp` (captured from the real app with demo data).
 * The check runs at build time — the page itself stays static, no-JS.
 * `astro build` / `astro dev` run with the site package as the working directory.
 */
export type ShotDevice = 'desktop' | 'phone';
export type ShotTheme = 'light' | 'dark';

export function shotPath(name: string, device: ShotDevice, theme: ShotTheme): string {
	return `shots/${name}-${device}-${theme}.webp`;
}

export function shotExists(name: string, device: ShotDevice, theme: ShotTheme): boolean {
	return existsSync(join(process.cwd(), 'public', shotPath(name, device, theme)));
}

/** True when at least one theme of this shot has been captured. */
export function hasShot(name: string, device: ShotDevice): boolean {
	return shotExists(name, device, 'dark') || shotExists(name, device, 'light');
}
