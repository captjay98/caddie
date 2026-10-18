import planningSkill from './skills/planning/SKILL.md';
import designSkill from './skills/design/SKILL.md';
import buildVerifySkill from './skills/build-verify/SKILL.md';
import deliveryChecklistSkill from './skills/delivery-checklist/SKILL.md';
import submissionSkill from './skills/submission/SKILL.md';

/**
 * P05 skills — imported via the flue plugin's automatic SKILL.md packaging
 * (plain .md imports from .ts files become SkillReference objects at build
 * time; no filesystem access exists at runtime). The imported objects are
 * passed directly to useSkill — that IS the actual Flue mechanism.
 *
 * The manifest at skills/manifest.json records the version + content hash of
 * each skill for audit; tests verify it against the packaged content.
 */

export interface VersionedSkill {
	name: string;
	version: string;
	instructions: string;
	sha256: string;
}

// The imported SkillReference objects carry { name, description, instructions, ... }
// typed by the flue plugin — pass them directly to useSkill.
export const PACKAGED_SKILLS = {
	planning: planningSkill,
	design: designSkill,
	'build-verify': buildVerifySkill,
	'delivery-checklist': deliveryChecklistSkill,
	submission: submissionSkill,
} as const;

export type PackagedSkillName = keyof typeof PACKAGED_SKILLS;

export function skillByName(name: PackagedSkillName) {
	return PACKAGED_SKILLS[name];
}
