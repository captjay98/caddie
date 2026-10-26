import {notesAppHtml} from './brief-run-notes-app.ts';
/** Actual offline/reconnect and request-state behavior, with an explicit
 * dropped-queue defect used to prove the independent executor catches it. */
export function acceptanceNotesApp(dropQueue=false):string {
 return notesAppHtml().replace("var listed = await api('/api/notes');",`h('<p>Loading notes</p>');
  var listed = await api('/api/notes');
  if (!listed.ok) { h('<p>Could not load notes</p><button id="retry">Try again</button>'); document.getElementById('retry').onclick=renderNotes;return; }`)
 .replace("await api('/api/notes', { method: 'POST'",`if (!navigator.onLine) { localStorage.setItem('queued-note',body); h('<p>Queued</p>');return; }
    await api('/api/notes', { method: 'POST'`)
 .replace("window.addEventListener('hashchange', route);",`window.addEventListener('online',async function(){var body=localStorage.getItem('queued-note');if(body){${dropQueue?'':"await api('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:body})});"}localStorage.removeItem('queued-note');renderNotes();}});
 window.addEventListener('hashchange', route);`);
}
