/**
 * TEMP (never committed): screenshot owner-facing project surfaces in a real
 * browser against the local dev server, reusing the owner's local session row
 * (same technique as caddie-walk.mjs; no secret is printed).
 *
 * Usage: bun test-support/ui-shots.mjs <projectId> <label> [path] [clickText...]
 *   path defaults to "project"; clickText entries are button labels clicked in order.
 * Env: SHOT_W (default 1280), SHOT_H (900), SHOT_OUT (/tmp/ui-shots), SHOT_SETTLE ms.
 */
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.CADDIE_WALK_BASE ?? "http://localhost:5176";
const OUT = process.env.SHOT_OUT ?? "/tmp/ui-shots";
const [projectId, label = "shot", path = "project", ...clicks] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

function ownerCookie() {
  const vars = readFileSync("apps/app/.dev.vars", "utf8");
  const secret = /^BETTER_AUTH_SECRET=(.*)$/m.exec(vars)?.[1]?.trim().replace(/^"|"$/g, "");
  const dbPath = "apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c204843922c7d8b0460aacd7d5eef263a2ad6de9bd92c76a90ee80ed8b6b331b.sqlite";
  const scratch = "/tmp/ui-shots-dev-copy.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try { copyFileSync(`${dbPath}${suffix}`, `${scratch}${suffix}`); } catch {}
  }
  const db = new Database(scratch);
  const row = db.query("select token from session order by createdAt desc limit 1").get();
  db.close();
  return `${row.token}.${createHmac("sha256", secret).update(row.token).digest("base64")}`;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: Number(process.env.SHOT_W ?? 1280), height: Number(process.env.SHOT_H ?? 900) },
  deviceScaleFactor: 1,
});
await context.addCookies([{ name: "better-auth.session_token", value: ownerCookie(), domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));
page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 160)}`); });
await page.goto(`${BASE}/app/${path}${path.includes("?") ? "&" : "?"}project=${projectId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(Number(process.env.SHOT_SETTLE ?? 9000));
for (const text of clicks) {
  const target = text.startsWith("css=") ? page.locator(text.slice(4)).first() : page.getByRole("button", { name: text, exact: false }).first();
  await target.click({ timeout: 15000 }).catch((e) => problems.push(`click ${text}: ${e.message.slice(0, 120)}`));
  await page.waitForTimeout(2500);
}
const text = (await page.locator("main, body").first().innerText().catch(() => "")).replace(/\n{3,}/g, "\n\n");
console.log(`--- ${label} @ ${page.url()}\n${text.slice(0, 4000)}`);
// Vertical rhythm of the main content cards: each visible card's padding and box.
const boxes = await page.evaluate(() => [...document.querySelectorAll(".focused-project-content > *, .plan-design-switch, .card-surface, .caddie-card")]
  .filter((el) => el.getBoundingClientRect().height > 0)
  .slice(0, 14)
  .map((el) => {
    const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")} y=${Math.round(r.top)} h=${Math.round(r.height)} w=${Math.round(r.width)} pad=${s.paddingTop}/${s.paddingRight}/${s.paddingBottom}/${s.paddingLeft} gap=${s.rowGap}`;
  }));
console.log(boxes.join("\n"));
await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: true });
console.log(`shot: ${OUT}/${label}.png`);
if (problems.length) console.log(`problems:\n${problems.join("\n")}`);
await browser.close();
