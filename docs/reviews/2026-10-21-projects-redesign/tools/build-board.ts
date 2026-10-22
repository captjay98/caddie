/**
 * Projects redesign review (2026-10-21): writes index.html, the page the owner
 * reviews: today, the three options (every state, desktop and phone), a
 * measured comparison, what was found on the way, and the questions. Numbers
 * come from today/measure.json and shots/measure.json, never typed by hand.
 *
 * Run from the repo root after shoot-mockups.ts:
 *   bun docs/reviews/2026-10-21-projects-redesign/tools/build-board.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Measure } from './measure.ts';
import { OPTION_INFO, OPTIONS, PROPOSED_WORDS, STATES, type Option, type State } from './build-mockups.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, '..');
const today = JSON.parse(readFileSync(join(REVIEW, 'today', 'measure.json'), 'utf8')) as Record<string, Measure>;
const shots = JSON.parse(readFileSync(join(REVIEW, 'shots', 'measure.json'), 'utf8')) as Record<string, Measure>;

const m = (who: 'today' | Option, key: string): Measure => {
	const found = who === 'today' ? today[key] : shots[`${who}/${key}`];
	if (!found) throw new Error(`no measure for ${who} ${key}`);
	return found;
};
const tallest = (x: Measure) => Math.max(...x.cardHeights);
const STATE_NAME: Record<State, string> = { review: 'Plan to approve', building: 'Building', ready: 'Ready to try', blocked: 'Needs you', empty: 'No plan yet' };

const DETAIL: Record<Option, { best: string; costs: string; card: string }> = {
	'a-focus': {
		best: 'You come back to act: approve the plan, try the app, get a paused build going again. The work is the first thing on the page.',
		costs: 'No single summary of the whole project; finished and later steps are a tab away.',
		card: 'Leanest: name, state, one line on what it is, when it last changed, one button.',
	},
	'b-overview': {
		best: 'You want to see the whole project before acting, especially on a phone, where a list of rows is natural.',
		costs: 'One more tap to reach the build’s details, and each step still needs its own page (it would be option A’s card on its own).',
		card: 'Option A’s card plus the hackathon and its deadline on one line.',
	},
	'c-journey': {
		best: 'You want the story on one page: what’s done and when, what Caddie is doing, and what happens next.',
		costs: 'The longest page of the three, and the current step’s work sits lower than in A.',
		card: 'Your Oct 20 pick, slimmer: the letter tile and the four steps on one line instead of four columns with notes.',
	},
};

function option(o: Option): string {
	const info = OPTION_INFO[o];
	const tabs = STATES.map((s, i) => `<button type="button" class="b-tab" data-option="${o}" data-state="${s}" aria-pressed="${i === 1 ? 'true' : 'false'}">${STATE_NAME[s]}</button>`).join('');
	return `<section class="b-option" id="${o}">
<h2>Option ${info.letter} · ${info.title}</h2>
<p class="b-lede">${info.idea}</p>
<dl class="b-facts"><div><dt>Best when</dt><dd>${DETAIL[o].best}</dd></div><div><dt>Costs</dt><dd>${DETAIL[o].costs}</dd></div><div><dt>Projects card</dt><dd>${DETAIL[o].card}</dd></div></dl>
<img class="b-sheet" src="shots/sheet-${o}.png" alt="Option ${info.letter}: the project page while building and the Projects list on desktop, and six phone screens">
<h3>Every state, whole page</h3>
<div class="b-tabs" role="group" aria-label="State">${tabs}</div>
<div class="b-pair">
<figure class="b-desk"><figcaption>Desktop · <a data-live="desktop" href="screens/${o}/project-building-desktop.html">open the page</a></figcaption><div class="b-frame"><img data-shot="desktop" src="shots/${o}/project-building-desktop-full.png" alt="Option ${info.letter}, desktop"></div></figure>
<figure class="b-phone"><figcaption>Phone · <a data-live="phone" href="screens/${o}/project-building-phone.html">open the page</a></figcaption><div class="b-frame"><img data-shot="phone" src="shots/${o}/project-building-phone-full.png" alt="Option ${info.letter}, phone"></div></figure>
</div>
<p class="b-small">Projects list: <a href="screens/${o}/list-desktop.html">desktop</a> · <a href="screens/${o}/list-phone.html">phone</a></p>
</section>`;
}

const row = (label: string, cells: string[]) => `<tr><th scope="row">${label}</th>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const each = (f: (who: 'today' | Option) => string) => (['today', ...OPTIONS] as const).map(f);

const compare = `<table class="b-table"><thead><tr><th></th><th>Today</th>${OPTIONS.map((o) => `<th>${OPTION_INFO[o].letter}</th>`).join('')}</tr></thead><tbody>
${row('Opening a project shows', ['Header, four step boxes, a Now card with the build card inside it, Your idea, Your app, then folds', 'The current step’s work', 'A summary of the four steps', 'The whole journey, current step open'])}
${row('Projects card height, desktop', each((w) => `${tallest(m(w, 'list-desktop'))} px`))}
${row('Projects cards on the first screen (desktop / phone)', each((w) => `${m(w, 'list-desktop').cardsOnFirstScreen} / ${m(w, 'list-phone').cardsOnFirstScreen}`))}
${row('Framed boxes on the page while building (deepest nesting)', each((w) => `${m(w, 'project-building-desktop').boxes} (${m(w, 'project-building-desktop').depth})`))}
${row('Page length while building, phone', each((w) => `${m(w, 'project-building-phone').pageHeight} px`))}
${row('Chat beside the page (desktop)', ['An empty-state card and a second copy of the project card', 'One status line', 'One status line', 'One status line'])}
</tbody></table>
<p class="b-small">Measured in Chromium at 1440×900 and 390×844 on these pages. A framed box is anything bordered on all sides and rounded, at least 120×36, buttons and links excluded. Phone page length is the content height; the options fold the feature list (one tap), today shows it open.</p>`;

const html = `<!doctype html>
<html lang="en" data-theme="dark" data-palette="caddie">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Projects redesign · three options for review</title>
<link rel="stylesheet" href="assets/app.css">
<style>
body { margin: 0; background: var(--color-ink); color: var(--color-bright); font-family: var(--font-ui); }
.b-wrap { max-width: 1240px; margin: 0 auto; padding: 32px 24px 80px; display: grid; gap: 34px; }
h1 { margin: 0; font-size: 30px; letter-spacing: -0.02em; }
h2 { margin: 0 0 6px; font-size: 22px; letter-spacing: -0.015em; }
h3 { margin: 18px 0 8px; font-size: 15px; color: var(--color-muted); font-weight: 650; }
p, li, dd, td { line-height: 1.6; }
.b-lede { margin: 0; max-width: 900px; color: var(--color-muted); font-size: 15px; }
.b-small { margin: 8px 0 0; color: var(--color-muted); font-size: 13px; }
a { color: var(--color-action); }
section { display: grid; gap: 10px; }
.b-box { padding: 16px 18px; border: 1px solid var(--color-line); border-radius: 13px; background: var(--color-raised); }
.b-box ul, .b-box ol { margin: 0; padding-left: 1.2rem; display: grid; gap: 4px; }
.b-sheet, .b-frame img { display: block; width: 100%; border-radius: 12px; border: 1px solid var(--color-line); }
.b-facts { margin: 4px 0 8px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.b-facts div { padding: 12px 14px; border: 1px solid var(--color-line); border-radius: 13px; background: var(--color-raised); }
.b-facts dt { font-size: 11px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-muted); }
.b-facts dd { margin: 4px 0 0; font-size: 14px; }
.b-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.b-tab { min-height: 40px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--color-line); background: transparent; color: var(--color-muted); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.b-tab[aria-pressed='true'] { border-color: var(--color-action); background: color-mix(in srgb, var(--color-action) 16%, transparent); color: var(--color-bright); }
.b-pair { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 16px; align-items: start; }
.b-pair figure { margin: 0; display: grid; gap: 6px; }
.b-pair figcaption { font-size: 13px; font-weight: 600; color: var(--color-muted); }
.b-frame { max-height: 760px; overflow: auto; border-radius: 12px; }
.b-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.b-table th, .b-table td { padding: 10px 12px; border-bottom: 1px solid var(--color-line); text-align: left; vertical-align: top; }
.b-table thead th { color: var(--color-muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
.b-table tbody th { width: 26%; color: var(--color-muted); font-weight: 600; }
code { font-family: var(--font-mono); font-size: 12.5px; }
@media (max-width: 900px) { .b-pair, .b-facts { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main class="b-wrap">
<header>
<h1>Projects redesign · three options for your review</h1>
<p class="b-lede">You said the Projects cards, the project page and its details are overwhelming. These are three ways to fix it, shown in all five states on desktop and on a 390px phone. Nothing in the app has changed: these pages use the app’s real stylesheet and real page frame, and every state’s words and build lists are what the app shows for that state today. The projects are examples. 21 October 2026.</p>
</header>

<section class="b-box">
<h2>Kept in every option</h2>
<ul>
<li>The four phone tabs (Caddie, Brief, Discover, Projects) and the chat box above them; the chat beside the page on desktop.</li>
<li>The steps Plan → Build → Check → Submit (Share for a personal project).</li>
<li>The card look you approved on 20 October: compact spacing, 13px corners, one outer frame.</li>
</ul>
<h3>Rules every option follows</h3>
<ol>
<li>One header: the name once, its state once, then the hackathon and deadline on one line.</li>
<li>The current step’s work is one card; nothing inside it is drawn as another card.</li>
<li>The chat beside a project page doesn’t repeat the project card. It shows one line, such as “Building your app · 2 of 7 features done · On this page”.</li>
<li>One main button per screen; everything else is quiet.</li>
<li>The brief, history, files, to-dos and settings are one tap away, not all on the page at once.</li>
<li>Every word comes from the same project status the chat and the Brief use. No made-up progress.</li>
</ol>
</section>

<section id="today">
<h2>Today</h2>
<img class="b-sheet" src="shots/sheet-today.png" alt="Today: the project page while building and the Projects list on desktop, and six phone screens">
<div class="b-box"><ul>
<li>On desktop the build shows twice: in the page’s Now card, and again in the chat beside it as a full project card, whose “Open project” button opens the page you are already on.</li>
<li>A card inside a card: the Now card wraps the “Building your app” card.</li>
<li>On a phone the name shows twice, the hackathon chips take two rows, and the steps show twice (the “Step 2 of 4” line with its bar, then four step buttons).</li>
<li>“Your idea” repeats the line under the name word for word, and “Your app” is an empty placeholder until the app exists.</li>
<li>A Projects card is ${tallest(m('today', 'list-desktop'))}px tall on desktop and ${tallest(m('today', 'list-phone'))}px on a phone, so ${m('today', 'list-phone').cardsOnFirstScreen} fit on the first phone screen.</li>
</ul></div>
</section>

${OPTIONS.map(option).join('\n')}

<section id="compare">
<h2>Side by side</h2>
${compare}
</section>

<section id="recommend" class="b-box">
<h2>My recommendation</h2>
<p>Option A for the project page, with option B’s Projects card. A is the plan’s own baseline (one header and the steps, then the current step’s work), has the least to read, and puts the button you need first in every state. B’s card keeps the deadline visible for hackathon projects for one extra line. C reads well but is the longest page, and B adds a tap before you see the work.</p>
</section>

<section id="found" class="b-box">
<h2>Found while preparing this (today’s app)</h2>
<ol>
<li>A paused build says “Press Retry to continue from here” (<code>apps/app/src/server/build-workflow.ts</code>, the stalled-build message), but its button says “Review next step” (<code>apps/app/src/server/project-experience.ts</code>, the blocked stage’s action).</li>
<li>While a build is paused, the Plan step says “Paused — check with Caddie” in amber although the plan was approved: the steps read the workflow phase (<code>apps/app/src/client/workspace/project-status.ts</code>, <code>workflowSteps</code>), which can’t tell a stuck plan from a paused build, while the Now card reads the project status, which knows the plan was approved. The options use the project status.</li>
<li>While building, the server marks “Stop build” as the main action, so the Now card draws it as the blue main button. The options make it quiet.</li>
<li>The chat beside the project page shows “Open project” for the project you are on.</li>
</ol>
</section>

<section id="questions" class="b-box">
<h2>Questions for you</h2>
<ol>
<li>Which project page: A, B or C? Mixing is fine, for example A’s page with C’s card.</li>
<li>Which Projects card: A (leanest), B (adds the hackathon and deadline) or C (keeps the letter tile and the steps)?</li>
<li>Is one status line in the chat beside a project page right? All three options assume it.</li>
<li>Should the two wording mismatches above (the Retry button, Plan showing “Paused”) be fixed now, on their own?</li>
</ol>
<p class="b-small">Not drawn yet: the step pages option B would open (they would reuse A’s card), the Check and Submit steps’ own content, the light theme, and 320px phones. They come with the build.</p>
</section>

<section id="how" class="b-box">
<h2>How these were made</h2>
<ul>
<li><code>tools/capture-today.ts</code> runs the real built app (<code>apps/app/dist</code>) on <code>127.0.0.1:4179</code> with every API answered by test data, the way the browser tests do, and saves today’s screens, the page frame and the real build lists.</li>
<li><code>tools/build-mockups.ts</code> puts each option’s page content into that frame (36 pages), with a snapshot of the app’s stylesheet; <code>assets/review.css</code> holds the few new styles, built from the app’s own colours.</li>
<li><code>tools/shoot-mockups.ts</code> takes the screenshots and the measurements; <code>tools/build-board.ts</code> writes this page.</li>
</ul>
<h3>Words these pages use that the app doesn’t yet</h3>
<ul>${PROPOSED_WORDS.map((w) => `<li>${w}</li>`).join('')}</ul>
</section>
</main>
<script>
for (const tab of document.querySelectorAll('.b-tab')) {
	tab.addEventListener('click', () => {
		const { option, state } = tab.dataset;
		const section = document.getElementById(option);
		for (const t of section.querySelectorAll('.b-tab')) t.setAttribute('aria-pressed', String(t === tab));
		for (const vp of ['desktop', 'phone']) {
			section.querySelector('[data-shot="' + vp + '"]').src = 'shots/' + option + '/project-' + state + '-' + vp + '-full.png';
			section.querySelector('[data-live="' + vp + '"]').href = 'screens/' + option + '/project-' + state + '-' + vp + '.html';
		}
	});
}
</script>
</body>
</html>
`;

writeFileSync(join(REVIEW, 'index.html'), html);
console.log('wrote index.html');
