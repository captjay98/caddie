import { chromium, type BrowserContext } from '@playwright/test';
const BASE = process.env.CADDIE_STUB_BASE ?? 'http://127.0.0.1:4173';
const NOW = '2026-10-11T10:00:00.000Z';
const HOME = { id:'home-1',workspaceId:'ws-1',name:'Home',description:null,contestId:null,contestUrl:null,status:'active',kind:'home',createdAt:NOW,updatedAt:NOW };
const json = (r:any,s:number,b:unknown) => r.fulfill({ status:s, contentType:'application/json', body: JSON.stringify(b) });
async function stub(c: BrowserContext) {
  await c.route('**/api/auth/status', r => json(r,200,{authenticated:true}));
  await c.route('**/api/auth/get-session', r => json(r,200,{session:{userId:'a'},user:{id:'a',name:'Ada Lovelace',email:'a@b.c'}}));
  await c.route('**/api/home-project', r => json(r,200,{project:HOME}));
  await c.route('**/api/profile', r => json(r,200,{profile:null}));
  await c.route('**/api/brief/read', r => json(r,200,{marked:0}));
  await c.route('**/api/brief', r => json(r,200,{cards:[],unseenCount:0,projects:[{id:'home-1',name:'Home',kind:'home'}],asOf:NOW}));
  await c.route('**/api/projects', r => json(r,200,{projects:[HOME]}));
  await c.route('**/api/projects/**', r => json(r,200,{}));
  await c.route('**/api/onboarding', r => json(r,200,{completedAt:null}));
}
// Quiet rows: no boxes, hairlines + a radio dot. Chips stay, but selection is
// tonal so the CTA is the only solid accent on the card.
const QUIET = `
.onboarding-quick-picks .segment-options { display: grid; grid-template-columns: 1fr; gap: 0; padding: 0; border: 0; background: none; }
.onboarding-quick-picks .segment-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 0 2px; border: 0; border-top: 1px solid var(--color-line); border-radius: 0; background: none; font-size: 15px; white-space: normal; text-align: left; }
.onboarding-quick-picks .segment-option:last-of-type { border-bottom: 1px solid var(--color-line); }
.onboarding-quick-picks .segment-option:hover { background: none; color: var(--color-bright); }
.onboarding-quick-picks .segment-option::after { content: ''; flex: none; width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--color-line); }
.onboarding-quick-picks .segment-option[data-selected='true'] { background: none; box-shadow: none; color: var(--color-bright); font-weight: 600; }
.onboarding-quick-picks .segment-option[data-selected='true']::after { border-color: var(--color-action); background: radial-gradient(circle, var(--color-action) 0 5px, transparent 5.5px); }
#note-off .onboarding-quick-note { display: none; }
.onboarding-quick-picks .onboarding-chips .chip-on { background: color-mix(in srgb, var(--color-action) 18%, transparent); border-color: color-mix(in srgb, var(--color-action) 60%, transparent); color: var(--color-bright); }
`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await stub(context);
const page = await context.newPage();
await page.goto(`${BASE}/app/onboarding`);
await page.getByTestId('welcome-next').click();
await page.getByTestId('welcome-name-skip').click();
await page.getByLabel('Country').fill('Nigeria');
await page.getByTestId('onboarding-profile-continue').click();
await page.getByTestId('onboarding-experience').waitFor({ state: 'visible' });
await page.addStyleTag({ content: QUIET });
await page.waitForTimeout(200);
await page.screenshot({ path: 'test-support/onboarding-quiet-390.png' });
await page.getByTestId('onboarding-experience').getByRole('radio', { name: 'A few apps' }).click();
await page.getByTestId('onboarding-format').getByRole('radio', { name: 'Either' }).click();
await page.getByTestId('onboarding-interests').getByRole('button', { name: 'AI & agents' }).click();
await page.waitForTimeout(250);
await page.screenshot({ path: 'test-support/onboarding-quiet-picked-390.png' });
const fit = await page.evaluate(() => {
  const card = document.querySelector('[data-testid="onboarding-profile"]')!.getBoundingClientRect();
  const finish = document.querySelector('[data-testid="onboarding-profile-save"]')!.getBoundingClientRect();
  const row = document.querySelector('[data-testid="onboarding-experience"] .segment-option')!.getBoundingClientRect();
  return { cardHeight: Math.round(card.height), ctaBottom: Math.round(finish.bottom), viewport: innerHeight, ctaFits: finish.bottom <= innerHeight, rowHeight: Math.round(row.height), docScroll: document.documentElement.scrollHeight };
});
console.log(JSON.stringify(fit, null, 1));
await browser.close();
