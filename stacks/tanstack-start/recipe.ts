import type { StackRecipe } from "@caddie/contracts";

/**
 * tanstack-start stack recipe. TanStack Start remains an OUTPUT stack even
 * though Caddie itself uses SPA — full-stack server behavior (server
 * functions, SSR) is what this template proves.
 *
 * Live verification (install/build/start in the sandbox, server state
 * persisting across requests, private preview auth) is BLOCKED on the P09
 * live window; the recipe and template are the locally-verifiable contract.
 */
export const recipe: StackRecipe = {
	id: "tanstack-start",
	version: "1.0.0",
	imageDigest: "sha256:TEMPLATE-FROZEN-AT-P15A",
	install: ["bun install"],
	test: ["bun test src/"],
	build: ["bun run build"],
	start: ["bun run start"],
	requiredCapabilities: ["node"],
	artifacts: [".output/"],
	preview: "server",
	availability: "unverified",
};
