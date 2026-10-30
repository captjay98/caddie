import { CardHeader } from '../brief/CardFrame.tsx';
import type { ReactElement } from 'react';
import { createContext, useContext } from 'react';
import type { HackathonResultsCard, HackathonCandidate } from '@caddie/contracts';
import { Icon } from '../icons.tsx';
import { countryName } from '../country.ts';
import {
	compactCount,
	compactPrize,
	dateRange,
	deadline,
	eligibilityView,
	endsSoon,
	FORMAT_LABEL,
	platformName,
	rowFacts,
	type EligibilityView,
} from './hackathon-format.ts';

/**
 * Lets the chat card open the SAME detail pane the Discover list uses, instead
 * of navigating away to the event page. The conversation host (Channel)
 * provides `openDetail`; when no provider is present (card rendered outside a
 * conversation), the title falls back to the external link so nothing breaks.
 */
export interface HackathonDetailContextValue {
	openDetail: (candidate: HackathonCandidate) => void;
}
const HackathonDetailContext = createContext<HackathonDetailContextValue | null>(null);
export const HackathonDetailProvider = HackathonDetailContext.Provider;
function useHackathonDetail(): HackathonDetailContextValue | null {
	return useContext(HackathonDetailContext);
}

/**
 * The hackathon-results chat card. One column, sized for the chat width: the
 * first event as a compact card (three numbers, the verdict, a fold-out with
 * the quoted rule), the rest as one-line rows, and anything past the first
 * few behind "Show N more".
 *
 * HONESTY in the render (mirrors the contract):
 *   - a null date / prize / entry count is simply NOT shown — never "unknown"
 *     noise, never a fabricated value;
 *   - eligibility is the strict engine verdict; its wording and the verbatim
 *     rule that decided it come from the quoted rules page, linked;
 *   - the AI fit verdict is a SEPARATE chip (never conflated with eligibility),
 *     shown only when the model actually scored the event;
 *   - every event links to its cited source page;
 *   - `gaps` fold into "How I checked" so the card never implies more
 *     certainty than the sweep had.
 */

/** Rows shown before the "Show N more" fold. */
const VISIBLE_ROWS = 4;

const ELIGIBILITY_ICON: Readonly<Record<EligibilityView['state'], 'check' | 'x' | 'info' | 'shield'>> = {
	eligible: 'check',
	closed: 'x',
	ineligible: 'x',
	confirm: 'info',
	unknown: 'shield',
};

export function EligibilityChip({ view, compact, testId }: { view: EligibilityView; compact?: boolean; testId?: string }): ReactElement {
	const text = compact ? view.short : view.label;
	return (
		<span className="hk-chip hk-chip-elig" data-eligibility={view.state} data-testid={testId ?? 'hk-elig-chip'} title={view.label}>
			<Icon name={ELIGIBILITY_ICON[view.state]} title="" /> {text}
		</span>
	);
}

/** The fold-out that shows the verbatim rule behind a verdict, linked to the official rules page. */
export function RuleQuote({ candidate, view }: { candidate: HackathonCandidate; view: EligibilityView }): ReactElement | null {
	const quote = candidate.eligibilityQuote?.trim();
	if (!quote || !view.why) return null;
	return (
		<details className="hk-why" data-testid="hk-rule-quote">
			<summary>{view.why}</summary>
			<p className="hk-why-body">
				{view.label}. From the official rules: <q>{quote}</q>{' '}
				{candidate.rulesUrl ? (
					<a className="hk-rule-link" href={candidate.rulesUrl} target="_blank" rel="noreferrer">
						Read the rules
					</a>
				) : null}
			</p>
		</details>
	);
}

/**
 * ONE eligibility object: the chip IS the disclosure trigger. Clicking the
 * verdict chip expands the verbatim rule that decided it (honest evidence,
 * never a second eligibility affordance). When there is no rule to quote the
 * chip renders plain — a verdict with nothing behind it never grows a caret.
 */
export function EligibilityDisclosure({ candidate, view }: { candidate: HackathonCandidate; view: EligibilityView }): ReactElement {
	const quote = candidate.eligibilityQuote?.trim();
	const hasRule = Boolean(quote && view.why);
	if (!hasRule) {
		return <EligibilityChip view={view} testId="hk-elig-chip" />;
	}
	// Review 2026-10-28: the reason in plain words first; the legal sentence it
	// rests on is folded under "Show the rule" and shortened, with a link to the
	// full rules. The chip carries a small caret instead of the word "why".
	const short = quote!.length > RULE_PREVIEW ? `${quote!.slice(0, RULE_PREVIEW).replace(/\s+\S*$/, '')}…` : quote!;
	return (
		<details className="hk-elig-disclosure" data-testid="hk-rule-quote">
			<summary className="hk-elig-summary" data-testid="hk-elig-chip-trigger" aria-label={`${view.short}: show why`}>
				<EligibilityChip view={view} compact testId="hk-elig-chip" />
				<Icon name="chevronDown" title="" className="hk-elig-caret" />
			</summary>
			{/* Flat on purpose (owner 2026-10-28): no box, no second fold, no
			    indented quote — every level costs width on a phone. */}
			<div className="hk-why-body" data-testid="hk-why-body">
				<p className="hk-why-reason">{view.label}.</p>
				<p className="hk-why-quote">
					“{short}”{' '}
					{candidate.rulesUrl ? (
						<a className="hk-rule-link" href={candidate.rulesUrl} target="_blank" rel="noreferrer">
							Full rules
						</a>
					) : null}
				</p>
			</div>
		</details>
	);
}

