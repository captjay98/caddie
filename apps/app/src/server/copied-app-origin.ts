/**
 * Where a copied app's code came from, as `import_previews.repoFullName`
 * records it (S07b, no new migration).
 *
 * A judge's finished example (judge-example.ts) is an ordinary, already-ready
 * import preview whose `repoFullName` carries this prefix. No GitHub name can:
 * owners are letters, digits and hyphens, and normalizeRepoFullName requires
 * owner/repo. A leaf module, so judge-limits.ts can read the marker without
 * importing the import-preview service and its sandbox dependencies.
 */
export const EXAMPLE_PREFIX = 'example:';

/** The value stored for an example named `name`. */
export function exampleRepoName(name: string): string {
	return `${EXAMPLE_PREFIX}${name}`;
}

/** Split a stored value into its origin and the name to show. */
export function copiedAppOrigin(stored: string): { origin: 'github' | 'example'; name: string } {
	return stored.startsWith(EXAMPLE_PREFIX)
		? { origin: 'example', name: stored.slice(EXAMPLE_PREFIX.length) }
		: { origin: 'github', name: stored };
}
