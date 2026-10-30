import { chromium, type BrowserContext } from '@playwright/test';

const BASE = process.env.CADDIE_STUB_BASE ?? 'http://127.0.0.1:4173';
const NOW = '2026-10-11T10:00:00.000Z';
const HOME = {
  id: 'home-1', workspaceId: 'ws-1', name: 'Home', description: null, contestId: null,
  contestUrl: null, status: 'active', kind: 'home', createdAt: NOW, updatedAt: NOW,
};

function json(route: { fulfill(options: Record<string, unknown>): unknown }, status: number, body: unknown) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function stubAccount(context: BrowserContext) {
  await context.route('**/api/auth/status', (route) => json(route, 200, { authenticated: true }));
  await context.route('**/api/auth/get-session', (route) =>
    json(route, 200, { session: { userId: 'actor-test' }, user: { id: 'actor-test', name: 'Ada Lovelace', email: 'user@example.com' } }),
  );
  await context.route('**/api/home-project', (route) => json(route, 200, { project: HOME }));
  await context.route('**/api/profile', (route) => json(route, 200, { profile: null }));
  await context.route('**/api/brief/read', (route) => json(route, 200, { marked: 0 }));
  await context.route('**/api/brief', (route) =>
    json(route, 200, { cards: [], unseenCount: 0, projects: [{ id: 'home-1', name: 'Home', kind: 'home' }], asOf: NOW }),
  );
  await context.route('**/api/projects', (route) => json(route, 200, { projects: [HOME] }));
  await context.route('**/api/projects/**', (route) => json(route, 200, {}));
  await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: null }));
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await stubAccount(context);
const page = await context.newPage();
await page.goto(`${BASE}/app/onboarding`);
await page.getByTestId('welcome-next').click();
await page.getByTestId('welcome-name-skip').click();
await page.getByLabel('Country').fill('Nigeria');
await page.waitForTimeout(200);
await page.screenshot({ path: 'test-support/onboarding-step1-frame-390.png' });
await page.getByTestId('onboarding-profile-continue').click();
await page.getByTestId('onboarding-experience').waitFor({ state: 'visible' });
await page.waitForTimeout(400);
await page.screenshot({ path: 'test-support/onboarding-step2-quiet-390.png' });

await page.getByTestId('onboarding-experience').getByRole('radio', { name: 'A few apps' }).click();
await page.getByTestId('onboarding-format').getByRole('radio', { name: 'Either' }).click();
await page.getByTestId('onboarding-interests').getByRole('button', { name: 'AI & agents' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: 'test-support/onboarding-step2-quiet-picked-390.png' });

const metrics = await page.evaluate(() => {
  const root = document.querySelector('[data-testid="onboarding-profile"]')!;
  return [...root.querySelectorAll('.segment-option')].map((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const label = el.querySelector('.segment-label')!;
    const range = document.createRange();
    range.selectNodeContents(label);
    const t = range.getBoundingClientRect();
    const ls = getComputedStyle(label);
    return {
      text: (label.textContent ?? '').trim(),
      display: s.display, align: s.alignItems, alignContent: s.alignContent,
      justify: s.justifyItems, lineHeight: s.lineHeight, labelLH: ls.lineHeight, labelDisplay: ls.display,
      pad: s.padding,
      btn: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), cx: +(r.x + r.width / 2).toFixed(1), cy: +(r.y + r.height / 2).toFixed(1) },
      textBox: { x: +t.x.toFixed(1), w: +t.width.toFixed(1), y: +t.y.toFixed(1), h: +t.height.toFixed(1), cx: +(t.x + t.width / 2).toFixed(1), cy: +(t.y + t.height / 2).toFixed(1) },
      dx: +((t.x + t.width / 2) - (r.x + r.width / 2)).toFixed(2),
      dy: +((t.y + t.height / 2) - (r.y + r.height / 2)).toFixed(2),
    };
  });
});
const frame = await page.evaluate(() => {
  const card = document.querySelector('.onboarding-card') as HTMLElement;
  const rows: unknown[] = [];
  let el: HTMLElement | null = card;
  for (let i = 0; i < 5 && el && el !== document.body; i++) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    rows.push({
      cls: el.className || el.tagName.toLowerCase(),
      x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      pad: s.padding, margin: s.margin, maxWidth: s.maxWidth,
    });
    el = el.parentElement;
  }
  const inner = card.querySelector('.onboarding-step-actions')!.getBoundingClientRect();
  return { viewport: { w: innerWidth, h: innerHeight }, chain: rows };
});
console.log(JSON.stringify(frame, null, 1));
console.log(JSON.stringify(metrics, null, 1));
await context.close();
await browser.close();