/** How much of a rule's wording the card shows before "Read the full rules". */
const RULE_PREVIEW = 160;

/** AI fit as a stat value (short word) — folded into the number row, not a floating chip. */
const AI_FIT_SHORT: Readonly<Record<'strong' | 'possible' | 'weak', string>> = {
	strong: 'Strong',
	possible: 'Possible',
	weak: 'Weak',
};

function FeaturedCard({ candidate }: { candidate: HackathonCandidate }): ReactElement {
	const view = eligibilityView(candidate);
	const detail = useHackathonDetail();
	const fit = candidate.aiFit && candidate.aiFit !== 'unknown' ? AI_FIT_SHORT[candidate.aiFit] : null;
	const rawReason = candidate.topPick ? candidate.aiFitReason?.trim() ?? '' : '';
	// The model's sentence, shown as a sentence (it sometimes starts lowercase).
	const reason = rawReason ? rawReason.charAt(0).toUpperCase() + rawReason.slice(1) : '';
	const subtitle = [candidate.organizer, candidate.format ? FORMAT_LABEL[candidate.format] : null, dateRange(candidate)].filter(Boolean);
	const prize = compactPrize(candidate.prize);
	const end = deadline(candidate);
	const soon = endsSoon(candidate);
	// Full-width stat row: the real numbers plus AI fit as a 4th stat (only when
	// the model actually scored it — an unscored event shows no fit stat, never
	// a fabricated verdict). A missing prize / count / date is simply absent.
	const stats = [
		prize ? { value: prize, label: 'prizes', id: 'prize' } : null,
		candidate.participants && candidate.participants > 0 ? { value: compactCount(candidate.participants), label: 'entered', id: 'participants' } : null,
		end ? { value: end, label: soon ? 'left to submit' : 'deadline', id: 'deadline' } : null,
		fit ? { value: fit, label: 'fit', id: 'fit' } : null,
	].filter((stat) => stat !== null);
	// Review 2026-10-28: no "Open on Devpost" button sending a first-timer away.
	// The whole card opens the details (which links the event page and offers
	// "Plan a project for this"). Clicks on the eligibility fold, or any link
	// inside it, keep their own behaviour.
	const openFromCard = detail
		? (event: { target: EventTarget | null }) => {
				const target = event.target as HTMLElement | null;
				if (target?.closest('details, a, button')) return;
				detail.openDetail(candidate);
			}
		: undefined;
	return (
		<article
			className="hk-feature caddie-card"
            data-design="opportunity" data-tone="blue"
			data-testid="hk-card"
			data-eligibility={candidate.eligibility}
			data-ai-fit={candidate.aiFit ?? 'unknown'}
			data-top-pick={candidate.topPick ? 'true' : undefined}
			data-openable={detail ? 'true' : undefined}
			onClick={openFromCard}
		>
            {/* One heading: "Found for you", plus "Top pick" only when it truly is one. */}
            <CardHeader design="opportunity" status={candidate.topPick ? 'Top pick' : ''} />
			{/* Match Brief: shared header, readable content, facts, then actions. */}
			<div className="hk-feature-head">
				<div className="hk-feature-ident">
					<h4 className="hk-feature-title">
						{detail ? (
							<button
								type="button"
								className="hk-title-btn"
								data-testid="hk-open-detail"
								onClick={() => detail.openDetail(candidate)}
								title={`Open details for ${candidate.title}`}
							>
								{candidate.title}
							</button>
						) : (
							candidate.title
						)}
					</h4>
					{subtitle.length > 0 ? <p className="hk-feature-sub">{subtitle.join(' · ')}</p> : null}
				</div>

			</div>
			{stats.length > 0 ? (
				<dl className="hk-stats" data-testid="hk-meta">
					{stats.map((stat) => (
						<div key={stat.id} className="hk-stat" data-stat={stat.id} data-testid={`hk-meta-${stat.id}`}>
							<dd>{stat.value}</dd>
							<dt>{stat.label}</dt>
						</div>
					))}
				</dl>
			) : null}
			{reason ? (
				<p className="hk-fit-reason" data-testid="hk-fit-reason">
					{reason}
				</p>
			) : null}
			{soon ? (
				<p className="hk-soon-note" data-testid="hk-soon-note">
					<Icon name="alert" title="" /> This one closes very soon. A first build usually needs more time.
				</p>
			) : null}
				<div className="hk-feature-actions">
					<EligibilityDisclosure candidate={candidate} view={view} />
					{candidate.openStatusUnverified ? (
						<span className="hk-chip hk-chip-unverified" data-testid="hk-unverified-chip">
							<Icon name="alert" title="" /> Open status unverified
						</span>
					) : null}
					{detail ? (
						<button type="button" className="hk-details-link" data-testid="hk-see-details" onClick={() => detail.openDetail(candidate)}>
							See details <span aria-hidden="true">→</span>
						</button>
					) : (
						// Outside a conversation there is no pane to open; link the event page.
						<a className="hk-details-link" href={candidate.url} target="_blank" rel="noreferrer">
							{platformName(candidate.platform) ?? 'Event page'} <Icon name="link" title="" />
						</a>
					)}
				</div>
		</article>
	);
}

