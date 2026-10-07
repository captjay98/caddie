import { useState } from 'react';
import type { ReactElement } from 'react';
import { Icon } from './icons.tsx';

/**
 * A full identifier with a copy affordance — UI review board screen 09/10:
 * truncation destroys the one property that makes a content hash or claim id
 * checkable, so identifiers render in full and are one click from the
 * clipboard. When the clipboard is unavailable (permissions), the id stays
 * selectable text and no success is claimed.
 */
export function CopyableId(props: { value: string; label: string }): ReactElement {
	const [copied, setCopied] = useState(false);
	return (
		<span className="ev-ident">
			<span className="mono-id" title={props.value}>
				{props.value}
			</span>
			<button
				type="button"
				className="copy-btn"
				data-testid={`copy-${props.label}`}
				onClick={() => {
					void navigator.clipboard
						?.writeText(props.value)
						.then(() => {
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1200);
						})
						.catch(() => {
							// clipboard unavailable — the full id is still selectable
						});
				}}
			>
				<Icon name="doc" title={`copy ${props.label}`} />
				{copied ? 'copied' : 'copy'}
			</button>
		</span>
	);
}