import { recipe } from "./recipe.ts";
import { SCAFFOLD_LOCKFILE } from "./scaffold-lock.ts";
import { SERVER_FILES } from "./server-files.ts";
import { AUTH_FILES } from "./auth-files.ts";

/**
 * The ONE generic scaffold + command set for the react-hono stack (R03).
 *
 * Before R03 the real chat build (`server/coordinator-host.ts`) hardcoded its
 * own `package.json` + `main.tsx` inline and ran ad-hoc commands (`bun test
 * src`, a raw `bun build …`), while the evaluation journey used
 * `stacks/react-hono/recipe.ts` + the acceptance manifest. Two different
 * setups meant a green fixture journey proved nothing about freeform chat.
 *
 * This module is the single source both paths import. The scaffold is a
 * GENERIC React/Bun app skeleton — NOT a todo app and NOT any acceptance
 * assertions — so the model still implements the requested app and the
 * protected acceptance stays outside candidate reach. The commands come from
 * the frozen recipe, so "the identical recipe used by chat" is a code fact.
 *
 * Phase 0 (2026-10-16): the scaffold now ships a WORKING test environment.
 * A real build (FarmLog AI) spent its run hand-writing jsdom/Testing Library
 * preloads because the skeleton had none. Bun's test runner does not support
 * jsdom; Bun's documented setup is happy-dom registered in its OWN preload
 * file (imports are hoisted, so Testing Library must load after it), then
 * Testing Library matchers + cleanup in a second preload. Both preloads and
 * bunfig.toml are protected paths (agents/permissions.ts): the builder writes
 * tests, never the harness. The example test lives OUTSIDE `src/`, so the
 * host's `bun test src/` gate still needs tests the builder actually wrote.
 */

/** Verify commands, sourced from the frozen recipe (never hand-copied). */
export const SCAFFOLD_COMMANDS = {
	install: recipe.install,
	test: recipe.test,
	build: recipe.build,
	start: recipe.start,
} as const;

/** Exact versions the scaffold (and its lockfile) were verified with. */
export const SCAFFOLD_PACKAGE = {
	name: "caddie-project",
	private: true,
	type: "module",
	scripts: {
		test: "bun test src/",
		// 1) the React client bundle (dist/main.js + dist/main.css, read by the host);
		// 2) the app's server for Cloudflare Workers (dist/server.js); node: built-ins
		//    stay imports — the Workers runtime provides them (nodejs_compat), and the
		//    check below still refuses the ones it can't run;
		// 3) Caddie's check that the server uses nothing Workers lacks.
		build:
			"bun build src/main.tsx --outdir dist --target browser && " +
			"bun build src/server.ts --outfile dist/server.js --target browser --format esm --conditions workerd --external 'cloudflare:*' --external 'node:*' && " +
			"bun run caddie/check-server.ts",
		start: "bun run src/server.ts",
	},
	dependencies: {
		react: "19.2.0",
		"react-dom": "19.2.0",
		hono: "4.12.32",
		// Sign-in for the app's users (caddie/auth.ts, stacks/react-hono/auth-files.ts).
		"better-auth": "1.7.10",
	},
	devDependencies: {
		"@happy-dom/global-registrator": "21.0.3",
		"@testing-library/dom": "10.4.2",
		"@testing-library/jest-dom": "7.0.1",
		"@testing-library/react": "16.3.3",
		"@types/bun": "1.4.3",
	},
} as const;

/** The test-harness files the builder must never edit (see PROTECTED_PATH_PREFIXES). */
export const SCAFFOLD_TEST_HARNESS = ["bunfig.toml", "test/setup/"] as const;

/** Caddie-owned runtime files in every app (D1 types, the Workers check). Protected too. */
export const SCAFFOLD_RUNTIME_DIR = "caddie/" as const;

