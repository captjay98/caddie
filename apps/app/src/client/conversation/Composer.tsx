import { useState } from 'react';
import type { ReactElement, KeyboardEvent } from 'react';
import { Icon } from '../icons.tsx';

/**
 * Composer — Enter sends, Shift+Enter breaks a line, visible pending state.
 * The transport owns delivery: `onSend` goes to the channel store, which
 * hands the text to the run transport with an idempotency key (duplicate-send
 * protection). While a run is working the composer is held with the reason
 * shown on the send key.
 */

export function Composer(props: {
	onSend: (text: string) => void;
	/** Transport busy (submitted/streaming) or no project selected. */
	disabled?: boolean;
	disabledReason?: string;
	placeholder?: string;
	/** Controlled text (audit F01): when provided, unsent typing is owned by
	 *  the scoped channel store and survives navigation/reload. Uncontrolled
	 *  (local state) remains the fallback for standalone use. */
	value?: string;
	onValueChange?: (text: string) => void;
}): ReactElement {
	const [localValue, setLocalValue] = useState('');
	const value = props.value ?? localValue;
	const setValue = props.onValueChange ?? setLocalValue;
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
		<div className="composer-wrap">
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
					placeholder={props.disabledReason ? undefined : (props.placeholder ?? 'Message Caddie…')}
					data-testid="composer-input"
				/>
				<button
					type="submit"
					className="composer-send"
					disabled={disabled || value.trim() === ''}
					data-testid="composer-send"
					aria-label={disabled ? 'Send — held' : 'Send message'}
					title={props.disabledReason ?? 'Send message'}
				>
					<Icon name="send" title="" />
				</button>
			</form>
			<p className="composer-hint">Enter to send · Shift + Enter for a new line</p>
		</div>
	);
}
