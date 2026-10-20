import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { splitChatMocks } from '@caddie/contracts';
import { Markdown } from '@caddie/ui/Markdown';
import { DesignMockPreview } from '../artifacts/DesignMockPreview.tsx';
import { cleanAssistantText } from './response-hygiene.ts';

/**
 * One piece of a reply's text as a person sees it (plan 4.5): the prose as
 * Markdown, and any design mockup in it drawn in the styled preview frame where
 * it stood, never printed as HTML. Mockups are taken out BEFORE the hygiene
 * pass, which only ever sees prose (it strips raw svg and would join lines). A
 * mockup still being written says so instead of showing half its markup.
 */
export function ReplyText({ text, streaming = false }: { text: string; streaming?: boolean }): ReactElement | null {
	const split = useMemo(() => splitChatMocks(text, { complete: !streaming }), [text, streaming]);
	const before = cleanAssistantText(split.before);
	const after = cleanAssistantText(split.after);
	if (!before && !after && split.mocks.length === 0 && !split.drawing) return null;
	return (
		<>
			{before ? <Markdown text={before} /> : null}
			{split.mocks.length > 0 ? <DesignMockPreview mocks={split.mocks} /> : null}
			{after ? <Markdown text={after} /> : null}
			{split.drawing ? (
				<p className="state-detail" role="status" data-testid="mock-drawing">
					Drawing a mockup…
				</p>
			) : null}
		</>
	);
}
