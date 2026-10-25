import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createContext, memo, useContext, useMemo } from 'react';
import type { ReactElement } from 'react';

/**
 * Chat markdown in Halo Ops styling — PORT AS-IS from the read-only reference
 * /Users/captjay98/projects/caddie/src/components/Markdown.tsx
 * (feature-ledger row C2; deps pinned to the same versions the reference
 * shipped: react-markdown 10.1.0 + remark-gfm 4.0.1).
 *
 * Every element is mapped to halo tokens via the `.md-body` styles in
 * ./markdown.css, so model output (headings, lists, tables, code) renders
 * like the product, not like GitHub. Rendering is display-only: markdown is
 * never parsed back into data, IDs or authorization (contracts.md — actions
 * resolve server-side IDs).
 */
// Memoized: the transcript re-renders on every shell update; re-parsing
// unchanged markdown blocks dominated route-change CPU (see execution ledger).
/** Per-conversation LRU, never a global cache of private conversation text.
 * ReactMarkdown's default export is a synchronous, hook-free parser in the
 * pinned version. Preparing it creates elements, not DOM or network requests. */
export function createMarkdownCache(maxEntries = 48, maxCharacters = 128_000) {
	const entries = new Map<string, ReactElement>();
	let characters = 0;
	function render(text: string): ReactElement {
		const hit = entries.get(text);
		if (hit) { entries.delete(text); entries.set(text, hit); return hit; }
		const result = ReactMarkdown({ children: text, remarkPlugins: [remarkGfm] });
		if (text.length <= maxCharacters && maxEntries > 0) {
			while (entries.size && (entries.size >= maxEntries || characters + text.length > maxCharacters)) {
				const oldest = entries.keys().next().value!;
				characters -= oldest.length; entries.delete(oldest);
			}
			entries.set(text, result); characters += text.length;
		}
		return result;
	}
	return {
		render,
		// Never spend an idle callback parsing a very large single reply.
		prepare(text: string) { if (text.length <= Math.min(12_000, maxCharacters)) render(text); },
		clear() { entries.clear(); characters = 0; },
		get size() { return entries.size; },
	};
}
export type MarkdownCache = ReturnType<typeof createMarkdownCache>;
const Cache = createContext<MarkdownCache | null>(null);
export const MarkdownCacheProvider = Cache.Provider;

export const Markdown = memo(function Markdown({ text, cacheable = true }: { text: string; cacheable?: boolean }): ReactElement {
	const cache = useContext(Cache);
	const content = useMemo(() => cache && cacheable ? cache.render(text) : ReactMarkdown({ children: text, remarkPlugins: [remarkGfm] }), [cache, text, cacheable]);
	return (
		<div className="md-body">
			{content}
		</div>
	);
});
