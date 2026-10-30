import { chromium } from '@playwright/test';

const base = process.env.BASE ?? 'http://127.0.0.1:4173';
const widths = [390, 1280];

type Row = Record<string, string | number | null>;

async function measure(page: import('@playwright/test').Page, selectors: string[]): Promise<Row[]> {
	return page.evaluate((sels) => {
		return sels.map((sel) => {
			const el = document.querySelector(sel);
			if (!el) return { sel, missing: true };
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return {
				sel,
				y: Math.round(r.top),
				h: Math.round(r.height),
				w: Math.round(r.width),
				fs: cs.fontSize,
				fw: cs.fontWeight,
				lh: cs.lineHeight === 'normal' ? 'normal' : `${Math.round(Number.parseFloat(cs.lineHeight))}px`,
				ls: cs.letterSpacing,
				mt: cs.marginTop,
				mb: cs.marginBottom,
				pt: cs.paddingTop,
				pb: cs.paddingBottom,
				gap: cs.rowGap,
			};
		});
	}, selectors);
}

function print(label: string, rows: Row[]) {
	console.log(`\n== ${label} ==`);
	for (const row of rows) {
		if (row.missing) {
			console.log(`  ${row.sel}: MISSING`);
			continue;
		}
		console.log(
			`  ${String(row.sel).padEnd(38)} y=${String(row.y).padStart(4)} h=${String(row.h).padStart(3)} w=${String(row.w).padStart(3)} fs=${String(row.fs).padStart(6)} fw=${String(row.fw).padStart(3)} lh=${String(row.lh).padStart(6)} ls=${String(row.ls).padStart(8)} mt=${row.mt} mb=${row.mb} pt=${row.pt} pb=${row.pb} gap=${row.gap}`,
		);
	}
}

const panelSelectors = [
	'.signin-card',
	'[data-testid="judge-panel"]',
	'.judge-panel-head',
	'.judge-access-kicker',
	'.judge-panel-title',
	'.judge-panel-lede',
	'.judge-access-form',
	'.judge-field',
	'.judge-field > span',
	'.judge-field .input',
	'.judge-field small',
	'.judge-access-submit',
	'[data-testid="judge-returning-link"]',
	'[data-testid="judge-new-link"]',
	'[data-testid="judge-back"]',
	'.signin-note',
];

const browser = await chromium.launch();
for (const width of widths) {
	const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
	const page = await context.newPage();
	await page.goto(`${base}/app/`, { waitUntil: 'networkidle' });
	await page.getByTestId('sign-in-panel').waitFor({ state: 'visible' });
	print(`sign-in card (control) @${width}`, await measure(page, ['.signin-card', '.signin-brand h1', '.signin-lede', '.signin-card .input', '.signin-card button']));

	await page.getByTestId('judge-link').click();
	await page.getByTestId('judge-panel').waitFor({ state: 'visible' });
	print(`judge first @${width}`, await measure(page, panelSelectors));

	await page.getByTestId('judge-returning-link').click();
	await page.getByTestId('judge-sign-in-form').waitFor({ state: 'visible' });
	print(`judge returning @${width}`, await measure(page, panelSelectors));

	await context.close();
}
await browser.close();
