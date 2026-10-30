// TEMP (never committed): print the box nesting of the project card and which
// CSS rules set padding on each level, against the local dev server.
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { readFileSync, copyFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const [projectId, width = "1280", ...clicks] = process.argv.slice(2);
const vars = readFileSync("apps/app/.dev.vars", "utf8");
const secret = /^BETTER_AUTH_SECRET=(.*)$/m.exec(vars)[1].trim().replace(/^"|"$/g, "");
const dbPath = "apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c204843922c7d8b0460aacd7d5eef263a2ad6de9bd92c76a90ee80ed8b6b331b.sqlite";
for (const s of ["", "-wal", "-shm"]) { try { copyFileSync(`${dbPath}${s}`, `/tmp/probe-layout.sqlite${s}`); } catch {} }
const db = new Database("/tmp/probe-layout.sqlite"); const row = db.query("select token from session order by createdAt desc limit 1").get(); db.close();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: Number(width), height: 900 } });
await context.addCookies([{ name: "better-auth.session_token", value: `${row.token}.${createHmac("sha256", secret).update(row.token).digest("base64")}`, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
const page = await context.newPage();
await page.goto(`http://localhost:5176/app/project?project=${projectId}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);
for (const c of clicks) { await page.locator(c).first().click().catch((e) => console.log("click fail", c, e.message.slice(0, 80))); await page.waitForTimeout(1500); }
const cdp = await context.newCDPSession(page);
await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
const sels = (process.env.SELS ?? ".focused-project-content|.focused-project-content > .project-workflow|.looks-picker|.plan-review").split("|");
for (const sel of sels) {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
  if (!nodeId) { console.log(sel, "— not found"); continue; }
  const box = await page.locator(sel).first().evaluate((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return `x=${Math.round(r.left)} y=${Math.round(r.top)} w=${Math.round(r.width)} h=${Math.round(r.height)} pad=${s.padding} gap=${s.rowGap} border=${s.borderTopWidth}`; });
  console.log(`\n${sel}: ${box}`);
  const m = await cdp.send("CSS.getMatchedStylesForNode", { nodeId });
  for (const r of m.matchedCSSRules ?? []) {
    const props = r.rule.style.cssProperties.filter((p) => /^padding|^gap|^row-gap|^margin/.test(p.name) && p.value);
    if (props.length) console.log(`  ${r.rule.selectorList.text.slice(0, 110)} → ${props.map((p) => `${p.name}:${p.value}`).join("; ")}`);
  }
}
await browser.close();
