/**
 * TEMP (never committed): walk the REAL Caddie client in a real browser against
 * the local dev server, as a plain-language user would, and report what the
 * screen says. Authentication reuses the owner's already-signed-in session row
 * in the LOCAL dev D1 (a copy taken to /tmp, so dev state is never written) and
 * signs its cookie value in-process; no secret is ever printed, and no
 * credential is typed into a tool call.
 *
 * Usage: bun test-support/caddie-walk.mjs <command> [args]
 *   state                 print url + visible text + any error banner
 *   send "text"           type into the composer, submit, wait, report
 *   click "label"         click a button/link whose accessible text contains label
 *   wait <seconds>        hold, then report
 *   shot <name>           screenshot the full page to the evidence folder
 *   page <path>           navigate to /app/<path>
 */
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { readFileSync, mkdirSync, copyFileSync, appendFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = process.env.CADDIE_WALK_BASE ?? "http://localhost:5176";
const OUT = process.env.CADDIE_WALK_OUT ?? "/tmp/caddie-walk";
const PROFILE = `${OUT}/profile`;
const HOLD_MS = Number(process.env.CADDIE_WALK_HOLD ?? 8000);
const APP = process.argv[2] ?? "state";
const ARG = process.argv[3];

mkdirSync(OUT, { recursive: true });

function ownerCookie() {
  const vars = readFileSync("apps/app/.dev.vars", "utf8");
  const secret = /^BETTER_AUTH_SECRET=(.*)$/m.exec(vars)?.[1]?.trim().replace(/^"|"$/g, "");
  if (!secret) throw new Error("no BETTER_AUTH_SECRET");
  const dbPath =
    process.env.CADDIE_WALK_DB ??
    "apps/app/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/c204843922c7d8b0460aacd7d5eef263a2ad6de9bd92c76a90ee80ed8b6b331b.sqlite";
  // The dev server owns the live file (and its WAL); copy it aside so a
  // read-only open can never fail on a lock and never writes to dev state.
  const scratch = "/tmp/caddie-walk-dev-copy.sqlite";
  for (const suffix of ["", "-wal", "-shm"]) {
    try { copyFileSync(`${dbPath}${suffix}`, `${scratch}${suffix}`); } catch {}
  }
  const db = new Database(scratch);
  const row = db
    .query("select token from session order by createdAt desc limit 1")
    .get();
  const user = db.query('select email from "user" limit 1').get();
  db.close();
  if (!row?.token) throw new Error("no session row in the local dev D1");
  return {
    value: `${row.token}.${createHmac("sha256", secret).update(row.token).digest("base64")}`,
    emailHint: String(user?.email ?? "").replace(/[^@]*@/, "***@"),
  };
}

const cookie = ownerCookie();
console.log(`signed in as the owner account (${cookie.emailHint}) via the local session row`);

const context = await chromium.launchPersistentContext(PROFILE, {
  headless: process.env.CADDIE_WALK_HEADED === "1" ? false : true,
  viewport: { width: Number(process.env.CADDIE_WALK_W ?? 1280), height: Number(process.env.CADDIE_WALK_H ?? 900) },
  deviceScaleFactor: 1,
});
await context.addCookies([
  { name: "better-auth.session_token", value: cookie.value, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
]);
const page = context.pages()[0] ?? (await context.newPage());
const problems = [];
page.on("console", (m) => {
  if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));

async function report(label) {
  await page.waitForTimeout(HOLD_MS);
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\n{3,}/g, "\n\n");
  console.log(`\n--- ${label} @ ${page.url()}`);
  console.log(text.slice(0, 6000));
  const shots = `${OUT}/${label}.png`;
  await page.screenshot({ path: shots, fullPage: true }).catch((e) => console.log("screenshot failed", e.message));
  console.log(`shot: ${shots}`);
  if (problems.length) console.log(`problems:\n${problems.join("\n")}`);
}

// Every command starts from this screen: this is a fresh browser each run, so
// the walk has to arrive at the page before it can act on it.
const START = process.env.CADDIE_WALK_URL ?? `${BASE}/app/`;
await page.goto(START, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(Number(process.env.CADDIE_WALK_SETTLE ?? 12000));

if (APP === "poll") {
  // One browser stays open: the client's Agents websocket is what keeps the
  // coordinator Durable Object warm, so polling must not churn contexts.
  const project = process.env.CADDIE_WALK_PROJECT;
  if (project) await page.goto(`${BASE}/app/project?project=${project}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const deadline = Date.now() + Number(ARG ?? 600) * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    const phase = /(\d\s*Plan[^0-9]{0,60})/.exec(text)?.[1]?.trim() ?? "";
    const cards = await page.locator('[data-testid="decision-card"]').evaluateAll((els) =>
      els.map((el) => `${el.dataset.kind}:${el.querySelector('[data-testid="card-primary-action"]')?.textContent?.trim() ?? "no action"}`),
    ).catch(() => []);
    const gate = cards.length ? cards.join(" | ") : "";
    const tail = text.slice(-320);
    const line = `${new Date().toISOString().slice(11, 19)} gate=${gate || "-"} ${phase || "-"} :: ${tail}`;
    if (line !== last) {
      console.log(line);
      // Append synchronously so a backgrounded poll is readable while it runs.
      appendFileSync(`${OUT}/poll.log`, `${line}\n`);
      last = line;
    }
    if (/approve|building|preview ready|ready to check/i.test(gate)) { console.log(`GATE SEEN: ${gate}`); break; }
    await page.waitForTimeout(30000);
  }
  await report("poll-end");
} else if (APP === "hist") {
  // TEMP: read the coordinator's own stored history straight off its endpoint and
  // print the last entries with their wire classification, to answer "did my
  // message reach the agent?" without trusting what the page renders.
  const conv = process.env.CADDIE_WALK_CONV;
  const res = await page.request.get(`${BASE}/agents/coordinator/${conv}`, { headers: { cookie: `better-auth.session_token=${cookie.value}` } });
  const raw = String(await res.text().catch(() => ""));
  let json = null;
  try { json = JSON.parse(raw); } catch { console.log(`status ${res.status()} unparsed ${raw.slice(0, 200)}`); }
  const arr = Array.isArray(json) ? json : Array.isArray(json?.entries) ? json.entries : Array.isArray(json?.messages) ? json.messages : [];
  console.log(`status ${res.status()} keys=${json && typeof json === "object" ? Object.keys(json).join(",") : "-"} n=${arr.length}`);
  console.log(`MSGKEYS=${JSON.stringify(Object.keys(arr[arr.length - 1] ?? {}))} SUB=${JSON.stringify(Object.keys((arr[arr.length - 1]?.message) ?? {}))}`);
  for (const e of arr.slice(-Number(ARG ?? 12))) {
    const text = (e.parts ?? []).map((p) => (typeof p === "string" ? p : (p?.text ?? JSON.stringify(p).slice(0, 120)))).join(" ");
    console.log([e.timestamp ?? "-", e.role, e.purpose, e.display, JSON.stringify(text.slice(0, 500))].join(" | "));
  }
} else if (APP === "page") {
  await page.goto(`${BASE}/app/${ARG ?? ""}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await report("page");
} else if (APP === "send") {
  await page.locator('[data-testid="composer-input"]').fill(ARG ?? "");
  await page.locator('[data-testid="composer-send"]').click();
  await report("after-send");
} else if (APP === "drive") {
  // Send, then KEEP this browser attached until the step settles. Closing the
  // context mid-turn interrupts the stream, and an interrupted turn keeps its
  // worst-case reservation (by design) — which ate half a fresh $1.00
  // preparation window live on 2026-10-28 at 19:10Z.
  const seconds = Number(process.argv[4] ?? 420);
  await page.locator('[data-testid="composer-input"]').fill(ARG ?? "");
  await page.locator('[data-testid="composer-send"]').click();
  const deadline = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    await page.waitForTimeout(20000);
    const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    const cards = await page.locator('[data-testid="decision-card"]').evaluateAll((els) =>
      els.map((el) => `${el.dataset.kind}:${el.querySelector('[data-testid="card-primary-action"]')?.textContent?.trim() ?? "no action"}`),
    ).catch(() => []);
    const phase = /(\d\s*(?:Plan|Looks|Design|Build)[^0-9]{0,50})/.exec(text)?.[1]?.trim() ?? "-";
    const sig = `${cards.join("|")}|${phase}`;
    const tail = text.slice(-360);
    const line = `${new Date().toISOString().slice(11, 19)} gate=${sig} :: ${tail}`;
    if (line !== last) {
      console.log(line);
      appendFileSync(`${OUT}/drive.log`, `${line}\n`);
      last = line;
    }
    if (/Choose a look/.test(text)) { console.log("PICKER READY"); break; }
    if (/were not saved|could not finish|hit a problem/i.test(tail)) { console.log("TURN FAILED"); break; }
  }
  await report("after-drive");
} else if (APP === "leak") {
  // Measure the same project on both sides of the display boundary: what the
  // server stores, and what a person's browser actually shows.
  const words = ["tier:", "a deep answer", "a quick answer", "nemotron", "token factory", "c.env.caddie.ai", "super tier", "fast tier"];
  const count = (hay) => words.map((w) => `${w}=${hay.split(w).length - 1}`).join(" ");
  const conv = process.env.CADDIE_WALK_CONV;
  if (conv) {
    const res = await page.request.get(`${BASE}/agents/coordinator/${conv}`, { headers: { cookie: `better-auth.session_token=${cookie.value}` } });
    const body = String(await res.text().catch(() => "")).toLowerCase();
    console.log(`RAW  (${res.status()}): ${count(body)}`);
  }
  await page.waitForTimeout(Number(ARG ?? 15000));
  const dom = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  console.log(`DOM  : ${count(dom)}`);
  await report("leak-boundary");
} else if (APP === "click") {
  const byRole = page.getByRole("button", { name: ARG, exact: false }).or(page.getByRole("link", { name: ARG, exact: false }));
  await byRole.first().scrollIntoViewIfNeeded().catch(() => {});
  await byRole.first().click({ timeout: 30000 });
  await report(`click-${ARG.slice(0, 18).replace(/\W+/g, "-")}`);
} else if (APP === "dom") {
  await page.goto(process.env.CADDIE_WALK_DOM_URL ?? START, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(Number(ARG ?? 12000));
  const info = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[data-testid]")].map((el) => `${el.tagName.toLowerCase()}#${el.getAttribute("data-testid")}`);
    const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent?.trim().slice(0, 40)).filter(Boolean);
    return { ids: [...new Set(ids)], buttons: buttons.slice(0, 60), frames: window.frames.length, iframes: document.querySelectorAll("iframe").length };
  });
  console.log(JSON.stringify(info, null, 1));
} else if (APP === "testid") {
  const target = page.locator(`[data-testid="${ARG}"]`).first();
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 30000 });
  await report(`tap-${ARG}`);
} else if (APP === "wait") {
  await report(`wait-${ARG}s`);
} else if (APP === "shot") {
  await page.screenshot({ path: `${OUT}/${ARG}.png`, fullPage: true });
  console.log(`shot: ${OUT}/${ARG}.png`);
} else {
  await page.goto(`${BASE}/app/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await report("state");
}

await context.close();
