import type { ReactElement } from 'react';
import { Icon } from '../icons.tsx';
import { ASK_BAR_PLACEHOLDER } from '../copy.ts';

/**
 * AskBar — the mobile "Ask Caddie…" affordance (v2 shell, HANDOFF §3.4).
 *
 * On every mobile tab except Caddie, this sits directly above the tab bar
 * where the real composer sits on the Caddie tab. It looks like an input but
 * acts as a button: tapping it opens the Caddie tab, already bound to the
 * thing on screen — the conversation scope follows the route (a project page
 * opens that project's chat; anywhere else opens Everything). The character
 * spot shows Caddie's current mood (the mascot lands in U03; until then the
 * same chip mark the conversation head uses).
 */
export function AskBar(props: {
	/** Opens the Caddie tab (mobile conversation pane). */
	onOpen: () => void;
	/** What the opened chat will be about, e.g. a project name. */
	scopeName?: string;
}): ReactElement {
	const placeholder = props.scopeName ? `Ask about ${props.scopeName}…` : ASK_BAR_PLACEHOLDER;
	return (
		<button
			type="button"
			className="ask-bar"
			data-testid="ask-bar"
			aria-label={`Ask Caddie — opens the chat${props.scopeName ? ` about ${props.scopeName}` : ''}`}
			onClick={props.onOpen}
		>
			<span className="conv-avatar ask-bar-mark" aria-hidden="true">
				C
			</span>
			<span className="ask-bar-ph">{placeholder}</span>
			<span className="ask-bar-go" aria-hidden="true">
				<Icon name="send" title="" />
			</span>
		</button>
	);
}
