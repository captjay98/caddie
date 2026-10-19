/**
 * Licence audit (S08) — what licence every PRODUCTION dependency of the shipped
 * surfaces carries, and whether any of them is outside the set this project
 * accepts. The competition's rules have an IP section and the compliance matrix
 * marks third-party licensing UNKNOWN, so this script turns that into a list
 * with a real answer per package, plus `docs/licenses.md` for the submission.
 *
 *   bun scripts/license-audit.ts
 *
 * What it proves:
 *   - For apps/app, every package under packages/*, the react-hono template (and
 *     the scaffold it generates) and every worker under workers/*, the declared
 *     PRODUCTION dependencies (`dependencies` only — `devDependencies` are build
 *     tooling that never ships) are all resolvable in node_modules and carry a
 *     licence that is one of: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC,
 *     0BSD.
 *   - Nothing is silently skipped: a dependency that cannot be resolved is
 *     reported UNRESOLVED, and an UNRESOLVED dependency is NOT clean (exit 1).
 *
 * Honesty / limits:
 *   - Direct declared dependencies only. The transitive tree (what those
 *     packages themselves depend on) is NOT walked; the declared set is what the
 *     submission's own manifests promise, and it is the set a rules reviewer
 *     reads first. A transitive audit would need the whole installed graph.
 *   - First-party workspace links (`workspace:*`, e.g. @caddie/contracts and
 *     @caddie/ui) are NOT third-party licences and are listed as skipped, not
 *     flagged.
 *   - An SPDX expression is treated as allowed only when EVERY named operand is
 *     in the set (e.g. `(MIT OR Apache-2.0)` is allowed; `(MIT OR GPL-3.0)` is
 *     flagged). That is deliberately stricter than an OR would require, so a
 *     surprising operand is never hidden behind a permissive one. A `WITH
 *     <exception>` clause keeps the base licence id.
 *   - Exit code 0 ONLY when nothing is flagged AND nothing is unresolved.
 *
 * Scope note: the packet's location list is apps/app, packages/*, the react-hono
 * template and workers/*. `apps/site` (the static landing page) is NOT a location
 * here even though it also declares production dependencies.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { SCAFFOLD_PACKAGE } from '../stacks/react-hono/scaffold.ts';

const REPO = join(import.meta.dir, '..');
const DOCS_PATH = join(REPO, 'docs', 'licenses.md');

/** The licences this project accepts in what it ships. */
const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD']);

