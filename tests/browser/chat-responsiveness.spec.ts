import { test, expect, type BrowserContext } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// SIMULATED transport; the actual composed React app is measured locally.
const OFFSET = '0000000000000000_0000000000000001';
const PROJECT = { id: 'proj-perf', workspaceId: 'ws-perf', name: 'Garden journal', description: 'Record a garden observation.', contestId: null, contestUrl: null, status: 'active', createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z' };
async function fixture(context: BrowserContext, options: { singleTurn?: boolean; hugeText?: boolean; bounded?: boolean } = {}) {
 const messages = Array.from({ length: options.hugeText ? 2 : 400 }, (_, i) => ({
  id: `message-${i}`, role: options.singleTurn ? (i ? 'assistant' : 'user') : i % 2 ? 'assistant' : 'user', purpose: options.singleTurn ? (i ? 'assistant' : 'user') : i % 2 ? 'assistant' : 'user', display: 'visible', timestamp: '2026-10-24T00:00:00Z',
  parts: [{ type: 'text', state: 'done', text: options.hugeText && i === 1 ? `# Your garden journal\n\n${Array.from({ length: 1200 }, (_, index) => `## Observation ${index}\n\nYour **garden record** keeps watering and growth notes together. [View record](#record-${index})\n\n`).join('')}END OF THE ORIGINAL RESPONSE` : (options.singleTurn ? i > 0 : i % 2) ? `Update ${i}. Your observation is saved.\n\n${'A useful garden note. '.repeat(25)}` : `Record observation ${i}` },
   ...((options.singleTurn ? i > 0 : i % 2) ? Array.from({ length: 8 }, (_, j) => ({ type: 'dynamic-tool', toolCallId: `t-${i}-${j}`, toolName: 'write_plan_note', state: 'output-available', input: {}, output: { saved: true } })) : [])],
 }));
 await context.route('**/api/**', route => {
  const path = new URL(route.request().url()).pathname;
  const send = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (path === '/api/auth/status') return send({ authenticated: true });
  if (path === '/api/auth/get-session') return send({ session: { userId: 'actor-perf' }, user: { id: 'actor-perf', name: 'Jay', email: 'jay@example.test' } });
  if (path === '/api/onboarding') return send({ completedAt: PROJECT.createdAt });
  if (path === '/api/projects') return send({ projects: [PROJECT] });
  if (path === '/api/home-project') return send({ project: { ...PROJECT, id: 'home-perf' } });
  if (path.endsWith('/run-bindings')) return send({ runBindings: [{ runId: 'run-perf', projectId: PROJECT.id, conversationId: 'conv-perf', submissionId: 's', planRevision: 'r', stackId: 'react-hono', payerId: 'actor-perf', modelRouteId: 'nemotron-3.5-super-vl', pricingVersion: 'v1', createdBy: 'actor-perf', createdAt: PROJECT.createdAt }] });
  if (path === '/api/brief') return send({ cards: [], projects: [PROJECT], unseenCount: 0, asOf: PROJECT.createdAt });
  if (path.endsWith('/plan-docs')) return send({ revisions: [], latest: null });
  if (path.endsWith('/workflow')) return send({ workflow: null });
  return send({});
 });
 await context.route('**/agents/coordinator/**', route => {
  const query = new URL(route.request().url()).searchParams;
  if (options.bounded && query.get('view') === 'history') {
   const cursor = query.get('before') ?? query.get('from');
   const at = cursor ? Number(cursor.split(':')[1]) : messages.length;
   const end = query.has('before') ? at : messages.length;
   const start = query.has('from') ? at : Math.max(0, end - 40);
   const body = query.has('before') ? {v:1,conversationId:'conv-perf',messages:messages.slice(start,end),before:start ? `page:${start}` : null} : {v:1,conversationId:'conv-perf',offset:OFFSET,messages:messages.slice(start,end),settlements:[],before:start ? `page:${start}` : null};
   return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  }
  if (new URL(route.request().url()).searchParams.get('view') === 'updates') return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
  return route.fulfill({ contentType: 'application/json', headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' }, body: JSON.stringify({ v: 1, conversationId: 'conv-perf', offset: OFFSET, messages, settlements: [] }) });
 });
}

for (const width of [390, 1440]) test(`bounded history and lazy diagnostics at ${width}px`, async ({ page, context }) => {
 await page.setViewportSize({ width, height: 915 });
 await fixture(context);
 const began = Date.now();
 await page.goto('/app/project?project=proj-perf&pane=channel');
 await expect(page.getByTestId('msg-user').first()).toBeVisible();
 const initialMs = Date.now() - began;
 const earlier = page.getByTestId('channel-show-earlier');
 const start = Date.now();
 await earlier.click();
 await expect(page.getByTestId('msg-user').first()).toBeVisible();
 const earlierMs = Date.now() - start;
 const input = page.getByTestId('composer-input');
 const typing = Date.now();
 await input.fill('Keep this draft while I review earlier messages');
 const typingMs = Date.now() - typing;
 const metrics = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid="msg-user"], [data-testid="msg-assistant"]').length, toolRows: document.querySelectorAll('[data-testid="tool-banner"]').length, nodes: document.querySelector('[data-testid="channel-transcript"]')?.querySelectorAll('*').length, overflow: document.documentElement.scrollWidth > innerWidth }));
 await writeFile(`/tmp/caddie-chat-${process.env.CADDIE_PERF_LABEL ?? 'after'}-${width}.json`, JSON.stringify({ initialMs, earlierMs, typingMs, ...metrics }, null, 2));
 expect(metrics.rows).toBeLessThanOrEqual(40);
 expect(metrics.toolRows).toBe(0);
 expect(metrics.overflow).toBe(false);
 await page.getByTestId('tool-strip').first().getByRole('button').click();
 await expect(page.getByTestId('tool-banner')).toHaveCount(8);
 await page.getByTestId('channel-jump-latest').click();
 await expect(page.getByTestId('msg-user').last()).toContainText('398');
 await expect(input).toHaveValue('Keep this draft while I review earlier messages');
 await page.reload();
 await expect(input).toHaveValue('Keep this draft while I review earlier messages');
 await page.screenshot({ path: `/tmp/caddie-chat-polish-${width}.png`, fullPage: false });
});

test('a follow-up can be drafted and queued without stopping active work', async ({ page, context }) => {
 await fixture(context);
 const keys: string[] = [];
 let stops = 0;
 await context.route('**/agents/coordinator/**', async route => {
  if (route.request().method() !== 'POST') return route.fallback();
  const input = route.request().postDataJSON();
  keys.push(input.idempotencyKey);
  if (new URL(route.request().url()).pathname.endsWith('/abort')) stops++;
  return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ submissionId: `queued-${keys.length}`, uid: `uid-${keys.length}`, streamUrl: route.request().url(), offset: OFFSET }) });
 });
 await page.goto('/app/project?project=proj-perf&pane=channel');
 const input = page.getByTestId('composer-input');
 await input.fill('Explain the garden journal');
 await page.getByTestId('composer-send').click();
 await expect(page.getByTestId('channel')).toHaveAttribute('data-transport-status', /streaming|submitted/);
 await expect(input).toBeEnabled();
 await input.fill('Also explain how I add a photo');
 await expect(page.getByTestId('composer-send')).toHaveAccessibleName('Send follow-up');
 await page.getByTestId('composer-send').click();
 await expect.poll(() => keys.length).toBe(2);
 expect(new Set(keys).size).toBe(2);
 expect(stops).toBe(0);
});


