/**
 * Projects redesign review (2026-10-21): builds the mockup pages for the three
 * options from the real app's rendered shell (templates/, saved by
 * capture-today.ts) and the real stylesheet (a snapshot of apps/app/dist).
 * Only the page content (main) and, on desktop, the chat transcript are
 * replaced; the build-stage and feature lists are the app's own rendered
 * markup (templates/fragments/). Pure: no browser, no network.
 *
 * Words: every state title, message, pill and button label is the app's own
 * (server/project-experience.ts, client/project/now-panel.ts,
 * client/workspace/project-status.ts). Proposed new words are listed in
 * PROPOSED_WORDS and in the review board. The projects are example data.
 *
 * Run from the repo root:  bun docs/reviews/2026-10-21-projects-redesign/tools/build-mockups.ts
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconColor, iconLetter } from '../../../../packages/contracts/src/app-icon.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(HERE, '..');
const REPO = join(REVIEW, '..', '..', '..');
const template = (name: string) => readFileSync(join(REVIEW, 'templates', name), 'utf8');
const fragment = (name: string) => readFileSync(join(REVIEW, 'templates', 'fragments', name), 'utf8');

export type Vp = 'desktop' | 'phone';
export type State = 'review' | 'building' | 'ready' | 'blocked' | 'empty';
export type Option = 'a-focus' | 'b-overview' | 'c-journey';
type StepState = 'done' | 'now' | 'stop' | 'todo';

export const STATES: readonly State[] = ['review', 'building', 'ready', 'blocked', 'empty'];
export const OPTIONS: readonly Option[] = ['a-focus', 'b-overview', 'c-journey'];
export const VPS: readonly Vp[] = ['desktop', 'phone'];

/** Words this review proposes that the app does not use today. */
export const PROPOSED_WORDS = [
	'"Not started yet" under Plan for a project with no plan yet (today the step shows nothing).',
	'"On this page" on the one-line project status in the chat beside the project.',
	'Option B\'s "This project" group and its row descriptions.',
	'Option C\'s dated lines on finished steps ("Approved Oct 19 · version 2") and its "what happens next" lines.',
];

// ---------------------------------------------------------------- icons (client/icons.tsx paths)
const ICONS: Record<string, string> = {
	play: '<path d="M6 4.5v7l5.5-3.5L6 4.5z" fill="currentColor" stroke="none"/>',
	check: '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
	sparkCheck: '<path d="M8 2.5l1.2 2.7 2.9.4-2.1 2 .5 2.9L8 9.3l-2.5 1.2.5-2.9-2.1-2 2.9-.4L8 2.5z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M12.8 12.8l.8.8M12.8 13.6l1.6-1.6" fill="none" stroke="currentColor" stroke-linecap="round"/>',
	trophy: '<path d="M4.5 3.5h7v3a3.5 3.5 0 0 1-7 0v-3z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M4.5 4.5h-2v1a2 2 0 0 0 2 2M11.5 4.5h2v1a2 2 0 0 1-2 2M8 10v2M5.5 13.5h5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
	settings: '<path d="M2.5 4.5h4M9.5 4.5h4M2.5 11.5h7M12.5 11.5h1" fill="none" stroke="currentColor" stroke-linecap="round"/><circle cx="8" cy="4.5" r="1.5" fill="none" stroke="currentColor"/><circle cx="11" cy="11.5" r="1.5" fill="none" stroke="currentColor"/>',
	info: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor"/><path d="M8 7.5V11M8 5.2v.1" fill="none" stroke="currentColor" stroke-linecap="round"/>',
	doc: '<path d="M4 2.5h5l3 3v8H4v-11z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M9 2.5v3h3M6 8.5h4M6 11h4" fill="none" stroke="currentColor" stroke-linecap="round"/>',
	clock: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor"/><path d="M8 4.8V8l2.2 1.6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
	box: '<path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11V5z" fill="none" stroke="currentColor" stroke-linejoin="round"/><path d="M2.5 5L8 7.5 13.5 5M8 7.5v6" fill="none" stroke="currentColor" stroke-linejoin="round"/>',
	chevron: '<path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
	expand: '<path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
	tasks: '<path d="M3 4.5l1.2 1.2L6.5 3.5M3 10.5l1.2 1.2 2.3-2.2M8.5 5h4.5M8.5 11h4.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>',
};
const icon = (name: string) => `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICONS[name] ?? ''}</svg>`;

