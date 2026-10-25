import { test, expect } from 'bun:test';
import type * as ReactDomServerTypes from '../apps/app/node_modules/@types/react-dom/server.d.ts';
const SERVER = '../apps/app/node_modules/react-dom/server.js';
const { renderToStaticMarkup } = await import(SERVER) as typeof ReactDomServerTypes;
import { createMarkdownCache } from '../packages/ui/src/Markdown.tsx';

test('preparing adjacent history reuses parsed output and keeps the cache bounded', () => {
 const cache = createMarkdownCache(2, 100);
 cache.prepare('**Older entry**');
 const older = cache.render('**Older entry**');
 expect(cache.render('**Older entry**')).toBe(older);
 cache.prepare('second'); cache.prepare('third');
 expect(cache.size).toBe(2);
 expect(cache.render('**Older entry**')).not.toBe(older);
});
test('large replies are on demand, scopes are isolated and HTML remains escaped', () => {
 const cache = createMarkdownCache(4, 100);
 cache.prepare('long '.repeat(100));
 expect(cache.size).toBe(0);
 const content = cache.render('<script>alert(1)</script>');
 expect(renderToStaticMarkup(content)).not.toContain('<script>');
 expect(createMarkdownCache().render('<script>alert(1)</script>')).not.toBe(content);
 cache.clear();
 expect(cache.size).toBe(0);
});
