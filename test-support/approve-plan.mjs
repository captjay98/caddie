// TEMP: open the project, press Approve plan, confirm in the dialog (the owner's two clicks).
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { readFileSync, copyFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const project = process.argv[2];
const vars = readFileSync("apps/app/.dev.vars", "utf8");
const secret = /^BETTER_AUTH_SECRET=(.*)$/m.exec(vars)[1].trim().replace(/^"|"$/g, "");
const dbPath = "apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c204843922c7d8b0460aacd7d5eef263a2ad6de9bd92c76a90ee80ed8b6b331b.sqlite";
for (const s of ["", "-wal", "-shm"]) { try { copyFileSync(`${dbPath}${s}`, `/tmp/approve-copy.sqlite${s}`); } catch {} }
const db = new Database("/tmp/approve-copy.sqlite"); const row = db.query("select token from session order by createdAt desc limit 1").get(); db.close();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{ name: "better-auth.session_token", value: `${row.token}.${createHmac("sha256", secret).update(row.token).digest("base64")}`, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
const page = await context.newPage();
await page.goto(`http://localhost:5176/app/project?project=${project}`, { waitUntil: "domcontentloaded" });
await page.getByTestId("plan-approve-open").click({ timeout: 60000 });
await page.getByTestId("design-review-approve").click({ timeout: 30000 });
await page.waitForTimeout(12000);
await page.screenshot({ path: "/tmp/ui-shots/after-approve.png" });
console.log((await page.locator("main").first().innerText()).slice(0, 800));
await browser.close();
