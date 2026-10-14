/**
 * Profile enrichment from GitHub signals (Caddie learns you — Stage 3 / CL3).
 *
 * PURE inference: given the file manifest of an imported repository (the tree
 * walk `importRepoSnapshot` already produces) plus optionally the content of a
 * few key files (package.json, pyproject.toml, pubspec.yaml, composer.json),
 * derive PROPOSED profile preferences and memory notes about how the user
 * builds. It writes NOTHING — it returns proposals the coordinator surfaces for
 * the user to confirm (routed through CL1's update_profile / remember, which
 * enforce the confirmation rule). No network, no DB: fully unit-testable.
 *
 * Guardrails:
 *   - Everything is a PROPOSAL. Caddie says "looks like X — want me to remember
 *     that?"; nothing enters context until the user confirms (CL1 memory rule).
 *   - Signals are inferred from file structure/manifests, never from private
 *     file CONTENT beyond the few declared manifest files, and never anything
 *     resembling a secret or an authorization.
 *   - Confidence is reported so the coordinator can phrase low-confidence
 *     signals tentatively.
 */

import { STACK_IDS } from '@caddie/contracts';

/** One file in the imported manifest (subset of ImportView.manifest). */
export interface EnrichmentFile {
	path: string;
	size: number;
}

/** Optional contents of key dependency-declaring files, keyed by basename. */
export interface EnrichmentManifests {
	/** Parsed package.json dependencies+devDependencies (names only). */
	packageJsonDeps?: readonly string[];
	/** Raw text of pyproject.toml / requirements.txt (python signal). */
	pythonManifest?: string;
	/** Raw text of pubspec.yaml (flutter/dart signal). */
	pubspec?: string;
	/** Raw text of composer.json (php/laravel signal). */
	composer?: string;
}

export interface ProposedSkill {
	skill: string;
	confidence: 'high' | 'medium' | 'low';
	reason: string;
}

export interface ProposedStack {
	stackId: (typeof STACK_IDS)[number];
	confidence: 'high' | 'medium' | 'low';
	reason: string;
}

export interface ProposedNote {
	content: string;
	kind: 'preference' | 'fact';
	reason: string;
}

export interface EnrichmentProposal {
	skills: ProposedSkill[];
	stacks: ProposedStack[];
	notes: ProposedNote[];
	/** True when nothing could be inferred — the coordinator then asks instead. */
	empty: boolean;
}

const CODE_EXT: Record<string, string> = {
	ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
	py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java',
	kt: 'Kotlin', swift: 'Swift', dart: 'Dart', php: 'PHP', cs: 'C#',
	cpp: 'C++', c: 'C', ex: 'Elixir', scala: 'Scala',
};

function extOf(path: string): string {
	const base = path.split('/').pop() ?? '';
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** A path that looks like a test file (any ecosystem). */
function isTestPath(path: string): boolean {
	const p = path.toLowerCase();
	return /(^|\/)tests?\//.test(p)
		|| /\.(test|spec)\.[a-z]+$/.test(p)
		|| /_test\.[a-z]+$/.test(p)
		|| /(^|\/)__tests__\//.test(p);
}

/**
 * Derive proposed enrichments from a repository's manifest. Pure; nothing is
 * written. The caller surfaces these for confirmation.
 */
export function deriveEnrichment(
	files: readonly EnrichmentFile[],
	manifests: EnrichmentManifests = {},
): EnrichmentProposal {
	const skills: ProposedSkill[] = [];
	const stacks: ProposedStack[] = [];
	const notes: ProposedNote[] = [];

	// --- language skills from file extensions (weighted by file count) ---
	const langCounts = new Map<string, number>();
	let testFiles = 0;
	let codeFiles = 0;
	for (const file of files) {
		const lang = CODE_EXT[extOf(file.path)];
		if (lang) {
			langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
			codeFiles += 1;
		}
		if (isTestPath(file.path)) testFiles += 1;
	}
	const rankedLangs = [...langCounts.entries()].sort((a, b) => b[1] - a[1]);
	for (const [lang, count] of rankedLangs.slice(0, 3)) {
		// A language used across many files is a confident skill; one or two files
		// is a low-confidence hint.
		const confidence = count >= 5 ? 'high' : count >= 2 ? 'medium' : 'low';
		skills.push({ skill: lang, confidence, reason: `${count} ${lang} file${count === 1 ? '' : 's'} in the repository` });
	}

	// --- stack preference from dependency manifests ---
	const deps = new Set((manifests.packageJsonDeps ?? []).map((d) => d.toLowerCase()));
	const hasReact = deps.has('react') || deps.has('react-dom');
	const hasHono = deps.has('hono');
	const hasTanstackStart = [...deps].some((d) => d.startsWith('@tanstack/'));
	if (hasReact && hasHono) {
		stacks.push({ stackId: 'react-hono', confidence: 'high', reason: 'package.json declares both react and hono' });
	} else if (hasReact && hasTanstackStart) {
		stacks.push({ stackId: 'tanstack-start', confidence: 'medium', reason: 'package.json declares react with a @tanstack package' });
	}
	if (manifests.pubspec && /\bflutter\b/i.test(manifests.pubspec)) {
		stacks.push({ stackId: 'flutter', confidence: 'high', reason: 'pubspec.yaml declares flutter' });
	}
	if (manifests.composer && /\blaravel\/framework\b/i.test(manifests.composer)) {
		stacks.push({ stackId: 'laravel-inertia', confidence: 'medium', reason: 'composer.json declares laravel/framework' });
	}
	if (manifests.pythonManifest && /\bfastapi\b/i.test(manifests.pythonManifest) && hasReact) {
		stacks.push({ stackId: 'fastapi-react', confidence: 'medium', reason: 'a FastAPI python manifest alongside a react frontend' });
	}

	// --- working-style note from test presence ---
	if (codeFiles >= 3) {
		if (testFiles >= 2) {
			notes.push({ content: 'Writes automated tests — their repositories include test files.', kind: 'fact', reason: `${testFiles} test file(s) present` });
		} else if (testFiles === 0) {
			notes.push({ content: 'Repositories reviewed had no test files; may value help adding tests.', kind: 'preference', reason: 'no test files found in the sampled repository' });
		}
	}

	const empty = skills.length === 0 && stacks.length === 0 && notes.length === 0;
	return { skills, stacks, notes, empty };
}

/**
 * Flatten a proposal into a short, human-facing summary the coordinator can
 * read back before proposing ("I looked at your repos — looks like …"). Pure
 * string building; no side effects.
 */
export function describeEnrichment(proposal: EnrichmentProposal): string {
	if (proposal.empty) return 'I could not infer much from the repository yet.';
	const parts: string[] = [];
	if (proposal.skills.length) parts.push(`languages: ${proposal.skills.map((s) => s.skill).join(', ')}`);
	if (proposal.stacks.length) parts.push(`stack: ${proposal.stacks.map((s) => s.stackId).join(', ')}`);
	if (proposal.notes.length) parts.push(proposal.notes.map((n) => n.content).join(' '));
	return `From the repository I noticed — ${parts.join('; ')}. Want me to remember any of this?`;
}
