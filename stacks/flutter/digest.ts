import { createHash } from "node:crypto";

/**
 * sha256 over the sorted scaffold files (path and content). The refresh script
 * records it next to the lockfiles and the recipe carries it as imageDigest, so
 * a scaffold edit without a lock refresh is caught (tests/flutter-scaffold.test.ts).
 */
export function scaffoldDigest(files: Readonly<Record<string, string>>): string {
	const hash = createHash("sha256");
	for (const path of Object.keys(files).sort()) hash.update(`${path}\0${files[path]}\0`);
	return `sha256:${hash.digest("hex")}`;
}
