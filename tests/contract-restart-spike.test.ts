import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { materializeApp, runAppTest, type MaterializedApp } from "./support/contract-restart-app.ts";

/**
 * SPIKE S4 (plan docs/plans/2026-10-22-software-team-mode.md, section 6): prove
 * locally that part E's restart check can work before building part E.
 *
 * Part E step 3 needs: A creates a record through the app's real Hono routes in
 * ONE `bun test` process; that process ends; a SEPARATE `bun test` process opens
 * the SAME database file and reads the record by id and in the list, with the
 * starter's migrations applied to the file database the same way they apply
 * in-memory today. Step 5: a second account B can't see A's record. Step 8: a
 * screen rendered in happy-dom whose fetch goes to the REAL server shows A's
 * record and not B's.
 *
 * The spike materialises a real starter app (SCAFFOLD_FILES) with a file-backed
 * copy of the SAME db wrapper (test/setup/d1-file.ts), a records table, real
 * owner-scoped CRUD routes and a screen, then runs the two processes and the
 * in-process screen/privacy test. Everything is LOCAL VERIFIED: no paid calls,
 * no sandbox.
 *
 * Classification: LOCAL VERIFIED.
 */

const SLOW = 180_000;

describe("S4: contract restart round trip (file-backed, two processes)", () => {
	let app: MaterializedApp;

	beforeAll(() => {
		app = materializeApp();
	}, SLOW);

	afterAll(() => {
		app?.cleanup();
	});

	test(
		"create (process 1) then restart-read (process 2) on the same file, plus privacy and the real-server screen",
		() => {
			// Process 1: A creates a record in the file database.
			const create = runAppTest(app, "caddie/contract-create.test.ts");
			expect(create.ok, `process 1 (create) failed:\n${create.out}`).toBe(true);
			expect(/\b1 pass\b/.test(create.out), create.out).toBe(true);
			expect(/\b0 fail\b/.test(create.out), create.out).toBe(true);

			// The file is a real on-disk database that outlived process 1.
			expect(existsSync(app.dbFile)).toBe(true);

			// Process 2: a fresh `bun test` run reopens the same file and reads it.
			const restart = runAppTest(app, "caddie/contract-restart.test.ts");
			expect(restart.ok, `process 2 (restart read) failed:\n${restart.out}`).toBe(true);
			expect(/\b1 pass\b/.test(restart.out), restart.out).toBe(true);
			expect(/\b0 fail\b/.test(restart.out), restart.out).toBe(true);

			// Same process: second-person privacy and the screen that fetches the
			// real server (happy-dom), for A and for B.
			const screen = runAppTest(app, "caddie/contract-screen.test.tsx");
			expect(screen.ok, `screen/privacy check failed:\n${screen.out}`).toBe(true);
			expect(/\b2 pass\b/.test(screen.out), screen.out).toBe(true);
			expect(/\b0 fail\b/.test(screen.out), screen.out).toBe(true);
		},
		SLOW,
	);
});