// ---------------------------------------------------------------- the example project and the app's own words
const P = {
	name: 'FarmLog AI',
	purpose: 'Helps small farmers log feed and spot a sick animal early.',
	event: 'Nebius x NVIDIA Global AI Hackathon',
	ends: 'Ends Oct 30 · 9 days left',
	due: 'Due in 9 days',
	can: 'You can enter',
};
const BLOCKED_MSG = 'Caddie stopped making progress on the build for 12 minutes, so it was paused. Your plan and files are saved. Press Retry to continue from here.';
const APPROVE_MEANING = 'Approving lets Caddie build exactly this plan in a private workspace; putting it online or changing real data always asks you first.';
const FEATURES = ['Log daily feed', 'See the feed dashboard', 'Flag a sick animal', 'Record a vet visit', 'Weekly summary for the farm', 'Works without a signal', 'Add a photo to a log'];

/** The Projects card (client/workspace/project-status.ts projectCardFromExperience; projectStatus for no workflow). */
const CARD: Record<State, { label: string; tone: string; live: boolean; action: string }> = {
	review: { label: 'Plan ready', tone: 'warn', live: false, action: 'Review plan' },
	building: { label: 'Building', tone: 'action', live: true, action: 'See progress' },
	ready: { label: 'Ready to try', tone: 'ok', live: false, action: 'Try app' },
	blocked: { label: 'Needs attention', tone: 'danger', live: false, action: 'Review next step' },
	empty: { label: 'No updates yet', tone: 'neutral', live: false, action: 'Continue with Caddie' },
};

/** The Now words (now-panel.ts TITLES, server messageOf/actionsOf). */
const NOW: Record<State, { title: string; message: string; updated: string; primary: string; secondary?: string }> = {
	review: { title: 'Your plan is ready to review', message: 'A plan is ready for your review.', updated: 'Updated 4 min ago', primary: 'Approve plan', secondary: 'Request a change' },
	building: { title: 'Caddie is building your app', message: 'Caddie is building and checking your app.', updated: 'Updated 1 min ago', primary: 'Stop build' },
	ready: { title: 'Your app is ready to try', message: 'Your app passed the required checks. Try it out.', updated: 'Updated 12 min ago', primary: 'Try app', secondary: 'Request a change' },
	blocked: { title: 'Caddie needs something from you', message: BLOCKED_MSG, updated: 'Updated 20 min ago', primary: 'Review next step' },
	empty: { title: 'Let’s get started', message: 'Tell Caddie what you want to make. Your plan, decisions, and progress will appear here.', updated: '', primary: 'Continue with Caddie' },
};