const BASE_FILES: Readonly<Record<string, string>> = {
	"package.json": `${JSON.stringify(SCAFFOLD_PACKAGE, null, 2)}\n`,
	"tsconfig.json": `${JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "bundler",
				jsx: "react-jsx",
				lib: ["ES2022", "DOM", "DOM.Iterable"],
				types: ["bun"],
				strict: true,
				skipLibCheck: true,
				noEmit: true,
			},
			include: ["src", "test", "caddie"],
		},
		null,
		2,
	)}\n`,
	"bunfig.toml": [
		"# Caddie test setup. Do not edit: the host runs `bun test src/` with these.",
		"# happy-dom must register BEFORE Testing Library loads, so they are two files.",
		"[test]",
		'preload = ["./test/setup/happydom.ts", "./test/setup/testing-library.ts"]',
		"",
	].join("\n"),
	"test/setup/happydom.ts": [
		"// Gives bun test a browser-like DOM: window, document, localStorage, events.",
		"// Its own file on purpose: imports are hoisted, and Testing Library must",
		"// load only after the DOM exists (see bunfig.toml).",
		'import { GlobalRegistrator } from "@happy-dom/global-registrator";',
		"",
		"// The server's tests need the runtime's own fetch classes: happy-dom's",
		"// browser Response drops Set-Cookie, which sign-in cookies travel in.",
		"const runtime = { fetch, Request, Response, Headers, FormData };",
		'GlobalRegistrator.register({ url: "http://localhost/" });',
		"Object.assign(globalThis, runtime);",
		"",
	].join("\n"),
	"test/setup/testing-library.ts": [
		"// Testing Library for bun test: jest-dom matchers, React act() mode, and a",
		"// clean DOM + storage between tests.",
		'import { afterEach, expect } from "bun:test";',
		'import { cleanup } from "@testing-library/react";',
		'import * as matchers from "@testing-library/jest-dom/matchers";',
		"",
		"(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;",
		"expect.extend(matchers);",
		"",
		"afterEach(() => {",
		"  cleanup();",
		"  localStorage.clear();",
		"});",
		"",
	].join("\n"),
	"test/setup/matchers.d.ts": [
		'import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";',
		"",
		'declare module "bun:test" {',
		"  interface Matchers<T> extends TestingLibraryMatchers<typeof expect.stringContaining, T> {}",
		"  interface AsymmetricMatchers extends TestingLibraryMatchers {}",
		"}",
		"",
	].join("\n"),
	// A working pattern to copy. NOT under src/, so the host's `bun test src/`
	// gate never counts it: the builder's own tests must make that gate pass.
	"test/examples/app.example.test.tsx": [
		"// Example behavior tests. Put the app's real tests in src/*.test.tsx,",
		"// next to the code they check — the host runs `bun test src/`.",
		'import { describe, expect, test } from "bun:test";',
		'import { useState } from "react";',
		'import { fireEvent, render, screen } from "@testing-library/react";',
		'import { App } from "../../src/App";',
		"",
		"function Counter() {",
		"  const [clicks, setClicks] = useState(0);",
		"  return <button onClick={() => setClicks(clicks + 1)}>Clicked {clicks}</button>;",
		"}",
		"",
		'describe("examples", () => {',
		'  test("renders the starter heading", () => {',
		"    render(<App />);",
		'    expect(screen.getByRole("heading", { name: "Your app" })).toBeInTheDocument();',
		"  });",
		"",
		'  test("updates after a click", () => {',
		"    render(<Counter />);",
		'    fireEvent.click(screen.getByRole("button"));',
		'    expect(screen.getByRole("button")).toHaveTextContent("Clicked 1");',
		"  });",
		"});",
		"",
	].join("\n"),
	"src/App.tsx": [
		"export function App() {",
		"  return (",
		"    <main>",
		"      <h1>Your app</h1>",
		"    </main>",
		"  );",
		"}",
		"",
	].join("\n"),
	"src/main.tsx": [
		'import { createRoot } from "react-dom/client";',
		'import { App } from "./App";',
		'import "./styles.css";',
		"",
		'createRoot(document.getElementById("root")!).render(<App />);',
		"",
	].join("\n"),
	"src/styles.css": "body{margin:0;font-family:system-ui,sans-serif}\n",
	// Files the browser code needs at run time travel inside dist/main.js (plan 1.6).
	"caddie/embed.ts": [
		"// Caddie runtime file — do not edit. Caddie keeps only dist/main.js and",
		"// dist/main.css from the build, so a file the browser code loads at run time",
		"// (a .wasm, a font, a data file) is never there. Put its bytes in the bundle:",
		"//",
		'//   import { embedBase64 } from "../caddie/embed.ts" with { type: "macro" };',
		'//   const bytes = Uint8Array.from(atob(embedBase64("node_modules/sql.js/dist/sql-wasm.wasm")), (c) => c.charCodeAt(0));',
		"//   const SQL = await initSqlJs({ wasmBinary: bytes });",
		"//",
		"// It runs when the app is built and when its tests run, never in the browser.",
		"// The path is from the app folder.",
		'import { readFileSync } from "node:fs";',
		"",
		"export function embedBase64(path: string): string {",
		'  return readFileSync(path).toString("base64");',
		"}",
		"",
	].join("\n"),
	// Backend-ready from the start (stacks/react-hono/server-files.ts).
	...SERVER_FILES,
	// Sign-in for the app's own users (stacks/react-hono/auth-files.ts).
	...AUTH_FILES,
};

/**
 * The generic scaffold files written into a fresh sandbox workspace. Keyed by
 * path relative to the project root. `bun.lock` comes from the generated
 * scaffold-lock.ts (scripts/refresh-scaffold-lock.ts) so the recipe's
 * `bun install --frozen-lockfile` installs exactly the verified versions.
 */
export const SCAFFOLD_FILES: Readonly<Record<string, string>> = SCAFFOLD_LOCKFILE
	? { ...BASE_FILES, "bun.lock": SCAFFOLD_LOCKFILE }
	: BASE_FILES;

/** The scaffold without its lockfile — the refresh script's install input. */
export const SCAFFOLD_BASE_FILES = BASE_FILES;

/** The recipe version this scaffold is bound to (recorded on receipts). */
export const SCAFFOLD_RECIPE_VERSION = recipe.version;
