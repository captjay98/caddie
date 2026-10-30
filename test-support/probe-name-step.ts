import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';
const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
const page = await context.newPage();
await page.goto('http://localhost:5176/app/onboarding', { waitUntil: 'networkidle' });
await page.getByRole('radio', { name: 'I have an idea' }).check();
await page.getByTestId('welcome-next').click();
await page.getByTestId('welcome-name').waitFor();
await page.waitForTimeout(400);
console.log(await page.evaluate(() => {
	const r = (sel: string) => {
		const el = document.querySelector(sel) as HTMLElement;
		const b = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), display: cs.display, width: cs.width, cols: cs.gridTemplateColumns, flow: cs.gridAutoFlow };
	};
	return {
		actions: r('[data-testid=welcome-name] .row-actions'),
		primary: r('[data-testid=welcome-name-save]'),
		skip: r('[data-testid=welcome-name-skip]'),
		card: r('[data-testid=welcome-name]'),
	};
}));
await browser.close();
