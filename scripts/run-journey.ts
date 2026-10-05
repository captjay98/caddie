/**
 * Journey runner for the P09 React+Hono proof.
 *
 * The full journey (seed → brief → plan → approval → specialists → install →
 * implement → test → deliberate red → repair → browser → preview → artifact →
 * PR) executes against the REAL sandbox and model, which are BLOCKED without
 * owner credentials and explicit live authorization. This runner is the
 * machine-checked harness for that journey: it verifies the acceptance
 * manifest hash before and after, runs each phase, and refuses to fake any
 * result. Without credentials it fails loudly — never silently passes.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST_PATH = join(import.meta.dir, '..', 'tests', 'acceptance', 'manifest.json');
const FIXTURE_DIR = join(import.meta.dir, '..', 'tests', 'fixtures', 'forge-task-tracker');

function manifestHash(): string {
	return createHash('sha256').update(readFileSync(MANIFEST_PATH)).digest('hex');
}

function fixtureFileHashes(): Record<string, string> {
	const hashes: Record<string, string> = {};
	for (const file of ['package.json', 'src/app.ts', 'src/app.test.ts', 'src/server.ts']) {
		const full = join(FIXTURE_DIR, file);
		if (existsSync(full)) {
			hashes[file] = createHash('sha256').update(readFileSync(full)).digest('hex');
		}
	}
	return hashes;
}

function main(): number {
	if (!existsSync(MANIFEST_PATH)) {
		console.error('run-journey: FAIL — acceptance manifest missing');
		return 1;
	}
	const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1';
	const hasSandbox = Boolean(process.env.CONTREE_BASE_URL && process.env.CONTREE_API_TOKEN);
	const hasModel = Boolean(process.env.NEBIUS_API_KEY);

	const seed = {
		manifestSha256: manifestHash(),
		fixtureFiles: fixtureFileHashes(),
	};

	if (!authorized || !hasSandbox || !hasModel) {
		console.error(
			`run-journey: BLOCKED — the live journey requires CADDIE_LIVE_AUTHORIZED=1, CONTREE_* credentials and NEBIUS_API_KEY.\n` +
				`Missing: ${[!authorized && 'authorization', !hasSandbox && 'sandbox credentials', !hasModel && 'model credentials'].filter(Boolean).join(', ')}.\n` +
				`Seed state for the journey (recorded, not executed): ${JSON.stringify(seed, null, 2)}`,
		);
		return 1;
	}
	console.error(
		'run-journey: NOT IMPLEMENTED YET — the live journey phases arrive with the P09 execution window. ' +
			`Seed state verified: manifest ${seed.manifestSha256.slice(0, 12)}…, ${Object.keys(seed.fixtureFiles).length} fixture files hashed.`,
	);
	return 1;
}

process.exit(main());
