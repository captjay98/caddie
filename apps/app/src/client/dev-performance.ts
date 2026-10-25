/** Local, explicitly opted-in diagnostics. Never records text, query strings or request data. */
export function installDevPerformance(host: Window & typeof globalThis = window as Window & typeof globalThis): () => void {
 const pending = new Map<string, { started: number; path: string }>();
 let frame: number | undefined;
 let disposed = false;
 const emit = (event: string, duration: number, path: string) => {
  host.console.info('[caddie:performance] ' + JSON.stringify({
   event, durationMs: Math.round(Math.max(0, duration) * 10) / 10,
   path, nodes: host.document.querySelectorAll('*').length,
  }));
 };
 const schedule = (event: string) => {
  if (disposed) return;
  // Coalesce rapid inputs into one measurement per frame, starting at the first event.
  if (!pending.has(event)) pending.set(event, { started: host.performance.now(), path: host.location.pathname });
  if (frame !== undefined) return;
  frame = host.requestAnimationFrame(() => {
   frame = undefined;
   const now = host.performance.now();
   const samples = [...pending];
   pending.clear();
   for (const [event, sample] of samples) emit(event, now - sample.started, sample.path);
  });
 };
 const input = () => schedule('input-to-frame');
 const click = (event: Event) => {
  const element = event.target as Element | null;
  if (typeof element?.closest === 'function' && element.closest('a[href]')) schedule('link-click-to-frame');
 };
 let lastPath = host.location.pathname;
 const route = () => {
  const nextPath = host.location.pathname;
  if (nextPath !== lastPath) {
   lastPath = nextPath;
   schedule('route-to-frame');
  }
 };
 const push = host.history.pushState;
 const replace = host.history.replaceState;
 const wrappedPush: History['pushState'] = function (...args) { push.apply(host.history, args); route(); };
 const wrappedReplace: History['replaceState'] = function (...args) { replace.apply(host.history, args); route(); };
 host.history.pushState = wrappedPush;
 host.history.replaceState = wrappedReplace;
 host.document.addEventListener('input', input, true);
 host.document.addEventListener('click', click, true);
 host.addEventListener('popstate', route);
 let animationObserver: PerformanceObserver | undefined;
 if (host.PerformanceObserver?.supportedEntryTypes?.includes('long-animation-frame')) {
  try {
   animationObserver = new host.PerformanceObserver(list => {
    if (disposed) return;
    for (const entry of list.getEntries()) {
     const frame = entry as PerformanceEntry & { scripts?: { sourceURL?: string; duration?: number; forcedStyleAndLayoutDuration?: number }[] };
     host.console.info('[caddie:frame] ' + JSON.stringify({ durationMs: frame.duration, scripts: (frame.scripts ?? []).map(script => ({ path: (() => { try { return new URL(script.sourceURL ?? '', host.location.origin).pathname; } catch { return 'unknown'; } })(), durationMs: script.duration, layoutMs: script.forcedStyleAndLayoutDuration })) }));
    }
   });
   animationObserver.observe({ type: 'long-animation-frame', buffered: false });
  } catch { animationObserver?.disconnect(); animationObserver = undefined; }
 }
 let observer: PerformanceObserver | undefined;
 if (host.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
  try {
   observer = new host.PerformanceObserver(list => {
    if (disposed) return;
    for (const entry of list.getEntries()) emit('long-task', entry.duration, host.location.pathname);
   });
   observer.observe({ type: 'longtask', buffered: false });
  } catch { observer?.disconnect(); observer = undefined; }
 }
 return () => {
  if (disposed) return;
  disposed = true;
  host.document.removeEventListener('input', input, true);
  host.document.removeEventListener('click', click, true);
  host.removeEventListener('popstate', route);
  if (host.history.pushState === wrappedPush) host.history.pushState = push;
  if (host.history.replaceState === wrappedReplace) host.history.replaceState = replace;
  observer?.disconnect();
  animationObserver?.disconnect();
  if (frame !== undefined) host.cancelAnimationFrame(frame);
  pending.clear();
 };
}
