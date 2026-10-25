/** Owner-authorized, bounded live model preflight. No product routing changes.
 * CADDIE_LIVE_AUTHORIZED=1 bun scripts/probe-reliability-models.ts
 * Synthetic inputs only. $3 conservative reservation cap, 24 physical requests,
 * 65k estimated input ceiling/call, 16,384 completion cap, no transport retries.
 * Saved outputs omit reasoning and credentials. This is not a harness benchmark.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';
import { chromium } from '@playwright/test';
import { createModels, createProvider } from '../apps/app/node_modules/@earendil-works/pi-ai/dist/index.js';
import { openAICompletionsApi } from '../apps/app/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js';

const selfTest = process.argv.includes('--self-test');
if (!selfTest && process.env.CADDIE_LIVE_AUTHORIZED !== '1') throw Error('Explicit live authorization required');
const root = resolve(import.meta.dir, '..');
const dir = resolve(root, 'docs/evidence/2026-10-25-model-validation');
mkdirSync(dir, { recursive: true });
const key = selfTest ? 'unused-local-self-test' : process.env.NEBIUS_API_KEY || readFileSync(resolve(root, 'apps/app/.dev.vars'), 'utf8').match(/^\s*NEBIUS_API_KEY\s*=\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '');
if (!key) throw Error('No configured Nebius credential');
const routes = [
 { id: 'nvidia/Nemotron-3.5-Super-VL', input: .30, output: .90, vision: true },
 { id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', input: .30, output: 1.20, vision: true },
 { id: 'zai-org/GLM-5.3', input: 1.40, output: 4.40, vision: false },
];
const previous = process.argv.includes('--vision-only') ? JSON.parse(readFileSync(resolve(dir, 'results.json'), 'utf8')) : null;
const results: any[] = previous?.results || [];
let calls = previous?.physicalRequests || 0, reserved = previous?.reservedCeilingUsd || 0;
const maxTokens = 16384;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
function persist() { writeFileSync(resolve(dir, 'results.json'), JSON.stringify({ evidence: 'LIVE VERIFIED provider calls; synthetic calibration cases; see per-case verdicts', checkedAt: new Date().toISOString(), physicalRequests: calls, reservedCeilingUsd: reserved, budgetUsd: 3, maxPhysicalRequests: 24, maxTokens, reasoningEffort: 'max', automaticRetries: 0, routes, results }, null, 2)); }
function reserve(r: typeof routes[number], inputBytes: number, images = false) {
 if (inputBytes > (images ? 512000 : 65000)) throw Error('Input byte guard exceeded (text plus base64 images)');
 const amount = (65000 * r.input + maxTokens * r.output) / 1e6;
 if (calls >= 24 || reserved + amount > 3) throw Error('Preflight budget exhausted');
 calls++; reserved += amount; persist();
}
function record(r: typeof routes[number], test: string, start: number, data: any) {
 const item = { model: r.id, test, durationMs: Date.now() - start, ...data };
 results.push(item); persist(); console.log(JSON.stringify({ model: r.id, test, verdict: item.verdict, durationMs: item.durationMs, error: item.error }));
}
function schema(properties: any) { return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }; }
const string = { type: 'string' }, bool = { type: 'boolean' }, strings = { type: 'array', items: string };
const reviewSchema = schema({ verdict: { type: 'string', enum: ['pass', 'revise', 'unavailable'] }, findings: strings });
function parse(text: string) { return JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
function checkShape(data: any, shape: any): boolean {
 if (shape.type === 'object') return data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).every(k => k in shape.properties) && shape.required.every((k: string) => k in data && checkShape(data[k], shape.properties[k]));
 if (shape.enum && !shape.enum.includes(data)) return false;
 if (shape.type === 'array') return Array.isArray(data) && data.every(x => checkShape(x, shape.items));
 return typeof data === shape.type;
}
async function raw(r: typeof routes[number], test: string, messages: any[], shape: any, assess: (d: any) => any) {
 const started = Date.now();
 const body = { model: r.id, messages, max_tokens: maxTokens, reasoning_effort: 'max', response_format: { type: 'json_schema', json_schema: { name: 'review', strict: true, schema: shape } } };
 reserve(r, JSON.stringify(messages).length, test.startsWith('vision-'));
 try {
  const res = await fetch('https://api.tokenfactory.nebius.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  if (!res.ok) { record(r, test, started, { verdict: 'FAILED', status: res.status, error: (await res.text()).slice(0, 1500) }); return; }
  const answer: any = await res.json(); const choice = answer.choices?.[0]; const text = choice?.message?.content || '';
  let data: any, checks: any;
  try { data = parse(text); checks = { schemaValid: checkShape(data, shape), ...assess(data) }; }
  catch (e) { checks = { schemaValid: false, parseError: String(e) }; }
  const passed = choice?.finish_reason !== 'length' && Object.values(checks).every(v => v === true);
  const usage = answer.usage;
  record(r, test, started, { verdict: passed ? 'PASS' : 'FAILED', finishReason: choice?.finish_reason, usage, estimatedUsd: usage ? (usage.prompt_tokens * r.input + usage.completion_tokens * r.output) / 1e6 : null, checks, answer: data ?? text.slice(0, 12000), promptHash: sha(JSON.stringify(messages)), requestShape: { responseFormat: 'json_schema', strict: true } });
 } catch (e) { record(r, test, started, { verdict: 'UNAVAILABLE', error: String(e) }); }
}
const models = createModels();
models.setProvider(createProvider({ id: 'nebius-probe', name: 'Nebius probe', baseUrl: 'https://api.tokenfactory.nebius.com/v1', auth: { apiKey: { name: 'probe credential', resolve: async () => ({ auth: { apiKey: key } }) } }, models: routes.map(r => ({ id: r.id, name: r.id, api: 'openai-completions' as const, provider: 'nebius-probe', baseUrl: 'https://api.tokenfactory.nebius.com/v1', reasoning: true, input: r.vision ? ['text' as const, 'image' as const] : ['text' as const], contextWindow: 1048576, maxTokens, cost: { input: r.input, output: r.output, cacheRead: 0, cacheWrite: 0 }, compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' as const } })), api: openAICompletionsApi() }));
async function toolRoundTrip(r: typeof routes[number]) {
 const started = Date.now(); const model = models.getModel('nebius-probe', r.id)!;
 const context: any = { systemPrompt: 'Use lookup_check for the exact requested checkpoint. Do not invent the result. After the tool result, state its nonce and whether the check passed in one sentence.', messages: [{ role: 'user', content: 'Look up checkpoint cp_482 and report its status.', timestamp: Date.now() }], tools: [{ name: 'lookup_check', description: 'Read the host check receipt', parameters: schema({ checkpoint: string }) }] };
 const physicalFetch: typeof fetch = ((url: any, options: any) => { reserve(r, String(options?.body || '').length); return fetch(url, options); }) as any;
 const options: any = { maxTokens, reasoning: 'max', maxRetries: 0, signal: AbortSignal.timeout(180000), fetch: physicalFetch };
 try {
  const response = await models.completeSimple(model, context, options);
  const tool = response.content.find((c: any) => c.type === 'toolCall') as any;
  if (!tool || tool.name !== 'lookup_check' || tool.arguments?.checkpoint !== 'cp_482' || response.stopReason === 'error') {
   record(r, 'pi-stream-tool-roundtrip', started, { verdict: 'FAILED', stopReason: response.stopReason, error: response.errorMessage, blocks: response.content.filter((x: any) => x.type !== 'thinking'), usage: response.usage }); return;
  }
  const nonce = 'receipt_' + crypto.randomUUID().slice(0, 8);
  context.messages.push(response, { role: 'toolResult', toolCallId: tool.id, toolName: tool.name, content: [{ type: 'text', text: JSON.stringify({ checkpoint: 'cp_482', passed: false, nonce }) }], isError: false, timestamp: Date.now() });
  const final = await models.completeSimple(model, context, { ...options, signal: AbortSignal.timeout(180000) });
  const text = final.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('');
  record(r, 'pi-stream-tool-roundtrip', started, { verdict: text.includes(nonce) && /fail|not pass|didn.t pass/i.test(text) && final.stopReason !== 'error' ? 'PASS' : 'FAILED', stopReason: final.stopReason, error: final.errorMessage, tool: { name: tool.name, arguments: tool.arguments }, answer: text, usage: [response.usage, final.usage], adapter: '@earendil-works/pi-ai@0.87.1 completeSimple (streaming internally), existing compat flags', requestShape: { reasoning: 'max', maxRetries: 0 } });
 } catch (e) { record(r, 'pi-stream-tool-roundtrip', started, { verdict: 'UNAVAILABLE', error: String(e) }); }
}
const repairPrompt = `Repair this JavaScript function. Return JSON {"code":"function applyEvents(initial, events) { ... }"}. Pure function only; no imports, I/O, dynamic code or external libraries. Keep API. initial is an integer balance in kobo; events have id:string, amountMinor:integer, synced:boolean. Apply each synced event exactly once by id, keep unsynced IDs in queued in first-seen order without duplicates, let a later synced occurrence supersede its queued copy. Negative integer amounts valid. Reject fractional/nonfinite amounts via throwing Error, including unsynced events. Do not mutate inputs. Return {balanceMinor, applied, queued} with ID arrays in first applied / first remaining queued order. Reject invalid initial integer. Current buggy function: function applyEvents(initial, events) { let balance=initial; for (const e of events) balance += e.amountMinor/100; return {balanceMinor:balance, applied:events.map(e=>e.id),queued:[]}; }`;
function repairChecks(data: any) {
 const code = data.code;
 if (typeof code !== 'string' || /\b(import|require|process|globalThis|eval|Function|constructor|prototype|__proto__)\b/.test(code)) return { hostTestsPass: false };
 try {
 const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
 new Script(code + ';globalThis.result = (() => { const cases = [ [10000,[{id:"a",amountMinor:-150,synced:true},{id:"a",amountMinor:-150,synced:true}],{balanceMinor:9850,applied:["a"],queued:[]}], [100,[{id:"q",amountMinor:25,synced:false},{id:"q",amountMinor:25,synced:true}],{balanceMinor:125,applied:["q"],queued:[]}], [100,[{id:"q",amountMinor:25,synced:false},{id:"q",amountMinor:25,synced:false}],{balanceMinor:100,applied:[],queued:["q"]}], [0,[],{balanceMinor:0,applied:[],queued:[]}], [0,[{id:"a",amountMinor:10,synced:true},{id:"a",amountMinor:10,synced:false}],{balanceMinor:10,applied:["a"],queued:[]}] ]; return cases.every(([i,e,w]) => { const before=JSON.stringify(e); const actual=applyEvents(i,e); return actual.balanceMinor===w.balanceMinor && JSON.stringify(actual.applied)===JSON.stringify(w.applied) && JSON.stringify(actual.queued)===JSON.stringify(w.queued) && JSON.stringify(e)===before; }) && [ [0,[{id:"x",amountMinor:.5,synced:false}]], [0,[{id:"x",amountMinor:NaN,synced:true}]], [.5,[]] ].every(([i,e]) => {try {applyEvents(i,e);return false;} catch {return true;} }); })();').runInContext(context, { timeout: 100 });
 return { hostTestsPass: context.result === true };
 } catch { return { hostTestsPass: false }; }
}
if (selfTest) {
 const knownGood = `function applyEvents(initial, events) {
 if (!Number.isInteger(initial)) throw new Error('invalid initial');
 let balanceMinor = initial; const applied = new Set(); const queued = new Set();
 for (const e of events) { if (!Number.isInteger(e.amountMinor)) throw new Error('invalid amount');
 if (e.synced) { if (!applied.has(e.id)) { balanceMinor += e.amountMinor; applied.add(e.id); } queued.delete(e.id); }
 else if (!applied.has(e.id)) queued.add(e.id); }
 return {balanceMinor, applied: [...applied], queued: [...queued]}; }`;
 const assertions = {
  goodRepairAccepted: repairChecks({code: knownGood}).hostTestsPass,
  wrongBalanceRejected: !repairChecks({code: knownGood.replace('balanceMinor += e.amountMinor', 'balanceMinor += e.amountMinor / 100')}).hostTestsPass,
  duplicateApplicationRejected: !repairChecks({code: knownGood.replace('if (!applied.has(e.id)) {', 'if (true) {')}).hostTestsPass,
  missingValidationRejected: !repairChecks({code: knownGood.replace("if (!Number.isInteger(e.amountMinor)) throw new Error('invalid amount');", '')}).hostTestsPass,
  invalidSchemaRejected: !checkShape({verdict:'pass',findings:[],extra:true}, reviewSchema),
 };
 console.log(JSON.stringify(assertions)); if (!Object.values(assertions).every(Boolean)) process.exit(1); process.exit(0);
}
const planBad = `User intent: farmers take a photo of a sick bird, get cautious guidance, record a treatment offline, sync later, with worker access limited to their farm. Draft: build a desktop-only online form. AI actually receives text descriptions only; advertise photo diagnosis. Every user can query all farms. All writes require connectivity. Done when the developer's own tests say pass. User must configure API keys and debug errors. The design is approved automatically by the author.`;
const fixtures = { repairPrompt, planBad, schemaCase: { country: 'Nigeria', deadline: '2026-10-23T19:00:00Z', localZone: 'Africa/Lagos', expiredAt: '2026-10-24T08:00:00Z' } };
writeFileSync(resolve(dir, 'fixtures.json'), JSON.stringify(fixtures, null, 2));
async function textCases(r: typeof routes[number]) {
 await toolRoundTrip(r);
 await raw(r, 'strict-json-deadline', [{ role: 'user', content: 'Return JSON only. At 2026-10-24T08:00:00Z a contest deadline was 2026-10-23T19:00:00Z. Country NG meets the checked entry rules. Local zone Africa/Lagos. Fields: eligibilityMet:boolean, deadlinePassed:boolean, recommendStarting:boolean, localDeadline:string (ISO local offset), explanation:string. Distinguish legal eligibility from remaining build time.' }], schema({ eligibilityMet: bool, deadlinePassed: bool, recommendStarting: bool, localDeadline: string, explanation: string }), d => ({ correct: d.eligibilityMet === true && d.deadlinePassed === true && d.recommendStarting === false && /2026-10-23T20:00.*\+01:00/.test(d.localDeadline) }));
 await raw(r, 'checked-repair-kobo-dedupe-offline', [{ role: 'user', content: repairPrompt }], schema({ code: string }), repairChecks);
 await raw(r, 'independent-plan-blockers', [{ role: 'user', content: `Independently review this draft, do not trust author claims. Return JSON verdict pass/revise/unavailable and findings array, each finding one concise actionable sentence. Do not ask user to debug.\n${planBad}` }], reviewSchema, d => { const t = (d.findings || []).join(' ').toLowerCase(); return { blocksBadPlan: d.verdict === 'revise', photoGapFound: /photo|image|vision/.test(t), offlineGapFound: /offline|connectiv|sync/.test(t), tenantGapFound: /farm|tenant|isolation|access/.test(t), approvalGapFound: /approv/.test(t) }; });
}
async function screenshots() {
 const browser = await chromium.launch({ headless: true });
 const manifest: any[] = [];
 try {
  for (const kind of ['good', 'broken', 'blank']) {
   for (const [width,height] of [[390,844],[1440,900]]) {
    const page = await browser.newPage({ viewport: { width, height }, serviceWorkers: 'block' });
    await page.route('**/*', route => route.abort());
    const html = kind === 'blank' ? '<html><body style="background:white"></body></html>' : `<!doctype html><html><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;background:#f3f5f4;color:#172a25;font:16px system-ui}main{max-width:1000px;margin:auto;padding:24px}header{display:flex;justify-content:space-between;align-items:center}h1{font-size:30px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.card{background:white;border:1px solid #d9e3de;border-radius:12px;padding:20px}.muted{color:#52675e}button{display:block;width:100%;min-height:48px;background:#175d45;color:white;border:0;border-radius:9px;font:600 16px system-ui;padding:12px;margin-top:20px}${kind === 'broken' ? 'main{min-width:1100px}button{position:fixed;left:1500px;top:150px}h1,.muted,.card{color:#eceeed;background:#f3f5f4}.card{font-size:7px}' : ''}</style><main><header><b>FARMHAND</b><span>Saved on this device</span></header><h1>Your farm today</h1><p class="muted">Record what happened. Your records sync when you reconnect.</p><div class="grid"><section class="card"><h2>Broiler cycle A</h2><p>480 birds · Week 4</p><p class="muted">Latest record: water checked at 08:15</p><button>Add an observation</button></section><section class="card"><h2>Feed remaining</h2><strong>14 days</strong><p class="muted">Based on your recent feed records</p><button>View feed records</button></section></div></main></html>`;
    await page.setContent(html); await page.screenshot({ path: resolve(dir, `${kind}-${width}.png`) });
    manifest.push({ kind, width, height, filename: `${kind}-${width}.png`, sha256: sha(readFileSync(resolve(dir, `${kind}-${width}.png`))), horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
    await page.close();
   }
  }
 } finally { await browser.close(); }
 writeFileSync(resolve(dir, 'screenshots.json'), JSON.stringify(manifest,null,2)); return manifest;
}
const manifest = process.argv.includes('--vision-only') ? JSON.parse(readFileSync(resolve(dir, 'screenshots.json'), 'utf8')) : await screenshots();
if (!process.argv.includes('--vision-only')) for (const r of routes) await textCases(r);
{
 for (const r of routes.slice(1)) await raw(r, 'sound-plan-negative-control', [{ role: 'user', content: `Review this complete first-version plan, not a production specification. Do not invent extra requirements. Return JSON verdict pass/revise/unavailable and concise findings. Intent: a single-owner farm notebook to record bird observations offline and sync after reconnecting. Included: mobile readable observation form; local durable save and queued/synced labels; safe retry with event IDs to avoid duplicates; authenticated owner-scoped farm records; readable errors with Caddie-owned recovery. Excluded explicitly: photo diagnosis, multiworker roles, lending, medication recommendations. Host checks: reload offline preserves observation; reconnect syncs exactly once; a second account cannot read it; phone and desktop primary action remains visible. AI/model configuration is platform-managed. Important limitation visible before approval: this is recordkeeping, not veterinary advice. User reviews and approves this scope, then selects and approves a rendered design before building. Technical specification optional. Hosting access and allowed costs already provisioned by platform; no new spending request. No claims of passing checks until host receipts exist. No unresolved product decisions.` }], reviewSchema, d => ({ acceptsSoundPlan: d.verdict === 'pass' }));
}
for (const r of routes.filter(r => r.vision)) {
 for (const kind of ['good', 'broken', 'blank']) {
  const content: any[] = [{ type: 'text', text: `Review actual phone and desktop screenshots of this farmer app. The accompanying author brief claims: "Both screens have readable contrast, all actions visible, no clipping, complete professional layouts." The brief may be wrong; trust pixels. Return JSON verdict pass/revise/unavailable and findings (concise concrete visible problems). A blank image is unavailable, not pass. Judge only visible usability, not whether backend saves work. First image phone, second desktop.` }];
  for (const m of manifest.filter((m: any) => m.kind === kind)) content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + readFileSync(resolve(dir,m.filename)).toString('base64') } });
  // Base64 is larger than text tokens; these small static images stay under the
  // base64-byte cap and are also recorded with exact dimensions/hashes.
  await raw(r, `vision-${kind}-phone-desktop`, [{ role: 'user', content }], reviewSchema, d => ({ expectedDecision: d.verdict === (kind === 'good' ? 'pass' : kind === 'blank' ? 'unavailable' : 'revise'), ...(kind === 'broken' ? { concreteVisualIssue: /contrast|clip|off.?screen|overflow|tiny|small|readab|invisible/.test((d.findings || []).join(' ').toLowerCase()) } : {}) }));
 }
}
persist(); console.log(JSON.stringify({ done: true, physicalRequests: calls, reservedCeilingUsd: reserved, passed: results.filter(x=>x.verdict==='PASS').length, failed: results.filter(x=>x.verdict!=='PASS').length }));
