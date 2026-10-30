import { readFileSync } from 'node:fs';
import { configuredDesignAudit, measureLooks } from '../apps/app/src/server/design-audit.ts';
import { CANONICAL_LOOKS_PROPOSAL, parseLooks } from '../packages/contracts/src/looks.ts';
const cfg = JSON.parse(readFileSync('apps/app/.wrangler/reliability-capture.json', 'utf8'));
const port = configuredDesignAudit({ DESIGN_CAPTURE_URL: `http://127.0.0.1:${cfg.port}`, DESIGN_CAPTURE_TOKEN: cfg.token });
const p = parseLooks(CANONICAL_LOOKS_PROPOSAL); if (!p.ok) throw new Error(p.error);
const t = Date.now();
console.log(JSON.stringify(await measureLooks(CANONICAL_LOOKS_PROPOSAL, p.set, port)), Date.now() - t, 'ms');
