import { chromium } from '@playwright/test';
const targets: Array<[string, string]> = [
  ['https://mobbin.com/browse/ios/flows/onboarding', 'test-support/ref-mobbin-flow.png'],
  ['https://dribbble.com/search/survey-options', 'test-support/ref-dribbble-survey.png'],
];
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 1700 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
for (const [url, path] of targets) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(6000);
    await page.screenshot({ path, fullPage: false });
    console.log(`${url} -> ${await page.title()}`);
  } catch (error) {
    console.log(`${url} -> ERROR ${(error as Error).message.split('\n')[0]}`);
  }
  await page.close();
}
await context.close();
await browser.close();
