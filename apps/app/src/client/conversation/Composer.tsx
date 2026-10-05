import { useState } from 'react';
import type { ReactElement, KeyboardEvent } from 'react';

/**
 * Composer skeleton — the shared input grammar ported from the reference
 * ChatComposer (Enter sends, Shift+Enter breaks a line, visible pending
 * state). P06 has no transport: `onSend` retains the text as an unsent draft
 * with a generated idempotency key (channel-store.ts). P05 swaps the store
 * call for `useFlueAgent().sendMessage(text, { idempotencyKey })`; the
 * component contract does not change.
 */

export function Composer(props: {
	onSend: (text: string) => void;
	/** Transport busy (submitted/streaming) or no project selected. */
	disabled?: boolean;
	disabledReason?: string;
	placeholder?: string;
}): ReactElement {
	const [value, setValue] = useState('');
	const disabled = Boolean(props.disabled);

	function submit() {
		const text = value.trim();
		if (!text || disabled) return;
		props.onSend(text);
		setValue('');
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	}

	return (
		<form
			className="composer"
			data-testid="composer"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<textarea
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={onKeyDown}
				disabled={disabled}
				enterKeyHint="send"
				rows={1}
				aria-label="Message the channel"
				placeholder={props.disabledReason ? undefined : (props.placeholder ?? 'Ask the caddie…')}
				data-testid="composer-input"
			/>
			<button
				type="submit"
				className="btn-key"
				disabled={disabled || value.trim() === ''}
				data-testid="composer-send"
				title={props.disabledReason}
			>
				{disabled ? 'Held' : 'Send'}
			</button>
		</form>
	);
}
