/* Caddie v2 — shared shell. Content on the left, Caddie always on the right (desktop);
   Caddie · Brief · Discover · Projects with an always-on input above the tab bar (mobile). */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('caddie2.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('caddie2.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  /* The name the user gave Caddie in the welcome intro. '' = they skipped; unset = demo persona. */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* The account you signed in with (Better Auth `session.user.name`). Google gives a full name;
     GitHub gives your display name, or your username if you never set one. Demo: GitHub "Jay".
     Prototype only: sign-in passes ?via=github|google (and review links may add &name=…). */
  (() => {
    const q = new URLSearchParams(location.search), via = q.get('via');
    if (via !== 'github' && via !== 'google') return;
    store.set('account', { provider: via === 'google' ? 'Google' : 'GitHub', name: q.has('name') ? q.get('name').slice(0, 80) : 'Jay' });
    try { localStorage.removeItem('caddie2.name'); } catch (e) { /* private mode */ } // a fresh sign-in starts from the account name
  })();
  const ACCOUNT = Object.assign({ provider: 'GitHub', name: 'Jay' }, store.get('account', {}));
  /* First name only; a username (no space, has digits/_-.) isn't a name, so suggest nothing. */
  const suggestName = (full) => {
    const n = String(full || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!n || (!n.includes(' ') && /[\d_.\-]/.test(n))) return '';
    return n.split(' ')[0];
  };
  window.CaddieAccount = { provider: ACCOUNT.provider, name: ACCOUNT.name, suggested: suggestName(ACCOUNT.name), suggestName };
  const NAME = esc(String(store.get('name', suggestName(ACCOUNT.name))).trim().slice(0, 40));
  const withName = (s) => (NAME ? ', ' + NAME : '') + s;
  /* ---------- Icons (Lucide-derived paths, ISC) ---------- */
  const P = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    send: '<path d="M5 12h13M12 5l7 7-7 7"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7M18 11.5c0 3-3 4-6 4.5"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1z"/><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
    repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
    gauge: '<path d="M12 14 16 9"/><path d="M3.5 18a10 10 0 1 1 17 0"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
    logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
    sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
  };
  P.brief = '<path d="M4 5h13v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v10a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5M8 17h3"/>';
  P.clip = '<path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4L14.5 7"/>';
  P.list = '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>';
  const I = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || P.info}</svg>`;
  window.CaddieIcon = I;

  /* ---------- Mascot: one SVG, eight states driven by data-state ---------- */
  let mid = 0;
  const Mascot = (state = 'idle', size = 32, live = false) => {
    const n = ++mid;
    return `<svg class="mascot" viewBox="0 0 64 64" width="${size}" height="${size}" data-state="${state}"${size <= 24 ? ' data-size="s"' : ''}${live ? ' data-live' : ''} aria-hidden="true">
