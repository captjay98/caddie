import { describe, expect, test } from "bun:test";
import type { Scope } from "@caddie/contracts";
import { LocalCodeStore } from "../apps/app/src/server/code-versions.ts";
import { openWorkingCopy } from "../apps/app/src/server/working-copy.ts";
import { addUser, migratedDatabase } from "./fixtures/sqlite-d1.ts";

/**
 * B05 — restore the right work after interruption (wiring).
 *
 * When a Restore pointer (build_sandbox_sessions) names an image saved under a
 * now-superseded recipe, openWorkingCopy must NOT silently reopen the working
 * copy on that stale image. A transcript cannot restore an execution
 * environment: if the image the pointer carries no longer matches the image
 * the run expects, the resume refuses effects with an actionable blocker
 * rather than building against the wrong base (plan B05.2).
 *
 * Today openWorkingCopy reopens on `override.image` with no comparison to
 * `ctx.baseImage`, so this test is RED until the guard lands.
 */
describe("B05 — resume refuses an incompatible restored image", () => {
	test("a Restore pointer on a stale image refuses to reopen", async () => {
		const { sqlite, db } = migratedDatabase();
		try {
			const actorId = "alice";
			addUser(sqlite, actorId, "alice@example.com");
			const projectId = "p1";
			const runId = "r1";
			const stamp = new Date().toISOString();
			// A real Restore pointer (reason "restore:…", NOT the FILLING/FILLED
			// seed markers), carrying the image saved at rollback time.
			sqlite
				.prepare(
					'insert into "build_sandbox_sessions" ("projectId","runId","sessionKey","image","reason","updatedAt") values (?,?,?,?,?,?)',
				)
				.run(projectId, runId, `restore:${runId}:k1`, "stale-image", "restore:v1", stamp);

			const scope: Scope = { actorId, workspaceId: actorId, projectId } as Scope;
			const seen: string[] = [];
			const driver = {
				hasSession: async () => true,
				workingCopyAvailable: async () => true,
				ensureSession: async (input: { image: string }) => {
					seen.push(input.image);
					return { sessionId: "sess-1" };
				},
				uploadFiles: async () => {},
				execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			};

			const open = openWorkingCopy({
				db,
				store: new LocalCodeStore(db),
				driver: driver as never,
				scope,
				runId,
				sessionKey: `build:${runId}`,
				baseImage: "fresh-image",
				root: "/app",
				env: {},
			});

			// The run expects "fresh-image"; the pointer is "stale-image". The
			// resume must refuse, not reopen the sandbox on the stale image.
			await expect(open).rejects.toThrow(/RESTORE_INCOMPATIBLE|incompatible|recipe/i);
			expect(seen).not.toContain("stale-image");
		} finally {
			sqlite.close();
		}
	});
});
