import { recipe } from "./recipe.ts";

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
 * MINIMAL GENERIC React/Bun app skeleton — NOT a todo app and NOT any
 * acceptance assertions — so the model still implements the requested app and
 * the protected acceptance stays outside candidate reach. The commands come
 * from the frozen recipe, so "the identical recipe used by chat" is a code
 * fact, not a comment.
 */

/** Verify commands, sourced from the frozen recipe (never hand-copied). */
export const SCAFFOLD_COMMANDS = {
	install: recipe.install,
	test: recipe.test,
	build: recipe.build,
	start: recipe.start,
} as const;

/**
 * The generic scaffold files written into a fresh sandbox workspace. Keyed by
 * path relative to the project root. Pinned dependency versions match the
 * recipe's frozen setup; scripts match the recipe commands so `bun run test` /
 * `bun run build` resolve.
 */
export const SCAFFOLD_FILES: Readonly<Record<string, string>> = {
	"package.json": JSON.stringify(
		{
			name: "caddie-project",
			private: true,
			type: "module",
			scripts: {
				test: "bun test src/",
				build: "bun build src/main.tsx --outdir dist --target browser",
				start: "bun run src/server.ts",
			},
			dependencies: {
				react: "19.2.0",
				"react-dom": "19.2.0",
				hono: "4.12.32",
			},
			devDependencies: {
				"@types/bun": "^1.2.0",
			},
		},
		null,
		2,
	),
	"tsconfig.json": JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "bundler",
				jsx: "react-jsx",
				strict: true,
				noEmit: true,
			},
			include: ["src"],
		},
		null,
		2,
	),
	"src/main.tsx":
		"import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport './styles.css';\ncreateRoot(document.getElementById('root')!).render(<main><h1>Your app</h1></main>);\n",
	"src/styles.css": "body{margin:0;font-family:system-ui,sans-serif}",
};

/** The recipe version this scaffold is bound to (recorded on receipts). */
export const SCAFFOLD_RECIPE_VERSION = recipe.version;
