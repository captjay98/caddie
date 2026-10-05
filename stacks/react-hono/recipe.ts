import type { StackRecipe } from "@caddie/contracts";

/**
 * react-hono stack recipe — the FIRST stack to prove (P09). Commands are
 * curated, never model-supplied (contracts.md). The template ships with
 * pinned commands; the journey runs them inside the sandbox.
 *
 * Live verification of this recipe (install/test/build/start inside the real
 * sandbox) is BLOCKED on CONTREE_* credentials; the recipe and template are
 * the locally-verifiable contract.
 */
export const recipe: StackRecipe = {
	id: "react-hono",
	version: "1.0.0",
	// Digest of the template directory at freeze time; recomputed by the
	// journey runner before each run and refused on mismatch.
	imageDigest: "sha256:TEMPLATE-FROZEN-AT-P09",
	install: ["bun install --frozen-lockfile"],
	test: ["bun run test"],
	build: ["bun run build"],
	start: ["bun run start"],
	requiredCapabilities: ["bun"],
	artifacts: ["dist/", "coverage/"],
	preview: "server",
	availability: "unverified",
};