function percentile95(samples: number[]) {
 return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1]!;
}

// These are browser interaction wall times, not model/network response latency.
// Long tasks and request counts are observations; bounded mounts and usable input
// are the gates. A quiet local fixture does not prove authenticated production UX.
test('repeated history navigation and typing stay responsive, with bounded mounts', async ({ page, context }) => {
 await fixture(context);
 const requestCounts: Record<string, number> = {};
 page.on('request', request => {
  const url = new URL(request.url());
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/agents/')) requestCounts[url.pathname] = (requestCounts[url.pathname] ?? 0) + 1;
 });
 await page.addInitScript(() => {
  const perf = window as typeof window & { __chatPerf?: { supported: boolean; tasks: { startTime: number; duration: number }[] } };
  perf.__chatPerf = { supported: PerformanceObserver.supportedEntryTypes.includes('longtask'), tasks: [] };
  if (perf.__chatPerf.supported) new PerformanceObserver(list => {
   perf.__chatPerf!.tasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })));
  }).observe({ type: 'longtask', buffered: true });
 });
 await page.goto('/app/project?project=proj-perf&pane=channel');
 const input = page.getByTestId('composer-input');
 await expect(input).toBeVisible();
 const started = await page.evaluate(() => {
  const audit = window as typeof window & { __inputFrames?: number[] };
  audit.__inputFrames = [];
  document.addEventListener('input', event => {
   if (!(event.target as Element).matches('[data-testid="composer-input"]')) return;
   const began = performance.now();
   requestAnimationFrame(() => audit.__inputFrames!.push(performance.now() - began));
  }, { capture: true });
  return performance.now();
 });
 const typingMs: number[] = [];
 const navigationMs: number[] = [];
 const nodeCounts: number[] = [];
 for (let iteration = 0; iteration < 12; iteration++) {
  let began = performance.now();
  await input.fill(`Draft ${iteration}: keep my garden observations together.`);
  await expect(input).toHaveValue(`Draft ${iteration}: keep my garden observations together.`);
  typingMs.push(performance.now() - began);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __inputFrames?: number[] }).__inputFrames!.length)).toBe(iteration + 1);
  began = performance.now();
  await page.getByTestId('channel-show-earlier').click();
  await expect(page.getByTestId('msg-user').last()).toContainText('358');
  await page.getByTestId('channel-jump-latest').click();
  await expect(page.getByTestId('msg-user').last()).toContainText('398');
  navigationMs.push(performance.now() - began);
  nodeCounts.push(await page.getByTestId('channel-transcript').locator('*').count());
  await expect(page.getByTestId('tool-banner')).toHaveCount(0);
 }
 const observations = await page.evaluate(started => {
  const perf = (window as typeof window & { __chatPerf?: { supported: boolean; tasks: { startTime: number; duration: number }[] } }).__chatPerf!;
  return { inputToNextFrameMs: (window as typeof window & { __inputFrames?: number[] }).__inputFrames!, longTaskSupported: perf.supported, interactionLongTasks: perf.tasks.filter(task => task.startTime >= started) };
 }, started);
 const report = { transport: 'SIMULATED', inputToNextFrameP95Ms: percentile95(observations.inputToNextFrameMs), typingMs, navigationMs, typingP95Ms: percentile95(typingMs), navigationRoundTripP95Ms: percentile95(navigationMs), nodeCounts, requestCounts, ...observations };
 await writeFile('/tmp/caddie-chat-interaction-samples.json', JSON.stringify(report, null, 2));
 expect(report.inputToNextFrameP95Ms, 'input event to next frame must meet the 50ms response budget').toBeLessThan(50);
 expect(report.typingP95Ms, 'draft editing must not freeze for a second').toBeLessThan(1000);
 expect(report.navigationRoundTripP95Ms, 'two local history transitions must not freeze for two seconds').toBeLessThan(2000);
 expect(Math.max(...nodeCounts) - Math.min(...nodeCounts), 'paging must not accumulate hidden transcript DOM').toBeLessThanOrEqual(10);
 await expect(input).toHaveValue('Draft 11: keep my garden observations together.');
});