const STEP_LABELS = ['Plan', 'Build', 'Check', 'Submit'] as const;
/** Where the work is, from ProjectExperience (which knows the plan was approved even when a build is paused). */
const STEP_STATE: Record<State, StepState[]> = {
	review: ['now', 'todo', 'todo', 'todo'],
	building: ['done', 'now', 'todo', 'todo'],
	ready: ['done', 'done', 'now', 'todo'],
	blocked: ['done', 'stop', 'todo', 'todo'],
	empty: ['now', 'todo', 'todo', 'todo'],
};
/** Step words: project-status.ts workflowSteps, plus feature counts from the build activity. */
const STEP_SUB: Record<State, string[]> = {
	review: ['Ready for you to review', 'After you approve', 'Before you submit', 'Hand in when ready'],
	building: ['Approved', 'Caddie is building it · 2 of 7 features done', 'Before you submit', 'Hand in when ready'],
	ready: ['Approved', 'Ready to try · 7 of 7 features done', 'Ready when you are', 'Hand in when ready'],
	blocked: ['Approved', 'Needs your help · 1 feature stuck', 'Before you submit', 'Hand in when ready'],
	empty: ['Not started yet', 'After you approve', 'Before you submit', 'Hand in when ready'],
};
/** Option B: where the current step's row button goes (it opens the step, or does the obvious thing). */
const ROW_ACTION: Record<State, string> = { review: 'Review plan', building: 'See progress', ready: 'Try app', blocked: 'Review next step', empty: 'Continue with Caddie' };
/** Option C: dated outcome of a finished step, and what happens at a step still to come. */
const DONE_LINE = ['Approved Oct 19 · version 2', 'Built and checked Oct 21 · 7 of 7 features · 70 tests passing'];
const DONE_LINK = ['View the plan', 'See what was built'];
const LATER_LINE = ['', 'Starts when you approve the plan', 'Caddie checks it against the hackathon’s rules', 'Hand in by Oct 30 · 9 days left'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function pill(state: State): string {
	const c = CARD[state];
	return `<span class="badge project-card-pill" data-tone="${c.tone}">${c.live ? '<span class="project-card-live" aria-hidden="true"></span>' : ''}${c.label}</span>`;
}

function cardHead(iconName: string, label: string, badge: string, pulse = false): string {
	return `<div class="compact-card-head"><span class="compact-card-kicker"><span class="compact-card-icon" aria-hidden="true">${icon(iconName)}</span><span>${label}</span>${pulse ? '<span class="compact-card-pulse" aria-hidden="true"></span>' : ''}</span><span class="compact-card-badge">${badge}</span></div>`;
}

function header(state: State, vp: Vp): string {
	const event = `<span>${icon('trophy')}${P.event}</span>`;
	const updated = NOW[state].updated ? `<span class="rv-updated">${NOW[state].updated}</span>` : '';
	if (vp === 'phone') {
		// The phone header above already says "FarmLog AI": no second title.
		return `<header class="rv-head"><div class="rv-head-row">${pill(state)}${updated}</div><p class="rv-purpose">${P.purpose}</p><p class="rv-meta">${event}<span class="rv-sep">·</span><span class="rv-due">${P.due}</span></p></header>`;
	}
	return `<header class="rv-head"><div class="rv-head-row"><h1 class="rv-title">${P.name}</h1>${pill(state)}${updated}</div><p class="rv-purpose">${P.purpose}</p><p class="rv-meta">${event}<span class="rv-sep">·</span><span class="rv-due">${P.ends}</span><span class="rv-sep">·</span><span class="rv-okay">${icon('check')}${P.can}</span></p></header>`;
}

function deviceMock(): string {
	return `<div class="rv-device" aria-label="Your app, live preview"><div class="rv-app-top"><b>FarmLog</b><span>Tue 21 Oct</span></div><div class="rv-app-card"><b>Today’s feed</b>3 of 4 pens logged</div><div class="rv-app-card" data-alert><b>Goat 12 is eating less</b>Down 40% over 3 days. Check on her.</div><div class="rv-app-card"><b>Vet visit</b>Thursday, 10:00</div><div class="rv-app-btn">Log feed</div><span class="rv-device-open">${icon('expand')}Full screen</span></div>`;
}

/** The real feature list inside a fold; its own heading moves into the fold's summary. */
function featuresFold(state: 'building' | 'ready' | 'blocked', vp: Vp, summary: string): string {
	const list = fragment(`project-${state}-build-features-${vp}.html`).replace(/<h4 class="build-features-head">[\s\S]*?<\/h4>/, '');
	return `<details class="rv-fold"><summary>${summary}</summary>${list}</details>`;
}

/**
 * The current step's work: ONE card, sections separated by hairlines, never a
 * card inside it. `title: false` (option C) leaves the heading to the timeline.
 * A message that only restates the title is left out (review, building).
 */
function workCard(state: State, vp: Vp, opts: { head?: boolean; title?: boolean } = {}): string {
	const head = opts.head ?? true;
	const now = NOW[state];
	const title = opts.title === false ? '' : `<h2 class="rv-work-title">${now.title}</h2>`;
	const message = state === 'ready' || state === 'blocked' || state === 'empty' ? `<p class="rv-work-msg">${now.message}</p>` : '';
	const actions = (primary: string, secondary?: string, ghostPrimary = false) =>
		`<div class="row-actions"><button type="button" class="${ghostPrimary ? 'btn-ghost rv-stop' : 'btn-key'}">${primary}</button>${secondary ? `<button type="button" class="btn-ghost">${secondary}</button>` : ''}</div>`;
	switch (state) {
		case 'review':
			return `<section class="caddie-card rv-work" data-design="plan" data-tone="blue">${head ? cardHead('check', 'Your decision', 'Needs you') : ''}${title}
<dl class="rv-plan">
<div class="rv-plan-row"><dt>What you’re making</dt><dd>A phone-first app where small farmers log each day’s feed and get an early warning when an animal may be sick.</dd></div>
<div class="rv-plan-row"><dt>Who it’s for, in your words</dt><dd>“farmers like my uncle who keep goats and cannot read English well”</dd></div>
<div class="rv-plan-row"><dt>Required by the hackathon</dt><dd>“Projects must use NVIDIA Nemotron models served through Nebius Token Factory.”</dd></div>
<div class="rv-plan-row"><dt>What it will do · 7 features</dt><dd><ol>${FEATURES.map((f) => `<li>${f}</li>`).join('')}</ol></dd></div>
<div class="rv-plan-row"><dt>Everything else</dt><dd><a class="rv-link" href="#">Read the whole plan</a></dd></div>
</dl><p class="rv-meaning">${APPROVE_MEANING}</p>${actions(now.primary, now.secondary)}</section>`;
		case 'building':
			return `<section class="caddie-card rv-work" data-design="build" data-tone="blue">${head ? cardHead('play', 'Building your app', 'In progress', true) : ''}${title}
<div class="${title || head ? 'rv-section' : ''}">${fragment(`project-building-build-stages-${vp}.html`)}</div>
${featuresFold('building', vp, 'Features · 2 of 7 done · now: Flag a sick animal')}${actions(now.primary, undefined, true)}</section>`;
		case 'ready':
			return `<section class="caddie-card rv-work" data-design="preview" data-tone="green">${head ? cardHead('play', 'Your app is ready', 'Passed the checks') : ''}<div class="rv-ready">${deviceMock()}<div class="rv-ready-body">${title}${message}<p class="rv-facts"><b>7 of 7 features done</b> · 70 tests passing · version 2</p>${actions(now.primary, now.secondary)}<p class="rv-quiet">Next: Caddie checks it against the hackathon’s rules before you submit.</p></div></div>
${featuresFold('ready', vp, 'What it does · 7 features')}</section>`;
		case 'blocked':
			return `<section class="caddie-card rv-work" data-design="repair" data-tone="amber">${head ? cardHead('info', 'Build paused', 'Needs you') : ''}${title}${message}${actions(now.primary, 'Ask Caddie what happened')}
${featuresFold('blocked', vp, 'Features · 3 of 7 done · 1 stuck')}</section>`;
		case 'empty':
			return `<section class="caddie-card rv-work" data-tone="quiet">${head ? cardHead('info', 'Getting started', 'No plan yet') : ''}${title}${message}${actions(now.primary)}<p class="rv-quiet">Caddie drafts a plan for you to review before it builds anything.</p></section>`;
	}
}

function moreLinks(): string {
	const link = (name: string, label: string) => `<a href="#">${icon(name)}${label}</a>`;
	return `<nav class="rv-morelinks" aria-label="More about this project">${link('doc', 'The brief')}${link('clock', 'History')}${link('box', 'Files')}${link('tasks', 'To-dos')}${link('settings', 'Settings')}</nav>`;
}

// ---------------------------------------------------------------- option A: focused, one step at a time
function optionA(state: State, vp: Vp): string {
	const tabs = STEP_LABELS.map((label, i) => {
		const s = STEP_STATE[state][i]!;
		const mark = s === 'done' ? '✓' : String(i + 1);
		return `<a class="rv-tab" href="#" data-state="${s}"${s === 'now' || s === 'stop' ? ' aria-current="step"' : ''}><span class="rv-tab-mark" aria-hidden="true">${mark}</span>${label}</a>`;
	}).join('');
	return `${header(state, vp)}<nav class="rv-tabs" aria-label="Project steps">${tabs}</nav>${workCard(state, vp)}${moreLinks()}`;
}

// ---------------------------------------------------------------- option B: overview with a way into each step
function optionB(state: State, vp: Vp): string {
	const rows = STEP_LABELS.map((label, i) => {
		const s = STEP_STATE[state][i]!;
		const mark = s === 'done' ? '✓' : String(i + 1);
		if (s === 'now' || s === 'stop') {
			// Its status once; the message only when it says something the status does not.
			const msg = state === 'blocked' || state === 'empty' ? `<p class="rv-row-msg">${NOW[state].message}</p>` : '';
			return `<li><div class="rv-row rv-row-current" data-state="${s}"><span class="rv-mark" aria-hidden="true">${mark}</span><div class="rv-row-text"><span class="rv-row-label">${label}</span><span class="rv-row-sub">${STEP_SUB[state][i]}</span>${msg}<div class="row-actions"><a class="btn-key rv-row-btn" href="#">${ROW_ACTION[state]}</a></div></div></div></li>`;
		}
		return `<li><a class="rv-row" href="#" data-state="${s}"><span class="rv-mark" aria-hidden="true">${mark}</span><span class="rv-row-text"><span class="rv-row-label">${label}</span><span class="rv-row-sub">${STEP_SUB[state][i]}</span></span><span class="rv-chev">${icon('chevron')}</span></a></li>`;
	}).join('');
	const about = [
		['doc', 'Idea and brief', 'Your idea in your words, and the brief Caddie wrote'],
		['tasks', 'To-dos', 'Nothing open'],
		['clock', 'History', 'Every decision and build so far'],
		['settings', 'Settings', 'Name, code and sharing'],
	]
		.map(([name, label, sub]) => `<li><a class="rv-row" href="#"><span class="rv-row-icon">${icon(name!)}</span><span class="rv-row-text"><span class="rv-row-label">${label}</span><span class="rv-row-sub">${sub}</span></span><span class="rv-chev">${icon('chevron')}</span></a></li>`)
		.join('');
	return `${header(state, vp)}<section class="rv-group" aria-label="Steps"><p class="rv-group-title">Steps</p><ol class="rv-list caddie-card">${rows}</ol></section><section class="rv-group" aria-label="This project"><p class="rv-group-title">This project</p><ul class="rv-list caddie-card">${about}</ul></section>`;
}

// ---------------------------------------------------------------- option C: the journey, as a timeline
function optionC(state: State, vp: Vp): string {
	const nodes = STEP_LABELS.map((label, i) => {
		const s = STEP_STATE[state][i]!;
		const mark = s === 'done' ? '✓' : String(i + 1);
		let body = '';
		if (s === 'done') {
			body = `<div class="rv-node-head"><span class="rv-node-label">${label}</span><a class="rv-link rv-node-link" href="#">${DONE_LINK[i]}</a></div><span class="rv-node-sub">${DONE_LINE[i]}</span>`;
		} else if (s === 'now' || s === 'stop') {
			body = `<div class="rv-node-head"><span class="rv-node-label">${label}</span></div><span class="rv-node-sub">${STEP_SUB[state][i]}</span><div class="rv-node-work">${workCard(state, vp, { head: false, title: false })}</div>`;
		} else {
			body = `<div class="rv-node-head"><span class="rv-node-label">${label}</span></div><span class="rv-node-sub">${LATER_LINE[i]}</span>`;
		}
		return `<li class="rv-node" data-state="${s}"><span class="rv-node-mark" aria-hidden="true">${mark}</span><div class="rv-node-body">${body}</div></li>`;
	}).join('');
	return `${header(state, vp)}<ol class="rv-tl" aria-label="Where this project is">${nodes}</ol>${moreLinks()}`;
}

// ---------------------------------------------------------------- Projects list
const LIST: Array<{ id: string; name: string; purpose: string; state: State; updated: string; hackathon: boolean }> = [
	{ id: 'proj-farm', name: 'FarmLog AI', purpose: 'Helps small farmers log feed and spot a sick animal early.', state: 'building', updated: 'Updated 1 min ago', hackathon: true },
	{ id: 'proj-herd', name: 'HerdVoice', purpose: 'Lets herders report a sick animal by voice, in their own language.', state: 'ready', updated: 'Updated 12 min ago', hackathon: true },
	{ id: 'proj-pit', name: 'Pit wall', purpose: 'A race-day strategy board for a small karting team.', state: 'review', updated: 'Updated 4 min ago', hackathon: false },
	{ id: 'proj-market', name: 'Market Day', purpose: 'Shows which stalls have stock before you travel.', state: 'blocked', updated: 'Updated 20 min ago', hackathon: false },
	{ id: 'proj-budget', name: 'Budget buddy', purpose: 'A simple monthly budget for a student.', state: 'empty', updated: 'Updated 3 days ago', hackathon: false },
];

function listCard(option: Option, p: (typeof LIST)[number]): string {
	const c = CARD[p.state];
	const foot = (left: string) => `<div class="rv-pcard-foot"><span class="rv-updated">${left}</span><button type="button" class="${p.state === 'empty' ? 'btn-ghost' : 'btn-key'}">${c.action}</button></div>`;
	const meta = p.hackathon ? `<p class="rv-pcard-meta">${icon('trophy')}<span class="rv-event">${P.event}</span><span class="rv-sep">·</span><span class="rv-due">${P.due}</span></p>` : '';
	if (option === 'a-focus') {
		return `<li class="caddie-card rv-pcard"><div class="rv-pcard-head"><a class="rv-pcard-name" href="#">${p.name}</a>${pill(p.state)}</div><p class="rv-pcard-purpose">${p.purpose}</p>${foot(p.updated)}</li>`;
	}
	if (option === 'b-overview') {
		return `<li class="caddie-card rv-pcard"><div class="rv-pcard-head"><a class="rv-pcard-name" href="#">${p.name}</a>${pill(p.state)}</div><p class="rv-pcard-purpose">${p.purpose}</p>${meta}${foot(p.updated)}</li>`;
	}
	const strip = STEP_LABELS.map((label, i) => {
		const s = STEP_STATE[p.state][i]!;
		const shown = p.state === 'empty' ? 'todo' : s;
		const name = i === 3 && !p.hackathon ? 'Share' : label;
		return `${i > 0 ? '<span class="rv-strip-line" aria-hidden="true"></span>' : ''}<span class="rv-strip-step" data-state="${shown}"><span class="rv-strip-dot" aria-hidden="true"></span>${name}</span>`;
	}).join('');
	return `<li class="caddie-card rv-pcard"><div class="rv-pcard-head"><span class="rv-pcard-tile" style="background:${iconColor(p.id)}" aria-hidden="true">${iconLetter(p.name) ?? '•'}</span><span class="rv-pcard-titles"><a class="rv-pcard-name" href="#">${p.name}</a><span class="rv-pcard-purpose">${p.purpose}</span></span>${pill(p.state)}</div><div class="rv-strip" aria-label="Where this project is">${strip}</div>${foot(p.hackathon ? `<span class="rv-due">${P.due}</span>` : p.updated)}</li>`;
}

function listPage(option: Option): string {
	const head = `<div class="r-section-head"><div><h1 class="page-title">Your projects</h1><p class="page-lede">Pick up where you left off, or start something new with Caddie.</p></div><span class="disc-actions"><button type="button" class="btn-key">New project</button><button type="button" class="btn-ghost">Bring your code</button></span></div>`;
	return `${head}<ul class="rv-plist">${LIST.map((p) => listCard(option, p)).join('')}</ul>`;
}

// ---------------------------------------------------------------- the chat beside a project page (desktop)
function chat(state: State): string {
	if (state === 'empty') {
		return `<div class="msg assistant" data-seq="first"><div class="bubble"><div class="md-body"><p>Tell me what FarmLog AI should do and who it’s for. I’ll draft a plan for you to review before anything is built.</p></div></div></div>`;
	}
	const status: Record<Exclude<State, 'empty'>, [string, string, boolean]> = {
		review: ['Your plan is ready to review', 'Needs you', false],
		building: ['Building your app', '2 of 7 features done', true],
		ready: ['Your app is ready to try', '7 of 7 features done', false],
		blocked: ['Caddie needs something from you', 'Build paused', false],
	};
	const [title, sub, live] = status[state];
	return `<div class="msg user" data-seq="first"><div class="bubble">Can farmers use it when there’s no signal?</div></div><div class="msg assistant" data-seq="first"><div class="bubble"><div class="md-body"><p>Yes. “Works without a signal” is feature 6 in your plan: logs are kept on the phone and sent once there’s signal again.</p></div></div></div><a class="rv-chat-status" href="#">${live ? '<span class="project-card-live" aria-hidden="true"></span>' : ''}<b>${title}</b> · ${esc(sub)}<span class="rv-chat-where">On this page</span></a>`;
}

// ---------------------------------------------------------------- assembling pages
function buildAppCss(): void {
	const dist = join(REPO, 'apps', 'app', 'dist', 'client', 'assets');
	const cssFile = readdirSync(dist).find((f) => /^index-.*\.css$/.test(f));
	if (!cssFile) throw new Error('no built stylesheet in apps/app/dist; run `bun run build` first');
	let inlined = 0;
	const css = readFileSync(join(dist, cssFile), 'utf8').replace(/@font-face\{[^}]*\}/g, (block) => {
		const font = /url\(\/assets\/((?:inter|ibm-plex-mono)-latin-\d{3}-normal-[^)]+\.woff2)\)/.exec(block);
		if (!font) return '';
		const keep = ['font-family', 'font-style', 'font-display', 'font-weight', 'unicode-range']
			.map((prop) => new RegExp(`${prop}:[^;}]+`).exec(block)?.[0])
			.filter(Boolean);
		inlined += 1;
		return `@font-face{${keep.join(';')};src:url(data:font/woff2;base64,${readFileSync(join(dist, font[1]!)).toString('base64')}) format("woff2")}`;
	});
	if (inlined < 8) throw new Error(`expected 8 latin fonts, inlined ${inlined}`);
	writeFileSync(join(REVIEW, 'assets', 'app.css'), `/* Snapshot of the app's built stylesheet (apps/app/dist/client/assets/${cssFile}) for the 2026-10-21 Projects review: latin fonts inlined, other font subsets dropped. Generated by tools/build-mockups.ts. */\n${css}`);
}

