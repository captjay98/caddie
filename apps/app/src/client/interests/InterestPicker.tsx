import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import { Icon } from '../icons.tsx';
import {
	MAX_INTERESTS,
	MAX_INTEREST_LENGTH,
	OPEN_TO_ANYTHING_INTEREST,
	addCustomInterest,
	canAddCustom,
	customPicks,
	matchTopics,
	toggleInterest,
} from './catalog.ts';

/**
 * The one interest picker used by onboarding and Settings, so anything a
 * builder might enjoy is a PICK rather than a typing task:
 *   - "Open to anything" leads the popular row; it is exclusive (picking it
 *     replaces the others, picking a topic replaces it);
 *   - 12 popular topics by default (short on mobile), "Show all topics" opens
 *     the grouped catalog, and typing in the search filters every topic;
 *   - a query that matches nothing offers "+ Add …", and Enter adds it;
 *   - at most {@link MAX_INTERESTS} picks.
 */
export function InterestPicker({
	selected,
	onChange,
	legend = 'What would you enjoy building?',
	hint = 'Pick any — or skip and tell me as we go.',
	optional = false,
	testId = 'interest-picker',
	disabled = false,
	compact = false,
}: {
	selected: readonly string[];
	onChange: (next: string[]) => void;
	legend?: string;
	hint?: string;
	optional?: boolean;
	testId?: string;
	disabled?: boolean;
	/** Onboarding: a short first row, with search/catalog behind More topics. */
	compact?: boolean;
}): ReactElement {
	const [query, setQuery] = useState('');
	const [expanded, setExpanded] = useState(false);
	const searchId = useId();
	const openToAnything = selected.includes(OPEN_TO_ANYTHING_INTEREST) || (compact && selected.length === 0);
	const picked = selected.filter((s) => s !== OPEN_TO_ANYTHING_INTEREST).length;
	const full = picked >= MAX_INTERESTS;
	const searching = query.trim().length > 0;
	const groups = matchTopics(query);
	const visible = searching || expanded ? groups : groups.filter((g) => g.label === null);
	const custom = customPicks(selected);
	const offerAdd = canAddCustom(query, selected);

	const isOn = (topic: string) => selected.some((s) => s.toLowerCase() === topic.toLowerCase());
	const chip = (topic: string) => {
		const on = isOn(topic) || (compact && topic === OPEN_TO_ANYTHING_INTEREST && selected.length === 0);
		return (
			<button
				key={topic}
				type="button"
				className={on ? 'chip chip-on' : 'chip'}
				data-selected={on ? 'true' : undefined}
				aria-pressed={on}
				disabled={disabled || (!on && full && topic !== OPEN_TO_ANYTHING_INTEREST)}
				onClick={() => onChange(toggleInterest(selected, topic))}
			>
				<span>{topic}</span>
				{on && !(compact && topic === OPEN_TO_ANYTHING_INTEREST) ? (
					<span className="chip-x" aria-hidden="true">
						<Icon name="x" title="" />
					</span>
				) : null}
			</button>
		);
	};
	const add = () => {
		if (!offerAdd || full) return;
		onChange(addCustomInterest(selected, query));
		setQuery('');
	};

	return (
		<fieldset className={`onboarding-chips interest-picker${compact ? ' interest-picker-compact' : ''}`} data-testid={testId} disabled={disabled}>
			<div className="chips-legend">
				<legend>
					{legend}
					{optional ? <span className="onboarding-optional-tag"> · optional</span> : null}
				</legend>
			<span className={compact && picked === 0 ? 'sr-only' : 'chips-count'} data-testid={`${testId}-count`}>
					{openToAnything ? 'Open to anything' : `${picked}/${MAX_INTERESTS}`}
				</span>
			</div>
			{!compact ? <p className="chips-hint">{hint}</p> : null}
			{!compact || expanded ? <><label className="sr-only" htmlFor={searchId}>
				Search topics or add your own
			</label>
			<input
				id={searchId}
				className="input interest-search"
				type="search"
				value={query}
				maxLength={MAX_INTEREST_LENGTH}
				placeholder="Search topics, or type your own"
				data-testid={`${testId}-search`}
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						event.preventDefault();
						add();
					}
				}}
			/></> : null}
			{compact && !expanded ? <div className="chip-flow">
                {chip(OPEN_TO_ANYTHING_INTEREST)}
                {[...new Set(['AI & agents', 'Games', 'Social impact', ...selected.filter(s => s !== OPEN_TO_ANYTHING_INTEREST)])].map(chip)}
                <button type="button" className="chip chip-add-pick" aria-expanded={false} onClick={() => setExpanded(true)} data-testid={`${testId}-more`}>+ More topics</button>
            </div> : visible.map((group) => (
				<div key={group.label ?? 'popular'} className="interest-group" data-group={group.label ?? 'popular'}>
					{group.label && (searching || expanded) ? <p className="interest-group-label">{group.label}</p> : null}
					{!group.label && (searching || expanded) ? <p className="interest-group-label">Popular</p> : null}
					<div className="chip-flow">
						{group.label === null && !searching ? chip(OPEN_TO_ANYTHING_INTEREST) : null}
						{group.topics.map(chip)}
						{group.label === null ? custom.map(chip) : null}
					</div>
				</div>
			))}
			{compact ? <p className="chips-hint">{hint}</p> : null}
			{offerAdd ? (
				<div className="chip-flow">
					<button type="button" className="chip chip-add-pick" disabled={disabled || full} onClick={add} data-testid={`${testId}-add`}>
						+ Add “{query.trim().slice(0, MAX_INTEREST_LENGTH)}”
					</button>
				</div>
			) : null}
			{searching || (compact && !expanded) ? null : (
				<button type="button" className="interest-more" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); setQuery(''); }} data-testid={`${testId}-more`}>
					{expanded ? 'Show fewer' : 'Show all topics'}
				</button>
			)}
			{full ? <p className="chips-hint" role="status">That’s the maximum of {MAX_INTERESTS} — remove one to pick another.</p> : null}
		</fieldset>
	);
}