function CandidateRow({ candidate }: { candidate: HackathonCandidate }): ReactElement {
	const view = eligibilityView(candidate);
	const facts = rowFacts(candidate);
	const detail = useHackathonDetail();
	return (
		<li className="hk-row" data-testid="hk-row" data-eligibility={candidate.eligibility}>
			<div className="hk-row-main">
				{detail ? (
					<button
						type="button"
						className="hk-row-title hk-title-btn"
						data-testid="hk-row-open-detail"
						onClick={() => detail.openDetail(candidate)}
						title={candidate.title}
					>
						{candidate.title}
					</button>
				) : (
					<a className="hk-row-title" href={candidate.url} target="_blank" rel="noreferrer" title={candidate.title}>
						{candidate.title}
					</a>
				)}
				{facts.length > 0 ? <span className="hk-row-facts">{facts.join(' · ')}</span> : null}
			</div>
			<span className="hk-row-chips">
				{candidate.openStatusUnverified ? (
					<span className="hk-chip hk-chip-unverified" data-testid="hk-unverified-chip">
						Unverified
					</span>
				) : null}
				<EligibilityChip view={view} compact />
			</span>
		</li>
	);
}

export function HackathonResultsCard({ card }: { card: HackathonResultsCard }): ReactElement {
	const [first, ...rest] = card.candidates;
	if (!first) {
		return (
			<div className="hk-results hk-empty" data-testid="hk-results">
				<p className="hk-empty-line">
					<Icon name="search" title="" /> No matching hackathons came back from this search.
				</p>
				<HkFooter card={card} />
			</div>
		);
	}
	const shown = rest.slice(0, VISIBLE_ROWS);
	const folded = rest.slice(VISIBLE_ROWS);
	return (
		<div className="hk-results" data-testid="hk-results">
			<FeaturedCard candidate={first} />
			{shown.length > 0 ? (
				<>
					<p className="hk-section-label">More that fit</p>
					<ul className="hk-rows">
						{shown.map((candidate) => (
							<CandidateRow key={candidate.id} candidate={candidate} />
						))}
					</ul>
				</>
			) : null}
			{folded.length > 0 ? (
				<details className="hk-more" data-testid="hk-more">
					<summary>Show {folded.length} more</summary>
					<ul className="hk-rows">
						{folded.map((candidate) => (
							<CandidateRow key={candidate.id} candidate={candidate} />
						))}
					</ul>
				</details>
			) : null}
			<HkFooter card={card} />
		</div>
	);
}

/**
 * "Entry rules read for 3 of 8 · for Nigeria · How I checked". The count is
 * the card's own (events with a verdict or a quoted rule), so the footer can
 * never claim more checking than the rows show (review 2026-10-28).
 */
function HkFooter({ card }: { card: HackathonResultsCard }): ReactElement | null {
	const country = countryName(card.profileCountry);
	const total = card.candidates.length;
	const checked = card.candidates.filter((c) => c.eligibility !== 'unknown' || Boolean(c.eligibilityQuote?.trim())).length;
	if (!country && card.gaps.length === 0 && total === 0) return null;
	const line =
		total === 0
			? null
			: checked === total
				? `Entry rules read for all ${total}${country ? ` · for ${country}` : ''}`
				: `Entry rules read for ${checked} of ${total}${country ? ` · for ${country}` : ''}`;
	return (
		<div className="hk-foot">
			{line ? <span className="hk-country-note" data-testid="hk-checked-note">{line}</span> : null}
			{card.gaps.length > 0 ? (
				<details className="hk-gaps" data-testid="hk-gaps">
					<summary>How I checked</summary>
					<ul>
						{card.gaps.map((gap, index) => (
							<li key={index}>{gap}</li>
						))}
					</ul>
				</details>
			) : null}
		</div>
	);
}
