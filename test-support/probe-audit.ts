import { chromium } from '@playwright/test';
import { openLocalDesignAudit } from '/Users/captjay98/projects/caddie-forge/scripts/local-design-audit.ts';
import { measureLooks } from '/Users/captjay98/projects/caddie-forge/apps/app/src/server/design-audit.ts';
import { CANONICAL_LOOKS_PROPOSAL, parseLooks } from '/Users/captjay98/projects/caddie-forge/packages/contracts/src/looks.ts';
const browser = await chromium.launch({ headless: true });
const audit = await openLocalDesignAudit(browser);
const p = parseLooks(CANONICAL_LOOKS_PROPOSAL); if (!p.ok) throw new Error(p.error);
const t = Date.now();
console.log(JSON.stringify(await measureLooks(CANONICAL_LOOKS_PROPOSAL, p.set, audit), null, 1));
// a deliberately bad screen
const bad = CANONICAL_LOOKS_PROPOSAL.replace('min-height:48px;background:var(--primary)', 'height:30px;width:900px;background:var(--primary)').replace(/color:var\(--muted\);font-size:13px/, 'color:var(--border);font-size:13px');
const q = parseLooks(bad); if (!q.ok) throw new Error(q.error);
console.log(JSON.stringify(await measureLooks(bad, q.set, audit), null, 1));
console.log('ms', Date.now() - t);
await browser.close();