async function page(templateName: string, main: string, transcript: string | null): Promise<string> {
	let rewriter = new HTMLRewriter()
		.on('link[rel="stylesheet"]', {
			element(el) {
				el.replace('<link rel="stylesheet" href="../../assets/app.css"><link rel="stylesheet" href="../../assets/review.css">', { html: true });
			},
		})
		.on('link[rel="apple-touch-icon"]', { element: (el) => void el.remove() })
		.on('main#main', {
			element(el) {
				el.setInnerContent(`<div class="shell-loading shell-page"><div class="page-col rv-col">${main}</div></div>`, { html: true });
			},
		});
	if (transcript !== null) rewriter = rewriter.on('aside .transcript', { element: (el) => void el.setInnerContent(transcript, { html: true }) });
	return rewriter.transform(new Response(template(templateName))).text();
}

export function screenPath(option: Option, name: string, vp: Vp): string {
	return join('screens', option, `${name}-${vp}.html`);
}

export const OPTION_INFO: Record<Option, { letter: string; title: string; idea: string }> = {
	'a-focus': { letter: 'A', title: 'Focused: one step at a time', idea: 'Opening a project goes straight to the step the work is on. The page shows that step’s work and nothing else; the four steps are one row of tabs.' },
	'b-overview': { letter: 'B', title: 'Overview: a short summary, one tap into each step', idea: 'Opening a project shows the four steps as rows with their status in words; the current one carries its one button. A step’s details open on its own page.' },
	'c-journey': { letter: 'C', title: 'Journey: where it’s been and where it’s going', idea: 'The four steps as a timeline: finished steps say what happened and when, the current step opens in place with its work, later steps say what happens next.' },
};

