import { useEffect, useState } from 'react';

/**
 * P13 judge scorecard (slice 3) — coaching UI over the REAL P13 routes.
 * Like the P10/P11 drawers this component is deliberately mounted NOWHERE
 * yet (exercisable through fixture routes; workspace-shell integration is
 * P06's).
 *
 * Honesty rules rendered into the UI (feature-ledger C15, packets P13):
 *   - The rubric shown is the one EXTRACTED from this project's evidence —
 *     an empty rubric says so and never falls back to a generic set.
 *   - Declared vs verified evidence is shown separately, with access badges
 *     recomputed server-side from receipts; a scorecard cannot claim access
 *     the evidence does not carry.
 *   - The coaching average carries the not-a-prediction label verbatim from
 *     the server. There is no win probability anywhere in this UI.
 *   - Warnings and retained conflicts are visible, never smoothed away.
 */

export interface RubricCriterion {
	text: string;
	weight: number | null;
	claimIds: readonly string[];
}

export interface Rubric {
	criteria: readonly RubricCriterion[];
	warnings: readonly string[];
	conflicts: readonly { criterionKey: string; claimIds: readonly string[] }[];
	hash: string;
	extractionVersion: string;
}

export interface EvidenceRef {
	level: 'declared' | 'verified_local' | 'verified_deployed';
	ref: { id: string; kind: 'receipt' | 'claim'; text: string };
}

export interface CriterionEvidence {
	criterionText: string;
	verified: readonly EvidenceRef[];
	declared: readonly EvidenceRef[];
	access: 'unknown' | 'declared' | 'verified_local' | 'verified_deployed';
}

