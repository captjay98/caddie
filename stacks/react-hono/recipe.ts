import type { StackRecipe } from "@caddie/contracts";

/**
 * react-hono stack recipe — the FIRST stack to prove (P09). Commands are
 * curated, never model-supplied (contracts.md). The template ships with
 * pinned commands; the journey runs them inside the sandbox.
 *
 * LIVE VERIFIED at the P09 execution window: scripts/run-journey.ts executed
 * every acceptance-manifest phase inside the contree sandbox (install, tests,
 * build, deliberate red → repair, server-start, artifact export) plus real
 * browser assertions against the sandbox-built bundle — exit 0, evidence in
 * the execution ledger. Availability flipped to "verified" by that run, per
 * contracts.md: only the journey labels a stack verified.
 */
export const recipe: StackRecipe = {
	id: "react-hono",
	version: "1.0.0",
	// Digest of the template directory at freeze time; recomputed by the
	// journey runner before each run and refused on mismatch. (Frozen at the
	// P09 execution window: template = package.json + tsconfig.json.)
	imageDigest: "sha256:d6d5179e9dff098455cd3a31a1de3c4022fd84881fc2226c3e7c54f1f38563e0",
	install: ["bun install --frozen-lockfile"],
	test: ["bun run test"],
	build: ["bun run build"],
	start: ["bun run start"],
	requiredCapabilities: ["bun"],
	artifacts: ["dist/", "coverage/"],
	preview: "server",
	// Flipped from "unverified" by the P09 journey (LIVE, exit 0, all phases).
	availability: "verified",
};
