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
  await context.route('**/api/onboarding', (route) => json(route, 200, { completedAt: NOW }));
}

const ROUTES: Array<[string, string]> = [
  ['brief', '/'],
  ['discover', '/discover'],
  ['projects', '/projects'],
  ['project', '/project?project=home-1'],
  ['settings', '/settings'],
  ['submission', '/submission'],
  ['usage', '/usage'],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await stubAccount(context);
const page = await context.newPage();

for (const [name, path] of ROUTES) {
  await page.goto(`${BASE}/app${path}`);
  await page.waitForTimeout(900);
  const report = await page.evaluate(() => {
    const main = document.querySelector('main#main');
    if (!main) return { error: 'no main' };
    const target = [...main.querySelectorAll('h1, h2, p')].find((el) => (el.textContent ?? '').trim().length > 12) as HTMLElement | undefined;
    if (!target) return { error: 'no text' };
    const stack: unknown[] = [];
    let el: HTMLElement | null = target;
    while (el) {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      stack.push({
        cls: typeof el.className === 'string' && el.className ? el.className : el.tagName.toLowerCase(),
        padL: s.paddingLeft, marL: s.marginLeft,
        x: Math.round(r.x), w: Math.round(r.width),
      });
      if (el === main) break;
      el = el.parentElement;
    }
    const r = target.getBoundingClientRect();
    const padded = [...main.querySelectorAll('*')].filter((el) => {
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 3);
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return hasText && box.width > 120 && (parseFloat(s.paddingLeft) >= 19 || parseFloat(s.paddingRight) >= 19);
    }).slice(0, 8).map((el) => {
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return {
        cls: typeof el.className === 'string' && el.className ? el.className : el.tagName.toLowerCase(),
        pad: `${s.paddingLeft}/${s.paddingRight}`,
        x: Math.round(box.x), w: Math.round(box.width),
      };
    });
    const rect = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return { x: Math.round(b.x), right: Math.round(innerWidth - b.right), w: Math.round(b.width), pad: s.padding, margin: s.margin };
    };
    return {
      viewport: innerWidth,
      sample: (target.textContent ?? '').trim().slice(0, 40),
      text: { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(innerWidth - r.right) },
      frame: {
        main: rect('.shell-main'),
        pageCol: rect('.page-col'),
        capsule: rect('.nav-capsule'),
        mobileHeader: rect('.mobile-header'),
        bottomNav: rect('.bottom-nav'),
        composer: rect('.bottom-nav-composer'),
        navRow: rect('.bottom-nav-row'),
      },
      stack, padded,
    };
  });
  console.log(`\n== ${name} ${path}`);
  console.log(JSON.stringify(report, null, 1));
  await page.screenshot({ path: `test-support/frame-${name}-390.png` });
}

await context.close();
await browser.close();
