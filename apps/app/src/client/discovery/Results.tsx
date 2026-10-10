import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { StatePanel } from '../states.tsx';

/**
 * P11 discovery results (slice 3) — candidate list reading the REAL P11
 * routes, rebuilt on the shared class system (UI review board screen 13: the
 * shipped file carried 17 hex literals and 25 inline style attributes with
 * zero className references, so the eligibility verdict — the word the whole
 * product exists to state honestly — was unreadable at 1.01–1.11:1 on the
 * dark theme).
 *
 * Honesty rules rendered into the UI (feature-ledger F10, packets P11):
 *   - PARTIAL FEED FAILURE IS VISIBLE: failed sources appear as named gaps
 *     with their failure reason — never silently dropped.
 *   - Every fit claim shows the P10 evidence claim ids it rests on, or its
 *     recorded assumption — nothing invented.
 *   - Eligibility verdicts are conservative: unknown is shown as UNKNOWN
 *     (never as "probably fine"), and a hard-ineligible candidate is labeled
 *     ineligible — ranking demotes it but never relabels it. The badge owns
 *     BOTH its tint and its text colour, so the verdict reads on any theme.
 *   - matchedRequirements is a crude heuristic count, never a win probability.
 *   - the first fetch renders a loading state, never a blank page.
 */

export interface DiscoveryCandidateRecord {
	id: string;
	url: string;
	title: string;
	summary: string;
	source: string;
	status: 'new' | 'accepted' | 'dismissed';
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

type FailureKind = 'denied' | 'limit' | 'offline' | 'error';

function classifyFailure(status: number, message: string): string {
	const kind: FailureKind =
		status === 401 || status === 403 ? 'denied' : status === 429 ? 'limit' : 'error';
	return kind === 'denied' ? `Denied: ${message}` : message || `Request failed (${status})`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, { credentials: 'same-origin', ...init });
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
		throw new Error(classifyFailure(response.status, body.message ?? body.error ?? ''));
	}
	return (await response.json()) as T;
}

function verdictLabel(verdict: string): string {
	// v2 plain words (§6): Eligibility → "Can you enter?" — the badge answers it.
	if (verdict === 'eligible') return 'You can enter';
	if (verdict === 'ineligible') return "Can't enter";
	return "Can't tell yet";
}

/** UNKNOWN reads as an absence of evidence — never a weak negative. */
function verdictTone(verdict: string): 'ok' | 'danger' | 'neutral' {
	if (verdict === 'eligible') return 'ok';
	if (verdict === 'ineligible') return 'danger';
	return 'neutral';
}

function when(iso: string | null): string {
	if (!iso) return 'never';
	const date = new Date(iso);
	return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
}

