import type { ReactElement } from 'react';
import { Icon, type IconName } from '../icons.tsx';

/**
 * A segmented single-choice picker (keyboard-accessible radiogroup): tappable
 * cards instead of a dropdown. Shared by onboarding and Settings so the same
 * question looks and behaves the same in both. The selected value is
 * reflected on the group via data-value so a test can read it; each option is
 * a real radio button.
 */
export function SegmentField({ legend, options, value, onChange, testId, hint }: {
	legend: string;
	options: readonly { value: string; label: string; icon?: IconName }[];
	value: string;
	onChange: (value: string) => void;
	testId: string;
	hint?: string;
}): ReactElement {
	return (
		<fieldset className="onboarding-segment" data-testid={testId} data-value={value}>
			<legend>{legend}</legend>
			{hint ? <p className="chips-hint">{hint}</p> : null}
			<div className="segment-options" role="radiogroup" aria-label={legend} data-count={options.length}>
				{options.map((option) => (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={value === option.value}
						className="segment-option"
						data-selected={value === option.value}
						data-value={option.value}
						onClick={() => onChange(option.value)}
					>
						{option.icon ? (
							<span className="segment-icon" aria-hidden="true">
								<Icon name={option.icon} title="" />
							</span>
						) : null}
						<span className="segment-label">{option.label}</span>
					</button>
				))}
			</div>
		</fieldset>
	);
}