function sheet(title: string, lede: string, desk: Array<[string, string]>, phones: Array<[string, string]>): string {
	const fig = (cls: string, [caption, src]: [string, string]) => `<figure class="${cls}"><figcaption>${caption}</figcaption><img src="${src}" alt="${esc(caption)}"></figure>`;
	return `<!doctype html><html lang="en" data-theme="dark" data-palette="caddie"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="../../assets/app.css"><style>
body{margin:0;background:var(--color-ink);color:var(--color-bright);font-family:var(--font-ui)}
.sheet{width:1536px;padding:28px 32px;display:grid;gap:16px}
h1{margin:0;font-size:26px;letter-spacing:-.02em}.lede{margin:0;max-width:1100px;color:var(--color-muted);font-size:15px;line-height:1.5}
.row{display:flex;gap:16px;align-items:flex-start}figure{margin:0;display:grid;gap:6px}
figcaption{font-size:13px;font-weight:600;color:var(--color-muted)}figure img{display:block;border:1px solid var(--color-line);border-radius:12px}
.desk img{width:752px}.phone img{width:240px}
</style></head><body><div class="sheet"><h1>${title}</h1><p class="lede">${lede}</p><div class="row">${desk.map((d) => fig('desk', d)).join('')}</div><div class="row">${phones.map((p) => fig('phone', p)).join('')}</div></div></body></html>`;
}

