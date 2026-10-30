// TEMP (never committed): keep one owner browser on the project page (keeps the
// coordinator socket warm, like caddie-walk poll) and log the build card text
// whenever it changes. Never clicks anything.
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { readFileSync, copyFileSync, appendFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const project = process.argv[2]; const seconds = Number(process.argv[3] ?? 7200);
const LOG = process.env.WATCH_LOG ?? "/tmp/watch-build.log";
const vars = readFileSync("apps/app/.dev.vars", "utf8");
const secret = /^BETTER_AUTH_SECRET=(.*)$/m.exec(vars)[1].trim().replace(/^"|"$/g, "");
const dbPath = "apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c204843922c7d8b0460aacd7d5eef263a2ad6de9bd92c76a90ee80ed8b6b331b.sqlite";
for (const s of ["", "-wal", "-shm"]) { try { copyFileSync(`${dbPath}${s}`, `/tmp/watch-copy.sqlite${s}`); } catch {} }
const db = new Database("/tmp/watch-copy.sqlite"); const row = db.query("select token from session order by createdAt desc limit 1").get(); db.close();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{ name: "better-auth.session_token", value: `${row.token}.${createHmac("sha256", secret).update(row.token).digest("base64")}`, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
const page = await context.newPage();
await page.goto(`http://localhost:5176/app/project?project=${project}`, { waitUntil: "domcontentloaded", timeout: 60000 });
const end = Date.now() + seconds * 1000; let last = "";
while (Date.now() < end) {
  await page.waitForTimeout(30000);
  const text = (await page.locator(".focused-project-content").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
  if (text && text !== last) { appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} ${text}\n`); last = text; }
  if (/Ready to try|Your app is ready|Needs attention|couldn.t/i.test(text)) appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} SIGNAL\n`);
}
await browser.close();
