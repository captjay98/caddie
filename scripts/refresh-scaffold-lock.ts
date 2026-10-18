/**
 * Regenerate (default) or verify (`--check`) the react-hono scaffold lockfile.
 *
 *   bun scripts/refresh-scaffold-lock.ts          # write stacks/react-hono/scaffold-lock.ts
 *   bun scripts/refresh-scaffold-lock.ts --check  # fail if the lockfile is stale or the scaffold is broken
 *
 * Both modes materialise the scaffold in a temp directory and PROVE it works
 * with real commands, so the lockfile can never be regenerated from a broken
 * scaffold:
 *   1. `bun install --frozen-lockfile` succeeds from the generated lockfile;
 *   2. the example tests (test/examples, outside src/) pass through the
 *      bunfig.toml preloads — i.e. happy-dom + Testing Library really work;
 *   3. `bun test src/` FAILS on the bare scaffold — the host's behavior-test
 *      gate needs tests the builder wrote, never the scaffold's own;
 *   4. `bun run build` emits dist/main.js.
 *   5. the Workers check refuses a server that needs Bun;
 *   6. sign-in: Better Auth's schema matches migrations/0000_caddie_auth.sql
 *      and a server that mounts sign-in passes the Workers check.
 * Needs network access to the npm registry (public packages, no credentials).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { SCAFFOLD_BASE_FILES } from "../stacks/react-hono/scaffold.ts";
import { SCAFFOLD_LOCKFILE } from "../stacks/react-hono/scaffold-lock.ts";

const check = process.argv.includes("--check");
const LOCK_MODULE = join(import.meta.dir, "..", "stacks", "react-hono", "scaffold-lock.ts");
const bun = process.execPath;

function run(cwd: string, args: string[]): { code: number; out: string } {
	const result = spawnSync(bun, args, { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
	return { code: result.status ?? 1, out: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function fail(message: string, detail = ""): never {
	console.error(`FAIL: ${message}${detail ? `\n${detail.trim().slice(-2000)}` : ""}`);
	process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "caddie-scaffold-"));
try {
	for (const [path, text] of Object.entries(SCAFFOLD_BASE_FILES)) {
		const full = join(dir, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	if (check) {
		if (!SCAFFOLD_LOCKFILE) fail("scaffold-lock.ts is empty; run without --check to generate it");
		writeFileSync(join(dir, "bun.lock"), SCAFFOLD_LOCKFILE);
	} else {
		const install = run(dir, ["install"]);
		if (install.code !== 0) fail("bun install failed", install.out);
	}
	const lock = readFileSync(join(dir, "bun.lock"), "utf8");

	// 1. The lockfile alone reproduces the install.
	rmSync(join(dir, "node_modules"), { recursive: true, force: true });
	const frozen = run(dir, ["install", "--frozen-lockfile"]);
	if (frozen.code !== 0) fail("bun install --frozen-lockfile failed", frozen.out);
	if (readFileSync(join(dir, "bun.lock"), "utf8") !== lock) fail("the frozen install rewrote bun.lock");

	// 2. The DOM + Testing Library preloads really work, and so does the server
	//    test harness (Hono app.request + the D1 test database).
	const examples = run(dir, ["test", "test/examples"]);
	if (examples.code !== 0 || !/\b8 pass\b/.test(examples.out)) fail("example tests did not pass through the preloads", examples.out);

	// 3. The bare scaffold cannot satisfy the host's behavior-test gate.
	const gate = run(dir, ["test", "src/"]);
	if (gate.code === 0) fail("`bun test src/` passed on the bare scaffold; the gate would not need builder tests", gate.out);

	// 4. The browser bundle AND the Workers server bundle build, and the
	//    compatibility check passes on the scaffold's own server.
	const build = run(dir, ["run", "build"]);
	if (build.code !== 0 || !existsSync(join(dir, "dist", "main.js"))) fail("bun run build did not emit dist/main.js", build.out);
	if (!existsSync(join(dir, "dist", "server.js"))) fail("bun run build did not emit dist/server.js", build.out);
	if (!/ok for Cloudflare Workers/.test(build.out)) fail("the server check did not pass on the scaffold", build.out);

	// 5. The check refuses a server that only works under Bun.
	const server = join(dir, "src", "server.ts");
	const original = readFileSync(server, "utf8");
	writeFileSync(server, `${original}\nexport const size = Bun.file("x").size;\n`);
	const refused = run(dir, ["run", "build"]);
	writeFileSync(server, original);
	if (refused.code === 0 || !/the Bun global/.test(refused.out)) fail("the server check accepted a server that uses Bun.file", refused.out);

	// 6. Sign-in: Better Auth's own view of the schema matches the shipped
	//    migration (nothing to create or add), and a server that mounts sign-in
	//    still builds and passes the Workers check.
	const schemaCheck = join(dir, "caddie-schema-check.ts");
	writeFileSync(
		schemaCheck,
		[
			'import { getMigrations } from "better-auth/db/migration";',
			'import { createSignInAuth } from "./caddie/auth";',
			'import { createTestCaddie } from "./test/setup/caddie";',
			'import { createTestDatabase, TEST_AUTH_SECRET } from "./test/setup/d1";',
			"const env = { DB: createTestDatabase(), CADDIE: createTestCaddie(), CADDIE_AUTH_SECRET: TEST_AUTH_SECRET };",
			'const { toBeCreated, toBeAdded } = await getMigrations(createSignInAuth(env, "http://localhost").options);',
			"if (toBeCreated.length > 0 || toBeAdded.length > 0) {",
			"  console.error(JSON.stringify({ toBeCreated: toBeCreated.map((t) => t.table), toBeAdded: toBeAdded.map((t) => t.table) }));",
			"  process.exit(1);",
			"}",
			'console.log("sign-in schema: matches migrations/0000_caddie_auth.sql");',
			"",
		].join("\n"),
	);
	const schema = run(dir, [schemaCheck]);
	rmSync(schemaCheck);
	if (schema.code !== 0 || !/sign-in schema: matches/.test(schema.out)) fail("Better Auth's schema does not match migrations/0000_caddie_auth.sql", schema.out);
	writeFileSync(server, `${original}\nimport { mountSignIn } from "../caddie/auth";\nmountSignIn(app);\n`);
	const signInBuild = run(dir, ["run", "build"]);
	writeFileSync(server, original);
	if (signInBuild.code !== 0 || !/ok for Cloudflare Workers/.test(signInBuild.out)) fail("a server with sign-in did not pass the Workers check", signInBuild.out);

	if (check) {
		console.log("OK: scaffold lockfile is current; install, example tests, gate refusal and build verified");
	} else {
		writeFileSync(
			LOCK_MODULE,
			[
				"// GENERATED by scripts/refresh-scaffold-lock.ts — do not edit by hand.",
				"// The react-hono scaffold's bun.lock, so `bun install --frozen-lockfile`",
				"// resolves the exact versions the scaffold was verified with.",
				`export const SCAFFOLD_LOCKFILE = ${JSON.stringify(lock)};`,
				"",
			].join("\n"),
		);
		console.log(`OK: wrote ${LOCK_MODULE} (${lock.length} bytes); install, example tests, gate refusal and build verified with bun ${Bun.version}`);
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
