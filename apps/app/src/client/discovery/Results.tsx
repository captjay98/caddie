import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { HackathonCandidate, HackathonResultsCard } from '@caddie/contracts';
import { StatePanel } from '../states.tsx';
import { countryName, countryFlag } from '../country.ts';
import { Icon } from '../icons.tsx';
import { EligibilityChip, RuleQuote } from '../conversation/HackathonResultsCard.tsx';
import { ContestDetailPane } from './ContestDetailPane.tsx';
import { eligibilityView, metaParts, deadline } from '../conversation/hackathon-format.ts';

/**
 * Discover — the account's hackathon list. It shows the SAME ranked, filtered,
 * rules-checked events as the chat card (the server builds both from one
 * pipeline, discoverForActor), one dense row per event: title, the facts a
 * builder decides on (organiser, format, dates, prize, entries, themes), a
 * short eligibility chip, Save and Find an idea.
 *
 * Honesty rules rendered into the UI (feature-ledger F10, packets P11):
 *   - PARTIAL FEED FAILURE IS VISIBLE: failed sources appear as named gaps
 *     with their failure reason — never silently dropped.
 *   - Eligibility is the strict engine verdict. "Not checked" means no rules
 *     page has been read yet (never "probably fine"); a hard-ineligible event
 *     is hidden behind a named reveal, never relabelled. The verbatim rule
 *     behind a verdict is one click away, linked to the official rules page.
 *   - Fit claims keep their evidence claim ids or recorded assumptions.
 *   - A field the source does not carry is omitted, never invented.
 *   - The first fetch renders a loading state, never a blank page.
 */

export interface DiscoveryCandidateRecord {
	id: string;
	url: string;
	title: string;
	summary: string;
	source: string;
	status: 'new' | 'accepted' | 'dismissed';
	/** B01: the saved bookmark — its own axis, never the acceptance status. */
	savedAt?: string | null;
	firstSeenAt: string;
}

export interface DiscoveryFitClaim {
	requirement: string;
	claimType: string;
	verdict: 'supported' | 'conflict' | 'unmatched' | 'unknown';
	statement: string;
	evidenceClaimIds: readonly string[];
	assumptions: readonly string[];
}

export interface DiscoveryEvaluation {
	candidate: DiscoveryCandidateRecord;
	fit: {
		matchedRequirements: number;
		claims: readonly DiscoveryFitClaim[];
	};
	eligibility: {
		verdict: 'eligible' | 'ineligible' | 'unknown';
		rules: readonly { claimType: string; verdict: string; basis: string; reason: string }[];
	};
}

export interface DiscoveryEvaluatedList {
	evaluations: readonly DiscoveryEvaluation[];
	ranked: readonly { candidateId: string; matchedRequirements: number; verdict: string }[];
	profileCountry: string | null;
	/** The ranked, filtered, rules-checked view the chat card also renders. */
	card?: HackathonResultsCard;
}

export interface DiscoveryFeedRecord {
	id: string;
	requestedAt: string;
	sources: readonly {
		source: string;
		outcome: 'succeeded' | 'failed';
		failureReason: string | null;
		candidateCount: number;
	}[];
}

/** Rows shown before "Show N more". */
const FIRST_PAGE = 12;

/** Plain words for a fit claim Caddie could not confirm (shown with its recorded assumption). */
const OPEN_CLAIM_WORDS: Record<Exclude<DiscoveryFitClaim['verdict'], 'supported'>, string> = {
	unknown: 'no rule on record yet',
	conflict: 'the sources disagree',
	unmatched: 'not met',
};

function classifyFailure(status: number, message: string): string {
	if (status === 401 || status === 403) return `Denied: ${message}`;
	return message || `Request failed (${status})`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, { credentials: 'same-origin', ...init });
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
		throw new Error(classifyFailure(response.status, body.message ?? body.error ?? ''));
	}
	return (await response.json()) as T;
}

function when(iso: string | null): string {
	if (!iso) return 'never';
	const date = new Date(iso);
	return Number.isFinite(date.getTime())
		? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
		: 'unknown';
}

/** A row for a stored candidate the ranked card does not carry (an older reader, or a saved event no longer listed). */
function rowFromEvaluation(evaluation: DiscoveryEvaluation): HackathonCandidate {
	const { candidate, eligibility } = evaluation;
	return {
		id: candidate.id,
		title: candidate.title,
		url: candidate.url,
		platform: null,
		summary: candidate.summary,
		startsAt: null,
		prize: null,
		endsAt: null,
		deadline: null,
		participants: null,
		format: null,
		organizer: null,
		themes: [],
		topPick: false,
		eligibility: eligibility.verdict,
		eligibilityNote: '',
		eligibilityQuote: null,
		eligibilityNeedsConfirm: false,
		rulesUrl: null,
		openStatusUnverified: false,
		saved: Boolean(candidate.savedAt),
		aiFit: 'unknown',
		aiFitReason: '',
		aiFitConfidence: null,
	};
}

