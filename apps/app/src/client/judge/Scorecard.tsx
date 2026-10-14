import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { StatePanel } from '../states.tsx';

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

/**
 * Access is label + mark, never tint alone (board screen 18): the badge owns
 * its text colour through the .badge primitive, so the level reads on both
 * themes — the shipped chip inherited near-white body text onto a pale wash.
 */
const ACCESS_BADGE: Record<CriterionEvidence['access'], { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
	verified_deployed: { label: 'VERIFIED (deployed)', tone: 'ok' },
	verified_local: { label: 'VERIFIED (local)', tone: 'ok' },
	declared: { label: 'DECLARED ONLY', tone: 'warn' },
	unknown: { label: 'UNKNOWN', tone: 'neutral' },
};

interface DraftScore {
	score: string;
	notes: string;
}

export function JudgeScorecard(props: { projectId: string; apiBase?: string }): ReactElement {
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
			setRubric(
				assessmentPayload.rubric ?? {
					criteria: [],
					warnings: ['the assessment payload carried no rubric'],
					conflicts: [],
					hash: 'unavailable',
					extractionVersion: 'unavailable',
				},
			);
			setAssessment(assessmentPayload.assessment);
			setScorecards(scorecardsPayload.scorecards);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function submitScorecard() {
		// Audit F12: a blank score must never be silently recorded as 0 — the
		// user's assessment is the whole point of this surface. Refuse with a
		// visible, named error and let the user finish scoring or cancel.
		const blank = (rubric?.criteria ?? []).filter(
			(criterion) => (drafts[criterion.text]?.score ?? '').trim() === '',
		);
		if (blank.length > 0) {
			setError(
				`Score every criterion before recording — still blank: ${blank.map((c) => c.text).join('; ')}.`,
			);
			return;
		}
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
		<section aria-label="Score it yourself" className="judge-panel" data-testid="judge-scorecard">
			<div className="r-section-head judge-head">
				<p className="page-lede">
					Caddie extracts the contest rubric from your evidence and shows what is verified; you record
					your own assessment against it — coaching to make it better, never a prediction of the result.
				</p>
				<button type="button" className="btn-ghost" onClick={() => void load()} disabled={busy}>
					{busy ? 'Loading…' : 'Refresh'}
				</button>
			</div>

			{error ? (
				<div role="alert" className="sign-in-error disc-error" data-testid="judge-error">
					<b>Checking what judges look for could not continue.</b>
					<span> {error}</span>
				</div>
			) : null}

			{rubric === null ? (
				<StatePanel kind="loading" title="Reading the rubric…" />
			) : rubric.criteria.length === 0 ? (
				<>
					<p className="state-detail">
						No judging criteria are on record in this project's evidence — the rubric stays empty instead of
						assuming a generic criterion set.
					</p>
					<ul className="disc-assumption">
						{rubric.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</>
			) : (
				<>
					<p className="state-detail">
						Rubric extracted from this project's evidence claims (hash <code>{rubric.hash.slice(0, 19)}…</code>,
						version {rubric.extractionVersion}). Access badges come from run receipts, not from anyone's claim.
					</p>
					{rubric.warnings.length > 0 ? (
						<div role="status" className="disc-gaps">
							<strong>Rubric warnings</strong>
							<ul>
								{rubric.warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</div>
					) : null}
					{rubric.conflicts.length > 0 ? (
						<div role="status" className="disc-gaps judge-conflicts">
							<strong>Retained conflicts</strong> — equal-authority sources disagree; nothing was auto-resolved.
							<ul>
								{rubric.conflicts.map((conflict) => (
									<li key={conflict.criterionKey}>
										<code>{conflict.criterionKey}</code>: {conflict.claimIds.join(', ')}
									</li>
								))}
							</ul>
						</div>
					) : null}

					<ul className="disc-list">
						{rubric.criteria.map((criterion) => {
							const evidence = assessmentByCriterion.get(criterion.text);
							const badge = ACCESS_BADGE[evidence?.access ?? 'unknown'];
							const open = expanded === criterion.text;
							const draft = drafts[criterion.text] ?? { score: '', notes: '' };
							return (
								<li key={criterion.text} className="disc-item">
									<div className="disc-head">
										<strong>{criterion.text}</strong>
										<span className="badge" data-tone={badge.tone}>
											{badge.label}
										</span>
										<span className="judge-weight">
											weight: {criterion.weight === null ? 'not claimed (never guessed)' : `${criterion.weight}%`}
										</span>
									</div>
									<div className="disc-meta">
										evidence: {criterion.claimIds.map((id) => (
											<code key={id}>{id}</code>
										))}
									</div>
									<div className="row-actions">
<label className="judge-score-label">
												your score (0–10) — your own assessment, not Caddie's{' '}
												<input
												type="number"
												className="input"
												min={0}
												max={10}
												value={draft.score}
												data-testid={`judge-score-${criterion.text}`}
												onChange={(event) =>
													setDrafts((prev) => ({ ...prev, [criterion.text]: { ...draft, score: event.target.value } }))
												}
											/>
										</label>
										<input
											type="text"
											className="input"
											placeholder="notes (required)"
											value={draft.notes}
											data-testid={`judge-notes-${criterion.text}`}
											onChange={(event) =>
												setDrafts((prev) => ({ ...prev, [criterion.text]: { ...draft, notes: event.target.value } }))
											}
										/>
										<button type="button" className="btn-ghost" onClick={() => setExpanded(open ? null : criterion.text)}>
											{open ? 'Hide evidence' : 'Show evidence'}
										</button>
									</div>
									{open ? (
										<div className="disc-detail">
											<strong>Verified (receipts)</strong>
											{(evidence?.verified ?? []).length === 0 ? (
												<div className="disc-meta">none — nothing verified for this criterion</div>
											) : (
												(evidence?.verified ?? []).map((ref) => (
													<div key={ref.ref.id} className="disc-meta">
														<code>{ref.ref.id}</code> [{ref.level}] {ref.ref.text}
													</div>
												))
											)}
											<strong className="judge-declared-head">Declared (claims only)</strong>
											{(evidence?.declared ?? []).length === 0 ? (
												<div className="disc-meta">none</div>
											) : (
												(evidence?.declared ?? []).map((ref) => (
													<div key={ref.ref.id} className="disc-meta">
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

					<div className="judge-submit">
						<label className="judge-risks-label">
							top risks (one per line — must reference the recorded evidence)
							<textarea
								className="input"
								value={topRisksText}
								rows={3}
								data-testid="judge-top-risks"
								onChange={(event) => setTopRisksText(event.target.value)}
							/>
						</label>
						<div className="row-actions">
							<button type="button" className="btn-key" onClick={() => void submitScorecard()} disabled={busy}>
								{busy ? 'Recording…' : 'Validate and record scorecard'}
							</button>
							<span className="mono-id">
								Malformed results are rejected server-side; access levels are recomputed from receipts.
							</span>
						</div>
					</div>
				</>
			)}

			{scorecards.length > 0 ? (
				<div className="judge-recorded">
					<h3 className="ev-head">Recorded scorecards</h3>
					<ul className="disc-list">
						{scorecards.map((record) => (
							<li key={record.id} className="disc-item">
								<div className="disc-meta">
									<code>{record.id}</code> · rubric {record.rubricHash.slice(0, 19)}… · {record.scoringVersion}
								</div>
								<div>
									<strong>{record.result.coachingAverage}</strong> — {record.result.averageLabel}
								</div>
								{record.result.topRisks.length > 0 ? (
									<ul className="judge-risks">
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

			<p className="judge-coaching-note" data-testid="judge-coaching-note">
				Coaching only. Scores describe the recorded evidence; they are not a prediction of how judges will
				score this project, and this UI has no win-probability feature.
			</p>
		</section>
	);
}