interface PackageManifest {
	name?: unknown;
	version?: unknown;
	license?: unknown;
	licenses?: unknown;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface Location {
	/** Label shown in output and docs. */
	label: string;
	/** Directory dependency resolution starts from (the location's own tree first). */
	dir: string;
	/** The location's declared production dependencies (name -> range). */
	dependencies: Record<string, string>;
	/** Where the declaration comes from (file paths, for the docs). */
	source: string;
	/** A note for locations that declare no production dependency at all. */
	note?: string;
}

interface Finding {
	name: string;
	range: string;
	version: string | null;
	expression: string | null;
	/** Where the licence value came from: the field, the legacy array, or the licence file text. */
	licenceSource: 'license field' | 'license object' | 'licenses array' | 'LICENSE file' | 'none';
	/** The node_modules root the package was resolved from. */
	resolvedFrom: string | null;
	/** True when a fallback root (not the location's own node_modules) was used. */
	fallback: boolean;
	allowed: boolean;
	detail: string;
}

const relativeToRepo = (path: string): string => relative(REPO, path) || '.';

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Every node_modules root a package might live in, nearest-first for a location. */
function packageRootsFor(locationDir: string): { ancestors: string[]; fallbacks: string[] } {
	const ancestors: string[] = [];
	let current = locationDir;
	while (current.startsWith(REPO)) {
		ancestors.push(join(current, 'node_modules'));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const fallbacks = new Set<string>();
	const add = (dir: string) => {
		const nm = join(dir, 'node_modules');
		if (existsSync(nm)) fallbacks.add(nm);
	};
	add(REPO);
	for (const base of ['apps', 'packages', 'workers', 'stacks']) {
		const baseDir = join(REPO, base);
		if (!existsSync(baseDir)) continue;
		for (const entry of readdirSync(baseDir)) {
			const dir = join(baseDir, entry);
			if (!statSync(dir).isDirectory()) continue;
			add(dir);
			// stacks/<stack>/template and similar one-level nests.
			for (const child of readdirSync(dir)) {
				const nested = join(dir, child);
				if (statSync(nested).isDirectory()) add(nested);
			}
		}
	}
	return { ancestors, fallbacks: [...fallbacks] };
}

/** The react-hono template: the checked-in template manifest AND the scaffold it generates. */
function reactHonoLocation(): Location {
	const templateManifestPath = join(REPO, 'stacks', 'react-hono', 'template', 'package.json');
	const declarations: Array<{ source: string; dir: string; dependencies: Record<string, string> }> = [];
	if (existsSync(templateManifestPath)) {
		const manifest = readJson<PackageManifest>(templateManifestPath);
		declarations.push({
			source: relativeToRepo(templateManifestPath),
			dir: dirname(templateManifestPath),
			dependencies: manifest.dependencies ?? {},
		});
	}
	// The scaffold Caddie actually generates (stacks/react-hono/scaffold.ts,
	// SCAFFOLD_PACKAGE) is what a generated app ships, so its production
	// dependencies belong to this location even though the template manifest
	// above declares only a subset.
	declarations.push({
		source: 'stacks/react-hono/scaffold.ts (SCAFFOLD_PACKAGE)',
		dir: join(REPO, 'stacks', 'react-hono'),
		dependencies: { ...SCAFFOLD_PACKAGE.dependencies },
	});

	const dependencies: Record<string, string> = {};
	for (const declaration of declarations) for (const [name, range] of Object.entries(declaration.dependencies)) dependencies[name] = range;
	return {
		label: 'react-hono template (and the scaffold it generates)',
		dir: join(REPO, 'stacks', 'react-hono'),
		dependencies,
		source: declarations.map((d) => d.source).join(' + '),
	};
}

function collectLocations(): Location[] {
	const locations: Location[] = [];

	const appManifestPath = join(REPO, 'apps', 'app', 'package.json');
	const appManifest = readJson<PackageManifest>(appManifestPath);
	locations.push({
		label: 'apps/app',
		dir: dirname(appManifestPath),
		dependencies: appManifest.dependencies ?? {},
		source: relativeToRepo(appManifestPath),
	});

	const packagesDir = join(REPO, 'packages');
	if (existsSync(packagesDir)) {
		for (const entry of readdirSync(packagesDir).sort()) {
			const manifestPath = join(packagesDir, entry, 'package.json');
			if (!existsSync(manifestPath)) continue;
			const manifest = readJson<PackageManifest>(manifestPath);
			locations.push({
				label: `packages/${entry}`,
				dir: dirname(manifestPath),
				dependencies: manifest.dependencies ?? {},
				source: relativeToRepo(manifestPath),
			});
		}
	}

	locations.push(reactHonoLocation());

	const workersDir = join(REPO, 'workers');
	if (existsSync(workersDir)) {
		for (const entry of readdirSync(workersDir).sort()) {
			const workerDir = join(workersDir, entry);
			if (!statSync(workerDir).isDirectory()) continue;
			const manifestPath = join(workerDir, 'package.json');
			if (existsSync(manifestPath)) {
				const manifest = readJson<PackageManifest>(manifestPath);
				locations.push({
					label: `workers/${entry}`,
					dir: workerDir,
					dependencies: manifest.dependencies ?? {},
					source: relativeToRepo(manifestPath),
				});
			} else {
				// No manifest: the worker imports the workspace packages by
				// relative path, so it declares no third-party dependency of its
				// own. Reported rather than dropped, so "workers/*" is visibly
				// covered.
				locations.push({
					label: `workers/${entry}`,
					dir: workerDir,
					dependencies: {},
					source: 'no package.json — declares no dependencies',
					note: 'no package.json; imports workspace packages by relative path, so it declares no third-party production dependency',
				});
			}
		}
	}

	return locations;
}

/** The licence files a package might ship, in the order npm uses. */
const LICENCE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'COPYING', 'COPYING.md'];

/** A best-effort licence id from a licence file's text, or null when it can't be told. */
function licenceFromText(text: string): string | null {
	const upper = text.toUpperCase();
	const markers: Array<[RegExp, string]> = [
		[/SIL OPEN FONT LICENSE|OFL-1\.1/, 'OFL-1.1'],
		[/APACHE LICENSE[\s\S]{0,40}VERSION 2\.0|APACHE-2\.0/, 'Apache-2.0'],
		[/MIT LICENSE|THE MIT LICENSE|PERMISSION IS HEREBY GRANTED, FREE OF CHARGE/, 'MIT'],
		[/0BSD/, '0BSD'],
		[/BSD 3-CLAUSE|BSD-3-CLAUSE|NEITHER THE NAME OF/, 'BSD-3-Clause'],
		[/BSD 2-CLAUSE|BSD-2-CLAUSE|REDISTRIBUTIONS OF SOURCE CODE/, 'BSD-2-Clause'],
		[/ISC LICENSE|PERMISSION TO USE, COPY, MODIFY, AND\/OR DISTRIBUTE/, 'ISC'],
		[/MOZILLA PUBLIC LICENSE/, 'MPL-2.0'],
		[/GNU (LESSER )?GENERAL PUBLIC LICENSE|GPL-/, 'GPL'],
		[/THE UNLICENSE|UNLICENSE/, 'Unlicense'],
		[/CC0 1\.0|CREATIVE COMMONS ZERO/, 'CC0-1.0'],
		[/PYTHON SOFTWARE FOUNDATION LICENSE/, 'Python-2.0'],
	];
	for (const [pattern, id] of markers) if (pattern.test(upper)) return id;
	return null;
}

interface LicenceValue {
	expression: string | null;
	source: Finding['licenceSource'];
}

function readLicence(packageDir: string, manifest: PackageManifest): LicenceValue {
	if (typeof manifest.license === 'string' && manifest.license.trim() !== '') {
		return { expression: manifest.license.trim(), source: 'license field' };
	}
	if (manifest.license && typeof manifest.license === 'object') {
		const type = (manifest.license as { type?: unknown }).type;
		if (typeof type === 'string' && type.trim() !== '') return { expression: type.trim(), source: 'license object' };
	}
	if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
		const types = manifest.licenses
			.map((entry) => (typeof entry === 'string' ? entry : typeof (entry as { type?: unknown })?.type === 'string' ? String((entry as { type?: unknown }).type) : ''))
			.filter((value) => value !== '');
		if (types.length > 0) return { expression: types.join(' OR '), source: 'licenses array' };
	}
	for (const file of LICENCE_FILES) {
		const path = join(packageDir, file);
		if (!existsSync(path) || !statSync(path).isFile()) continue;
		const text = readFileSync(path, 'utf8').slice(0, 8000);
		const guessed = licenceFromText(text);
		if (guessed) return { expression: guessed, source: 'LICENSE file' };
		// The file exists but could not be recognised — keep the raw shape so the
		// output says a fallback was used and what it saw.
		return { expression: `UNRECOGNISED (${file})`, source: 'LICENSE file' };
	}
	return { expression: null, source: 'none' };
}

