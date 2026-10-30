import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const cookieDomain = new URL(BASE).hostname;
const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: cookieDomain, path: '/' }]);
const page = await context.newPage();
await page.goto(`${BASE}/app/onboarding`, { waitUntil: 'load' });
await page.getByTestId('welcome-next').click();
await page.getByTestId('welcome-name-skip').click();
await page.getByTestId('onboarding-profile').waitFor({ state: 'visible' });
await page.getByLabel('Country').fill('Nigeria');
await page.getByTestId('onboarding-profile-continue').click();
await page.getByTestId('onboarding-experience').waitFor({ state: 'visible' });
await page.waitForTimeout(400);
await page.screenshot({ path: 'test-support/onboarding-step2-390.png' });

await page.getByTestId('onboarding-experience').getByRole('radio', { name: 'A few apps' }).check();
await page.getByTestId('onboarding-format').getByRole('radio', { name: 'Either' }).check();
await page.getByTestId('onboarding-interests').getByRole('button', { name: 'AI & agents' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: 'test-support/onboarding-step2-picked-390.png' });

const metrics = await page.evaluate(() => {
  const root = document.querySelector('[data-testid="onboarding-profile"]')!;
  const rows = [...root.querySelectorAll('legend, .segment-option, .chip, .btn-key, .onboarding-quick-note, .onboarding-lede, .onboarding-title')];
  return rows.map((el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: el.className,
      text: (el.textContent ?? '').trim().slice(0, 30),
      fs: s.fontSize,
      fw: s.fontWeight,
      w: Math.round(r.width),
      h: Math.round(r.height),
      right: Math.round(r.right),
    };
  });
});
console.log(JSON.stringify(metrics, null, 1));
await context.close();
await browser.close();
