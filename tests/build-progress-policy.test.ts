import { describe, test, expect } from "bun:test";
import { REPEATED_ACTION_LIMIT } from "../apps/app/src/agents/permissions.ts";
import {
  actionFingerprint,
  progressVerdict,
  type ActionFingerprint,
} from "../apps/app/src/server/build-progress-policy.ts";

/**
 * B03 — progress detection by CONTENT fingerprint, not byte count.
 *
 * guardAction (coordinator-host.ts) flags a repeated file write when the last
 * REPEATED_ACTION_LIMIT rows share subject AND `bytes` (a byte COUNT). Two
 * different edits of the same length collide, so a productive equal-length
 * edit is wrongly blocked; meanwhile genuine loops (identical writes,
 * alternating command/error cycles) must still stop. This pure policy replaces
 * the byte-count test with a content fingerprint over a bounded recent window.
 *
 * Pure, O(window), never scans full history. RED until build-progress-policy.ts
 * exists.
 */

const LIMIT = REPEATED_ACTION_LIMIT; // 3

function file(subject: string, contentHash: string): ActionFingerprint {
  return actionFingerprint({ kind: "file", subject, contentHash, outcome: "ok" });
}
function command(subject: string, outcome: "ok" | "failed"): ActionFingerprint {
  return actionFingerprint({ kind: "command", subject, outcome });
}

describe("B03 — content-fingerprint progress policy", () => {
  test("an equal-length but DIFFERENT-content edit proceeds (the byte-count bug)", () => {
    // Same path, same length, different bytes → different hash → progress.
    const recent = [file("src/App.tsx", "hashA"), file("src/App.tsx", "hashA"), file("src/App.tsx", "hashA")];
    const next = file("src/App.tsx", "hashB");
    expect(progressVerdict(recent, next, LIMIT).kind).toBe("proceed");
  });

  test("a byte-identical repeated write is no-progress", () => {
    const recent = [file("src/App.tsx", "hashA"), file("src/App.tsx", "hashA"), file("src/App.tsx", "hashA")];
    const next = file("src/App.tsx", "hashA");
    expect(progressVerdict(recent, next, LIMIT).kind).toBe("no-progress");
  });

  test("a repeated check whose outcome flips (failed→ok) is progress", () => {
    const recent = [command("bun test src", "failed"), command("bun test src", "failed"), command("bun test src", "failed")];
    const next = command("bun test src", "ok");
    expect(progressVerdict(recent, next, LIMIT).kind).toBe("proceed");
  });

  test("an alternating command/error loop (same cmd, same failed outcome ×limit) stops", () => {
    const recent = [command("bun run build", "failed"), command("bun run build", "failed"), command("bun run build", "failed")];
    const next = command("bun run build", "failed");
    expect(progressVerdict(recent, next, LIMIT).kind).toBe("no-progress");
  });

  test("fewer than `limit` matching recent actions always proceeds", () => {
    const recent = [file("src/App.tsx", "hashA"), file("src/App.tsx", "hashA")]; // only 2
    const next = file("src/App.tsx", "hashA");
    expect(progressVerdict(recent, next, LIMIT).kind).toBe("proceed");
  });

  test("a different subject in the window does not count toward the repeat", () => {
    const recent = [file("src/App.tsx", "hashA"), file("src/other.tsx", "hashX"), file("src/App.tsx", "hashA")];
    const next = file("src/App.tsx", "hashA");
    // Only 2 of the last 3 are the same (subject,hash) → not a run of `limit`.
    expect(progressVerdict(recent, next, LIMIT).kind).toBe("proceed");
  });

  test("actionFingerprint is stable and discriminates content", () => {
    expect(file("a", "h1")).toBe(file("a", "h1"));
    expect(file("a", "h1")).not.toBe(file("a", "h2"));
    expect(command("c", "ok")).not.toBe(command("c", "failed"));
  });
});


test('a real alternating A/B loop stops, while a new result breaks it',()=>{
 const a=actionFingerprint({kind:'file',subject:'src/App.tsx',contentHash:'a',outcome:'ok'});
 const b=actionFingerprint({kind:'file',subject:'src/App.tsx',contentHash:'b',outcome:'ok'});
 expect(progressVerdict([a,b,a,b,a,b],a,3).kind).toBe('no-progress');
 expect(progressVerdict([a,b,a,b,a,b],b+'changed',3).kind).toBe('proceed');
});