/**
 * Whether an SPDX expression is entirely within the allowed set. Every `OR`/`AND`
 * operand must be allowed (see the header note), `WITH <exception>` is stripped,
 * and parentheses are ignored for the operand split.
 */
function evaluate(expression: string): { allowed: boolean; operands: string[] } {
	const cleaned = expression.replace(/[()]/g, ' ');
	const parts = cleaned
		.split(/\s+(?:OR|AND)\s+/i)
		.map((part) => part.split(/\s+WITH\s+/i)[0]!.trim())
		.filter((part) => part !== '');
	if (parts.length === 0) return { allowed: false, operands: [] };
	return { allowed: parts.every((part) => ALLOWED.has(part)), operands: parts };
}

/** Format the licence cell so a fallback or an expression is visible in the docs. */
function licenceCell(finding: Finding): string {
	const expression = finding.expression ?? 'UNKNOWN (no licence found)';
	const notes: string[] = [];
	if (finding.licenceSource === 'LICENSE file') notes.push(`from LICENSE file${finding.expression?.startsWith('UNRECOGNISED') ? ' (unrecognised)' : ''}`);
	if (finding.licenceSource === 'licenses array') notes.push('from legacy `licenses` array');
	if (finding.expression !== null && /[()]|\s(?:OR|AND|WITH)\s/i.test(finding.expression)) notes.push('SPDX expression');
	if (finding.fallback && finding.resolvedFrom) notes.push(`resolved via ${finding.resolvedFrom}`);
	return notes.length > 0 ? `${expression} (${notes.join('; ')})` : expression;
}

const locations = collectLocations();
const workspaceLinks: Array<{ location: string; name: string; range: string }> = [];
const findingsByLocation: Array<{ location: Location; findings: Finding[] }> = [];