<defs><linearGradient id="mg${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--m-blue)"/><stop offset="1" style="stop-color:var(--m-deep)"/></linearGradient></defs>
<g class="m-dots" fill="currentColor"><circle cx="11" cy="13" r="1.7"/><circle cx="6.5" cy="8" r="2.1"/><circle cx="12.5" cy="3" r="2.5"/></g>
<g class="m-z" font-family="IBM Plex Mono, monospace" font-weight="600" fill="currentColor"><text x="5" y="14" font-size="9">z</text><text x="11" y="7" font-size="7">z</text></g>
<g class="m-all">
<g class="m-flag"><path d="M43 18V4.5" stroke="var(--m-deep)" stroke-width="2.6" stroke-linecap="round"/><path d="M43.6 4.6 53 8.1l-9.4 3.5z" fill="var(--m-flag)" stroke="var(--m-flag)" stroke-width="1.4" stroke-linejoin="round"/></g>
<rect class="m-body" x="9" y="16.5" width="46" height="41.5" rx="18" fill="url(#mg${n})"/>
<path class="m-gloss" d="M14.4 31.1A13 13 0 0 1 21.5 22.7" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".32"/>
<g class="m-look">
<g class="m-open" fill="var(--m-ink)"><rect x="21" y="30" width="6.5" height="11" rx="3.25"/><rect x="36.5" y="30" width="6.5" height="11" rx="3.25"/><circle cx="25.4" cy="32.7" r="1.3" fill="#fff"/><circle cx="40.9" cy="32.7" r="1.3" fill="#fff"/></g>
<g class="m-happy" fill="none" stroke="var(--m-ink)" stroke-width="2.6" stroke-linecap="round"><path d="M20.5 37.5q3.75-5 7.5 0"/><path d="M36 37.5q3.75-5 7.5 0"/></g>
<g class="m-closed" fill="none" stroke="var(--m-ink)" stroke-width="2.4" stroke-linecap="round"><path d="M20.5 35.5q3.75 3.6 7.5 0"/><path d="M36 35.5q3.75 3.6 7.5 0"/></g>
<g class="m-flat" fill="none" stroke="var(--m-ink)" stroke-width="2.6" stroke-linecap="round"><path d="M21 36.5h6.5"/><path d="M36.5 36.5H43"/></g>
</g>
<g class="m-cheek" fill="var(--m-cheek)" opacity=".42"><ellipse cx="17.2" cy="44.6" rx="3.2" ry="2"/><ellipse cx="46.8" cy="44.6" rx="3.2" ry="2"/></g>
<path class="m-mouth" d="M28.6 46.6q3.4 3 6.8 0" fill="none" stroke="var(--m-ink)" stroke-width="2.2" stroke-linecap="round"/>
<ellipse class="m-mo" cx="32" cy="47.6" rx="2" ry="2.3" fill="var(--m-ink)"/>
<path class="m-mflat" d="M29 48h6" fill="none" stroke="var(--m-ink)" stroke-width="2.2" stroke-linecap="round"/>
</g>
<g class="m-badge"><circle cx="53" cy="21" r="7" fill="var(--m-flag)" stroke="var(--panel)" stroke-width="2.5"/><path d="M53 17.6v4" stroke="var(--m-ink)" stroke-width="2.2" stroke-linecap="round"/><circle cx="53" cy="24.7" r="1.2" fill="var(--m-ink)"/></g>
</svg>`;
  };
  window.CaddieMascot = Mascot;
  let baseMood = 'idle';
  const setMood = (m) => $$('.mascot[data-live]').forEach((el) => { el.dataset.state = m; });
  window.CaddieMood = setMood;

  /* ---------- Theme ---------- */
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    $$('[data-theme-label]').forEach((el) => { el.textContent = t === 'light' ? 'Dark mode' : 'Light mode'; });
    // Icon-only switches (sign-in): the label names the theme it switches TO.
    $$('.theme-btn[data-theme-toggle]').forEach((el) => { const l = 'Switch to ' + (t === 'light' ? 'dark' : 'light') + ' theme'; el.setAttribute('aria-label', l); el.title = l; });
  };
  const setTheme = (t) => { applyTheme(t); store.set('theme', t); };
  // Only an explicit choice is saved. Pages before the app (sign-in) follow the device when nothing is saved, like the landing page.
  const deviceTheme = () => (window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(store.get('theme', document.documentElement.dataset.themeDefault === 'device' ? deviceTheme() : 'dark'));

  /* ---------- Sample projects (illustrative). Hackathons are real Devpost listings (events.js). ---------- */
  const PROJECTS = {
    ledger: { name: 'Ledger Nudge', event: 'PayPal AI Hackathon', due: 'Due Nov 12', left: '34 days left', dot: 'warn', kind: 'contest', mood: 'needs', status: 'Waiting for your OK on the plan',
      stages: { plan: ['needs', 'Needs your OK'], build: ['', 'Works · older plan'], check: ['', '4 of 6 ready'], submit: ['', '3 things left'] } },
    founder: { name: 'Founder Hours', event: 'AI Agents for Founders — HETIC 2026', due: 'Due Dec 18', left: '70 days left', dot: 'warn', kind: 'contest', mood: 'needs', status: '2 things judges want are missing',
      stages: { plan: ['done', 'Approved'], build: ['done', 'Working preview'], check: ['needs', '2 missing'], submit: ['', 'Not started'] } },
    pantry: { name: 'Pantry Scale', event: 'Personal project', due: 'No deadline', left: '', dot: 'action', kind: 'standalone', mood: 'working', status: 'Building · about 6 min left',
      stages: { plan: ['done', 'Approved'], build: ['', 'Building now'], check: ['', 'Optional'], submit: ['', 'When you’re ready'] } },
  };
  const params = new URLSearchParams(location.search);
  const rawP = params.get('p');
  const pid = rawP || 'ledger';
  const project = PROJECTS[pid] || PROJECTS.ledger;
  window.CaddieProject = { id: PROJECTS[pid] ? pid : 'ledger', ...project };

  const app = $('.app');
  if (!app) return;
  const page = app.dataset.page || '';
  const bare = app.classList.contains('bare');
  const isProject = !!app.dataset.projectTab;
  const isChat = page === 'caddie';
  if (isProject && !PROJECTS[pid]) { location.replace('not-found.html?missing=1'); return; }
  if (isChat) app.classList.add('chat-page');
  const scope = isProject ? pid : isChat && PROJECTS[rawP] ? rawP : 'general';
  const scopeName = scope === 'general' ? 'Everything' : PROJECTS[scope].name;
  const q = (u) => (isProject && pid !== 'ledger' ? `${u}?p=${pid}` : u);
  baseMood = scope === 'general' ? 'idle' : PROJECTS[scope].mood;
  const statusLine = scope === 'general' ? 'Ready · 3 things in your brief' : PROJECTS[scope].status;

  /* ---------- Desktop top nav ---------- */
  const main = $('.main', app);
  const TABS = [['brief', 'brief.html', 'brief', 'Brief'], ['discover', 'discover.html', 'compass', 'Discover'], ['projects', 'projects.html', 'folder', 'Projects']];
  const cur = (k) => (k === page || (k === 'projects' && isProject) ? 'aria-current="page"' : '');
  if (main && !bare) {
    const top = document.createElement('header');
    top.className = 'topnav';
    top.innerHTML = `<a class="brand" href="caddie.html" ${isChat ? 'aria-current="page"' : ''} data-od-id="brand">${Mascot(baseMood, 30)}<span>Caddie</span></a>
      <nav class="tabs-top" aria-label="Primary">${TABS.map(([k, h, ic, l]) => `<a href="${h}" ${cur(k)} data-od-id="tab-${k}">${I(ic)}${l}${k === 'brief' ? '<span class="count" aria-label="3 things">3</span>' : ''}</a>`).join('')}</nav>
      <div class="spacer"></div>
      <button class="search-trigger" data-palette data-od-id="search-trigger">${I('search')}<span>Search</span><kbd>⌘K</kbd></button>
      ${isChat ? '' : `<button class="btn ghost sm conv-fab" data-conv-toggle data-od-id="open-caddie">${Mascot(baseMood, 22, true)}Caddie</button>`}
      <button class="avatar-btn" data-menu="account-menu" aria-haspopup="menu" aria-label="Your account" data-od-id="account-button"><span class="avatar">J</span></button>`;
    main.prepend(top);
    const back = isProject ? 'projects.html' : app.dataset.back;
    const mh = document.createElement('header');
    mh.className = 'm-head';
    mh.innerHTML = `${back ? `<a class="btn ghost icon" href="${back}" aria-label="Back">${I('back')}</a>` : ''}
      <div class="m-title" ${back ? '' : 'style="padding-left:4px"'}>${isChat ? `<button class="about" data-menu="about-menu" aria-haspopup="menu">${I('chat')}Talking about <b>${scopeName}</b>${I('down')}</button>` : isProject ? project.name : app.dataset.title || ''}</div>
      <button class="btn ghost icon" data-palette aria-label="Search">${I('search')}</button>
      <button class="btn ghost icon" data-menu="account-menu" aria-label="Your account"><span class="avatar">J</span></button>`;
    main.prepend(mh);
    main.addEventListener('scroll', () => main.classList.toggle('scrolled', main.scrollTop > 4), { passive: true });
  }

  /* ---------- Project header: title + four plain steps ---------- */
  const ph = $('[data-project-head]');
  if (ph && isProject) {
    const tab = app.dataset.projectTab;
    const last = project.kind === 'contest' ? 'Submit' : 'Share';
    const st = (k, n, label, href) => {
      const [cls, state] = project.stages[k];
      return `<a class="stage ${cls}" href="${q(href)}" ${tab === k ? 'aria-current="page"' : ''} data-od-id="step-${k}"><span class="s-top"><span class="stage-n">${cls === 'done' ? '✓' : n}</span>${label}</span><span class="s-state">${state}</span></a>`;
    };
    ph.className = 'proj-head';
    ph.innerHTML = `<a class="back-link hide-m" href="projects.html">${I('back')}Projects</a>
      <div class="proj-title">
        <div><h1 data-od-id="project-title"><a href="${q('project-overview.html')}">${project.name}</a></h1>
          <div class="meta-line"><span>${I(project.kind === 'standalone' ? 'user' : 'trophy')} ${project.event}</span><span>${I('calendar')} ${project.due}${project.left ? ` · <b style="color:var(--fg);font-weight:550">${project.left}</b>` : ''}</span></div></div>
        <a class="btn ghost icon sm" href="${q('project-settings.html')}" aria-label="Project settings" ${tab === 'settings' ? 'aria-current="page"' : ''} data-od-id="project-settings-link">${I('settings')}</a>
      </div>
      <nav class="stages" aria-label="Project steps">${st('plan', 1, 'Plan', 'project-plan.html')}${st('build', 2, 'Build', 'project-build.html')}${st('check', 3, 'Check', 'project-check.html')}${st('submit', 4, last, 'project-submit.html')}</nav>`;
  }
  $$('[data-when]').forEach((el) => { el.hidden = el.dataset.when !== project.kind; });
  $$('[data-project-name]').forEach((el) => { el.textContent = project.name; });

  /* ---------- Caddie conversation (one thread per "talking about") ---------- */
  const SEEDS = {
    general: [
      { from: 'caddie', text: 'Morning' + withName('.') + ' Your brief is ready — <b>3 things</b> could use you today.', art: ['Today’s brief', '1 approval · 2 hackathons worth a look', 'brief.html', 'brief'] },
      { from: 'user', text: 'Anything I can enter before December?' },
      { from: 'caddie', think: ['Checked 9 hackathons on Devpost · 14s', ['Removed 1 you can’t enter (ages 13–18 only)', 'Compared each one with your skills and free time', 'Kept the two with the best fit']],
        text: 'Two worth a look. <b>Bridge The Gap Hacks</b> fits your Flutter work and runs Nov 15–21. <b>Meta VR</b> has the biggest prize, but it needs a VR app — I can’t build or test that for you yet.', art: ['Bridge The Gap Hacks', 'Online · closes Nov 21', 'opportunity.html?e=bridge', 'trophy'] },
      { from: 'caddie', routine: 'Daily rules check', text: 'PayPal’s rules didn’t change overnight. Nothing to do.' },
    ],
    ledger: [
      { from: 'caddie', text: 'I updated the plan so people can <b>choose how often reminders go out</b>. It changes 2 screens. Nothing you already approved is removed.',
        ask: ['Build the updated plan?', 'Uses up to <b>$4</b> of your $50 monthly limit. About 25 minutes.', 'Approve and build', 'project-plan.html'] },
      { from: 'user', text: 'Does it change the demo video?' },
      { from: 'caddie', text: 'No. PayPal wants a public YouTube video under 3 minutes. I’d record it after this build is done.' },
    ],
    founder: [
      { from: 'caddie', text: 'Judges score 6 things. You have proof for 4. Still missing: <b>a working prototype link</b> and <b>setup instructions</b>.', art: ['See what’s missing', 'Founder Hours · Check', 'project-check.html?p=founder', 'shield'] },
    ],
    pantry: [
      { from: 'user', text: 'Add a “use it up first” list for things about to expire.' },
      { from: 'caddie', think: ['Planned the change · 9s', ['Adds one list on the home screen', 'Reads expiry dates you already enter']], text: 'Building it now — <b>about 6 minutes left</b>. I’ll tell you when you can try it.', art: ['Watch the build', 'Pantry Scale · Build', 'project-build.html?p=pantry', 'bolt'] },
    ],
  };
  const convKey = 'conv.' + scope;
  const msgHtml = (m) => {
    if (m.from === 'user') return `<div class="msg user"><div class="text">${m.text}</div></div>`;
    return `<div class="msg"><div class="from">${Mascot('idle', 22)}<b>Caddie</b>${m.routine ? `<span class="from-routine">${I('repeat')}From routine: ${m.routine}</span>` : ''}</div>
      ${m.think ? `<details class="think"><summary>${I('chevron')}${m.think[0]}</summary><ul>${m.think[1].map((x) => `<li>${x}</li>`).join('')}</ul></details>` : ''}
      <div class="text">${m.text}</div>
      ${m.art ? `<a class="art" href="${m.art[2]}"><span class="ico-box action">${I(m.art[3] || 'file')}</span><span class="grow"><b>${m.art[0]}</b><small>${m.art[1]}</small></span>${I('chevron')}</a>` : ''}
      ${m.ask ? `<div class="ask" data-od-id="chat-ask"><div><b>${m.ask[0]}</b><p>${m.ask[1]}</p></div><div class="btn-row"><button class="btn ${isChat ? "primary" : "secondary"} sm" data-ask-yes>${m.ask[2]}</button><a class="btn ghost sm" href="${m.ask[3]}">Read the plan first</a></div></div>` : ''}</div>`;
  };
  let openConv = () => {};
  if (!bare) {
    const conv = document.createElement('aside');
    conv.className = 'conv';
    conv.setAttribute('aria-label', 'Caddie');
    conv.dataset.odId = 'caddie-panel';
    const sugg = (app.dataset.suggest || 'What should I do next?|Find hackathons for me').split('|');
    conv.innerHTML = `
      <div class="conv-rail"><button data-conv-toggle aria-label="Show Caddie">${Mascot(baseMood, 36, true)}</button></div>
      <div class="conv-head">${Mascot(baseMood, 34, true)}<div class="who"><b>Caddie</b><small data-status>${statusLine}</small></div>
        <a class="btn ghost icon sm" href="caddie.html${scope === 'general' ? '' : '?p=' + scope}" aria-label="Open full screen">${I('external')}</a>
        <button class="btn ghost icon sm" data-conv-toggle aria-label="Hide Caddie">${I('sidebar')}</button></div>
      <div class="conv-about">${isChat ? `<button class="about" data-menu="about-menu" aria-haspopup="menu" data-od-id="talking-about">${I('chat')}Talking about <b>${scopeName}</b>${I('down')}</button>` : `<span class="about">${I(scope === 'general' ? 'globe' : 'folder')}Talking about <b>${scopeName}</b></span>`}</div>
      <div class="conv-body" role="log" aria-live="polite">${isChat ? `<div class="chat-hello">${Mascot(baseMood, 76, true)}<h1>${scope === 'general' ? 'What are we making' + withName('?') : 'Working on ' + scopeName}</h1><p>${scope === 'general' ? 'Ask anything, or tell me what to do. I check with you before I spend money or change your code.' : statusLine + '.'}</p></div>` : ''}</div>
      <div class="suggests">${sugg.map((s) => `<button data-suggest>${s}</button>`).join('')}</div>
      <form class="composer" data-od-id="composer"><label class="sr" for="composer-input">Message Caddie</label>
        <textarea id="composer-input" rows="1" placeholder="Ask Caddie or tell it what to do…"></textarea>
        <div class="composer-foot"><button type="button" class="btn ghost icon sm" aria-label="Attach a file" data-toast="Attach is a prototype stub" data-toast-icon="clip">${I('clip')}</button><span class="meta">Asks before spending money</span><button class="btn primary icon sm" type="submit" aria-label="Send">${I('send')}</button></div></form>`;
    if (isChat) main.append(conv); else app.append(conv);
    const body = $('.conv-body', conv);
    const msgs = store.get(convKey, null) || SEEDS[scope];
    body.insertAdjacentHTML('beforeend', msgs.map(msgHtml).join(''));
    body.scrollTop = body.scrollHeight;
    const ta = $('textarea', conv);
    ta.value = store.get('draft.' + convKey, '');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
    ta.addEventListener('input', () => { store.set('draft.' + convKey, ta.value); grow(); setMood(ta.value.trim() ? 'listening' : baseMood); });
    ta.addEventListener('blur', () => { if (!ta.value.trim()) setMood(baseMood); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form', conv).requestSubmit(); } });
    /* Unsent messages (the real app's draft rows): kept per chat, with Send again · Edit · Discard. */
    const draftsKey = 'unsent.' + convKey;
    let failMode = params.get('chat') === 'unsent' || navigator.onLine === false;
    let unsent = store.get(draftsKey, []);
    if (params.get('chat') === 'unsent' && !unsent.length) unsent = [{ id: 'd1', text: scope === 'general' ? 'Remind me about Bridge The Gap the day it opens' : 'Can the reminder show a preview before it sends?' }];
    const unsentHtml = (d) => `<div class="msg user unsent" data-draft="${d.id}"><div class="text">${esc(d.text)}</div><div class="msg-state fail" role="status">${I('alert')}Not sent<button type="button" class="retry" data-draft-retry>Send again</button><button type="button" data-draft-edit>Edit</button><button type="button" data-draft-discard>Discard</button></div></div>`;
    const offlineHtml = `<div class="conv-offline" role="status" data-od-id="chat-offline">${I('alert')}<span class="grow">Can’t reach Caddie right now. What you send waits here until you send it again.</span></div>`;
    const syncOffline = () => {
      const has = $('.conv-offline', conv);
      if (failMode && !has) body.insertAdjacentHTML('beforebegin', offlineHtml);
      if (!failMode && has) has.remove();
    };
    const saveUnsent = () => store.set(draftsKey, unsent);
    body.insertAdjacentHTML('beforeend', unsent.map(unsentHtml).join(''));
    syncOffline();
    if (unsent.length) setTimeout(() => setMood('stuck'), 0);
    const foot = $('.composer-foot .meta', conv);
    /* A draft restored from an earlier visit is labelled until it's sent or cleared. */
    const draftNote = (restored) => { const d = restored && !!ta.value.trim(); foot.textContent = d ? 'Draft from earlier · not sent yet' : 'Asks before spending money'; foot.classList.toggle('draft-note', d); };
    draftNote(true);
    ta.addEventListener('input', () => { if (!ta.value.trim()) draftNote(false); });
    const deliver = (raw) => {
      const list = store.get(convKey, null) || msgs.slice();
      list.push({ from: 'user', text: esc(raw) });
      body.insertAdjacentHTML('beforeend', `<div class="msg user sending"><div class="text">${esc(raw)}</div><div class="msg-state">${I('clock')}Sending…</div></div>`);
      body.scrollTop = body.scrollHeight;
      setMood('thinking');
      setTimeout(() => {
        const s = $('.msg.sending', body); if (s) { s.classList.remove('sending'); $('.msg-state', s).remove(); }
        body.insertAdjacentHTML('beforeend', '<div class="msg typing-msg"><div class="typing"><i></i><i></i><i></i></div></div>');
        body.scrollTop = body.scrollHeight;
      }, 450);
      setTimeout(() => {
        $('.typing-msg', body)?.remove();
        const r = app.dataset.reply ? app.dataset.reply.split('|') : null;
        const reply = { from: 'caddie', text: 'On it. I’ll put it together and check with you here before anything runs or costs money.', art: r ? [r[0], r[1], r[2], 'arrow'] : null };
        list.push(reply); store.set(convKey, list);
        body.insertAdjacentHTML('beforeend', msgHtml(reply));
        body.scrollTop = body.scrollHeight;
        setMood('done'); setTimeout(() => setMood(unsent.length ? 'stuck' : baseMood), 1800);
      }, 1700);
    };
    const send = (text) => {
      if (!text.trim()) return;
      ta.value = ''; store.set('draft.' + convKey, ''); grow(); draftNote(false);
      if (failMode) {
        const d = { id: 'd' + Date.now(), text: text.trim().slice(0, 4000) };
        unsent.push(d); saveUnsent();
        body.insertAdjacentHTML('beforeend', unsentHtml(d));
        body.scrollTop = body.scrollHeight;
        setMood('stuck');
        return;
      }
      deliver(text.trim());
    };
    conv.addEventListener('click', (e) => {
      const row = e.target.closest('[data-draft]'); if (!row) return;
      const d = unsent.find((x) => x.id === row.dataset.draft); if (!d) return;
      const drop = () => { unsent = unsent.filter((x) => x !== d); saveUnsent(); row.remove(); };
      if (e.target.closest('[data-draft-retry]')) { failMode = false; syncOffline(); drop(); deliver(d.text); }
      else if (e.target.closest('[data-draft-edit]')) { drop(); ta.value = d.text; store.set('draft.' + convKey, ta.value); grow(); draftNote(false); ta.focus(); setMood(unsent.length ? 'stuck' : 'listening'); }
      else if (e.target.closest('[data-draft-discard]')) { drop(); toast('Message discarded', 'trash'); if (!unsent.length) setMood(baseMood); }
    });
    addEventListener('online', () => { failMode = false; syncOffline(); });
    addEventListener('offline', () => { failMode = true; syncOffline(); });
    $('form', conv).addEventListener('submit', (e) => { e.preventDefault(); send(ta.value); });
    $$('[data-suggest]', conv).forEach((b) => b.addEventListener('click', () => send(b.textContent)));
    conv.addEventListener('click', (e) => {
      const y = e.target.closest('[data-ask-yes]'); if (!y) return;
      const card = y.closest('.ask'); card.classList.add('answered');
      $('.btn-row', card).innerHTML = `<span class="chip ok">${I('check')}Approved · building started</span>`;
      baseMood = 'working'; setMood('working'); $$('[data-status]').forEach((s) => { s.textContent = 'Building · about 25 min left'; });
      toast('Approved — Caddie is building');
    });
    window.CaddieAsk = (text) => { openConv(true); send(text); };
    if (isChat && location.hash === '#type') setTimeout(() => ta.focus(), 60);
  }
  const wide = () => matchMedia('(min-width: 1081px)').matches;
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  document.body.append(scrim);
  openConv = (open) => {
    if (isChat) { $('#composer-input')?.focus(); return; }
    app.dataset.conv = open ? 'open' : 'closed';
    if (wide()) store.set('convDesktop', app.dataset.conv);
    scrim.classList.toggle('open', !wide() && open);
  };
  app.dataset.conv = isChat ? 'open' : wide() ? store.get('convDesktop', 'open') : 'closed';

  /* ---------- Resizable Caddie panel: 40% of the window by default, 340px–60% (content keeps ≥ 520px) ---------- */
  const CONV_DEFAULT = 0.4, CONV_MIN = 340;
  const convMax = () => Math.max(CONV_MIN, Math.min(innerWidth * 0.6, innerWidth - 520));
  const conv = $('.conv', app);
  if (conv && !isChat) {
    conv.insertAdjacentHTML('afterbegin', '<div class="conv-resize" role="separator" aria-orientation="vertical" aria-label="Resize Caddie" tabindex="0" title="Drag to resize · double-click to reset" data-od-id="caddie-resize"><span class="grip"><i></i><i></i><i></i></span></div><span class="conv-w-tip" aria-hidden="true"></span>');
    const handle = $('.conv-resize', conv), tip = $('.conv-w-tip', conv);
    let frac = +store.get('convFrac', CONV_DEFAULT) || CONV_DEFAULT;
    const apply = () => {
      if (!wide()) { app.style.removeProperty('--conv-w'); return; }
      const px = Math.round(Math.min(convMax(), Math.max(CONV_MIN, frac * innerWidth)));
      app.style.setProperty('--conv-w', px + 'px');
      const pct = Math.round((px / innerWidth) * 100);
      handle.setAttribute('aria-valuenow', pct);
      handle.setAttribute('aria-valuemin', Math.round((CONV_MIN / innerWidth) * 100));
      handle.setAttribute('aria-valuemax', Math.round((convMax() / innerWidth) * 100));
      handle.setAttribute('aria-valuetext', `Caddie takes ${pct}% of the window`);
      tip.textContent = pct + '%' + (Math.abs(frac - CONV_DEFAULT) < 0.005 ? ' · default' : '');
    };
    const setFrac = (f, save = true) => { frac = Math.min(convMax() / innerWidth, Math.max(CONV_MIN / innerWidth, f)); apply(); if (save) store.set('convFrac', +frac.toFixed(4)); };
    apply();
    addEventListener('resize', apply);
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); handle.setPointerCapture(e.pointerId);
      document.documentElement.classList.add('resizing');
      const move = (ev) => setFrac((innerWidth - ev.clientX) / innerWidth, false);
      const up = () => { document.documentElement.classList.remove('resizing'); handle.removeEventListener('pointermove', move); store.set('convFrac', +frac.toFixed(4)); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up, { once: true });
      handle.addEventListener('pointercancel', up, { once: true });
    });
    handle.addEventListener('dblclick', () => { setFrac(CONV_DEFAULT); toast('Caddie is back to 40% wide', 'sidebar'); });
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setFrac(frac + step); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setFrac(frac - step); }
      else if (e.key === 'Home') { e.preventDefault(); setFrac(0); }
      else if (e.key === 'End') { e.preventDefault(); setFrac(1); }
      else if (e.key === 'Enter') { e.preventDefault(); setFrac(CONV_DEFAULT); }
    });
    window.CaddieConvWidth = { reset: () => setFrac(CONV_DEFAULT), get: () => frac };
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-conv-toggle]')) openConv(app.dataset.conv !== 'open'); });

  /* ---------- Mobile: tab bar + always-on Caddie input ---------- */
  if (!bare) {
    const tb = document.createElement('nav');
    tb.className = 'tabbar';
    tb.setAttribute('aria-label', 'Primary');
    tb.innerHTML = `<a href="caddie.html" ${isChat ? 'aria-current="page"' : ''} data-od-id="m-tab-caddie">${Mascot(baseMood, 24, true)}Caddie</a>`
      + TABS.map(([k, h, ic, l]) => `<a href="${h}" ${cur(k)} data-od-id="m-tab-${k}">${I(ic)}${l}${k === 'brief' ? '<span class="badge" aria-label="3 things">3</span>' : ''}</a>`).join('');
    document.body.append(tb);
    if (!isChat) {
      const dock = document.createElement('a');
      dock.className = 'dock';
      dock.href = 'caddie.html' + (scope === 'general' ? '' : '?p=' + scope) + '#type';
      dock.dataset.odId = 'm-dock';
      dock.innerHTML = `${Mascot(baseMood, 30, true)}<span class="ph">${scope === 'general' ? 'Ask Caddie anything…' : 'Ask about ' + scopeName + '…'}</span><span class="go">${I('arrow')}</span>`;
      document.body.append(dock);
    }
  }
  setMood(baseMood);

  /* ---------- Shared overlays ---------- */
  const shared = document.createElement('div');
  shared.innerHTML = `
  <div class="modal palette" id="palette" role="dialog" aria-modal="true" aria-label="Search">
    <div class="palette-input">${I('search')}<input type="text" placeholder="Search projects, hackathons and chats" aria-label="Search"><kbd>Esc</kbd></div>
    <div class="palette-list" role="listbox"></div>
  </div>
  <div class="menu" id="account-menu" role="menu">
    <div class="menu-head"><b>${NAME || 'Your account'}</b><div class="meta">Signed in with ${esc(ACCOUNT.provider)}</div></div><hr>
    <a href="settings.html" role="menuitem">${I('user')}Profile &amp; interests</a>
    <a href="settings.html#knows" role="menuitem">${I('brain')}What Caddie knows</a>
    <a href="settings.html#accounts" role="menuitem">${I('plug')}Connected accounts</a>
    <a href="settings.html#routines" role="menuitem">${I('repeat')}Routines</a>
    <a href="settings.html#spending" role="menuitem">${I('gauge')}Spending</a><hr>
    <button data-theme-toggle role="menuitem">${I('sun')}<span data-theme-label>Light mode</span></button>
    <a href="sign-in.html" role="menuitem">${I('logout')}Sign out</a>
  </div>
  <div class="menu" id="about-menu" role="menu">
    <div class="menu-head"><b>Talking about</b><div class="meta">Each one keeps its own chat</div></div><hr>
    <a href="caddie.html" role="menuitem" ${scope === 'general' ? 'aria-current="true"' : ''}>${I('globe')}Everything</a>
    ${Object.entries(PROJECTS).map(([id, p]) => `<a href="caddie.html?p=${id}" role="menuitem">${I('folder')}${p.name}${scope === id ? I('check') : ''}</a>`).join('')}
  </div>
  <div class="modal lg" id="new-project" role="dialog" aria-modal="true" aria-labelledby="np-title" data-od-id="modal-new-project">
    <div class="modal-head"><div class="grow"><h2 id="np-title">Start a project</h2><p>Tell Caddie what you want to make. It writes a plan first — nothing is built until you say OK.</p></div><button class="btn ghost icon sm" data-close aria-label="Close">${I('x')}</button></div>
    <div class="modal-body">
      <div class="field"><label for="np-idea">What do you want to make?</label><textarea class="textarea" id="np-idea" placeholder="e.g. An app that scales recipes to what’s left in my pantry" data-required></textarea><span class="err" hidden>Describe your idea in a sentence or two.</span></div>
      <div class="grid-2">
        <div class="field"><label for="np-for">Is it for a hackathon?</label><select class="select" id="np-for"><option>No — just for me</option><option>PayPal AI Hackathon</option><option>AI Agents for Founders — HETIC 2026</option></select></div>
        <div class="field"><label for="np-stack">Tools to build with</label><select class="select" id="np-stack" aria-describedby="np-stack-hint"><option>Let Caddie choose</option><option>Web app (React)</option><option disabled>Web app (TanStack Start) · later</option><option disabled>Web app (PHP / Laravel) · later</option><option disabled>Web app (Python / FastAPI) · later</option><option disabled>Phone app (Flutter) · later</option></select><span class="hint" id="np-stack-hint">React web apps come first. The others open up once each passes its own full test. <a class="link" href="settings.html#tools">See where each one is</a></span></div>
      </div>
      <details class="more" style="border:0"><summary style="padding:4px 0">${I('chevron')}Start from code you already have</summary><div style="padding:8px 0 0"><div class="field"><label for="np-repo">GitHub repo</label><div class="input-wrap">${I('git')}<input class="input" id="np-repo" placeholder="owner/repo"></div><span class="hint">Caddie reads it and suggests a plan. It never changes your code without asking.</span></div></div></details>
    </div>
    <div class="modal-foot"><span class="meta">Free until you approve a plan</span><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-np-submit>Write the plan</button></div>
  </div>
  <div class="toast-wrap" aria-live="polite"></div>`;
  document.body.append(...shared.children);
  $('[data-np-submit]').addEventListener('click', () => {
    const t = $('#np-idea'); if (!t.value.trim()) { t.classList.add('invalid'); t.nextElementSibling.hidden = false; t.focus(); return; }
    toast('Project started — Caddie is writing the plan'); closeAll();
    setTimeout(() => { location.href = 'project-plan.html?p=pantry'; }, 900);
  });

  /* ---------- Overlay mechanics ---------- */
  let lastFocus = null;
  const openOverlay = (el) => {
    if (!el) return;
    closeAll(true);
    lastFocus = document.activeElement;
    el.classList.add('open');
    scrim.classList.add('open');
    const f = el.querySelector('input:not([type=radio]):not([type=checkbox]), textarea, select, button:not([data-close]), a');
    setTimeout(() => f && f.focus(), 30);
  };
  const closeAll = (keepScrim) => {
    $$('.modal.open, .drawer.open, .menu.open').forEach((m) => m.classList.remove('open'));
    if (!keepScrim) { scrim.classList.toggle('open', !isChat && !wide() && app.dataset.conv === 'open'); if (lastFocus) lastFocus.focus(); }
  };
  window.CaddieOpen = (id) => openOverlay(document.getElementById(id));
  window.CaddieClose = () => closeAll();
  scrim.addEventListener('click', () => { if ($('.modal.open, .drawer.open')) closeAll(); else openConv(false); });

  const toast = (text, icon = 'check') => {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = I(icon) + '<span></span>';
    t.lastChild.textContent = text;
    $('.toast-wrap').append(t);
    setTimeout(() => t.remove(), 2800);
  };
  window.CaddieToast = toast;

  document.addEventListener('click', (e) => {
    const o = e.target.closest('[data-open]');
    if (o) { e.preventDefault(); openOverlay(document.getElementById(o.dataset.open)); return; }
    const m = e.target.closest('[data-menu]');
    if (m) {
      e.preventDefault();
      const menu = document.getElementById(m.dataset.menu);
      const wasOpen = menu.classList.contains('open');
      $$('.menu.open').forEach((x) => x.classList.remove('open'));
      if (!wasOpen) {
        menu.classList.add('open');
        const r = m.getBoundingClientRect();
        const mw = menu.offsetWidth, mhgt = menu.offsetHeight;
        let left = Math.min(r.left, innerWidth - mw - 8), top = r.bottom + 6;
        if (top + mhgt > innerHeight - 8) top = Math.max(8, r.top - mhgt - 6);
        menu.style.left = Math.max(8, left) + 'px'; menu.style.top = top + 'px';
        $('a, button', menu).focus();
      }
      return;
    }
    if (!e.target.closest('.menu')) $$('.menu.open').forEach((x) => x.classList.remove('open'));
    if (e.target.closest('[data-theme-toggle]')) setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    const c = e.target.closest('[data-close]');
    if (c) closeAll();
    const t = e.target.closest('[data-toast]');
    if (t) {
      const form = t.closest('.modal, .drawer');
      const req = form ? $$('[data-required]', form).filter((f) => !f.value.trim()) : [];
      if (req.length) { req.forEach((f) => { f.classList.add('invalid'); if (f.nextElementSibling?.classList.contains('err')) f.nextElementSibling.hidden = false; }); req[0].focus(); return; }
      toast(t.dataset.toast, t.dataset.toastIcon || 'check');
      if (t.dataset.thenClose !== undefined || form) closeAll();
      if (t.dataset.go) setTimeout(() => { location.href = t.dataset.go; }, 700);
    }
    if (e.target.closest('[data-palette]')) { e.preventDefault(); openPalette(); }
    const ask = e.target.closest('[data-ask]');
    if (ask && window.CaddieAsk) window.CaddieAsk(ask.dataset.ask);
  });
  document.addEventListener('input', (e) => { if (e.target.matches('[data-required]') && e.target.value.trim()) { e.target.classList.remove('invalid'); if (e.target.nextElementSibling?.classList.contains('err')) e.target.nextElementSibling.hidden = true; } });

  /* Focus trap + keys */
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.key === '/' && !e.target.closest('input, textarea, select, [contenteditable]')) { e.preventDefault(); openPalette(); return; }
    if (e.key === 'Escape') { if ($('.modal.open, .drawer.open, .menu.open')) closeAll(); else if (!isChat && !wide() && app.dataset.conv === 'open') openConv(false); return; }
    const open = $('.modal.open, .drawer.open');
    if (e.key === 'Tab' && open) {
      const f = $$('a[href], button:not([disabled]), input, select, textarea', open).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });

  /* ---------- Search palette ---------- */
  const PAL = [
    ['Go to', 'chat', 'Caddie', 'Chat with Caddie', 'caddie.html'],
    ['Go to', 'brief', 'Brief', 'What needs you today', 'brief.html'],
    ['Go to', 'compass', 'Discover', 'Hackathons that fit you', 'discover.html'],
    ['Go to', 'folder', 'Projects', 'Everything you’re making', 'projects.html'],
    ['Projects', 'folder', 'Ledger Nudge', 'PayPal AI Hackathon · plan needs your OK', 'project-overview.html'],
    ['Projects', 'folder', 'Founder Hours', 'HETIC 2026 · 2 things missing', 'project-overview.html?p=founder'],
    ['Projects', 'folder', 'Pantry Scale', 'Personal · building now', 'project-overview.html?p=pantry'],
    ['Hackathons', 'trophy', 'PayPal AI Hackathon', 'Closes Nov 12 · $67,500 in prizes', 'opportunity.html'],
    ['Hackathons', 'trophy', 'Bridge The Gap Hacks', 'Closes Nov 21 · online', 'opportunity.html?e=bridge'],
    ['Hackathons', 'trophy', 'Meta VR Start Developer Competition 2026', 'Closes Nov 18 · $1,000,000 in prizes', 'opportunity.html?e=metavr'],
    ['Chats', 'chat', 'Does it change the demo video?', 'Ledger Nudge · today', 'caddie.html?p=ledger'],
    ['Do', 'plus', 'Start a project', 'Describe an idea', '#new-project'],
    ['Do', 'git', 'Bring code you already have', 'Start from a GitHub repo', 'projects.html?open=import-repo'],
    ['Do', 'sun', 'Switch light / dark', 'Appearance', '#theme'],
  ];
  const pal = $('#palette'), palIn = $('input', pal), palList = $('.palette-list', pal);
  let palIdx = 0;
  const renderPal = () => {
    const term = palIn.value.trim().toLowerCase();
    const items = PAL.filter((p) => !term || (p[2] + ' ' + p[3] + ' ' + p[0]).toLowerCase().includes(term));
    let g = '', html = '';
    items.forEach((p, i) => {
      if (p[0] !== g) { g = p[0]; html += `<div class="palette-group kicker">${g}</div>`; }
      html += `<a class="p-item ${i === palIdx ? 'active' : ''}" role="option" href="${p[4]}" data-pal="${p[4]}">${I(p[1])}<span class="grow">${p[2]}<small>${p[3]}</small></span>${I('arrow')}</a>`;
    });
    const safe = esc(palIn.value.trim().slice(0, 80));
    const all = term ? `<div class="palette-group kicker">Everything</div><a class="p-item ${palIdx === items.length ? 'active' : ''}" role="option" href="search.html?q=${encodeURIComponent(palIn.value.trim().slice(0, 80))}" data-pal="search" data-od-id="palette-see-all">${I('search')}<span class="grow">See all results for “${safe}”<small>Searches inside plans, to-dos and what Caddie knows too</small></span>${I('arrow')}</a>` : '';
    palList.innerHTML = html ? html + all : `<div class="empty" style="padding:28px 24px 16px"><h3>No quick match for “${safe}”</h3><p>Search inside your plans and to-dos, or ask Caddie.</p><a class="btn ghost sm" href="caddie.html#type">Ask Caddie</a></div>${all}`;
  };
  const openPalette = () => { if (bare) return; palIn.value = ''; palIdx = 0; renderPal(); openOverlay(pal); };
  palIn.addEventListener('input', () => { palIdx = 0; renderPal(); });
  palIn.addEventListener('keydown', (e) => {
    const items = $$('.p-item', palList);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      palIdx = (palIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((x, i) => x.classList.toggle('active', i === palIdx));
      const a = items[palIdx]; if (a) { const top = a.offsetTop, bot = top + a.offsetHeight; if (top < palList.scrollTop) palList.scrollTop = top - 30; else if (bot > palList.scrollTop + palList.clientHeight) palList.scrollTop = bot - palList.clientHeight; }
    }
    if (e.key === 'Enter' && items[palIdx]) { e.preventDefault(); items[palIdx].click(); }
  });
  palList.addEventListener('click', (e) => {
    const a = e.target.closest('[data-pal]'); if (!a) return;
    const h = a.dataset.pal;
    if (h === '#new-project') { e.preventDefault(); openOverlay($('#new-project')); }
    else if (h === '#theme') { e.preventDefault(); setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'); closeAll(); }
  });

  /* ---------- Tabs, segmented controls, pills ---------- */
  $$('[data-tabs]').forEach((group) => {
    const tabs = $$('[data-tab-target]', group);
    const activate = (t, push) => {
      tabs.forEach((x) => x.setAttribute('aria-selected', x === t ? 'true' : 'false'));
      tabs.forEach((x) => { const p = document.getElementById(x.dataset.tabTarget); if (p) p.hidden = x !== t; });
      if (push && group.dataset.tabs === 'hash') history.replaceState(null, '', '#' + t.dataset.tabTarget);
    };
    tabs.forEach((t) => t.addEventListener('click', (e) => { e.preventDefault(); activate(t, true); }));
    const fromHash = tabs.find((t) => '#' + t.dataset.tabTarget === location.hash);
    activate(fromHash || tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0]);
  });
  $$('.seg').forEach((s) => s.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', s).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    s.dispatchEvent(new CustomEvent('seg', { detail: b.dataset.value, bubbles: true }));
  }));
  document.addEventListener('click', (e) => {
    const p = e.target.closest('.pill[data-toggle]');
    if (p) p.setAttribute('aria-pressed', p.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  });

  /* ---------- Page states: ?state=loading | error (headers stay real; only the content waits) ---------- */
  const pageState = params.get('state');
  if (pageState === 'loading' || pageState === 'error') {
    const LABEL = { brief: 'your brief', discover: 'hackathons', projects: 'your projects', settings: 'your settings', opportunity: 'this hackathon', search: 'results', caddie: 'this chat' };
    const what = isProject ? project.name : LABEL[page] || 'this page';
    const clean = (() => { const u = new URLSearchParams(location.search); u.delete('state'); const qs = u.toString(); return location.pathname.split('/').pop() + (qs ? '?' + qs : '') + location.hash; })();
    const pg = main ? $('.page', main) : null;
    const bodyEl = $('.conv-body');
    if (pg && pg.firstElementChild) {
      const first = pg.firstElementChild;
      if (pageState === 'loading') {
        const w = [[62, 38], [48, 30], [70, 44], [55, 34]];
        const rows = (n) => Array.from({ length: n }, (_, i) => `<div class="skel-row"><span class="skel" style="width:34px;height:34px;border-radius:9px;flex:none"></span><span class="grow"><span class="skel" style="height:12px;width:${w[i % 4][0]}%"></span><span class="skel" style="height:10px;width:${w[i % 4][1]}%"></span></span></div>`).join('');
        pg.classList.add('is-loading'); pg.setAttribute('aria-busy', 'true');
        first.insertAdjacentHTML('afterend', `<div class="skel-wrap" data-od-id="state-loading"><div class="state-note" role="status">${Mascot('thinking', 26)}<span>Loading ${esc(what)}…</span></div><div class="panel">${rows(4)}</div><div class="panel">${rows(2)}</div></div>`);
      } else {
        pg.classList.add('is-error');
        first.insertAdjacentHTML('afterend', `<section class="panel state-panel" role="alert" data-od-id="state-error"><div class="empty" style="padding:48px 24px">${Mascot('stuck', 56)}<h3>Couldn’t load ${esc(what)}</h3><p>Your work is safe — this is only the connection. Caddie tries again by itself every few seconds.</p><div class="btn-row" style="justify-content:center"><a class="btn secondary sm" href="${esc(clean)}">${I('repeat')}Try again now</a><a class="btn ghost sm" href="caddie.html#type">Ask Caddie what happened</a></div></div></section>`);
      }
    }
    if (bodyEl && pageState === 'loading') {
      bodyEl.setAttribute('aria-busy', 'true');
      bodyEl.innerHTML = `<div class="state-note" role="status">${Mascot('thinking', 26)}<span>Loading the chat…</span></div>`
        + [[78, 52], [0, 46], [84, 64]].map(([a, b]) => (a ? `<div class="msg" style="gap:8px"><span class="skel" style="height:12px;width:${a}%"></span><span class="skel" style="height:12px;width:${b}%"></span></div>` : `<div class="msg user"><span class="skel" style="height:34px;width:${b}%;border-radius:14px 14px 4px 14px"></span></div>`)).join('');
    }
  }

  /* Deep-link an overlay: ?open=<id> (used by the review launcher) */
  const op = new URLSearchParams(location.search).get('open');
  if (op) setTimeout(() => { const el = document.getElementById(op); if (el) openOverlay(el); }, 120);

  /* Hydrate inline icon placeholders: <i data-i="name"></i> */
  $$('i[data-i]').forEach((el) => { el.outerHTML = I(el.dataset.i, el.className); });
  $$('i[data-mascot]').forEach((el) => { el.outerHTML = Mascot(el.dataset.mascot || 'idle', +(el.dataset.size || 32), el.hasAttribute('data-live')); });
  window.CaddieOpenConv = openConv;

  /* Settings → Profile: the Name field is the same name Caddie greets you by. */
  const pName = $('#p-name');
  if (pName) {
    pName.value = String(store.get('name', suggestName(ACCOUNT.name)));
    pName.addEventListener('change', () => store.set('name', pName.value.trim().slice(0, 40)));
  }
})();
