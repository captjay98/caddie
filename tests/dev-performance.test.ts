import { expect, test } from 'bun:test';
import { installDevPerformance } from '../apps/app/src/client/dev-performance.ts';

function fixture() {
 const listeners = new Map<string, EventListener>();
 const logs: unknown[][] = [];
 let tick = 10;
 let callback: FrameRequestCallback | undefined;
 let cancelled = 0;
 let disconnected = 0;
 let longTasks: ((list: { getEntries(): { duration: number; name: string }[] }) => void) | undefined;
 const location = { pathname: '/app/', search: '?secret=never-log' };
 const history = {
  pushState: (_data: unknown, _unused: string, url?: string | URL | null) => { location.pathname = new URL(String(url), 'https://local.test').pathname; },
  replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => { location.pathname = new URL(String(url), 'https://local.test').pathname; },
 };
 const host = {
  location, history, console: { info: (...args: unknown[]) => logs.push(args) },
  performance: { now: () => tick },
  document: {
   querySelectorAll: () => ({ length: 42 }),
   addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
   removeEventListener: (name: string) => listeners.delete(name),
  },
  addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
  removeEventListener: (name: string) => listeners.delete(name),
  requestAnimationFrame: (fn: FrameRequestCallback) => { callback = fn; return 1; },
  cancelAnimationFrame: () => { cancelled++; callback = undefined; },
  PerformanceObserver: class {
   static supportedEntryTypes = ['longtask'];
   constructor(fn: typeof longTasks) { longTasks = fn; }
   observe() {}
   disconnect() { disconnected++; }
  },
 };
 return {
  host: host as unknown as Parameters<typeof installDevPerformance>[0], listeners, logs, history,
  frame: () => { tick += 16; const fn = callback; callback = undefined; fn?.(tick); },
  longTask: () => longTasks?.({ getEntries: () => [{ duration: 123, name: 'private prompt?token=secret' }] }),
  counts: () => ({ cancelled, disconnected }),
 };
}

test('diagnostics measure frames and long tasks without recording user or URL content', () => {
 const f = fixture();
 const cleanup = installDevPerformance(f.host);
 f.listeners.get('input')?.({ target: { value: 'private message' } } as unknown as Event);
 f.listeners.get('input')?.({ target: { value: 'another private message' } } as unknown as Event);
 f.listeners.get('click')?.({ target: { closest: () => ({ href: '/app/projects?token=secret' }) } } as unknown as Event);
 f.history.pushState({ private: 'data' }, '', '/app/projects?token=secret');
 f.frame();
 f.longTask();
 expect(f.logs.map(([line]) => ['[caddie:performance]', JSON.parse(String(line).slice('[caddie:performance] '.length))])).toEqual([
  ['[caddie:performance]', { event: 'input-to-frame', durationMs: 16, path: '/app/', nodes: 42 }],
  ['[caddie:performance]', { event: 'link-click-to-frame', durationMs: 16, path: '/app/', nodes: 42 }],
  ['[caddie:performance]', { event: 'route-to-frame', durationMs: 16, path: '/app/projects', nodes: 42 }],
  ['[caddie:performance]', { event: 'long-task', durationMs: 123, path: '/app/projects', nodes: 42 }],
 ]);
 expect(JSON.stringify(f.logs)).not.toMatch(/secret|private|token|message/);
 cleanup();
});

test('cleanup cancels pending work, disconnects observers and restores history idempotently', () => {
 const f = fixture();
 const originalPush = f.history.pushState;
 const originalReplace = f.history.replaceState;
 const cleanup = installDevPerformance(f.host);
 f.listeners.get('input')?.({} as Event);
 cleanup(); cleanup();
 f.frame(); f.longTask();
 expect(f.listeners.size).toBe(0);
 expect(f.history.pushState).toBe(originalPush);
 expect(f.history.replaceState).toBe(originalReplace);
 expect(f.counts()).toEqual({ cancelled: 1, disconnected: 1 });
 expect(f.logs).toEqual([]);
});

test('cleanup preserves a later history wrapper and tolerates unavailable long-task support', () => {
 const f = fixture();
 delete (f.host as unknown as { PerformanceObserver?: unknown }).PerformanceObserver;
 const cleanup = installDevPerformance(f.host);
 const laterWrapper = () => {};
 f.history.pushState = laterWrapper;
 cleanup();
 expect(f.history.pushState).toBe(laterWrapper);
});