function sheets(): void {
	const dir = join(REVIEW, 'screens', 'sheets');
	mkdirSync(dir, { recursive: true });
	const names: Record<State, string> = { review: 'Plan to approve', building: 'Building', ready: 'Ready to try', blocked: 'Needs you', empty: 'No plan yet' };
	writeFileSync(
		join(dir, 'sheet-today.html'),
		sheet(
			'Today',
			'The running app today, same example projects and states (taken from the real build with test data).',
			[['Project page while building · desktop', '../../today/project-building-desktop.png'], ['Projects list · desktop', '../../today/list-desktop.png']],
			[['Projects list', '../../today/list-phone.png'], ...(['review', 'building', 'ready', 'blocked', 'empty'] as const).map((s): [string, string] => [names[s], `../../today/project-${s}-phone.png`])],
		),
	);
	for (const option of OPTIONS) {
		const info = OPTION_INFO[option];
		writeFileSync(
			join(dir, `sheet-${option}.html`),
			sheet(
				`Option ${info.letter} · ${info.title}`,
				info.idea,
				[['Project page while building · desktop', `../../shots/${option}/project-building-desktop.png`], ['Projects list · desktop', `../../shots/${option}/list-desktop.png`]],
				[['Projects list', `../../shots/${option}/list-phone.png`], ...STATES.map((s): [string, string] => [names[s], `../../shots/${option}/project-${s}-phone.png`])],
			),
		);
	}
}

async function main(): Promise<void> {
	mkdirSync(join(REVIEW, 'assets'), { recursive: true });
	buildAppCss();
	sheets();
	const builders: Record<Option, (state: State, vp: Vp) => string> = { 'a-focus': optionA, 'b-overview': optionB, 'c-journey': optionC };
	let count = 0;
	for (const option of OPTIONS) {
		mkdirSync(join(REVIEW, 'screens', option), { recursive: true });
		for (const vp of VPS) {
			writeFileSync(join(REVIEW, screenPath(option, 'list', vp)), await page(`list-${vp}.html`, listPage(option), null));
			count += 1;
			for (const state of STATES) {
				const html = await page(`project-ready-${vp}.html`, builders[option](state, vp), vp === 'desktop' ? chat(state) : null);
				writeFileSync(join(REVIEW, screenPath(option, `project-${state}`, vp)), html);
				count += 1;
			}
		}
	}
	console.log(`wrote assets/app.css and ${count} mockup pages`);
}

if (import.meta.main) await main();