function FitEvidence({ claims, candidateId }: { claims: readonly DiscoveryFitClaim[]; candidateId: string }): ReactElement | null {
 const fitClaims = claims.filter(claim => claim.verdict === 'supported');
 const openClaims = claims.filter((claim): claim is DiscoveryFitClaim & { verdict: keyof typeof OPEN_CLAIM_WORDS } => claim.verdict !== 'supported');
 return <>{fitClaims.length > 0 || openClaims.length > 0 ? (
												<details className="hk-why" data-testid={`disc-fit-${candidateId}`}>
													<summary>{fitClaims.length > 0 ? 'Why it fits' : 'Not confirmed yet'}</summary>
													{fitClaims.map((claim) => (
														<div key={`${claim.claimType}:${claim.requirement}`} className="disc-claim">
															<div className="disc-claim-line">{claim.statement}</div>
															{claim.evidenceClaimIds.length > 0 ? (
																<div className="disc-claim-evidence">
																	evidence:{' '}
																	{claim.evidenceClaimIds.map((id) => (
																		<code key={id}>{id}</code>
																	))}
																</div>
															) : null}
															{claim.assumptions.map((assumption) => (
																<div key={assumption} className="disc-assumption">
																	Assumption: {assumption}
																</div>
															))}
														</div>
													))}
													{openClaims.length > 0 ? (
														<div className="disc-open-claims" data-testid={`disc-open-claims-${candidateId}`}>
															{fitClaims.length > 0 ? <p className="disc-open-title">Not confirmed yet</p> : null}
															{openClaims.map((claim) => (
																<div key={`${claim.claimType}:${claim.requirement}`} className="disc-claim" data-verdict={claim.verdict}>
																	<div className="disc-claim-line">
																		{claim.requirement} <span className="disc-claim-status">· {OPEN_CLAIM_WORDS[claim.verdict]}</span>
																	</div>
																	{claim.evidenceClaimIds.length > 0 ? (
																		<div className="disc-claim-evidence">
																			evidence:{' '}
																			{claim.evidenceClaimIds.map((id) => (
																				<code key={id}>{id}</code>
																			))}
																		</div>
																	) : null}
																	{claim.assumptions.map((assumption) => (
																		<div key={assumption} className="disc-assumption">
																			Assumption: {assumption}
																		</div>
																	))}
																</div>
															))}
														</div>
													) : null}
												</details>
											) : null}</>;
}

