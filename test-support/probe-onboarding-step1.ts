import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://127.0.0.1:4173';
const cookieDomain = new URL(BASE).hostname;
const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: cookieDomain, path: '/' }]);
const page = await context.newPage();
await page.goto(`${BASE}/app/onboarding`, { waitUntil: 'networkidle' });
await page.getByTestId('welcome-next').click();
await page.getByTestId('welcome-name-skip').click();
await page.getByTestId('onboarding-profile').waitFor({ state: 'visible' });
await page.waitForTimeout(300);
await page.screenshot({ path: 'test-support/onboarding-step1-390.png' });

await page.getByTestId('onboarding-profile-continue').click();
await page.waitForTimeout(200);
await page.screenshot({ path: 'test-support/onboarding-step1-error-390.png' });

await page.getByLabel('Country').fill('Nigeria');
await page.waitForTimeout(200);
await page.screenshot({ path: 'test-support/onboarding-step1-filled-390.png' });
console.log('ok', await page.getByTestId('onboarding-profile').boundingBox());
await context.close();
await browser.close();
