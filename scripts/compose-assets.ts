#!/usr/bin/env bun
/**
 * Compose the two static build outputs into one Workers assets tree:
 *
 *   apps/site/dist          (Astro landing)        -> apps/app/dist/client/*
 *   apps/app/dist/client    (Vite/React SPA build) -> SPA relocated under app/
 *
 * The SPA's hashed assets stay at the tree root (/assets/*) because the Vite
 * build emits absolute references; only its HTML entry points move to app/
 * so the landing document at / and the SPA shell at /app/ cannot shadow each
 * other. Any path collision between the two sources fails the composition
 * loudly — outputs are never silently overwritten.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPA_DIR = join(REPO_ROOT, 'apps/app/dist/client');
const SITE_DIR = join(REPO_ROOT, 'apps/site/dist');
const SPA_DIR_NAME = 'caddie_app';
const WORKER_DIR = join(REPO_ROOT, `apps/app/dist/${SPA_DIR_NAME}`);
const MANIFEST_PATH = join(REPO_ROOT, 'apps/app/dist/composition-manifest.json');

function fail(message: string): never {
	console.error(`compose-assets: FAIL — ${message}`);
	process.exit(1);
}

function listFiles(dir: string, prefix = ''): string[] {
	const entries: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const rel = prefix ? `${prefix}/${name}` : name;
		if (statSync(full).isDirectory()) entries.push(...listFiles(full, rel));
		else entries.push(rel);
	}
	return entries;
}

if (!existsSync(SPA_DIR)) {
	fail(`SPA build output missing at ${SPA_DIR} — run \`bun --cwd=apps/app run build\` first`);
}
if (!existsSync(SITE_DIR)) {
	fail(`Astro build output missing at ${SITE_DIR} — run \`bun --cwd=apps/site run build\` first`);
}
if (!existsSync(join(WORKER_DIR, 'index.js'))) {
	fail(`Worker bundle missing at ${WORKER_DIR} — run \`bun --cwd=apps/app run build\` first`);
}
if (existsSync(join(SPA_DIR, 'app'))) {
	fail(`pre-existing app/ subtree in ${SPA_DIR} — compose requires pristine Vite output; run \`bun run build\` (which wipes dist first)`);
}

// --- 1. classify SPA output ------------------------------------------------
const spaEntries = listFiles(SPA_DIR).filter((p) => p !== '.assetsignore');
const htmlEntries = spaEntries.filter((p) => p.endsWith('.html'));
// Vite emits the client HTML entry at the outDir root; everything else that
// is not HTML stays put (assets/*, favicon, etc.).
const relocated = htmlEntries.map((p) => `app/${p}`);
const unchanged = spaEntries.filter((p) => !p.endsWith('.html'));

// --- 2. classify landing output --------------------------------------------
const landingEntries = listFiles(SITE_DIR);

// --- 3. collision detection BEFORE any write -------------------------------
const landingSet = new Set(landingEntries);
const unchangedSet = new Set(unchanged);
const collisions = [
	...relocated.filter((p) => landingSet.has(p)),
	...landingEntries.filter((p) => unchangedSet.has(p)),
];
if (collisions.length > 0) {
	fail(`asset collisions between Astro landing and SPA output — refusing to overwrite:\n${collisions.map((c) => `  ${c}`).join('\n')}`);
}
const spaIndexRelocated = relocated.includes('app/index.html');
if (!spaIndexRelocated) {
	fail('SPA index.html not found in Vite output — cannot compose /app shell');
}
if (!landingEntries.includes('index.html')) {
	fail('Astro landing index.html not found in site output');
}

// --- 4. relocate SPA HTML, then merge landing tree --------------------------
for (const p of htmlEntries) {
	const dest = join(SPA_DIR, 'app', p);
	mkdirSync(join(dest, '..'), { recursive: true });
	renameSync(join(SPA_DIR, p), dest);
}
cpSync(SITE_DIR, SPA_DIR, { recursive: true });

// --- 5. manifest -------------------------------------------------------------
// collisions is the real computed intersection: always empty here because a
// non-empty intersection hard-failed above, before any write.
const manifest = {
	composedAt: new Date().toISOString(),
	spa: { relocated, unchanged, scanned: spaEntries.length },
	landing: { files: landingEntries, scanned: landingEntries.length },
	collisions,
};
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

// --- 6. deployable Worker config ----------------------------------------------
// @cloudflare/vite-plugin 1.39.2 (bundling wrangler 4.97) writes
// `"legacy_env": true` into the generated config. The repo's wrangler 4.113
// refuses that file ("The legacy_env field is no longer supported ... removing
// the field will not change how your Worker is deployed"), so every
// `wrangler deploy`/`secret`/`rollback` run from apps/app would fail. Drop it.
const WORKER_CONFIG = join(WORKER_DIR, 'wrangler.json');
let legacyEnvRemoved = false;
if (existsSync(WORKER_CONFIG)) {
	const workerConfig = JSON.parse(readFileSync(WORKER_CONFIG, 'utf8')) as Record<string, unknown>;
	if ('legacy_env' in workerConfig) {
		delete workerConfig.legacy_env;
		writeFileSync(WORKER_CONFIG, `${JSON.stringify(workerConfig)}\n`);
		legacyEnvRemoved = true;
	}
}

console.log(
	`compose-assets: composed ${relocated.length} relocated SPA + ${unchanged.length} SPA asset + ${landingEntries.length} landing files; collisions: 0; manifest: ${relative(REPO_ROOT, MANIFEST_PATH)}${legacyEnvRemoved ? '; legacy_env removed from the Worker config' : ''}`,
);