test('a single 399-message assistant turn cannot defeat the history bound', async ({ page, context }) => {
 await fixture(context, { singleTurn: true });
 await page.setViewportSize({ width: 390, height: 915 });
 await page.goto('/app/project?project=proj-perf&pane=channel');
 const transcript = page.getByTestId('channel-transcript');
 await expect(transcript).toContainText('Update 399.');
 await expect(transcript).not.toContainText('Update 359.');
 await expect(page.getByTestId('tool-banner')).toHaveCount(0);
 await page.getByTestId('channel-show-earlier').click();
 await expect(transcript).toContainText('Update 359.');
 await expect(transcript).not.toContainText('Update 319.');
 await expect(transcript).not.toContainText('Update 399.');
 await page.getByTestId('channel-jump-latest').click();
 await expect(transcript).toContainText('Update 399.');
 await expect(transcript).not.toContainText('Update 359.');
 const measurements = await page.evaluate(() => ({ nodes: document.querySelector('[data-testid="channel-transcript"]')!.querySelectorAll('*').length, overflow: document.documentElement.scrollWidth > innerWidth }));
 await writeFile('/tmp/caddie-chat-single-turn.json', JSON.stringify({ transport: 'SIMULATED', ...measurements }, null, 2));
 expect(measurements.overflow).toBe(false);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) test(`restored history does not replay arrival animation on resize, reload or project changes (${reducedMotion})`, async ({ page, context }) => {
 await fixture(context);
 await page.emulateMedia({ reducedMotion });
 await page.addInitScript(() => {
  const audit = window as typeof window & { __historyEntrances?: string[] };
  audit.__historyEntrances = [];
  document.addEventListener('animationstart', event => {
   if ((event.target as Element).matches('.msg')) audit.__historyEntrances!.push((event as AnimationEvent).animationName);
  });
 });
 await page.goto('/app/project?project=proj-perf&pane=channel');
 const input = page.getByTestId('composer-input');
 await input.fill('Keep this project draft');
 await page.getByTestId('channel-show-earlier').click();
 for (const width of [320, 768, 1440, 390]) {
  await page.setViewportSize({ width, height: 915 });
  await expect(input).toHaveValue('Keep this project draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await expect.poll(() => page.locator('.msg').evaluateAll(elements => [...new Set(elements.map(element => getComputedStyle(element).animationName))])).toEqual(['none']);
 }
 await page.reload();
 await expect(input).toHaveValue('Keep this project draft');
 await expect(page.locator('.msg[data-arriving="true"]')).toHaveCount(0);
 // A different conversation must begin from its own history, not animate it as
 // new activity. Going back must retain the draft scoped to the first project.
 await page.goto('/app/project?project=home-perf&pane=channel');
 await expect(input).toBeVisible();
 await expect(page.locator('.msg[data-arriving="true"]')).toHaveCount(0);
 await page.goto('/app/project?project=proj-perf&pane=channel');
 await expect(input).toHaveValue('Keep this project draft');
 await expect(page.locator('.msg[data-arriving="true"]')).toHaveCount(0);
 expect(await page.evaluate(() => (window as typeof window & { __historyEntrances?: string[] }).__historyEntrances)).toEqual([]);
});


test('a broken updates connection recovers without replaying historical arrivals', async ({ page, context }) => {
 await fixture(context);
 let disconnect = false;
 let failedUpdates = 0;
 let recoveredUpdates = 0;
 await context.route('**/agents/coordinator/**', async route => {
  if (new URL(route.request().url()).searchParams.get('view') !== 'updates') return route.fallback();
  if (disconnect) { failedUpdates++; return route.abort('connectionfailed'); }
  if (failedUpdates) recoveredUpdates++;
  return route.fallback();
 });
 await page.addInitScript(() => {
  const audit = window as typeof window & { __historicalAnimations?: string[] };
  audit.__historicalAnimations = [];
  document.addEventListener('animationstart', event => {
   if ((event.target as Element).matches('.msg')) audit.__historicalAnimations!.push((event as AnimationEvent).animationName);
  });
 });
 await page.goto('/app/project?project=proj-perf&pane=channel');
 const input = page.getByTestId('composer-input');
 await input.fill('Keep my draft through reconnect');
 await expect(page.getByTestId('msg-user').last()).toContainText('398');
 disconnect = true;
 await expect.poll(() => failedUpdates, { timeout: 15000 }).toBeGreaterThan(0);
 disconnect = false;
 await expect.poll(() => recoveredUpdates, { timeout: 15000 }).toBeGreaterThan(0);
 await expect(input).toHaveValue('Keep my draft through reconnect');
 await expect(page.getByTestId('msg-user').last()).toContainText('398');
 await expect(page.locator('.msg[data-arriving="true"]')).toHaveCount(0);
 expect(await page.evaluate(() => (window as typeof window & { __historicalAnimations?: string[] }).__historicalAnimations)).toEqual([]);
});


test('one huge Markdown response renders progressively while preserving the complete original', async ({ page, context }) => {
 await fixture(context, { hugeText: true });
 await page.setViewportSize({ width: 390, height: 915 });
 await page.goto('/app/project?project=proj-perf&pane=channel');
 const response = page.getByTestId('msg-assistant');
 await expect(response).toContainText('Observation 0');
 await expect(response).not.toContainText('END OF THE ORIGINAL RESPONSE');
 const initial = await response.evaluate(element => ({ textCharacters: element.textContent!.length, nodes: element.querySelectorAll('*').length }));
 expect(initial.textCharacters).toBeLessThan(14000);
 expect(initial.nodes).toBeLessThan(1200);
 const button = response.getByRole('button', { name: 'Read more of this response', exact: true });
 await expect(button).toBeVisible();
 let sectionsOpened = 0;
 const input = page.getByTestId('composer-input');
 while (true) {
  await expect.poll(async () => (await response.textContent())!.includes('END OF THE ORIGINAL RESPONSE') || ((await button.count()) > 0 && await button.isEnabled({ timeout: 100 }).catch(() => false))).toBe(true).catch(async error => { await writeFile('/tmp/caddie-giant-debug.json', JSON.stringify({ sectionsOpened, tail: (await response.textContent())!.slice(-500), buttons: await response.getByRole('button').allTextContents() })); throw error; });
  if ((await response.textContent())!.includes('END OF THE ORIGINAL RESPONSE')) break;
  await expect(button).toBeEnabled();
  await button.click();
  sectionsOpened++;
  await input.fill(`Draft survives section ${sectionsOpened}`);
  if (sectionsOpened > 30) throw new Error('The original response did not become reachable in thirty sections');
 }
 await expect(response).toContainText('END OF THE ORIGINAL RESPONSE');
 await expect(response).toContainText('Observation 0');
 await expect(response).toContainText('Observation 1199');
 await expect(input).toHaveValue(`Draft survives section ${sectionsOpened}`);
 expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
 await writeFile('/tmp/caddie-chat-giant-text.json', JSON.stringify({ transport: 'SIMULATED', initial, sectionsOpened, finalNodes: await response.locator('*').count() }, null, 2));
});

test('native history loads only the latest page, then one older page per upward gesture',async({page,context})=>{
 await fixture(context,{bounded:true});
 const reads:string[]=[];
 page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/agents/')&&url.searchParams.get('view')==='history')reads.push(url.search);});
 const errors:string[]=[];
 page.on('console',message=>{if(message.type()==='error'&&message.text().includes('Maximum update depth'))errors.push(message.text());});
 await page.goto('/app/project?project=proj-perf&pane=channel');
 await expect(page.getByTestId('msg-user').last()).toContainText('398');
 expect(reads.some(query=>query.includes('limit=40'))).toBe(true);
 const earlier=page.getByTestId('channel-show-earlier');
 await expect(earlier).toContainText('Load earlier messages');
 await earlier.click();
 await expect(page.getByTestId('msg-user').last()).toContainText('358');
 expect(reads.filter(query=>query.includes('before=')).length).toBe(1);
 const transcript=page.getByTestId('channel-transcript');
 await transcript.evaluate(el=>{el.scrollTop=0;});
 await transcript.hover();
 await page.mouse.wheel(0,-300);
 await expect(page.getByTestId('msg-user').last()).toContainText('318');
 expect(reads.filter(query=>query.includes('before=')).length).toBe(2);
 expect(await page.locator('.msg').count()).toBeLessThanOrEqual(40);
 await page.getByTestId('channel-jump-latest').click();
 await expect(page.getByTestId('msg-user').last()).toContainText('398');
 expect(errors).toEqual([]);
});

test('unavailable history offers read-only recovery instead of claiming Caddie is working',async({page,context})=>{
 await fixture(context);
 let failing=true;
 let sends=0;
 await context.route('**/agents/coordinator/**',route=>{
  if(route.request().method()==='POST') sends++;
  if(failing && new URL(route.request().url()).searchParams.get('view')==='history') return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'temporarily unavailable'})});
  return route.fallback();
 });
 await page.goto('/app/project?project=proj-perf&pane=channel');
 const recovery=page.getByTestId('conversation-load-recovery');
 await expect(recovery).toBeVisible({timeout:15000});
 await expect(recovery).toContainText('project status below is separate');
 await expect(page.getByTestId('channel-status')).toHaveCount(0);
 await expect(page.getByTestId('caddie-status')).not.toHaveText('Working…');
 failing=false;
 await recovery.getByRole('button',{name:'Reload conversation'}).click();
 await expect(page.getByText('Record observation 398',{exact:true})).toBeVisible();
 await expect(recovery).toHaveCount(0);
 expect(sends).toBe(0);
});
