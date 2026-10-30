/**
 * TEMP (not committed): trigger the workflow retry for the Farmhand demo
 * project against the running dev server, authenticated as the project owner
 * via a Better Auth signed session cookie (token read read-only from local D1).
 *
 * No DB writes from here; the retry route owns its own writes. The secret is
 * read from BETTER_AUTH_SECRET env and never printed.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... bun test-support/farmhand-retry-trigger.mjs [retryKey]
 */
import { createHmac } from "node:crypto";

const BASE = process.env.CADDIE_DEV_BASE ?? "http://localhost:5176";
const PROJECT = "proj_506d61ece6d7ca3a12fdd9a41a281960";
const KEY = process.argv[2] ?? `farmhand-rebuild-${new Date().toISOString().slice(0, 10)}`;

const token = process.env.SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET;
if (!token || !secret) {
  console.error("need SESSION_TOKEN and BETTER_AUTH_SECRET");
  process.exit(3);
}

function sign(value) {
  // The running dev server verifies the session cookie with STANDARD base64
  // (probed 2026-10-26: base64url fails, base64-std authenticates).
  const sig = createHmac("sha256", secret).update(value).digest("base64");
  return `${value}.${sig}`;
}
const cookie = `better-auth.session_token=${sign(token)}`;

async function main() {
  const sess = await fetch(`${BASE}/api/auth/get-session`, { headers: { cookie } });
  const sj = await sess.json().catch(() => null);
  console.log("get-session http", sess.status, "user =", sj?.user?.email ?? sj?.user?.id ?? "none");

  const before = await fetch(`${BASE}/api/projects/${PROJECT}/workflow`, { headers: { cookie } });
  const bj = await before.json().catch(() => null);
  console.log("workflow BEFORE phase =", bj?.workflow?.phase, "http", before.status);

  const retry = await fetch(`${BASE}/api/projects/${PROJECT}/workflow/retry`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ key: KEY }),
  });
  const rj = await retry.json().catch(() => null);
  console.log("RETRY http", retry.status, "key", KEY);
  console.log("retry response:", JSON.stringify(rj)?.slice(0, 800));
  console.log("workflow AFTER phase =", rj?.workflow?.phase);
  process.exit(retry.ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR", e); process.exit(2); });
