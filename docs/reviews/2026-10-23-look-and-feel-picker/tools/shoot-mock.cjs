// Screenshots the look-and-feel picker mock with Caddie's real built CSS.
// Uses the repo's own @playwright/test chromium (playwright-cli's crashes here).
// Run from the repo root after `bun run build`: node docs/reviews/2026-10-23-look-and-feel-picker/tools/shoot-mock.cjs
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const here = path.join(__dirname, '..');
const repo = path.join(here, '../../..');
const { chromium } = createRequire(path.join(repo, 'package.json'))('@playwright/test');

const mockHtml = path.join(here, 'mock/look-and-feel-picker-mock.html');
const shots = path.join(here, 'shots');
const assets = path.join(repo, 'apps/app/dist/client/assets');
const css = fs.readdirSync(assets).find((f) => /^index-.*\.css$/.test(f));
const ORIGIN = 'http://caddie.mock';

async function serve(context) {
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ path: mockHtml, contentType: 'text/html' });
    if (url.pathname === '/caddie.css') return route.fulfill({ path: path.join(assets, css), contentType: 'text/css' });
    if (url.pathname.startsWith('/assets/')) {
      const file = path.join(assets, path.basename(url.pathname));
      if (fs.existsSync(file)) return route.fulfill({ path: file });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

function measure() {
  const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => {
    const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return +((x + 0.05) / (y + 0.05)).toFixed(2); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return b; } return 'rgb(255,255,255)'; };
  const pair = (el) => ratio(getComputedStyle(el).color, bgOf(el));
  const contrast = {};
  for (const app of document.querySelectorAll('.app')) {
    const q = (s) => app.querySelector(s);
    contrast[app.dataset.look] = {
      title: pair(q('.app-title')), muted: pair(q('.app-kicker')), statLabel: pair(q('.app-stats span')),
      alert: pair(q('.app-alert span')), micLabel: pair(q('.app-mic')), task: pair(q('.app-tasks em')),
    };
  }
  const targets = [...document.querySelectorAll('.look-option, .look-switch button, .row-actions button, .look-for a, .project-step, .project-back, .project-head-settings')]
    .filter((el) => el.getClientRects().length)
    .map((el) => ({ el: el.className || el.tagName, h: Math.round(el.getBoundingClientRect().height) }))
    .filter((t) => t.h < 44);
  return { overflowX: document.documentElement.scrollWidth - window.innerWidth, contrast, smallTargets: targets };
}

(async () => {
  const browser = await chromium.launch();
  try {
    for (const [name, width, height] of [['desktop', 1280, 900], ['phone', 390, 1600]]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
      await serve(context);
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/`);
      await page.evaluate(() => document.fonts.ready);
      console.log(name, JSON.stringify(await page.evaluate(measure)));
      await page.screenshot({ path: path.join(shots, `mock-${name}.png`), fullPage: name === 'desktop' });
      if (name === 'phone') {
        // Tap the second look's name, then also swipe to the third, checking state follows the view.
        await page.click('.look-switch [data-go="calm"]');
        const settled = await page.evaluate(() => new Promise((resolve) => {
          const t = document.querySelector('.look-track');
          let last = -1, still = 0; const start = performance.now();
          const tick = () => {
            if (t.scrollLeft === last) still += 1; else { still = 0; last = t.scrollLeft; }
            if (still >= 8 || performance.now() - start > 4000) return resolve({ scrollLeft: t.scrollLeft, ms: Math.round(performance.now() - start) });
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }));
        console.log('phone-settled', JSON.stringify(settled));
        const afterTap = await page.evaluate(() => ({
          button: document.getElementById('look-use').textContent,
          pressed: document.querySelector('.look-switch [aria-pressed="true"]').dataset.go,
          checked: document.querySelector('.look-option input:checked').value,
        }));
        await page.screenshot({ path: path.join(shots, 'mock-phone-after-tap.png') });
        await page.evaluate(() => { const t = document.querySelector('.look-track'); t.scrollTo({ left: t.scrollWidth, behavior: 'auto' }); });
        await page.waitForTimeout(400);
        const afterSwipe = await page.evaluate(() => ({
          button: document.getElementById('look-use').textContent,
          pressed: document.querySelector('.look-switch [aria-pressed="true"]').dataset.go,
          checked: document.querySelector('.look-option input:checked').value,
        }));
        console.log('phone-state', JSON.stringify({ afterTap, afterSwipe }));
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