for (const location of locations) {
	const { ancestors, fallbacks } = packageRootsFor(location.dir);
	const searchRoots = [...ancestors, ...fallbacks];
	const findings: Finding[] = [];

	for (const name of Object.keys(location.dependencies).sort()) {
		const range = location.dependencies[name]!;
		if (range.startsWith('workspace:')) {
			workspaceLinks.push({ location: location.label, name, range });
			continue;
		}
		let resolved: string | null = null;
		let fallback = false;
		for (const [index, root] of searchRoots.entries()) {
			const candidate = join(root, name, 'package.json');
			if (existsSync(candidate)) {
				resolved = candidate;
				fallback = index >= ancestors.length;
				break;
			}
		}
		if (resolved === null) {
			findings.push({
				name,
				range,
				version: null,
				expression: null,
				licenceSource: 'none',
				resolvedFrom: null,
				fallback: false,
				allowed: false,
				detail: 'UNRESOLVED — no node_modules/<name>/package.json found from this location or any repo node_modules root',
			});
			continue;
		}
		const packageDir = dirname(resolved);
		const manifest = readJson<PackageManifest>(resolved);
		const licence = readLicence(packageDir, manifest);
		const version = typeof manifest.version === 'string' ? manifest.version : null;
		if (licence.expression === null) {
			findings.push({
				name,
				range,
				version,
				expression: null,
				licenceSource: 'none',
				resolvedFrom: relativeToRepo(dirname(dirname(packageDir))),
				fallback,
				allowed: false,
				detail: `no \`license\` field, no \`licenses\` array and no recognisable licence file in ${relativeToRepo(packageDir)}`,
			});
			continue;
		}
		const { allowed, operands } = evaluate(licence.expression);
		const expressionIsSpdx = /[()]|\s(?:OR|AND|WITH)\s/i.test(licence.expression);
		const detail = allowed
			? expressionIsSpdx
				? `SPDX expression — every operand in the allowed set (${operands.join(', ')})`
				: 'allowed'
			: expressionIsSpdx
				? `operand(s) outside the allowed set: ${operands.filter((operand) => !ALLOWED.has(operand)).join(', ')}`
				: 'not in the allowed set';
		findings.push({
			name,
			range,
			version,
			expression: licence.expression,
			licenceSource: licence.source,
			resolvedFrom: relativeToRepo(dirname(dirname(packageDir))),
			fallback,
			allowed,
			detail,
		});
	}

	findingsByLocation.push({ location, findings });
}

const allFindings = findingsByLocation.flatMap((group) => group.findings);
const flagged = allFindings.filter((finding) => finding.expression !== null && !finding.allowed);
const unresolved = allFindings.filter((finding) => finding.expression === null);
const allowedCount = allFindings.length - flagged.length - unresolved.length;

// --- stdout ------------------------------------------------------------------
for (const { location, findings } of findingsByLocation) {
	console.log(`${location.label} — ${location.source}`);
	if (location.note) console.log(`  ${location.note}`);
	if (findings.length === 0) {
		if (!location.note) console.log('  (no production dependencies)');
		continue;
	}
	for (const finding of findings) {
		const marker = finding.expression === null ? 'UNRESOLVED' : finding.allowed ? 'ok' : 'FLAGGED';
		console.log(`  [${marker}] ${finding.name}@${finding.version ?? '?'} — ${finding.expression ?? 'no licence found'} (${finding.detail})`);
	}
}

if (workspaceLinks.length > 0) {
	console.log('\nFirst-party workspace links skipped (not third-party licences):');
	for (const link of workspaceLinks) console.log(`  ${link.location}: ${link.name} (${link.range})`);
}

if (flagged.length > 0) {
	console.log('\nFLAGGED — outside the allowed set (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD):');
	for (const finding of flagged) console.log(`  ${finding.name}@${finding.version ?? '?'} — ${finding.expression} (${finding.detail})`);
} else {
	console.log('\nFLAGGED: nothing — every resolved production dependency is in the allowed set.');
}

if (unresolved.length > 0) {
	console.log('\nUNRESOLVED — no licence could be read (NOT clean):');
	for (const finding of unresolved) console.log(`  ${finding.name} — ${finding.detail}`);
}

