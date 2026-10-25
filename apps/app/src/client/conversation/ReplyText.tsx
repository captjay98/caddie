import { useDeferredValue, useMemo, useState, useTransition } from 'react';
import type { ReactElement } from 'react';
import { splitChatMocks } from '@caddie/contracts';
import { Markdown, type MarkdownCache } from '@caddie/ui/Markdown';
import { DesignMockPreview } from '../artifacts/DesignMockPreview.tsx';
import { cleanAssistantText } from './response-hygiene.ts';

/**
 * One piece of a reply's text as a person sees it (plan 4.5): the prose as
 * Markdown, and any design mockup in it drawn in the styled preview frame where
 * it stood, never printed as HTML. Mockups are taken out BEFORE the hygiene
 * pass, which only ever sees prose (it strips raw svg and would join lines). A
 * mockup still being written says so instead of showing half its markup.
 */
export function prepareReplyMarkdown(cache: MarkdownCache, text: string): void {
	if (text.length > 12_000) return;
	const split = splitChatMocks(text, { complete: true });
	if (split.before) cache.prepare(cleanAssistantText(split.before));
	if (split.after) cache.prepare(cleanAssistantText(split.after));
}

/** Bound Markdown parsing even when one completed message is unusually large. */
function ReplyProse({ text, streaming }: { text: string; streaming: boolean }): ReactElement {
	const [visible, setVisible] = useState(1);
	const [pending, reveal] = useTransition();
	const chunks = useMemo(() => {
		if (streaming || text.length <= 12_000) return [text];
		const result: string[] = [];
		let start = 0;
		while (start < text.length) {
			let end = Math.min(start + 12_000, text.length);
			if (end < text.length) {
				const paragraph = text.lastIndexOf('\n\n', end);
				if (paragraph > start + 6_000) end = paragraph + 2;
			}
			result.push(text.slice(start, end));
			start = end;
		}
		return result;
	}, [text, streaming]);
	return <>{chunks.slice(0, visible).map((chunk, index) => <Markdown key={index} text={chunk} cacheable={!streaming} />)}
		{visible < chunks.length ? <button type="button" className="btn-ghost response-load-more" disabled={pending} onClick={() => reveal(() => setVisible(count => count + 1))}>{pending ? 'Opening…' : 'Read more of this response'}</button> : null}
	</>;
}

export function ReplyText({ text, streaming = false }: { text: string; streaming?: boolean }): ReactElement | null {
	// Keystrokes and navigation take priority over parsing each streamed token.
	const deferred = useDeferredValue(text);
	const displayed = streaming ? deferred : text;
	const split = useMemo(() => splitChatMocks(displayed, { complete: !streaming }), [displayed, streaming]);
	const before = cleanAssistantText(split.before);
	const after = cleanAssistantText(split.after);
	if (!before && !after && split.mocks.length === 0 && !split.drawing) return null;
	return (
		<>
			{before ? <ReplyProse text={before} streaming={streaming} /> : null}
			{split.mocks.length > 0 ? <DesignMockPreview mocks={split.mocks} /> : null}
			{after ? <ReplyProse text={after} streaming={streaming} /> : null}
			{split.drawing ? (
				<p className="state-detail" role="status" data-testid="mock-drawing">
					Drawing a mockup…
				</p>
			) : null}
		</>
	);
}
