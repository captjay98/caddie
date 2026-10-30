/** TEMP (not committed): does the in-app preview frame actually load on the
 *  live local servers (built 4173 vs dev 5176)? */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const path = process.argv[2] ?? '/app/preview?project=proj_506d61ece6d7ca3a12fdd9a41a281960';
const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch({ headless: true });
for (const base of ['http://127.0.0.1:4173', 'http://localhost:5176']) {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: new URL(base).hostname, path: '/' }]);
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 120)); });
	let status = 'n/a';
	try {
		const response = await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
		status = String(response?.status());
		await page.waitForTimeout(4000);
	} catch (error) {
		status = `goto failed: ${String(error).slice(0, 80)}`;
	}
	const state = await page.evaluate(() => {
		const text = document.body.innerText.replace(/\s+/g, ' ').slice(0, 240);
		const frames = [...document.querySelectorAll('iframe')].map((frame) => ({ title: frame.getAttribute('title') ?? '', src: (frame.getAttribute('src') ?? '').slice(0, 80) }));
		return { text, frames, alert: document.querySelector('[role="alert"]')?.textContent?.trim().slice(0, 140) ?? null };
	}).catch(() => ({ text: 'evaluate failed', frames: [], alert: null }));
	console.log(`${base} status=${status}`);
	console.log(`  text: ${state.text}`);
	console.log(`  frames: ${JSON.stringify(state.frames)}`);
	console.log(`  alert: ${state.alert}`);
	if (errors.length) console.log(`  console errors: ${JSON.stringify(errors.slice(0, 3))}`);
	await context.close();
}
await browser.close();
