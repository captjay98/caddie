import { describe, test, expect } from "bun:test";
import { restoreCompatibility } from "../apps/app/src/server/build-resume-context.ts";

/**
 * B05 — restore the right work after interruption. On a cold restart
 * resolveCoordinatorContext rebuilds scope + run and re-opens the sandbox
 * session, but nothing checks that the restored workspace/stack/checkpoint
 * still matches the run before effects (plan B05.2: "incompatible restoration
 * refuses effects with an actionable state"). This pure guard decides that.
 *
 * A chat transcript alone is not enough to restore an execution environment;
 * the host must prove the stack, the last verified checkpoint and the recipe
 * version still line up before writing anything.
 */
describe("B05 — restoreCompatibility", () => {
  test("all identities match → ok", () => {
    const v = restoreCompatibility({
      expectedStack: "react-hono",
      restoredStack: "react-hono",
      expectedCheckpointRef: "abc",
      availableCheckpointRef: "abc",
    });
    expect(v.ok).toBe(true);
  });

  test("a stack mismatch refuses effects", () => {
    const v = restoreCompatibility({
      expectedStack: "react-hono",
      restoredStack: "flutter",
      expectedCheckpointRef: "abc",
      availableCheckpointRef: "abc",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/stack/i);
  });

  test("the expected checkpoint being gone refuses effects", () => {
    const v = restoreCompatibility({
      expectedStack: "react-hono",
      restoredStack: "react-hono",
      expectedCheckpointRef: "abc",
      availableCheckpointRef: null,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/checkpoint/i);
  });

  test("the available checkpoint pointing elsewhere refuses effects", () => {
    const v = restoreCompatibility({
      expectedStack: "react-hono",
      restoredStack: "react-hono",
      expectedCheckpointRef: "abc",
      availableCheckpointRef: "xyz",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/checkpoint/i);
  });

  test("a recipe-version drift (both known) refuses effects", () => {
    const v = restoreCompatibility({
      expectedStack: "react-hono",
      restoredStack: "react-hono",
      expectedCheckpointRef: "abc",
      availableCheckpointRef: "abc",
      expectedRecipeVersion: "v1",
      restoredRecipeVersion: "v2",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/recipe/i);
  });

  test("absent recipe versions are not a blocker (legacy runs)", () => {
    const v = restoreCompatibility({
      expectedStack: "react-hono",
      restoredStack: "react-hono",
      expectedCheckpointRef: "abc",
      availableCheckpointRef: "abc",
    });
    expect(v.ok).toBe(true);
  });

  test("a feature with no prior checkpoint (first feature) is compatible", () => {
    const v = restoreCompatibility({
      expectedStack: "react-hono",
      restoredStack: "react-hono",
      expectedCheckpointRef: null,
      availableCheckpointRef: null,
    });
    expect(v.ok).toBe(true);
  });
});
