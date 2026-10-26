/** Local QA adapter: real Chromium PNGs, isolated generated HTML, no network.
 * Pixel differences detect visual drift; they are NOT a semantic design review
 * or proof of saving, navigation, offline behavior, or backend integrations.
 * Production Workers must supply their own host-owned browser adapter.
 */
import { chromium, type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { previewDocument as isolatedBuiltDocument } from '../apps/app/src/shared/preview-frame.ts';
import { documentHash, type FidelityPort, type VisualCapture, type VisualDifference } from '../apps/app/src/server/visual-fidelity.ts';

export async function openLocalVisualFidelity(options: { directory: string; browser?: Browser; maxChangedFraction?: number }) {
  const maximum = options.maxChangedFraction ?? 0.015;
  if (!Number.isFinite(maximum) || maximum < 0 || maximum > 0.05) throw new Error('The local appearance tolerance must be between 0 and 5%.');
  const browser = options.browser ?? await chromium.launch({ headless: true });
  const owned = !options.browser;
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const images = new Map<string, { bytes: Buffer; overflow: boolean; errors: string[] }>();
  const remember=(artifact:string,value:{bytes:Buffer;overflow:boolean;errors:string[]})=>{images.delete(artifact);images.set(artifact,value);let bytes=0;for(const entry of images.values())bytes+=entry.bytes.length;while(images.size>128||bytes>96*1024*1024){const oldest=images.keys().next().value;if(!oldest)break;bytes-=images.get(oldest)!.bytes.length;images.delete(oldest);}};
  const port: FidelityPort = {
    async capture(input) {
      input.signal?.throwIfAborted();
      if (input.document.length > 5 * 1024 * 1024 || await documentHash(input.document) !== input.documentHash) throw new Error('Invalid or oversized appearance document.');
      const context = await browser.newContext({ viewport: { width: input.viewport.width, height: input.viewport.height }, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block' });
      const cancel = () => { void context.close(); };
      input.signal?.addEventListener('abort', cancel, { once: true });
      try {
        // Deny ALL requests, including navigation, images and localhost. The
        // document is supplied bytes, never an arbitrary external URL.
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', () => errors.push('The captured app raised a browser error.'));
        await page.setContent('<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe title="Isolated appearance capture"></iframe></body></html>');
        const html = input.kind === 'built' ? isolatedBuiltDocument(input.document, 'local-appearance', {}, false) : input.document;
        // The browser parses generated HTML only inside an opaque sandbox.
        const loaded = page.waitForEvent('framenavigated', { predicate: (frame) => frame.parentFrame() === page.mainFrame() && frame.url() === 'about:srcdoc', timeout: 10_000 });
        await page.locator('iframe').evaluate((frame, data) => {
          frame.setAttribute('sandbox', data.scripts ? 'allow-scripts' : '');
          (frame as HTMLIFrameElement).srcdoc = data.html;
        }, { html, scripts: input.kind === 'built' });
        const frame = await loaded;
        await frame.waitForLoadState('load', { timeout: 10_000 });
        await frame.evaluate(async () => {
          await Promise.race([document.fonts.ready, new Promise((ready) => setTimeout(ready, 500))]);
        });
        // Chromium can throttle frame rAF in headless opaque documents. A
        // bounded compositor settle avoids an unbounded callback wait.
        await page.waitForTimeout(50);
        const overflow = await frame.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        const bytes = await page.screenshot({ type: 'png', animations: 'disabled', timeout: 10_000 });
        const sha256 = await documentHashBytes(bytes);
        const artifact = resolve(directory, `${sha256}.png`);
        await writeFile(artifact, bytes);
        remember(artifact, { bytes, overflow, errors });
        input.signal?.throwIfAborted();
        return { artifact, sha256, documentHash: input.documentHash, width: input.viewport.width, height: input.viewport.height, capturedAt: new Date().toISOString() };
      } finally {
        input.signal?.removeEventListener('abort', cancel);
        await context.close();
      }
    },
    async compare(input) {
      input.signal?.throwIfAborted();
      const approved = images.get(input.approved.artifact);
      const built = images.get(input.built.artifact);
      if (!approved || !built || await documentHashBytes(approved.bytes) !== input.approved.sha256 || await documentHashBytes(built.bytes) !== input.built.sha256) throw new Error('The captured pixels are unavailable or changed.');
      const context = await browser.newContext({ serviceWorkers: 'block' });
      try {
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        await page.setContent('<!doctype html><title>Local pixel comparison</title>');
        const fraction = await page.evaluate(async ({ before, after }) => {
          async function pixels(data: string) {
            const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height).data;
          }
          const a = await pixels(before); const b = await pixels(after); let changed = 0;
          for (let i = 0; i < a.length; i += 4) {
            // Ignore tiny antialiasing/channel changes, never layout shifts.
            if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > 24) changed++;
          }
          return changed / (a.length / 4);
        }, { before: approved.bytes.toString('base64'), after: built.bytes.toString('base64') });
        const differences: VisualDifference[] = [];
        if (built.overflow) differences.push({ severity: 'blocking', area: 'overflow', message: 'The built screen extends beyond the viewport horizontally.' });
        if (built.errors.length) differences.push({ severity: 'blocking', area: 'content', message: 'The built screen raised a browser error during capture.' });
        if (fraction > maximum) differences.push({ severity: 'blocking', area: 'appearance', message: `${(fraction * 100).toFixed(2)}% of the captured key screen differs from the approved reference (local pixel tolerance ${(maximum * 100).toFixed(2)}%). Inspect the saved pair before accepting intentional changes.` });
        input.signal?.throwIfAborted();
        return { differences };
      } finally { await context.close(); }
    },
  };
  return { port, async adoptCapture(value: {capture:VisualCapture;bytes:Buffer;overflow:boolean;errors:string[]}) {
    if(await documentHashBytes(value.bytes)!==value.capture.sha256 || value.bytes.readUInt32BE(16)!==value.capture.width || value.bytes.readUInt32BE(20)!==value.capture.height)throw new Error('Invalid navigated PNG');
    remember(value.capture.artifact,{bytes:value.bytes,overflow:value.overflow,errors:value.errors});return value.capture;
  }, close: async () => { images.clear(); if (owned) await browser.close(); } };
}
async function documentHashBytes(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
