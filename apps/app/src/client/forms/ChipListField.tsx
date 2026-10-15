import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import { Icon } from '../icons.tsx';

/**
 * A free-entry chip list (skills): every entry is a removable chip and new
 * ones join on Enter or "Add" — never a comma-separated text box. Trims,
 * caps each entry at `maxLength`, ignores case-insensitive duplicates, and
 * stops at `max` entries with a visible reason.
 */
export function ChipListField({
	legend,
	hint,
	values,
	onChange,
	testId,
	placeholder = 'Add one',
	max = 12,
	maxLength = 60,
}: {
	legend: string;
	hint?: string;
	values: readonly string[];
	onChange: (next: string[]) => void;
	testId: string;
	placeholder?: string;
	max?: number;
	maxLength?: number;
}): ReactElement {
	const [draft, setDraft] = useState('');
	const inputId = useId();
	const full = values.length >= max;
	const add = () => {
		const item = draft.replace(/\s+/g, ' ').trim().slice(0, maxLength);
		if (!item || full || values.some((v) => v.toLowerCase() === item.toLowerCase())) return;
		onChange([...values, item]);
		setDraft('');
	};
	return (
		<fieldset className="onboarding-chips" data-testid={testId}>
			<div className="chips-legend">
				<legend>{legend}</legend>
				<span className="chips-count">{values.length}/{max}</span>
			</div>
			{hint ? <p className="chips-hint">{hint}</p> : null}
			<div className="chip-flow">
				{values.map((item) => (
					<button
						key={item}
						type="button"
						className="chip chip-on"
						data-selected="true"
						aria-label={`Remove ${item}`}
						onClick={() => onChange(values.filter((v) => v !== item))}
					>
						<span>{item}</span>
						<span className="chip-x" aria-hidden="true">
							<Icon name="x" title="" />
						</span>
					</button>
				))}
				<label className="sr-only" htmlFor={inputId}>
					{legend}: add one
				</label>
				<input
					id={inputId}
					className="chip-add"
					value={draft}
					maxLength={maxLength}
					placeholder={full ? `Up to ${max}` : placeholder}
					disabled={full}
					data-testid={`${testId}-input`}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							add();
						}
					}}
				/>
			</div>
		</fieldset>
	);
}
