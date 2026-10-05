import { createHash } from 'node:crypto';
import manifestRaw from './skills/manifest.json?raw';
import planningRaw from './skills/planning/SKILL.md?raw';
import buildVerifyRaw from './skills/build-verify/SKILL.md?raw';
import deliveryChecklistRaw from './skills/delivery-checklist/SKILL.md?raw';

/**
 * P05 skills loader — versioned, hash-verified. Contents are bundled at build
 * time via Vite `?raw` imports (no filesystem access exists in workerd); the
 * manifest's sha256 is checked against the bundled content at module load, so
 * a tampered skill or manifest fails the worker loudly instead of mounting.
 */

export interface VersionedSkill {
	name: string;
	version: string;
	instructions: string;
	sha256: string;
}

interface ManifestEntry {
	name: string;
	version: string;
	path: string;
	sha256: string;
}

const manifest = JSON.parse(manifestRaw) as { version: string; skills: ManifestEntry[] };

function sha256(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

const CONTENT_BY_PATH: Record<string, string> = {
	'planning/SKILL.md': planningRaw,
	'build-verify/SKILL.md': buildVerifyRaw,
	'delivery-checklist/SKILL.md': deliveryChecklistRaw,
};

function loadSkill(entry: ManifestEntry): VersionedSkill {
	const content = CONTENT_BY_PATH[entry.path];
	if (content === undefined) {
		throw new Error(`skill ${entry.name}: bundled content missing for ${entry.path}`);
	}
	const actual = sha256(content);
	if (actual !== entry.sha256) {
		throw new Error(
			`skill ${entry.name}@${entry.version}: content hash mismatch (manifest ${entry.sha256}, actual ${actual}) — refusing to mount`,
		);
	}
	return { name: entry.name, version: entry.version, instructions: content, sha256: actual };
}

const loaded = manifest.skills.map((entry) => loadSkill(entry));

export const SKILLS: readonly VersionedSkill[] = loaded;

export function skillByName(name: string): VersionedSkill {
	const skill = SKILLS.find((s) => s.name === name);
	if (!skill) throw new Error(`skill ${name} is not in the versioned manifest`);
	return skill;
}

export { manifest as SKILLS_MANIFEST };
