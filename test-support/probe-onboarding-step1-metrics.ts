import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://127.0.0.1:4173';
const cookieDomain = new URL(BASE).hostname;
const token = process.env.SESSION_TOKEN!;
const secret = process.env.BETTER_AUTH_SECRET!;
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const selectors = [
	'[data-testid="onboarding-profile"]',
	'.onboarding-head',
	'.onboarding-title-row',
	'.onboarding-title',
	'.onboarding-lede',
	'.onboarding-fieldgroup',
	'.onboarding-field',
	'.onboarding-field > small',
	'.onboarding-field .input',
	'.onboarding-zone',
	'.onboarding-zone > label',
	'.onboarding-zone .input',
	'.onboarding-zone small',
	'.onboarding-step-actions',
	'.onboarding-step-actions .btn-key',
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: cookieDomain, path: '/' }]);
const page = await context.newPage();
await page.goto(`${BASE}/app/onboarding`, { waitUntil: 'networkidle' });
await page.getByTestId('welcome-next').click();
await page.getByTestId('welcome-name-skip').click();
await page.getByTestId('onboarding-profile').waitFor({ state: 'visible' });
await page.waitForTimeout(250);

const rows = await page.evaluate((sels) => sels.map((sel) => {
	const el = document.querySelector(sel);
	if (!el) return { sel, missing: true };
	const cs = getComputedStyle(el);
	const r = el.getBoundingClientRect();
	return {
		sel,
		y: Math.round(r.top),
		bottom: Math.round(r.bottom),
		h: Math.round(r.height),
		fs: cs.fontSize,
		fw: cs.fontWeight,
		lh: cs.lineHeight === 'normal' ? 'normal' : `${Math.round(Number.parseFloat(cs.lineHeight))}px`,
		mt: cs.marginTop,
		mb: cs.marginBottom,
		pt: cs.paddingTop,
		pb: cs.paddingBottom,
		gap: cs.rowGap,
		color: cs.color,
	};
}), selectors);

for (const row of rows) {
	if ((row as { missing?: boolean }).missing) {
		console.log(`  ${row.sel}: MISSING`);
		continue;
	}
	console.log(`  ${String(row.sel).padEnd(40)} y=${String(row.y).padStart(4)} b=${String(row.bottom).padStart(4)} h=${String(row.h).padStart(3)} fs=${String(row.fs).padStart(6)} fw=${String(row.fw).padStart(3)} lh=${String(row.lh).padStart(6)} mt=${row.mt} mb=${row.mb} gap=${row.gap}`);
}

// Gaps between consecutive blocks.
const gaps = await page.evaluate(() => {
	const pick = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
	const lede = pick('.onboarding-lede');
	const field = pick('.onboarding-field');
	const zone = pick('.onboarding-zone');
	const actions = pick('.onboarding-step-actions');
	return {
		ledeToField: lede && field ? Math.round(field.top - lede.bottom) : null,
		fieldToZone: field && zone ? Math.round(zone.top - field.bottom) : null,
		zoneToActions: zone && actions ? Math.round(actions.top - zone.bottom) : null,
	};
});
console.log('\ngaps:', gaps);
await context.close();
await browser.close();