export interface ScorecardRecord {
	id: string;
	rubricHash: string;
	scoringVersion: string;
	result: {
		criteria: readonly { criterion: string; score: number; notes: string; access: string }[];
		topRisks: readonly string[];
		coachingAverage: number;
		averageLabel: string;
	};
	createdAt: string;
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

const ACCESS_BADGE: Record<CriterionEvidence['access'], { label: string; background: string }> = {
	verified_deployed: { label: 'VERIFIED (deployed)', background: '#e6f6e6' },
	verified_local: { label: 'VERIFIED (local)', background: '#eef6e6' },
	declared: { label: 'DECLARED ONLY', background: '#fff4d6' },
	unknown: { label: 'UNKNOWN', background: '#f2f2f2' },
};

interface DraftScore {
	score: string;
	notes: string;
}

export function JudgeScorecard(props: { projectId: string; apiBase?: string }) {
	const { projectId, apiBase = '' } = props;
	const [rubric, setRubric] = useState<Rubric | null>(null);
	const [assessment, setAssessment] = useState<readonly CriterionEvidence[]>([]);
	const [scorecards, setScorecards] = useState<readonly ScorecardRecord[]>([]);
	const [drafts, setDrafts] = useState<Record<string, DraftScore>>({});
	const [topRisksText, setTopRisksText] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [expanded, setExpanded] = useState<string | null>(null);

	const base = `${apiBase}/api/projects/${encodeURIComponent(projectId)}/judge`;

	async function load() {
		setBusy(true);
		setError(null);
		try {
			const [assessmentPayload, scorecardsPayload] = await Promise.all([
				fetchJson<{ rubric: Rubric; assessment: CriterionEvidence[] }>(`${base}/assessment`),
				fetchJson<{ scorecards: ScorecardRecord[] }>(`${base}/scorecards`),
			]);
			setRubric(assessmentPayload.rubric);
			setAssessment(assessmentPayload.assessment);
			setScorecards(scorecardsPayload.scorecards);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function submitScorecard() {
		setBusy(true);
		setError(null);
		try {
			const criteria = (rubric?.criteria ?? []).map((criterion) => {
				const draft = drafts[criterion.text] ?? { score: '', notes: '' };
				return {
					criterion: criterion.text,
					score: Number(draft.score),
					notes: draft.notes,
				};
			});
			const topRisks = topRisksText
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			await fetchJson(`${base}/scorecards`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ criteria, topRisks }),
			});
			setDrafts({});
			setTopRisksText('');
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	useEffect(() => {
		void load();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projectId]);

	const assessmentByCriterion = new Map(assessment.map((entry) => [entry.criterionText, entry]));

	return (
		<section aria-label="Judge scorecard" style={{ maxWidth: 760, fontFamily: 'system-ui, sans-serif' }}>
			<header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
				<h2 style={{ margin: 0, fontSize: '1.1rem' }}>Judge coaching</h2>
				<button type="button" onClick={() => void load()} disabled={busy}>
					{busy ? 'Loading…' : 'Refresh'}
				</button>
			</header>

			{error ? (
				<p role="alert" style={{ color: '#a00' }}>
					{error}
				</p>
			) : null}

			{rubric === null ? null : rubric.criteria.length === 0 ? (
				<>
					<p style={{ color: '#556' }}>
						No judging criteria are on record in this project's evidence — the rubric stays empty instead of
						assuming a generic criterion set.
					</p>
					<ul style={{ color: '#860', fontSize: '0.85rem' }}>
						{rubric.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</>
			) : (
				<>
					<p style={{ color: '#556', fontSize: '0.85rem' }}>
						Rubric extracted from this project's evidence claims (hash <code>{rubric.hash.slice(0, 19)}…</code>,
						version {rubric.extractionVersion}). Access badges come from run receipts, not from anyone's claim.
					</p>
					{rubric.warnings.length > 0 ? (
						<div role="status" style={{ border: '1px solid #d90', borderRadius: 6, padding: '0.5rem 0.75rem', margin: '0.5rem 0' }}>
							<strong>Rubric warnings</strong>
							<ul style={{ margin: '0.25rem 0 0' }}>
								{rubric.warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</div>
					) : null}
					{rubric.conflicts.length > 0 ? (
						<div role="status" style={{ border: '1px solid #a0a', borderRadius: 6, padding: '0.5rem 0.75rem', margin: '0.5rem 0' }}>
							<strong>Retained conflicts</strong> — equal-authority sources disagree; nothing was auto-resolved.
							<ul style={{ margin: '0.25rem 0 0' }}>
								{rubric.conflicts.map((conflict) => (
									<li key={conflict.criterionKey}>
										<code>{conflict.criterionKey}</code>: {conflict.claimIds.join(', ')}
									</li>
								))}
							</ul>
						</div>
					) : null}

					<ul style={{ listStyle: 'none', padding: 0 }}>
						{rubric.criteria.map((criterion) => {
							const evidence = assessmentByCriterion.get(criterion.text);
							const badge = ACCESS_BADGE[evidence?.access ?? 'unknown'];
							const open = expanded === criterion.text;
							const draft = drafts[criterion.text] ?? { score: '', notes: '' };
							return (
								<li key={criterion.text} style={{ borderTop: '1px solid #eee', padding: '0.5rem 0' }}>
									<div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
										<strong>{criterion.text}</strong>
										<span style={{ background: badge.background, borderRadius: 4, padding: '0 0.35rem', fontSize: '0.8rem' }}>
											{badge.label}
										</span>
										<span style={{ fontSize: '0.8rem', color: '#556' }}>
											weight: {criterion.weight === null ? 'not claimed (never guessed)' : `${criterion.weight}%`}
										</span>
									</div>
									<div style={{ fontSize: '0.8rem', color: '#556' }}>
										evidence: {criterion.claimIds.map((id) => (
											<code key={id} style={{ marginRight: 6 }}>
												{id}
											</code>
										))}
									</div>
									<div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
										<label style={{ fontSize: '0.85rem' }}>
											score (0–10){' '}
											<input
												type="number"
												min={0}
												max={10}
												value={draft.score}
												style={{ width: 60 }}
												onChange={(event) =>
													setDrafts((prev) => ({ ...prev, [criterion.text]: { ...draft, score: event.target.value } }))
												}
											/>
										</label>
										<input
											type="text"
											placeholder="notes (required)"
											value={draft.notes}
											style={{ flex: 1 }}
											onChange={(event) =>
												setDrafts((prev) => ({ ...prev, [criterion.text]: { ...draft, notes: event.target.value } }))
											}
										/>
										<button type="button" onClick={() => setExpanded(open ? null : criterion.text)}>
											{open ? 'Hide evidence' : 'Show evidence'}
										</button>
									</div>
									{open ? (
										<div style={{ margin: '0.5rem 0', paddingLeft: 12, borderLeft: '3px solid #dde', fontSize: '0.85rem' }}>
											<strong>Verified (receipts)</strong>
											{(evidence?.verified ?? []).length === 0 ? (
												<div style={{ color: '#556' }}>none — nothing verified for this criterion</div>
											) : (
												(evidence?.verified ?? []).map((ref) => (
													<div key={ref.ref.id} style={{ fontSize: '0.8rem', color: '#556' }}>
														<code>{ref.ref.id}</code> [{ref.level}] {ref.ref.text}
													</div>
												))
											)}
											<strong style={{ display: 'block', marginTop: 6 }}>Declared (claims only)</strong>
											{(evidence?.declared ?? []).length === 0 ? (
												<div style={{ color: '#556' }}>none</div>
											) : (
												(evidence?.declared ?? []).map((ref) => (
													<div key={ref.ref.id} style={{ fontSize: '0.8rem', color: '#556' }}>
														<code>{ref.ref.id}</code> {ref.ref.text}
													</div>
												))
											)}
										</div>
									) : null}
								</li>
							);
						})}
					</ul>

					<div style={{ margin: '0.75rem 0' }}>
						<label style={{ display: 'block', fontSize: '0.85rem' }}>
							top risks (one per line — must reference the recorded evidence)
							<textarea
								value={topRisksText}
								rows={3}
								style={{ width: '100%' }}
								onChange={(event) => setTopRisksText(event.target.value)}
							/>
						</label>
						<button type="button" onClick={() => void submitScorecard()} disabled={busy}>
							Validate and record scorecard
						</button>
						<span style={{ fontSize: '0.8rem', color: '#556', marginLeft: 8 }}>
							Malformed results are rejected server-side; access levels are recomputed from receipts.
						</span>
					</div>
				</>
			)}

			{scorecards.length > 0 ? (
				<div style={{ marginTop: 12 }}>
					<h3 style={{ fontSize: '1rem' }}>Recorded scorecards</h3>
					<ul style={{ listStyle: 'none', padding: 0 }}>
						{scorecards.map((record) => (
							<li key={record.id} style={{ borderTop: '1px solid #eee', padding: '0.5rem 0', fontSize: '0.85rem' }}>
								<code>{record.id}</code> · rubric {record.rubricHash.slice(0, 19)}… · {record.scoringVersion}
								<div>
									<strong>{record.result.coachingAverage}</strong> — {record.result.averageLabel}
								</div>
								{record.result.topRisks.length > 0 ? (
									<ul style={{ margin: '0.25rem 0 0' }}>
										{record.result.topRisks.map((risk) => (
											<li key={risk}>{risk}</li>
										))}
									</ul>
								) : null}
							</li>
						))}
					</ul>
				</div>
			) : null}

			<p style={{ color: '#556', fontSize: '0.8rem' }}>
				Coaching only. Scores describe the recorded evidence; they are not a prediction of how judges will
				score this project, and this UI has no win-probability feature.
			</p>
		</section>
	);
}
