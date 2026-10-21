import { useEffect, useRef, useState, useId } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../icons.tsx';
import { StatePanel } from '../states.tsx';
import { mergeDetailFacts } from './detail-facts.ts';
import type { MetaPart } from '../conversation/hackathon-format.ts';

/**
 * Hackathon detail pane (feature: "a deeper detail view, not just the Devpost
 * link"). A right-side drawer that opens from the Discover list when a title is
 * clicked. Two tiers, mirroring the reference caddie ContestDetail:
 *   - Tier 1: the AI digest (headline + bullets + watch-out), clearly marked
 *     "ai-read · verify below" — it is fail-soft and NEVER load-bearing, so a
 *     null digest renders its gap, never a fabricated summary.
 *   - Tier 2: the verbatim rules grouped by kind, each with its quote and
 *     verdict — the source of truth, which does not depend on the model.
 *
 * The data comes from GET …/discovery/candidates/:id/detail (candidateDetail).
 * a11y: role="dialog" aria-modal, Esc closes, focus moves to the close button
 * on open, click on the backdrop closes.
 */

interface DetailClaim {
	claimId: string;
	claimType: string;
	quote: string;
	verdict: 'eligible' | 'ineligible' | 'unknown';
	reason: string;
}
interface DetailGroup {
	kind: string;
	label: string;
	claims: readonly DetailClaim[];
}
interface CandidateDigest {
	headline: string;
	bullets: readonly string[];
	watchOut: string | null;
	/* Richer v2 fields — optional so an older-shape response still renders. */
	about?: string;
	tracks?: readonly { name: string; detail: string }[];
	prizes?: readonly { label: string; amount: string }[];
	perks?: readonly string[];
	judging?: readonly string[];
	fitTracks?: readonly { name: string; why: string }[];
}
export interface CandidateDetailResponse {
	candidate: { id: string; url: string; title: string; summary: string };
	eligibility: { verdict: 'eligible' | 'ineligible' | 'unknown' };
	digest: CandidateDigest | null;
	digestGap: string | null;
	/** True when the digest was deferred and must be fetched from /digest. */
	digestPending?: boolean;
    officialPrizes?: readonly {label:string;amount:string;quantity:string;eligibility:string}[];
    prizesSourceUrl?: string | null;
	groups: readonly DetailGroup[];
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, { credentials: 'same-origin' });
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
		throw new Error(body.message ?? body.error ?? `request failed (${response.status})`);
	}
	return (await response.json()) as T;
}

