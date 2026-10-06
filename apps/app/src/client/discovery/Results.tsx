import { useEffect, useState } from 'react';

/**
 * P11 discovery results (slice 3) — candidate list reading the REAL P11
 * routes. Workspace-shell integration is P06's; like the P10 evidence drawer
 * this component is deliberately mounted NOWHERE yet (it is exercisable
 * through the fixture routes and can be embedded under a project route later).
 *
 * Honesty rules rendered into the UI (feature-ledger C10, packets P11):
 *   - PARTIAL FEED FAILURE IS VISIBLE: failed sources appear as named gaps
 *     with their failure reason — never silently dropped.
 *   - Every fit claim shows the P10 evidence claim ids it rests on, or its
 *     recorded assumption — nothing invented.
 *   - Eligibility verdicts are conservative: unknown is shown as UNKNOWN
 *     (never as "probably fine"), and a hard-ineligible candidate is labeled
 *     ineligible — ranking demotes it but never relabels it.
 *   - matchedRequirements is a crude heuristic count, never a win probability.
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
	if (verdict === 'eligible') return 'ELIGIBLE';
	if (verdict === 'ineligible') return 'HARD-INELIGIBLE';
	return 'UNKNOWN';
}

function when(iso: string | null): string {
	if (!iso) return 'never';
	const date = new Date(iso);
	return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
}

export function DiscoveryResults(props: { projectId: string; apiBase?: string }) {
	const { projectId, apiBase = '' } = props;
	const [list, setList] = useState<DiscoveryEvaluatedList | null>(null);
	const [latestFeed, setLatestFeed] = useState<DiscoveryFeedRecord | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState<string | null>(null);

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
		void load();
	}, [projectId]);

	const ranked = list?.ranked ?? [];
	const byId = new Map((list?.evaluations ?? []).map((e) => [e.candidate.id, e]));
	const failedSources = (latestFeed?.sources ?? []).filter((s) => s.outcome === 'failed');

	return (
		<section aria-label="Discovery results" style={{ maxWidth: 760, fontFamily: 'system-ui, sans-serif' }}>
			<header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
				<h2 style={{ margin: 0, fontSize: '1.1rem' }}>Discovery</h2>
				<span>
					<button type="button" onClick={() => void runFeed()} disabled={busy}>
						Run feed
					</button>{' '}
					<button type="button" onClick={() => void load()} disabled={busy}>
						{busy ? 'Loading…' : 'Refresh'}
					</button>
				</span>
			</header>

			{error ? (
				<p role="alert" style={{ color: '#a00' }}>
					{error}
				</p>
			) : null}

			{/* Partial feed failure is a visible, named gap — never silently dropped. */}
			{failedSources.length > 0 ? (
				<div role="status" style={{ border: '1px solid #d90', borderRadius: 6, padding: '0.5rem 0.75rem', margin: '0.5rem 0' }}>
					<strong>Feed gaps</strong> (last run {when(latestFeed?.requestedAt ?? null)}):
					<ul style={{ margin: '0.25rem 0 0' }}>
						{failedSources.map((s) => (
							<li key={s.source}>
								<code>{s.source}</code> failed — {s.failureReason ?? 'unknown reason'}; its candidates are
								missing from this list.
							</li>
						))}
					</ul>
				</div>
			) : null}

			<p style={{ color: '#556', fontSize: '0.85rem' }}>
				Eligibility uses your profile country: {list?.profileCountry ?? 'none recorded — country rules stay UNKNOWN'}.
				Ranking never presents a hard-ineligible candidate as eligible.
			</p>

			{ranked.length === 0 ? (
				<p style={{ color: '#556' }}>{list ? 'No candidates yet — run the feed.' : ''}</p>
			) : (
				<ul style={{ listStyle: 'none', padding: 0 }}>
					{ranked.map((entry) => {
						const evaluation = byId.get(entry.candidateId);
						if (!evaluation) return null;
						const { candidate, fit, eligibility } = evaluation;
						const open = expanded === candidate.id;
						return (
							<li key={candidate.id} style={{ borderTop: '1px solid #eee', padding: '0.5rem 0' }}>
								<div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
									<strong>{candidate.title}</strong>
									<span
										style={{
											background:
												eligibility.verdict === 'eligible'
													? '#e6f6e6'
													: eligibility.verdict === 'ineligible'
														? '#fde5e5'
														: '#f2f2f2',
											borderRadius: 4,
											padding: '0 0.35rem',
											fontSize: '0.8rem',
										}}
									>
										{verdictLabel(eligibility.verdict)}
									</span>
									<span style={{ fontSize: '0.8rem', color: '#556' }}>
										fit: {fit.matchedRequirements} requirement(s) evidenced
									</span>
								</div>
								<div style={{ color: '#556', fontSize: '0.85rem' }}>
									{candidate.summary}
								</div>
								<div style={{ color: '#556', fontSize: '0.8rem' }}>
									<a href={candidate.url} rel="noreferrer noopener" target="_blank">
										{candidate.url}
									</a>{' '}
									· source {candidate.source} · first seen {when(candidate.firstSeenAt)} · status{' '}
									{candidate.status}
								</div>
								<div style={{ marginTop: 4 }}>
									<button type="button" onClick={() => setExpanded(open ? null : candidate.id)}>
										{open ? 'Hide fit detail' : 'Explain fit'}
									</button>{' '}
									{candidate.status === 'new' ? (
										<button type="button" onClick={() => void accept(candidate.id)} disabled={busy}>
											Accept
										</button>
									) : null}
								</div>
								{open ? (
									<div style={{ margin: '0.5rem 0', paddingLeft: 12, borderLeft: '3px solid #dde' }}>
										{fit.claims.length === 0 ? (
											<p style={{ color: '#556', fontSize: '0.85rem' }}>
												No evidence-mapped requirements for this candidate.
											</p>
										) : (
											fit.claims.map((claim) => (
												<div key={`${claim.claimType}:${claim.requirement}`} style={{ marginBottom: 6 }}>
													<div style={{ fontSize: '0.85rem' }}>
														<strong>{claim.verdict.toUpperCase()}</strong> — {claim.statement}
													</div>
													{claim.evidenceClaimIds.length > 0 ? (
														<div style={{ fontSize: '0.8rem', color: '#556' }}>
															evidence:{' '}
															{claim.evidenceClaimIds.map((id) => (
																<code key={id} style={{ marginRight: 6 }}>
																	{id}
																</code>
															))}
														</div>
													) : null}
													{claim.assumptions.map((assumption) => (
														<div key={assumption} style={{ fontSize: '0.8rem', color: '#860' }}>
															assumption: {assumption}
														</div>
													))}
												</div>
											))
										)}
										{eligibility.rules.length === 0 ? (
											<p style={{ color: '#556', fontSize: '0.8rem' }}>
												No quoted eligibility rules on record — verdict stays UNKNOWN, never assumed
												eligible.
											</p>
										) : (
											eligibility.rules.map((rule) => (
												<div key={`${rule.claimType}:${rule.reason}`} style={{ fontSize: '0.8rem', color: '#556' }}>
													<code>{rule.claimType}</code> → {rule.verdict} ({rule.basis}): {rule.reason}
												</div>
											))
										)}
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