export function DiscoveryResults(props: {
	projectId: string;
	apiBase?: string;
	/**
	 * Account-level Discover hands off an opportunity to a real project. When
	 * present, each event's PRIMARY action is "Find an idea" (onExplore —
	 * create or continue a project) and the secondary action is Save. Without
	 * it the surface keeps its project-scoped "Accept" behaviour.
	 */
	onExplore?: (candidate: DiscoveryCandidateRecord) => void;
	exploreBusy?: boolean;
}): ReactElement {
	const { projectId, apiBase = '', onExplore, exploreBusy } = props;
	const [list, setList] = useState<DiscoveryEvaluatedList | null>(null);
	const [latestFeed, setLatestFeed] = useState<DiscoveryFeedRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [view, setView] = useState<'forYou' | 'saved'>('forYou');
	const [canEnterOnly, setCanEnterOnly] = useState(false);
	const [onlineOnly, setOnlineOnly] = useState(false);
	const [filtersOpen, setFiltersOpen] = useState(false);
	const [showIneligible, setShowIneligible] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const [detailId, setDetailId] = useState<string | null>(null);
	const [checkingId, setCheckingId] = useState<string | null>(null);

	const base = `${apiBase}/api/projects/${encodeURIComponent(projectId)}/discovery`;

	async function load() {
		setBusy(true);
		setError(null);
		try {
			const [evaluated, feed] = await Promise.all([
				fetchJson<DiscoveryEvaluatedList>(`${base}/candidates?evaluate=1`),
				fetchJson<{ runs: DiscoveryFeedRecord[] }>(`${base}/feed`),
			]);
			setList(evaluated);
			setLatestFeed(feed.runs[0] ?? null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	/** Run one action, then re-read the list; an error stays visible. */
	async function act(request: () => Promise<unknown>) {
		setBusy(true);
		setError(null);
		try {
			await request();
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	const runFeed = () => act(() => fetchJson(`${base}/feed`, { method: 'POST' }));
	const toggleSaved = (candidateId: string, save: boolean) =>
		act(() => fetchJson(`${base}/candidates/${encodeURIComponent(candidateId)}/save`, { method: save ? 'POST' : 'DELETE' }));
	const accept = (candidateId: string) =>
		act(() => fetchJson(`${base}/candidates/${encodeURIComponent(candidateId)}/accept`, { method: 'POST' }));
	/** On-demand read of ONE candidate's rules, then refresh the list. */
	async function checkEligibility(candidateId: string) {
		setCheckingId(candidateId);
		try {
			await fetchJson(`${base}/candidates/${encodeURIComponent(candidateId)}/check-eligibility`, { method: 'POST' });
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setCheckingId(null);
		}
	}

	useEffect(() => {
		setList(null);
		setLatestFeed(null);
		void load();
	}, [projectId]);

	const evaluations = new Map((list?.evaluations ?? []).map((e) => [e.candidate.id, e]));
	const isSaved = (row: HackathonCandidate) => {
		const stored = evaluations.get(row.id)?.candidate.savedAt;
		return stored === undefined ? row.saved : Boolean(stored);
	};
	// The ranked card is the list; without one (an older server), fall back to
	// the stored evaluations in their ranked order.
	const ranked: HackathonCandidate[] = list?.card
		? [...list.card.candidates]
		: (list?.ranked ?? []).flatMap((entry) => {
				const evaluation = evaluations.get(entry.candidateId);
				return evaluation ? [rowFromEvaluation(evaluation)] : [];
			});
	const rankedIds = new Set(ranked.map((row) => row.id));
	// A saved event stays reachable under Saved even after it left the ranking.
	const savedOutsideRanking = (list?.evaluations ?? [])
		.filter((e) => e.candidate.savedAt && !rankedIds.has(e.candidate.id))
		.map(rowFromEvaluation);
	const pool = view === 'saved' ? [...ranked, ...savedOutsideRanking].filter(isSaved) : ranked;
	const afterFilters = pool.filter((row) => {
		if (canEnterOnly && row.eligibility !== 'eligible') return false;
		if (onlineOnly && row.format !== 'online') return false;
		return true;
	});
	const visible = showIneligible ? afterFilters : afterFilters.filter((row) => row.eligibility !== 'ineligible');
	const hiddenIneligible = afterFilters.length - visible.length;
	const shown = showAll ? visible : visible.slice(0, FIRST_PAGE);
	const savedCount = [...ranked, ...savedOutsideRanking].filter(isSaved).length;
	const failedSources = (latestFeed?.sources ?? []).filter((s) => s.outcome === 'failed');
	const profileCountry = list?.card?.profileCountry ?? list?.profileCountry ?? null;
	const hasAny = ranked.length > 0 || savedOutsideRanking.length > 0;

	function exploreRecord(row: HackathonCandidate): DiscoveryCandidateRecord {
		return (
			evaluations.get(row.id)?.candidate ?? {
				id: row.id,
				url: row.url,
				title: row.title,
				summary: row.summary,
				source: row.platform ?? 'web',
				status: 'new',
				savedAt: null,
				firstSeenAt: '',
			}
		);
	}

	return (
		<section aria-label="Discovery results" className="discovery-panel" data-testid="discovery-results">
			{hasAny ? (
				<div className="disc-toolbar">
					<span className="disc-seg" role="group" aria-label="Which events" data-testid="discovery-view">
						<button type="button" aria-pressed={view === 'forYou'} data-testid="discovery-view-foryou" onClick={() => setView('forYou')}>
							Best for you <span className="seg-count">{ranked.length}</span>
						</button>
						<button type="button" aria-pressed={view === 'saved'} data-testid="discovery-view-saved" onClick={() => setView('saved')}>
							Saved <span className="seg-count">{savedCount}</span>
						</button>
					</span>
					<div className="disc-filterline">
						<span className="disc-country-chip" data-testid="discovery-country">
							{profileCountry ? `${countryFlag(profileCountry)} ${countryName(profileCountry)}` : 'Set your country for entry checks'}
							{onlineOnly ? ' · Online' : ''}{canEnterOnly ? ' · Can enter' : ''}
						</span>
						<button type="button" className="btn-ghost disc-filter-toggle" data-testid="discovery-filter-toggle" aria-expanded={filtersOpen} aria-controls="discover-filters" onClick={() => setFiltersOpen(value => !value)}>
							<Icon name="settings" title="" /> Filters{canEnterOnly || onlineOnly ? ` · ${Number(canEnterOnly) + Number(onlineOnly)}` : ''}
						</button>
					</div>
					<div id="discover-filters" className="disc-filter-chips" data-testid="discovery-filters" hidden={!filtersOpen}>
						<label className="disc-filter-option"><input type="checkbox" className="disc-filter" data-testid="discovery-filter-canenter" checked={canEnterOnly} onChange={event => setCanEnterOnly(event.target.checked)} />Can enter only</label>
						<label className="disc-filter-option"><input type="checkbox" className="disc-filter" data-testid="discovery-filter-online" checked={onlineOnly} onChange={event => setOnlineOnly(event.target.checked)} />Online only</label>
						<p className="disc-filter-help">{profileCountry ? `Entry checks use your profile country: ${countryName(profileCountry)}. Each event shows its own verdict.` : 'Country-based eligibility stays unknown until you set your profile country.'}</p>
						<button type="button" className="btn-key disc-filters-apply" onClick={() => setFiltersOpen(false)}>Show opportunities</button>
					</div>
					<button type="button" className="btn-ghost disc-refresh" onClick={() => void runFeed()} disabled={busy} data-testid="discovery-sweep" aria-label={busy ? 'Checking opportunities' : 'Check again'}>
						<Icon name="refresh" title="" /><span>{busy ? 'Checking…' : 'Check again'}</span>
					</button>
				</div>
			) : null}

			{error ? (
				<div role="alert" className="sign-in-error disc-error" data-testid="discovery-error">
					<b>The list could not be read.</b>
					<span> {error}</span>
					<button type="button" className="btn-ghost" onClick={() => void load()}>
						Retry
					</button>
				</div>
			) : null}

			{/* Partial feed failure is a visible, named gap — never silently dropped. */}
			{failedSources.length > 0 ? (
				<div role="status" className="disc-gaps" data-testid="feed-gaps">
					<strong>Some sources failed</strong> (last check {when(latestFeed?.requestedAt ?? null)}):
					<ul>
						{failedSources.map((s) => (
							<li key={s.source}>
								<code>{s.source}</code> failed — {s.failureReason ?? 'unknown reason'}; its events are missing from this list.
							</li>
						))}
					</ul>
				</div>
			) : null}

			{!hasAny ? (
				list ? (
					<div className="disc-empty" data-testid="discovery-empty">
						<span className="disc-empty-icon" aria-hidden="true">
							<Icon name="search" title="" />
						</span>
						<h3>Let's see what's out there</h3>
						<p className="disc-empty-lede">
							Caddie reads every open Devpost contest plus events on Devfolio, HackerEarth, DoraHacks, ETHGlobal and
							Kaggle, checks the top ones' entry rules, and ranks them for you. Nothing here starts a build until you
							say so.
						</p>
						<button type="button" className="btn-key" onClick={() => void runFeed()} disabled={busy} data-testid="discovery-sweep-empty">
							{busy ? 'Checking…' : 'Find hackathons for me'}
						</button>
					</div>
				) : (
					<StatePanel kind="loading" title="Reading the list…" />
				)
			) : visible.length === 0 ? (
				<div data-testid="discovery-filter-empty">
					<StatePanel
						kind="empty"
						title={view === 'saved' && savedCount === 0 ? 'Nothing saved yet' : 'Nothing matches these filters'}
						detail={view === 'saved' && savedCount === 0 ? 'Save an event to keep it here.' : 'Clear a filter, or check again for new events.'}
					/>
					{hiddenIneligible > 0 ? (
						<button
							type="button"
							className="disc-link"
							data-testid="discovery-reveal-ineligible"
							aria-pressed={false}
							onClick={() => setShowIneligible(true)}
						>
							Show {hiddenIneligible} you can't enter
						</button>
					) : null}
				</div>
			) : (
				<>
					<ul className="disc-list">
						{shown.map((row) => {
							const saved = isSaved(row);
							const status = evaluations.get(row.id)?.candidate.status ?? 'new';
							const facts = metaParts(row);
							const end = deadline(row);
							const primaryFacts = [...(end ? [{ key: 'deadline', label: 'Due', value: end }] : []), ...facts.filter(part => part.key === 'prize')];
							const host = row.organizer ?? facts.find(part => part.key === 'host')?.value;
							const eligibility = eligibilityView(row);
                            return (
                                <li key={row.id} className="disc-row" data-testid={`disc-row-${row.id}`} onClick={event => {
                                    if ((event.target as Element).closest('button, a, input, summary, details') || window.getSelection()?.toString()) return;
                                    setDetailId(row.id);
                                }}>
                                    <div className="disc-card-top">
                                        <p className="disc-event-host">{host ?? 'Hackathon'}</p>
                                        <div className="disc-entry-status">{eligibility.state === 'unknown' ? (
												<button
													type="button"
													className="hk-chip hk-chip-check"
													data-testid={`check-eligibility-chip-${row.id}`}
													onClick={() => void checkEligibility(row.id)}
													disabled={checkingId === row.id || busy}
													title="Read this contest's rules now to check if you can enter"
												>
													{checkingId === row.id ? 'Checking…' : 'Not checked ↻'}
												</button>
											) : (
												<EligibilityChip view={eligibility} compact testId={`eligibility-${row.id}`} />
											)}</div>
                                    </div>
                                    <button type="button" className="disc-row-title disc-row-title--btn" onClick={() => setDetailId(row.id)} title={`Open details for ${row.title}`} data-testid={`disc-open-${row.id}`}>{row.title}</button>
                                    <div className="disc-card-footer">
                                        <div className="disc-card-meta">
                                            {primaryFacts.length > 0 ? <ul className="disc-facts" data-testid={`disc-facts-${row.id}`}>{primaryFacts.map(part => <li key={part.key} className="disc-fact" data-fact={part.key}><span className="disc-fact-label">{part.label}</span><span className="disc-fact-value">{part.value}</span></li>)}</ul> : null}
                                            <span className="disc-format">{facts.find(part => part.key === 'format')?.value}{row.openStatusUnverified ? ' · Open status unverified' : ''}</span>
                                        </div>
                                        {onExplore ? <button type="button" className="btn-ghost disc-bookmark" data-testid={`${saved ? 'unsave' : 'save'}-candidate-${row.id}`} onClick={() => void toggleSaved(row.id, !saved)} disabled={busy} aria-pressed={saved} aria-label={saved ? `Remove ${row.title} from saved` : `Save ${row.title}`}><Icon name="bookmark" title="" /></button> : status === 'new' ? <button type="button" className="btn-key" onClick={() => void accept(row.id)} disabled={busy}>Accept</button> : null}
                                    </div>
                                </li>
                            );
						})}
					</ul>
					<div className="disc-list-foot">
						{!showAll && visible.length > FIRST_PAGE ? (
							<button type="button" className="disc-link" data-testid="discovery-show-more" onClick={() => setShowAll(true)}>
								Show {visible.length - FIRST_PAGE} more
							</button>
						) : null}
						{hiddenIneligible > 0 ? (
							<button
								type="button"
								className="disc-link"
								data-testid="discovery-reveal-ineligible"
								aria-pressed={showIneligible}
								onClick={() => setShowIneligible((value) => !value)}
							>
								{showIneligible ? 'Hide' : 'Show'} {hiddenIneligible} you can't enter
							</button>
						) : null}
					</div>
				</>
			)}
			{detailId ? (
				(() => {
					const detailRow = visible.find((r) => r.id === detailId) ?? shown.find((r) => r.id === detailId);
					return (
						<ContestDetailPane
							projectId={projectId}
							candidateId={detailId}
							apiBase={apiBase}
							onClose={() => setDetailId(null)}
							metaParts={detailRow ? metaParts(detailRow).map(part => part.key === 'host' && detailRow.organizer ? {...part,value:detailRow.organizer} : part.key === 'themes' ? {...part,value:detailRow.themes.join(', ')} : part) : null}
                            overviewEvidence={<FitEvidence candidateId={detailId} claims={evaluations.get(detailId)?.fit.claims ?? []} />}
                            sourceSummary={detailRow?.summary}
                            entryQuote={detailRow?.eligibilityQuote}
                            rulesUrl={detailRow?.rulesUrl}
                            entryEvidence={detailRow ? <RuleQuote candidate={detailRow} view={eligibilityView(detailRow)} /> : null}
							deadline={detailRow ? deadline(detailRow) : null}
							autoCheckOnOpen
							saved={detailRow ? isSaved(detailRow) : false}
							busy={busy}
							checking={checkingId === detailId}
							onCheck={() => void checkEligibility(detailId)}
							onSave={detailRow ? () => void toggleSaved(detailRow.id, !isSaved(detailRow)) : undefined}
							onExplore={detailRow && onExplore ? () => { setDetailId(null); onExplore(exploreRecord(detailRow)); } : undefined}
						/>
					);
				})()
			) : null}
		</section>
	);
}
