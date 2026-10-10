/* Caddie v2 · alternative character directions.
   All three directions share one 64-unit face rig (eyes, mouth, cheeks, dots, z's, badge)
   and the same class names, so the eight state animations in caddie.css drive every
   variant. Only the silhouette and the "moving part" (.m-flag) differ:
     flag   — the current proposal (rendered by CaddieMascot in caddie.js)
     bubble — a talking speech bubble; the tail is the moving part
     cap    — a round golf ball wearing an amber caddie cap; the cap is the moving part
   Load after caddie.js. */
(function () {
  'use strict';
  let n = 0;

  const FACE = `
<g class="m-look">
<g class="m-open" fill="var(--m-ink)"><rect x="21" y="30" width="6.5" height="11" rx="3.25"/><rect x="36.5" y="30" width="6.5" height="11" rx="3.25"/><circle cx="25.4" cy="32.7" r="1.3" fill="#fff"/><circle cx="40.9" cy="32.7" r="1.3" fill="#fff"/></g>
<g class="m-happy" fill="none" stroke="var(--m-ink)" stroke-width="2.6" stroke-linecap="round"><path d="M20.5 37.5q3.75-5 7.5 0"/><path d="M36 37.5q3.75-5 7.5 0"/></g>
<g class="m-closed" fill="none" stroke="var(--m-ink)" stroke-width="2.4" stroke-linecap="round"><path d="M20.5 35.5q3.75 3.6 7.5 0"/><path d="M36 35.5q3.75 3.6 7.5 0"/></g>
<g class="m-flat" fill="none" stroke="var(--m-ink)" stroke-width="2.6" stroke-linecap="round"><path d="M21 36.5h6.5"/><path d="M36.5 36.5H43"/></g>
</g>
<g class="m-cheek" fill="var(--m-cheek)" opacity=".42"><ellipse cx="17.2" cy="44.6" rx="3.2" ry="2"/><ellipse cx="46.8" cy="44.6" rx="3.2" ry="2"/></g>
<path class="m-mouth" d="M28.6 46.6q3.4 3 6.8 0" fill="none" stroke="var(--m-ink)" stroke-width="2.2" stroke-linecap="round"/>
<ellipse class="m-mo" cx="32" cy="47.6" rx="2" ry="2.3" fill="var(--m-ink)"/>
<path class="m-mflat" d="M29 48h6" fill="none" stroke="var(--m-ink)" stroke-width="2.2" stroke-linecap="round"/>`;

  const EXTRAS = `
<g class="m-dots" fill="currentColor"><circle cx="11" cy="13" r="1.7"/><circle cx="6.5" cy="8" r="2.1"/><circle cx="12.5" cy="3" r="2.5"/></g>
<g class="m-z" font-family="IBM Plex Mono, monospace" font-weight="600" fill="currentColor"><text x="5" y="14" font-size="9">z</text><text x="11" y="7" font-size="7">z</text></g>`;

  const badge = (cx, cy) => `
<g class="m-badge"><circle cx="${cx}" cy="${cy}" r="7" fill="var(--m-flag)" stroke="var(--panel)" stroke-width="2.5"/><path d="M${cx} ${cy - 3.4}v4" stroke="var(--m-ink)" stroke-width="2.2" stroke-linecap="round"/><circle cx="${cx}" cy="${cy + 3.7}" r="1.2" fill="var(--m-ink)"/></g>`;

  const grad = (id) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--m-blue)"/><stop offset="1" style="stop-color:var(--m-deep)"/></linearGradient></defs>`;

  const BODY = {
    /* Speech bubble: Caddie *is* the conversation. Tail sits under the body so the join is hidden. */
    bubble: (g) => `
<g class="m-all">
<path class="m-flag" d="M18.5 50 13 61.6Q22.6 59.4 28.5 53z" fill="var(--m-deep)" stroke="var(--m-line)" stroke-width="1.4" stroke-linejoin="round"/>
<rect class="m-body" x="8" y="13" width="48" height="42" rx="17" fill="url(#${g})"/>
<path class="m-gloss" d="M13.6 28.6A13 13 0 0 1 20.6 19.6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" opacity=".32"/>
${FACE}
</g>${badge(54, 15)}`,

    /* Golf ball in a caddie cap: the cap tips back, wobbles, or slides over the eyes. */
    cap: (g) => `
<g class="m-all">
<circle class="m-body" cx="32" cy="37" r="23" fill="url(#${g})"/>
<g class="m-dimple" fill="var(--m-ink)" opacity=".16"><circle cx="13.6" cy="49" r="1.3"/><circle cx="19.4" cy="54.6" r="1.3"/><circle cx="44.6" cy="54.6" r="1.3"/><circle cx="50.4" cy="49" r="1.3"/><circle cx="52.6" cy="40.6" r="1.1"/><circle cx="11.4" cy="40.6" r="1.1"/></g>
<path class="m-gloss" d="M12.2 37.5Q12.6 44 15.6 48.4" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".28"/>
${FACE}
<g class="m-flag">
<path d="M10 27A22 17 0 0 1 54 27z" fill="var(--m-flag)"/>
<rect x="9.4" y="24.4" width="45.2" height="4.2" rx="2.1" style="fill:color-mix(in oklch, var(--m-flag), black 20%)"/>
<path d="M50.6 24.6q8.6-.4 12.9 2.4-4.3 2.4-12.9 2z" style="fill:color-mix(in oklch, var(--m-flag), black 20%)"/>
<circle cx="32" cy="10.4" r="1.9" style="fill:color-mix(in oklch, var(--m-flag), black 20%)"/>
<path class="m-gloss" d="M18 21.5A15 12 0 0 1 25.5 14.6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity=".35"/>
</g>
</g>${badge(54, 12)}`,
  };

  const Character = (variant = 'flag', state = 'idle', size = 32, live = false) => {
    if (variant === 'flag' || !BODY[variant]) {
      return window.CaddieMascot(state, size, live).replace('<svg class="mascot"', '<svg class="mascot" data-v="flag"');
    }
    const g = 'cv' + variant + (++n);
    return `<svg class="mascot" data-v="${variant}" viewBox="0 0 64 64" width="${size}" height="${size}" data-state="${state}"${size <= 24 ? ' data-size="s"' : ''}${live ? ' data-live' : ''} aria-hidden="true">${grad(g)}${EXTRAS}${BODY[variant](g)}</svg>`;
  };

  window.CaddieCharacter = Character;
  window.CaddieCharacters = [
    { id: 'flag', name: 'Flag block', line: 'A soft block carrying a golf flag. The flag marks where you’re heading.' },
    { id: 'bubble', name: 'Talking bubble', line: 'A speech bubble with a face. Caddie is the chat, so the chat has a face.' },
    { id: 'cap', name: 'Ball in a cap', line: 'A golf ball wearing a caddie’s cap. The most “character” of the three.' },
  ];
})();