export function ContestDetailPane(props: {
	projectId: string;
	candidateId: string;
	apiBase?: string;
	onClose: () => void;
	onSave?: () => void;
	onExplore?: () => void;
	onCheck?: () => void;
	saved?: boolean;
	busy?: boolean;
	checking?: boolean;
	/** The row's "organiser · format · dates · prize" facts, shown under the title as labelled pills. */
	metaParts?: readonly MetaPart[] | null;
	deadline?: string | null;
	overviewEvidence?: ReactNode;
	entryEvidence?: ReactNode;
	entryQuote?: string | null;
	rulesUrl?: string | null;
	sourceSummary?: string;
	/**
	 * When true, opening the pane for a candidate whose rules have NOT been read
	 * triggers onCheck ONCE automatically — so an unchecked card syncs its real
	 * eligibility the moment the user opens it, instead of making them press a
	 * button. Honest: the check reads the actual rules page; nothing is guessed.
	 */
	autoCheckOnOpen?: boolean;
}): ReactElement {
	const { projectId, candidateId, apiBase = '', onClose } = props;
	const closeRef = useRef<HTMLButtonElement>(null);
    const [tab, setTab] = useState<'overview' | 'build' | 'entry' | 'prizes'>('overview');
    const tabId = useId();
    useEffect(() => { setTab('overview'); }, [candidateId]);
    const tabs = [{id:'overview', label:'Overview'}, {id:'build', label:'Build'}, {id:'entry', label:'Entry rules'}, {id:'prizes', label:'Prizes'}] as const;
	const base = `${apiBase}/api/projects/${encodeURIComponent(projectId)}/discovery`;

	const detail = useQuery({
		queryKey: ['discovery-detail', projectId, candidateId],
		// Rules first: the slow AI digest is deferred to its own request below.
		queryFn: () => fetchJson<CandidateDetailResponse>(`${base}/candidates/${encodeURIComponent(candidateId)}/detail?digest=defer`),
	});

	// a11y: Esc closes; focus the close button on open.
	useEffect(() => {
		closeRef.current?.focus();
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') onClose();
		}
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [onClose]);

	const data = detail.data;
    const sourceSummary = data?.candidate.summary || props.sourceSummary || '';
    const composedSource = /^By .+ · /.test(sourceSummary) && /in prizes|registered/.test(sourceSummary);
    const quoteKey = (value: string) => value.replace(/[“”"*_]/g, '').replace(/\s+/g, ' ').trim();
    const canonicalCoversEntry = Boolean(props.entryQuote && data?.groups.some(group => group.kind !== 'fit' && group.claims.some(claim => quoteKey(claim.quote) === quoteKey(props.entryQuote!))));

	// Auto-sync (point 3): when the pane opens for a candidate whose rules have
	// not been read (no verbatim groups yet), run the check ONCE — reading the
	// real rules page — so both this pane and the list card stop showing "not
	// checked". Guarded by a ref so a re-render or the post-check refetch does
	// not loop; cleared when the candidate changes.
	const autoCheckedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!props.autoCheckOnOpen || !props.onCheck) return;
		if (!data || props.checking) return;
		if (data.groups.length > 0) return; // already read — nothing to sync
		if (autoCheckedRef.current === candidateId) return; // already triggered for this one
		autoCheckedRef.current = candidateId;
		props.onCheck();
	}, [data, props.autoCheckOnOpen, props.onCheck, props.checking, candidateId]);

	// The auto-check is about to (or will) read the rules page, which changes
	// the digest's input — so don't spend the slow digest call before it runs.
	const awaitingAutoCheck = Boolean(
		props.autoCheckOnOpen && props.onCheck && data && data.groups.length === 0 && autoCheckedRef.current !== candidateId,
	);
	const readingRules = Boolean(props.checking) || awaitingAutoCheck;

	// Deferred AI digest (the slow ~30s model call), fetched only when the
	// detail response says none is cached yet and no rules read is pending.
	const digestQuery = useQuery({
		queryKey: ['discovery-digest', projectId, candidateId],
		queryFn: () =>
			fetchJson<Pick<CandidateDetailResponse, 'digest' | 'digestGap'>>(`${base}/candidates/${encodeURIComponent(candidateId)}/digest`),
		enabled: Boolean(data?.digestPending) && !readingRules,
	});

	const digest = data?.digest ?? digestQuery.data?.digest ?? null;
	const keyDetails = mergeDetailFacts(props.metaParts ?? [], props.deadline, digest?.bullets ?? []);
	const digestLoading = Boolean(data?.digestPending) && !digest && (readingRules || digestQuery.isPending);
	const digestGap = data?.digestPending
		? digestQuery.error
			? 'The AI summary could not load — read the official rules below.'
			: (digestQuery.data?.digestGap ?? null)
		: (data?.digestGap ?? null);

	// When a check completes (checking true → false), the list has been
	// re-read; refetch THIS pane's detail so its verbatim rules + digest reflect
	// the freshly-read rules instead of the stale "not read yet" state.
	const wasChecking = useRef(false);
	useEffect(() => {
		if (wasChecking.current && !props.checking) {
			void detail.refetch();
			if (digestQuery.data || digestQuery.error) void digestQuery.refetch();
		}
		wasChecking.current = Boolean(props.checking);
	}, [props.checking, detail, digestQuery]);

	return (
		<div className="cdp-backdrop" onClick={onClose} data-testid="contest-detail-backdrop">
			<aside
				className="cdp-pane"
				role="dialog"
				aria-modal="true"
				aria-label="Hackathon detail"
				data-testid="contest-detail-pane"
				onClick={(e) => e.stopPropagation()}
			>
                <header className="cdp-head">
                    <div className="cdp-topbar">
                        <button ref={closeRef} type="button" className="btn-ghost cdp-close" onClick={onClose} data-testid="contest-detail-close" aria-label="Close detail"><Icon name="arrowLeft" title="" /> Back</button>
                        {data ? <span className="cdp-header-verdict" data-verdict={data.eligibility.verdict}>{data.eligibility.verdict === 'eligible' ? 'Can enter' : data.eligibility.verdict === 'ineligible' ? "Can't enter" : 'Entry unconfirmed'}</span> : null}
                    </div>
                    <div className="cdp-head-main">
                        <h2 className="cdp-title">{detail.isPending ? 'Loading…' : data?.candidate.title ?? 'Hackathon'}</h2>
                        <p className="cdp-organizer">{(props.metaParts ?? []).filter(part => part.key === 'host' || part.key === 'format').map(part => part.value).join(' · ')}</p>

                    </div>
                </header>

				<div className="cdp-tabs" role="tablist" aria-label="Hackathon details" onKeyDown={event => {
                    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
                    if (next < 0) return;
                    event.preventDefault(); setTab(tabs[next]!.id); buttons[next]?.focus();
                }}>
                    {tabs.map(item => <button key={item.id} type="button" role="tab" id={`${tabId}-${item.id}-tab`} aria-controls={`${tabId}-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)}>{item.label}</button>)}
                </div>
                <div className="cdp-body">
                    {digest?.watchOut ? <div className="cdp-watch cdp-watch-persistent"><p className="cdp-watch-tag">Watch out</p><p className="cdp-watch-body">{digest.watchOut}</p></div> : null}
					{detail.isPending ? <StatePanel kind="loading" title="Reading this hackathon…" /> : null}
					{detail.error ? (
						<StatePanel
							kind="error"
							title="Could not load this hackathon"
							detail={detail.error instanceof Error ? detail.error.message : undefined}
							onRetry={() => void detail.refetch()}
							retryLabel="Retry"
						/>
					) : null}

						<>
							<section role="tabpanel" id={`${tabId}-overview`} aria-labelledby={`${tabId}-overview-tab`} hidden={tab !== 'overview'}>
                            {/* Tier 1: AI digest, clearly marked. */}
							{digest ? (
								<div className="cdp-digest" data-testid="contest-detail-digest">
									<div className="cdp-digest-head">
										<span className="cdp-digest-tag">The opportunity</span>
										<span className="cdp-digest-ai" title="This is Caddie's plain-language summary. The exact official rules are quoted in Entry rules — they are the real source of truth.">
											AI summary · verify in Entry rules
										</span>
									</div>
									{digest.headline ? <p className="cdp-headline">{digest.headline}</p> : null}
									{digest.about ? <p className="cdp-about" data-testid="contest-detail-about">{digest.about}</p> : null}

								</div>
							) : detail.isPending ? null : digestLoading ? (
								<div className="cdp-digest cdp-digest-loading" role="status" aria-live="polite" data-testid="contest-detail-digest-loading">
									<div className="cdp-digest-head">
										<span className="cdp-digest-tag">The opportunity</span>
									</div>
									<p className="cdp-digest-progress">
										<span className="channel-activity-dot" aria-hidden="true" />
										{readingRules ? 'Caddie is reading the official rules page…' : 'Caddie is reading the event page…'}
									</p>
									<p className="cdp-digest-progress-detail">
										{readingRules
											? 'Checking who can enter first. The summary of tracks, prizes and perks comes next.'
											: 'Pulling out what you’d build, the tracks, prizes and perks. This usually takes about 30 seconds — you can inspect Entry rules while you wait.'}
									</p>
								</div>
							) : (
								<p className="cdp-digest-gap" data-testid="contest-detail-digest-gap">
									{digestGap ?? 'No digest — read the Entry rules tab.'}
								</p>
							)}

                            {keyDetails.facts.length || keyDetails.notes.length ? <section className="cdp-key-details" data-testid="contest-detail-key-details"><h3>Key details</h3><dl>{keyDetails.facts.map(fact => <div key={fact.key}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>{keyDetails.notes.map((note,index) => <p key={index} className="cdp-key-note">{note}</p>)}</section> : null}
							{sourceSummary && !composedSource ? <details className="cdp-summary-more" data-testid="contest-detail-source-summary"><summary>From the event listing</summary><p>{sourceSummary}</p></details> : null}
                            {props.overviewEvidence}
                            {digest ? <DigestSections digest={digest} section="overview" /> : null}
                            </section>
                            <section role="tabpanel" id={`${tabId}-build`} aria-labelledby={`${tabId}-build-tab`} hidden={tab !== 'build'}>
                                {digest ? <DigestSections digest={digest} section="build" /> : <p className="cdp-digest-gap">{digestLoading ? 'Reading tracks and judging requirements…' : 'No track or judging summary is available. Read the official event page.'}</p>}
                            </section>
                            <section role="tabpanel" id={`${tabId}-prizes`} aria-labelledby={`${tabId}-prizes-tab`} hidden={tab !== 'prizes'}>
                                {data?.officialPrizes?.length ? <section className="cdp-section" data-testid="contest-detail-official-prizes"><h3 className="cdp-section-title">Prize breakdown</h3><p className="cdp-section-note">From the official rules{data.prizesSourceUrl ? <> · <a href={data.prizesSourceUrl} target="_blank" rel="noopener noreferrer">Read source</a></> : null}</p><ul className="cdp-list">{data.officialPrizes.map(prize => <li key={prize.label} className="cdp-item cdp-official-prize"><h4>{prize.label}</h4><ul className="cdp-prize-benefits">{prize.amount.split(/\s+\*\s+/).map((benefit,index) => <li key={index}>{benefit}</li>)}</ul>{prize.quantity ? <p className="cdp-prize-condition">Number of awards: {prize.quantity}</p> : null}{prize.eligibility ? <p className="cdp-prize-condition">{prize.eligibility}</p> : null}</li>)}</ul></section> : null}
                                {digest ? <DigestSections digest={digest} section="prizes" officialPrizeLabels={(data?.officialPrizes ?? []).map(prize => prize.label)} /> : data?.officialPrizes?.length ? null : <p className="cdp-digest-gap">{digestLoading ? 'Reading prize details…' : 'No prize breakdown is available. Read the official event page.'}</p>}
                            </section>
                            <section role="tabpanel" id={`${tabId}-entry`} aria-labelledby={`${tabId}-entry-tab`} hidden={tab !== 'entry'}>
                            {keyDetails.entryNotes.length ? <section className="cdp-entry-summary"><h3>Conditions to check</h3><p className="cdp-section-note">From Caddie's summary — verify against the quoted rules.</p>{keyDetails.entryNotes.map((note,index) => <p key={index}>{note.value}</p>)}</section> : null}
                            {!canonicalCoversEntry ? props.entryEvidence : null}
                            {props.rulesUrl ? <a className="cdp-rules-source" href={props.rulesUrl} target="_blank" rel="noopener noreferrer">Official entry rules <Icon name="link" title="" /></a> : null}

							{/* Tier 2: verbatim rules grouped by kind. */}
							{(data?.groups.length ?? 0) > 0 ? (
								<div className="cdp-fine">
									<h3 className="cdp-section-title">Entry requirements</h3>
									<p className="cdp-entry-verdict" data-testid="contest-detail-verdict">{data?.eligibility.verdict === 'eligible' ? 'Your profile matches the requirements checked so far.' : data?.eligibility.verdict === 'ineligible' ? 'The checked rules exclude you from this event.' : 'Some entry requirements are still unconfirmed.'}</p>
									<p className="cdp-fine-sub">{data?.groups.filter(group => group.kind !== 'fit').length} checked {data?.groups.filter(group => group.kind !== 'fit').length === 1 ? 'category' : 'categories'}. Only recorded requirements appear here; read the official rules for the full entry conditions.</p>
									{(data?.groups ?? []).map((group) => (
										<details open key={group.kind} className="cdp-group" data-testid={`contest-detail-group-${group.kind}`}>
											<summary className="cdp-group-sum">
												<Icon name="chevronDown" title="Expand" className="cdp-group-chevron" />
												<span className="cdp-group-label">{group.label}</span>
												<span className="cdp-group-n">
													{group.claims.length} {group.claims.length === 1 ? 'quote' : 'quotes'}
												</span>
											</summary>
											<div className="cdp-claims">
												{group.claims.map((claim) => (
													<div key={claim.claimId} className="cdp-claim" data-verdict={claim.verdict}>
														<blockquote className="cdp-quote">“{claim.quote}”</blockquote>
														{claim.reason ? <details className="cdp-check-explanation"><summary>How this was checked</summary><p className="cdp-claim-reason">{claim.reason}</p></details> : null}
													</div>
												))}
											</div>
										</details>
									))}
								</div>
							) : data ? (
								<div className="cdp-unread" data-testid="contest-detail-unread">
									<p className="cdp-unread-title">Rules not read yet</p>
									<p className="cdp-unread-body">
										I haven&rsquo;t read this contest&rsquo;s official rules, so eligibility stays unknown — I never guess it. Run a
										check and I&rsquo;ll read the rules page and quote what decides it.
									</p>
									{props.onCheck ? (
										<button
											type="button"
											className="btn-key cdp-unread-btn"
											onClick={props.onCheck}
											disabled={props.checking || props.busy}
											data-testid="contest-detail-check"
										>
											{props.checking ? 'Checking…' : 'Check eligibility'}
										</button>
									) : null}
								</div>
							) : null}
                            </section>
						</>
				</div>

				<footer className="cdp-foot">
					{data ? (
						<a className="btn-ghost" href={data.candidate.url} target="_blank" rel="noreferrer noopener" data-testid="contest-detail-devpost">
							Official event page
							<Icon name="link" title="Official event page" />
						</a>
					) : null}
					{props.onSave ? (
						<button type="button" className="btn-ghost" onClick={props.onSave} disabled={props.busy}>
							{props.saved ? 'Saved' : 'Save'}
						</button>
					) : null}
					{props.onExplore ? (
						<button type="button" className="btn-key" onClick={props.onExplore} disabled={props.busy}>
							Find an idea
						</button>
					) : null}
				</footer>
			</aside>
		</div>
	);
}

/**
 * The "about the hackathon" sections under the summary: what Caddie thinks fits
 * you, the tracks, the prize breakdown, perks/credits and how it is judged. Each
 * section renders only when the page actually listed something — nothing is
 * filled in to look complete. "Good fit for you" is labelled as Caddie's
 * suggestion (an inference from your profile), never as a fact from the page.
 */
function DigestSections({ digest, section, officialPrizeLabels = [] }: { digest: CandidateDigest; section: 'overview' | 'build' | 'prizes'; officialPrizeLabels?: readonly string[] }): ReactElement | null {
	const fit = section === 'overview' ? digest.fitTracks ?? [] : [];
	const tracks = section === 'build' ? digest.tracks ?? [] : [];
	const prizeKey = (label: string) => label.trim().replace(/\s+/g,' ').toLowerCase();
    const officialLabels = new Set(officialPrizeLabels.map(prizeKey));
	const prizes = section === 'prizes' ? (digest.prizes ?? []).filter(prize => !officialLabels.has(prizeKey(prize.label))) : [];
	const perks = section === 'prizes' ? digest.perks ?? [] : [];
	const judging = section === 'build' ? digest.judging ?? [] : [];
	if (fit.length + tracks.length + prizes.length + perks.length + judging.length === 0) return section === 'overview' || officialPrizeLabels.length > 0 ? null : <p className="cdp-digest-gap">{section === 'build' ? 'No tracks or judging criteria were listed in the summary.' : 'No prize breakdown or perks were listed in the summary.'} Check the official event page.</p>;
	const fitNames = new Set((digest.fitTracks ?? []).map((f) => f.name.toLowerCase()));
	return (
		<div className="cdp-sections" data-testid={`contest-detail-sections-${section}`}>
			{fit.length > 0 ? (
				<section className="cdp-section cdp-section--fit" data-testid="contest-detail-fit">
					<h4 className="cdp-section-title">
						Good fit for you
						<span className="cdp-section-note">Caddie's suggestion, from your profile</span>
					</h4>
					<ul className="cdp-list">
						{fit.map((f) => (
							<li key={f.name} className="cdp-item">
								<span className="cdp-item-name">{f.name}</span>
								{f.why ? <span className="cdp-item-detail">{f.why}</span> : null}
							</li>
						))}
					</ul>
				</section>
			) : null}
			{tracks.length > 0 ? (
				<section className="cdp-section cdp-secondary" data-testid="contest-detail-tracks">
					<h3 className="cdp-section-title">Tracks</h3>
					<ul className="cdp-list">
						{tracks.map((t) => (
							<li key={t.name} className="cdp-item" data-fit={fitNames.has(t.name.toLowerCase()) ? 'true' : undefined}>
								<span className="cdp-item-name">{t.name}</span>
								{t.detail ? <span className="cdp-item-detail">{t.detail}</span> : null}
							</li>
						))}
					</ul>
				</section>
			) : null}
			{prizes.length > 0 ? (
				<div className="cdp-section cdp-secondary" data-testid="contest-detail-prizes">{officialPrizeLabels.length ? <details className="cdp-unmatched-prizes"><summary>Other awards mentioned in the summary</summary><p className="cdp-section-note">Not matched to the official table — verify on the event page.</p><ul className="cdp-list">{prizes.map((prize,index) => <li key={index} className="cdp-item"><span className="cdp-item-name">{prize.label}</span><span className="cdp-item-amount">{prize.amount}</span></li>)}</ul></details> : <>
					<h3 className="cdp-section-title">{officialPrizeLabels.length ? 'Other awards from the summary' : 'Prizes'}</h3>
                    {officialPrizeLabels.length ? <p className="cdp-section-note">Not matched to the official table — verify on the event page.</p> : null}
					<ul className="cdp-list">
						{prizes.map((p, i) => (
							<li key={`${p.label}-${i}`} className="cdp-item cdp-item--row">
								<span className="cdp-item-name">{p.label || 'Prize'}</span>
								{p.amount ? <span className="cdp-item-amount">{p.amount}</span> : null}
							</li>
						))}
					</ul>
				</>}</div>
			) : null}
			{perks.length > 0 ? (
				<section className="cdp-section cdp-secondary" data-testid="contest-detail-perks">
					<h3 className="cdp-section-title">Credits and perks</h3>
					<ul className="cdp-list">
						{perks.map((perk) => (
							<li key={perk} className="cdp-item">
								<span className="cdp-item-detail">{perk}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
			{judging.length > 0 ? (
				<section className="cdp-section cdp-secondary" data-testid="contest-detail-judging">
					<h3 className="cdp-section-title">How it's judged</h3>
					<ul className="cdp-list">
						{judging.map((j) => (
							<li key={j} className="cdp-item">
								<span className="cdp-item-detail">{j}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}
