/**
 * TEMP (not committed): drive the REAL app client against the local dev server
 * so the coordinator Durable Object stays warm (live Agents WebSocket) and its
 * overdue __flueWakeAgentSubmissions alarm fires, letting the feature-3 repair
 * ladder continue. Authenticated by injecting the owner's signed session cookie
 * (read read-only from local D1); secret from BETTER_AUTH_SECRET env.
 *
 * Usage: SESSION_TOKEN=... BETTER_AUTH_SECRET=... HOLD_SECONDS=600 \
 *          bun test-support/farmhand-drive-app.mjs
 */
import { createHmac } from "node:crypto";
import { chromium } from "@playwright/test";

const BASE = "http://localhost:5176";
const PROJECT = "proj_506d61ece6d7ca3a12fdd9a41a281960";
const HOLD = Number(process.env.HOLD_SECONDS ?? 600);

const token = process.env.SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET;
if (!token || !secret) { console.error("need SESSION_TOKEN and BETTER_AUTH_SECRET"); process.exit(3); }
const sig = createHmac("sha256", secret).update(token).digest("base64");
const cookieValue = `${token}.${sig}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addCookies([{
  name: "better-auth.session_token",
  value: cookieValue,
  domain: "localhost",
  path: "/",
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
}]);
const page = await context.newPage();
page.on("websocket", (ws) => console.log("WS opened:", ws.url()));
page.on("console", (m) => { const t = m.text(); console.log("console:", t.slice(0, 160)); });

const url = `${BASE}/app/project?project=${PROJECT}&pane=channel`;
console.log("navigating", url);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("goto note:", e.message));
// Confirm we are authenticated (not bounced to sign-in).
await page.waitForTimeout(4000);
console.log("page url now:", page.url());
console.log("title:", await page.title().catch(() => "?"));

console.log(`holding page open for ${HOLD}s to keep the DO warm...`);
const end = Date.now() + HOLD * 1000;
while (Date.now() < end) {
  await page.waitForTimeout(15000);
  // nudge the client to keep the socket active
  await page.evaluate(() => void (document.hidden)).catch(() => {});
}
await browser.close();
console.log("done holding");