export function DiscoveryResults(props: {
	projectId: string;
	apiBase?: string;
	/**
	 * Account-level Discover hands off an opportunity to a real project. When
	 * present, each new candidate's PRIMARY action is "Explore ideas for this
	 * hackathon" (calls onExplore — create or continue a project) and the
	 * secondary action is "Save" (the scoped accept). Without it the surface
	 * keeps its original project-scoped "Accept" behaviour. The callback owns the
	 * navigation + duplicate-continue logic; this component only renders it.
	 */
	onExplore?: (candidate: DiscoveryCandidateRecord) => void;
	exploreBusy?: boolean;
}): ReactElement {
	const { projectId, apiBase = '', onExplore, exploreBusy } = props;
	const [list, setList] = useState<DiscoveryEvaluatedList | null>(null);
	const [latestFeed, setLatestFeed] = useState<DiscoveryFeedRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

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

	async function runFeed() {
		setBusy(true);
		setError(null);
		try {
			await fetchJson<{ feed: DiscoveryFeedRecord }>(`${base}/feed`, { method: 'POST' });
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	async function accept(candidateId: string) {
		setBusy(true);
		setError(null);
		try {
			await fetchJson(`${base}/candidates/${encodeURIComponent(candidateId)}/accept`, { method: 'POST' });
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	useEffect(() => {
		setList(null);
		setLatestFeed(null);
		void load();
	}, [projectId]);

	const ranked = list?.ranked ?? [];
	const byId = new Map((list?.evaluations ?? []).map((e) => [e.candidate.id, e]));
	const failedSources = (latestFeed?.sources ?? []).filter((s) => s.outcome === 'failed');

	// v2 Discover (HANDOFF §4): ONE list, no search, no sort. Two real filters
	// only — "Can enter" (eligible-only) and the "can't enter" reveal. The
	// prototype's date/prize filters need feed data the sources don't carry yet
	// (no closes-at or prize field on a candidate), so they stay unrendered
	// rather than faked. "Saved" as its own segment lands with B01 (saved vs.
	// accepted are the same flag today); until then Save keeps its current
	// accept semantics and no Saved segment is shown.
	const [canEnterOnly, setCanEnterOnly] = useState(false);
	const [showIneligible, setShowIneligible] = useState(false);
	const [expanded, setExpanded] = useState<string | null>(null);
	const visible = ranked.filter((entry) => {
		const evaluation = byId.get(entry.candidateId);
		if (!evaluation) return true;
		if (canEnterOnly && evaluation.eligibility.verdict !== 'eligible') return false;
		if (!showIneligible && evaluation.eligibility.verdict === 'ineligible') return false;
		return true;
	});
	const hiddenIneligible = ranked.length - visible.length;

	return (
		<section aria-label="Discovery results" className="discovery-panel" data-testid="discovery-results">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						FIND
					</p>
					<h2 className="ev-title">Hackathons that fit you</h2>
					<p className="page-lede">
						Ranked only on what Caddie could actually read. Opening one shows whether you can enter and
						what you'd hand in.
					</p>
				</div>
				<span className="disc-actions">
					<button type="button" className="btn-key" onClick={() => void runFeed()} disabled={busy}>
						{busy ? 'Checking…' : 'Check for new contests'}
					</button>
				</span>
			</div>

			{error ? (
				<div role="alert" className="sign-in-error disc-error" data-testid="discovery-error">
					<b>The sweep could not be read.</b>
					<span> {error}</span>
					<button type="button" className="btn-ghost" onClick={() => void load()}>
						Retry
					</button>
				</div>
			) : null}

			{/* Partial feed failure is a visible, named gap — never silently dropped. */}
			{failedSources.length > 0 ? (
				<div role="status" className="disc-gaps" data-testid="feed-gaps">
					<strong>Feed gaps</strong> (last run {when(latestFeed?.requestedAt ?? null)}):
					<ul>
						{failedSources.map((s) => (
							<li key={s.source}>
								<code>{s.source}</code> failed — {s.failureReason ?? 'unknown reason'}; its candidates are
								missing from this list.
							</li>
						))}
					</ul>
				</div>
			) : null}

			<p className="state-detail">
				Whether you can enter is judged with your profile country:{' '}
				{list?.profileCountry ?? 'none recorded — country rules stay UNKNOWN'}.
			</p>

			{ranked.length > 0 ? (
				<div className="disc-filters" data-testid="discovery-filters">
					<button
						type="button"
						className="detail-toggle"
						data-testid="discovery-filter-canenter"
						aria-pressed={canEnterOnly}
						onClick={() => setCanEnterOnly((value) => !value)}
					>
						Can enter
					</button>
					{hiddenIneligible > 0 ? (
						<button
							type="button"
							className="detail-toggle"
							data-testid="discovery-reveal-ineligible"
							aria-pressed={showIneligible}
							onClick={() => setShowIneligible((value) => !value)}
						>
							{showIneligible ? 'Hide' : 'Show'} {hiddenIneligible} you can't enter
						</button>
					) : null}
				</div>
			) : null}

			{ranked.length === 0 ? (
				list ? (
					<StatePanel
						kind="empty"
						title="Nothing has been read, so nothing is ranked"
						detail="No candidates yet — run the feed. A sweep reads the sources this project watches and ranks only what it could actually read; until one runs this pane stays empty on purpose rather than guessing."
					/>
				) : (
					<StatePanel kind="loading" title="Reading the feeds…" />
				)
			) : visible.length === 0 ? (
				<div data-testid="discovery-filter-empty">
					<StatePanel
						kind="empty"
						title="Nothing matches these filters"
						detail="Everything in the loaded feed is filtered out. Clear a filter, or check for new contests."
					/>
				</div>
			) : (
				<ul className="disc-list">
					{visible.map((entry) => {
						const evaluation = byId.get(entry.candidateId);
						if (!evaluation) return null;
						const { candidate, fit, eligibility } = evaluation;
						const open = expanded === candidate.id;
						// One reason it fits (§4): the first evidenced claim's statement,
						// or the honest requirement count when nothing was evidenced.
						const fitReason =
							fit.claims.find((claim) => claim.verdict === 'supported')?.statement ??
							`${fit.matchedRequirements} requirement(s) evidenced`;
						const canYouEnter =
							eligibility.verdict === 'eligible'
								? 'You can enter.'
								: eligibility.verdict === 'ineligible'
									? "You can't enter."
									: "Can't tell yet — the rules on record don't cover it.";
						return (
							<li key={candidate.id} className="disc-item">
								<div className="disc-head">
									<strong>{candidate.title}</strong>
									<span className="badge" data-tone={verdictTone(eligibility.verdict)} data-testid={`eligibility-${candidate.id}`}>
										{verdictLabel(eligibility.verdict)}
									</span>
								</div>
								<div className="disc-summary">{fitReason}</div>
								<div className="disc-meta">
									<a href={candidate.url} rel="noreferrer noopener" target="_blank">
										{candidate.url}
									</a>{' '}
									· source {candidate.source}
									{candidate.status === 'accepted' ? ' · saved' : ''}
								</div>
								<div className="row-actions">
									{candidate.status === 'new' || candidate.status === 'accepted' ? (
										onExplore ? (
											<>
												<button
													type="button"
													className="btn-key"
													data-testid={`explore-ideas-${candidate.id}`}
													onClick={() => onExplore(candidate)}
													disabled={exploreBusy}
												>
													{exploreBusy ? 'Opening…' : 'Find an idea'}
												</button>{' '}
												{candidate.status === 'new' ? (
													<button
														type="button"
														className="btn-ghost"
														data-testid={`save-candidate-${candidate.id}`}
														onClick={() => void accept(candidate.id)}
														disabled={busy}
													>
														Save
													</button>
												) : (
													<span className="state-chip" data-testid={`saved-candidate-${candidate.id}`}>
														Saved
													</span>
												)}
											</>
										) : (
											<button type="button" className="btn-key" onClick={() => void accept(candidate.id)} disabled={busy}>
												Accept
											</button>
										)
									) : null}
									<button type="button" className="btn-ghost" onClick={() => setExpanded(open ? null : candidate.id)}>
										{open ? 'Hide details' : 'Can you enter?'}
									</button>
								</div>
								{open ? (
									<div className="disc-detail" data-testid={`disc-detail-${candidate.id}`}>
										<p className="disc-verdict-line" data-testid={`disc-canenter-${candidate.id}`}>
											<strong>{canYouEnter}</strong>{' '}
											{eligibility.rules.length > 0
												? `Based on ${eligibility.rules.length} quoted rule(s) on record.`
												: 'No quoted eligibility rules on record, so this stays UNKNOWN — never assumed eligible.'}
										</p>
										{fit.claims.length === 0 ? (
											<p className="state-detail">No evidence-mapped requirements for this candidate.</p>
										) : (
											fit.claims.map((claim) => (
												<div key={`${claim.claimType}:${claim.requirement}`} className="disc-claim">
													<div className="disc-claim-line">
														<strong>{claim.verdict.toUpperCase()}</strong> — {claim.statement}
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
															assumption: {assumption}
														</div>
													))}
												</div>
											))
										)}
										{eligibility.rules.map((rule) => (
											<div key={`${rule.claimType}:${rule.reason}`} className="disc-rules">
												<code>{rule.claimType}</code> → {rule.verdict} ({rule.basis}): {rule.reason}
											</div>
										))}
										{/* "What you'll hand in" needs deliverable data the feed does
										    not carry yet — stated honestly, never invented. */}
										<p className="state-detail">What you'll hand in isn't in this feed yet — check the contest page for its full requirements.</p>
									</div>
								) : null}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
