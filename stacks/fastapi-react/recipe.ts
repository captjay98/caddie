import type { StackRecipe } from "@caddie/contracts";

/**
 * fastapi-react stack recipe. uv/Python backend + Bun-built React client.
 * `bun install`/`bun run build` run at the template root (the client is a
 * workspace; a generated uv.lock is committed at first toolchain-equipped
 * run, after which reproducible environments use `uv sync --frozen`).
 * CORS is an explicit allowlist (CADDIE_CLIENT_ORIGIN); unset means
 * same-origin only — no wildcard shortcut.
 */
export const recipe: StackRecipe = {
	id: "fastapi-react",
	version: "1.0.0",
	imageDigest: "sha256:TEMPLATE-FROZEN-AT-P15C",
	install: ["uv sync", "bun install"],
	test: ["uv run pytest", "bun test client/src/"],
	build: ["bun run build"],
	start: ["uv run uvicorn app.main:app --port 8080"],
	requiredCapabilities: ["python", "uv", "node"],
	artifacts: ["client/dist/", ".pytest_cache/"],
	preview: "server",
	availability: "unverified",
};
