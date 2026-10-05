import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P05 skills loader — versioned, hash-verified. A skill mounts into an agent
 * catalog only if its SKILL.md sha256 matches the manifest; a tampered or
 * missing file is a hard error, never a silent downgrade. Content is read at
 * module load (bundled with the Worker); the manifest is the version ledger.
 */

export interface VersionedSkill {
	name: string;
	version: string;
	instructions: string;
	sha256: string;
}

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skills');

interface ManifestEntry {
	name: string;
	version: string;
	path: string;
	sha256: string;
}

const manifest = JSON.parse(readFileSync(join(SKILLS_DIR, 'manifest.json'), 'utf8')) as {
	version: string;
	skills: ManifestEntry[];
};

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

function loadSkill(entry: ManifestEntry): VersionedSkill {
	const content = readFileSync(join(SKILLS_DIR, entry.path), 'utf8');
	const actual = sha256(content);
	if (actual !== entry.sha256) {
		throw new Error(
			`skill ${entry.name}@${entry.version}: content hash mismatch (manifest ${entry.sha256}, actual ${actual}) — refusing to mount`,
		);
	}
	return {
		name: entry.name,
		version: entry.version,
		instructions: content,
		sha256: actual,
	};
}

const loaded = manifest.skills.map((entry) => loadSkill(entry));

export const SKILLS: readonly VersionedSkill[] = loaded;

export function skillByName(name: string): VersionedSkill {
	const skill = SKILLS.find((s) => s.name === name);
	if (!skill) throw new Error(`skill ${name} is not in the versioned manifest`);
	return skill;
}

export { manifest as SKILLS_MANIFEST };
