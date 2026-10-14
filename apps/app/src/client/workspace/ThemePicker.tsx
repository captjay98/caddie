import { useRef } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import { Icon } from '../icons.tsx';
import { PALETTE_META, PALETTES, type Palette, type ThemeChoice, type ThemeMode } from '../theme.ts';

/**
 * Theme picker: one swatch per palette plus a Dark / Light switch.
 *
 * Each swatch previews the palette IN THE CURRENT MODE (its canvas with an
 * accent bar and dot), so what you see is what you get on click. The swatch
 * colours come from PALETTE_META, which tests/theme-state.test.ts pins to the
 * seeds in tokens.css; the chrome around them uses the live tokens only.
 *
 * Two hosts, two ARIA shapes:
 *   - `menu`  (account menu, role="menu"): groups of `menuitemradio`, each a
 *             plain Tab stop like the menu's other items.
 *   - `panel` (Settings > Appearance): two `radiogroup`s with a roving
 *             tabindex — Tab enters the group on the checked option and the
 *             arrow keys move + select, per the WAI-ARIA radio pattern.
 */
export function ThemePicker(props: {
	palette: Palette;
	mode: ThemeMode;
	onChange: (next: Partial<ThemeChoice>) => void;
	variant: 'menu' | 'panel';
}): ReactElement {
	const { palette, mode, onChange, variant } = props;
	const inMenu = variant === 'menu';
	const optionRole = inMenu ? 'menuitemradio' : 'radio';
	const groupRole = inMenu ? 'group' : 'radiogroup';

	return (
		<div className="theme-picker" data-variant={variant} data-testid={`theme-picker-${variant}`}>
			<RadioRow
				label="Palette"
				groupRole={groupRole}
				optionRole={optionRole}
				roving={!inMenu}
				className="theme-swatches"
				options={PALETTES.map((name) => {
					const [canvas, accent] = PALETTE_META[name].swatch[mode];
					return {
						key: name,
						checked: name === palette,
						onSelect: () => onChange({ palette: name }),
						label: `${PALETTE_META[name].label} palette`,
						testId: `theme-swatch-${name}`,
						content: (
							<>
								<span
									className="theme-swatch-chip"
									aria-hidden="true"
									style={{ '--swatch-canvas': canvas, '--swatch-accent': accent } as CSSProperties}
								>
									<span className="theme-swatch-bar" />
									<span className="theme-swatch-dot" />
								</span>
								<span className="theme-swatch-name">{PALETTE_META[name].label}</span>
							</>
						),
					};
				})}
			/>
			<RadioRow
				label="Mode"
				groupRole={groupRole}
				optionRole={optionRole}
				roving={!inMenu}
				className="theme-modes"
				options={(['dark', 'light'] as const).map((value) => ({
					key: value,
					checked: value === mode,
					onSelect: () => onChange({ mode: value }),
					label: value === 'dark' ? 'Dark mode' : 'Light mode',
					testId: `theme-mode-${value}`,
					content: (
						<>
							<Icon name={value === 'dark' ? 'moon' : 'sun'} title={value === 'dark' ? 'Dark mode' : 'Light mode'} />
							{value === 'dark' ? 'Dark' : 'Light'}
						</>
					),
				}))}
			/>
		</div>
	);
}

interface RadioOption {
	key: string;
	checked: boolean;
	onSelect: () => void;
	label: string;
	testId: string;
	content: ReactElement;
}

function RadioRow(props: {
	label: string;
	groupRole: 'group' | 'radiogroup';
	optionRole: 'menuitemradio' | 'radio';
	roving: boolean;
	className: string;
	options: RadioOption[];
}): ReactElement {
	const refs = useRef<(HTMLButtonElement | null)[]>([]);
	const checkedIndex = Math.max(0, props.options.findIndex((option) => option.checked));

	function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
		if (!props.roving) return;
		const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
		const jump = event.key === 'Home' ? 0 : event.key === 'End' ? props.options.length - 1 : null;
		if (step === 0 && jump === null) return;
		event.preventDefault();
		const next = jump ?? (index + step + props.options.length) % props.options.length;
		props.options[next]!.onSelect();
		refs.current[next]?.focus();
	}

	return (
		<div className="theme-picker-row">
			<span className="theme-picker-label" aria-hidden="true">
				{props.label}
			</span>
			<div role={props.groupRole} aria-label={props.label} className={props.className}>
				{props.options.map((option, index) => (
					<button
						key={option.key}
						ref={(element) => {
							refs.current[index] = element;
						}}
						type="button"
						role={props.optionRole}
						aria-checked={option.checked}
						aria-label={option.label}
						title={option.label}
						data-testid={option.testId}
						tabIndex={props.roving ? (index === checkedIndex ? 0 : -1) : undefined}
						onClick={option.onSelect}
						onKeyDown={(event) => onKeyDown(event, index)}
					>
						{option.content}
					</button>
				))}
			</div>
		</div>
	);
}