// --- docs/licenses.md --------------------------------------------------------
const generatedAt = new Date().toISOString();
const lines: string[] = [];
lines.push('# Third-party licences');
lines.push('');
lines.push('A licence audit of Caddie\'s shipped **production** dependencies: their declared');
lines.push('licence, and whether it falls outside the set this project accepts.');
lines.push('');
lines.push(`- Generated: ${generatedAt}`);
lines.push('- Regenerate with: `bun scripts/license-audit.ts`');
lines.push('- Never edit this file by hand; the script rewrites it.');
lines.push('');
lines.push('## Method');
lines.push('');
lines.push('- Locations: `apps/app`, every package under `packages/*`, the react-hono');
lines.push('  template (`stacks/react-hono/template/package.json` and the scaffold it');
lines.push(`  generates, \`stacks/react-hono/scaffold.ts\`) and every worker under \`workers/*\`.`);
lines.push('- Dependencies: the declared production `dependencies` of each location.');
lines.push('  `devDependencies` are build tooling that does not ship, so they are not');
lines.push('  audited. First-party `workspace:*` links are listed but not treated as');
lines.push('  third-party licences.');
lines.push('- Licence value: `license` in the package\'s `node_modules/<name>/package.json`;');
lines.push('  falling back to a legacy `licenses` array, then to the text of the package\'s');
lines.push('  `LICENSE` file. Where a fallback was used, the table says so.');
lines.push('- Allowed set: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD.');
lines.push('- SPDX expressions are allowed only when every named operand is in the set');
lines.push('  (e.g. `(MIT OR Apache-2.0)` is allowed; a `WITH <exception>` clause keeps the');
lines.push('  base licence id). This is stricter than an OR requires, deliberately.');
lines.push('- Direct declared dependencies only; the transitive tree is not walked.');
lines.push('- Exit code 0 only when nothing is flagged and nothing is unresolved.');
lines.push('');
lines.push('## Summary');
lines.push('');
lines.push(`${allFindings.length} production dependencies audited across ${findingsByLocation.length} locations: ${allowedCount} allowed, ${flagged.length} flagged, ${unresolved.length} unresolved.`);
lines.push('');
for (const { location, findings } of findingsByLocation) {
	lines.push(`### ${location.label}`);
	lines.push('');
	lines.push(`Declared in: \`${location.source}\`.`);
	if (location.note) lines.push(`\n${location.note}.`);
	lines.push('');
	if (findings.length === 0) {
		lines.push('No production dependencies.');
		lines.push('');
		continue;
	}
	lines.push('| Package | Version | Licence | Range |');
	lines.push('| --- | --- | --- | --- |');
	for (const finding of findings) {
		const licence = finding.expression === null ? '**UNRESOLVED — no licence found**' : licenceCell(finding);
		lines.push(`| \`${finding.name}\` | ${finding.version ?? '—'} | ${licence} | \`${finding.range}\` |`);
	}
	lines.push('');
}
if (workspaceLinks.length > 0) {
	lines.push('### First-party workspace links (skipped)');
	lines.push('');
	lines.push('| Location | Package | Range |');
	lines.push('| --- | --- | --- |');
	for (const link of workspaceLinks) lines.push(`| ${link.location} | \`${link.name}\` | \`${link.range}\` |`);
	lines.push('');
}
lines.push('## Flagged');
lines.push('');
if (flagged.length === 0) {
	lines.push('Nothing was flagged: every resolved production dependency is licensed under one of MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC or 0BSD.');
} else {
	lines.push('These are outside the allowed set and need a decision (replace, or record why they are acceptable):');
	lines.push('');
	lines.push('| Package | Version | Licence | Why it is flagged |');
	lines.push('| --- | --- | --- | --- |');
	for (const finding of flagged) lines.push(`| \`${finding.name}\` | ${finding.version ?? '—'} | ${finding.expression} | ${finding.detail} |`);
}
lines.push('');
lines.push('## Unresolved');
lines.push('');
if (unresolved.length === 0) {
	lines.push('Nothing: every declared production dependency was found in `node_modules` with a readable licence.');
} else {
	lines.push('A dependency whose licence could not be read is NOT clean (no licence means an unknown licence):');
	lines.push('');
	for (const finding of unresolved) lines.push(`- \`${finding.name}\` — ${finding.detail}`);
}
lines.push('');

writeFileSync(DOCS_PATH, `${lines.join('\n')}`);

const clean = flagged.length === 0 && unresolved.length === 0;
console.log(
	`\nlicense-audit: ${allFindings.length} production dependencies across ${findingsByLocation.length} locations — ${allowedCount} allowed, ${flagged.length} flagged, ${unresolved.length} unresolved, ${workspaceLinks.length} first-party link(s) skipped; wrote ${relativeToRepo(DOCS_PATH)}`,
);
console.log(clean ? 'license-audit: CLEAN' : 'license-audit: NOT CLEAN');
process.exit(clean ? 0 : 1);
