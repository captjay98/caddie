import type { StackRecipe } from "@caddie/contracts";

/**
 * tanstack-start stack recipe. TanStack Start remains an OUTPUT stack even
 * though Caddie itself uses SPA — full-stack server behavior (server
 * functions, SSR) is what this template proves.
 *
 * Toolchain is Bun end to end (install/test/build/serve: the built
 * dist/server/server.js default-exports a fetch handler that Bun serves).
 * The production-start gate (build serves SSR HTML) is proven by the live
 * spec; availability stays unverified until that run.
 */
export const recipe: StackRecipe = {
	id: "tanstack-start",
	version: "1.0.0",
	imageDigest: "sha256:TEMPLATE-FROZEN-AT-P15A",
	install: ["bun install"],
	test: ["bun test src/"],
	build: ["bun run build"],
	start: ["bun run start"],
	requiredCapabilities: ["bun"],
	artifacts: ["dist/"],
	preview: "server",
	availability: "unverified",
};
