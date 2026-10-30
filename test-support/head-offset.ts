/** TEMP (not committed): why the project header sits 10px higher on the
 *  Preview tab than on the other project tabs. Prints the geometry and the
 *  computed spacing of the shells around it on both routes. */
import { createHmac } from 'node:crypto';
import { chromium } from '@playwright/test';

const BASE = process.env.CADDIE_DEV_BASE ?? 'http://localhost:5176';
const project = process.env.CADDIE_PROJECT ?? 'proj_506d61ece6d7ca3a12fdd9a41a281960';
const token = process.env.SESSION_TOKEN;
const secret = process.env.BETTER_AUTH_SECRET;
if (!token || !secret) { console.error('need SESSION_TOKEN and BETTER_AUTH_SECRET'); process.exit(3); }
const signed = `${token}.${createHmac('sha256', secret).update(token).digest('base64')}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: Number(process.env.CADDIE_WIDTH ?? 1280), height: Number(process.env.CADDIE_HEIGHT ?? 900) } });
await context.addCookies([{ name: 'better-auth.session_token', value: signed, domain: 'localhost', path: '/' }]);
const page = await context.newPage();

const read = () => page.evaluate(() => {
  const info = (el: Element | null) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      tag: `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className ?? '').split(' ').filter(Boolean).slice(0, 3).join('.')}`,
      top: Math.round(box.top), height: Math.round(box.height),
      padTop: cs.paddingTop, padBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom,
      gap: cs.rowGap, display: cs.display, alignContent: cs.alignContent, scrollTop: (el as HTMLElement).scrollTop,
    };
  };
  const head = document.querySelector('.project-head');
  const chain: ReturnType<typeof info>[] = [];
  let node: Element | null = head;
  while (node && chain.length < 6) { chain.push(info(node)); node = node.parentElement; }
  return chain;
});

for (const path of [`/app/runs?project=${project}`, `/app/project?project=${project}`, `/app/preview?project=${project}`]) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.project-head', { timeout: 30_000 });
  await page.waitForTimeout(1500);
  console.log(`\n=== ${path}`);
  for (const row of await read()) console.log(JSON.stringify(row));
}
await browser.close();
