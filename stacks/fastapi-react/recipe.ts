import type { StackRecipe } from "@caddie/contracts";

/**
 * fastapi-react stack recipe. uv/Python backend + Bun-built React client.
 * Live verification (uv sync, pytest, client build, server start) is
 * BLOCKED on the P09 live window + Python toolchain availability.
 */
export const recipe: StackRecipe = {
	id: "fastapi-react",
	version: "1.0.0",
	imageDigest: "sha256:TEMPLATE-FROZEN-AT-P15C",
	install: ["uv sync --frozen", "bun install"],
	test: ["uv run pytest", "bun test src/"],
	build: ["bun run build"],
	start: ["uv run uvicorn app.main:app --port 8080"],
	requiredCapabilities: ["python", "uv", "node"],
	artifacts: ["dist/", ".pytest_cache/"],
	preview: "server",
	availability: "unverified",
};
