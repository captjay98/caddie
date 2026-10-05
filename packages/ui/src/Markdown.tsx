import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
export function Markdown({ text }: { text: string }): ReactElement {
	return (
		<div className="md-body">
			<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
		</div>
	);
}
