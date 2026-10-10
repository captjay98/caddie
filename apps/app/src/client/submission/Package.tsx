import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

/**
 * P13 submission package (slice 3) — preparation/export UI over the REAL P13
 * routes. Mounted NOWHERE yet (exercisable through fixture routes;
 * workspace-shell integration is P06's).
 *
 * Honesty rules rendered into the UI (feature-ledger C16/H11/H12, packets
 * P13):
 *   - The package title is the PROJECT title — the UI never invents a
 *     contest title.
 *   - Checklist rows appear only with their citation (claim id, quote,
 *     source url); missing requirements are shown as MISSING — never filled
 *     in with a universal video/repo/license assumption.
 *   - Reuse disclosure needs an explicit human confirmation; export is
 *     refused until then.
 *   - Exports show their hash and requirements version; a rule change after
 *     export marks readiness STALE.
 *   - Recording the submission only RECORDS the human's attestation — the
 *     final external submission stays a human action performed elsewhere.
 */

export interface SubmissionPackageRecord {
	id: string;
	title: string;
	reuseRequired: boolean;
	reuseState: 'unconfirmed' | 'confirmed';
	reuseConfirmedBy: string | null;
	requirementsVersion: string;
}

export interface ChecklistItemRecord {
	id: string;
	kind: string;
	requirementText: string;
	citation: { claimId: string; quote: string; url: string };
	status: 'missing' | 'declared' | 'verified' | 'conflict';
	evidence: readonly { refId: string; basis: string }[];
}

export interface SubmissionExportRecord {
	id: string;
	exportHash: string;
	requirementsVersion: string;
	packageJson: string;
	createdAt: string;
}

export interface SubmissionConfirmationRecord {
	id: string;
	exportId: string;
	exportHash: string;
	attestations: readonly string[];
	note: string | null;
	confirmedAt: string;
}

export interface ReadinessRecord {
	status: 'no_export' | 'stale' | 'blocked' | 'ready';
	currentRequirementsVersion: string;
	reasons: readonly string[];
}

export interface PackageDetail {
	package: SubmissionPackageRecord;
	checklist: readonly ChecklistItemRecord[];
	exports: readonly SubmissionExportRecord[];
	confirmations: readonly SubmissionConfirmationRecord[];
	readiness: ReadinessRecord;
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

/** The badge owns tint AND text colour (board screen 19: five meanings rode
 * five pale washes whose labels inherited near-white text at 1.01–1.11:1). */
const STATUS_BADGE: Record<ChecklistItemRecord['status'], { label: string; tone: 'danger' | 'warn' | 'ok' | 'action' }> = {
	missing: { label: 'MISSING', tone: 'danger' },
	declared: { label: 'DECLARED', tone: 'warn' },
	verified: { label: 'VERIFIED', tone: 'ok' },
	conflict: { label: 'CONFLICT', tone: 'action' },
};

function readinessTone(status: ReadinessRecord['status']): 'neutral' | 'warn' | 'danger' | 'ok' {
	if (status === 'ready') return 'ok';
	if (status === 'stale') return 'warn';
	if (status === 'blocked') return 'danger';
	return 'neutral';
}

const READINESS_LABEL: Record<ReadinessRecord['status'], string> = {
	no_export: 'NOT EXPORTED',
	stale: 'STALE — RULES CHANGED',
	blocked: 'BLOCKED (gaps on record)',
	ready: 'PREPARED (not submitted)',
};

export function SubmissionPackage(props: { projectId: string; apiBase?: string }): ReactElement {
	const { projectId, apiBase = '' } = props;
	const [detail, setDetail] = useState<PackageDetail | null>(null);
	const [reuseRequired, setReuseRequired] = useState(false);
	const [attestationsText, setAttestationsText] = useState('');
	const [confirmationNote, setConfirmationNote] = useState('');
	// The demo video link (§4 video-link window): a DRAFT kept on this device
	// only — it is pasted into the contest portal by the user, never uploaded
	// or recorded server-side by Caddie.
	const videoKey = `caddie:video-link:${props.projectId}`;
	const [videoLink, setVideoLinkState] = useState(() => {
		try {
			return sessionStorage.getItem(`caddie:video-link:${props.projectId}`) ?? '';
		} catch {
			return '';
		}
	});
	const [videoOpen, setVideoOpen] = useState(false);
	const [recordOpen, setRecordOpen] = useState(false);
	const setVideoLink = (value: string) => {
		setVideoLinkState(value);
		try {
			if (value) sessionStorage.setItem(videoKey, value);
			else sessionStorage.removeItem(videoKey);
		} catch {
			// private mode: the link stays in memory for the session
		}
	};
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const base = `${apiBase}/api/projects/${encodeURIComponent(projectId)}/submission`;

	async function loadPackage(packageId: string) {
		setBusy(true);
		setError(null);
		try {
			setDetail(await fetchJson<PackageDetail>(`${base}/packages/${encodeURIComponent(packageId)}`));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function load() {
		setBusy(true);
		setError(null);
		try {
			const list = await fetchJson<{ packages: SubmissionPackageRecord[] }>(`${base}/packages`);
			if (list.packages[0]) {
				setDetail(await fetchJson<PackageDetail>(`${base}/packages/${encodeURIComponent(list.packages[0].id)}`));
			} else {
				setDetail(null);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function createPackage() {
		setBusy(true);
		setError(null);
		try {
			const created = await fetchJson<{ package: SubmissionPackageRecord }>(`${base}/packages`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ reuseRequired }),
			});
			await loadPackage(created.package.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	async function action(init: RequestInit) {
		setBusy(true);
		setError(null);
		try {
			await fetchJson(`${base}/packages/${encodeURIComponent(detail!.package.id)}`, init);
			await loadPackage(detail!.package.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	async function confirmReuse() {
		await action({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	}

	async function deriveChecklist() {
		setBusy(true);
		setError(null);
		try {
			await fetchJson(`${base}/packages/${encodeURIComponent(detail!.package.id)}/checklist`, { method: 'POST' });
			await loadPackage(detail!.package.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	async function exportNow() {
		setBusy(true);
		setError(null);
		try {
			await fetchJson(`${base}/packages/${encodeURIComponent(detail!.package.id)}/exports`, { method: 'POST' });
			await loadPackage(detail!.package.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	async function recordSubmitted() {
		setBusy(true);
		setError(null);
		try {
			const attestations = attestationsText
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			const latestExport = detail?.exports[0];
			if (!latestExport) throw new Error('export the package before recording a submission');
			await fetchJson(`${base}/exports/${encodeURIComponent(latestExport.id)}/confirmations`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ exportId: latestExport.id, attestations, note: confirmationNote || null }),
			});
			setAttestationsText('');
			setConfirmationNote('');
			await loadPackage(detail!.package.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function copyLatestExport() {
		setBusy(true);
		setError(null);
		try {
			const detailNow = await fetchJson<PackageDetail>(`${base}/packages/${encodeURIComponent(detail!.package.id)}`);
			const latest = detailNow.exports[0];
			if (!latest) throw new Error('nothing exported yet');
			await navigator.clipboard.writeText(latest.packageJson);
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

	const record = detail?.package ?? null;

	return (
		<section aria-label="Submission package" className="submission-panel" data-testid="submission-package">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						SHIP
					</p>
					<h2 className="ev-title">Submit</h2>
					<p className="page-lede">
						Prepare here, submit elsewhere — this tool never submits anywhere. The package is checked
						against the rules before you send it.
					</p>
				</div>
				<button type="button" className="btn-ghost" onClick={() => void load()} disabled={busy}>
					{busy ? 'Loading…' : 'Refresh'}
				</button>
			</div>

			{error ? (
				<div role="alert" className="sign-in-error disc-error" data-testid="submission-error">
					<b>The package could not be read.</b>
					<span> {error}</span>
				</div>
			) : null}

			{record === null ? (
				<div className="submission-empty">
					<p className="state-detail">
						No package yet. The title comes from THIS project; the checklist derives only from cited
						requirement claims — with none on record it stays empty.
					</p>
					<label className="stack-toggle">
						<input
							type="checkbox"
							data-testid="reuse-required"
							checked={reuseRequired}
							onChange={(event) => setReuseRequired(event.target.checked)}
						/>{' '}
						submitting requires a reuse disclosure
					</label>
					<div>
						<button type="button" className="btn-key" onClick={() => void createPackage()} disabled={busy}>
							Create package
						</button>
					</div>
				</div>
			) : (
				<>
					<div className="disc-head">
						<strong>{record.title}</strong>
						<span className="badge" data-tone={readinessTone(detail!.readiness.status)} data-testid="readiness-badge">
							{READINESS_LABEL[detail!.readiness.status]}
						</span>
						<span className="disc-meta">
							rules version <code>{record.requirementsVersion.slice(0, 14)}…</code>
						</span>
					</div>

					{detail!.readiness.reasons.length > 0 ? (
						<div role="status" className="disc-gaps" data-testid="readiness-reasons">
							<strong>Readiness gaps</strong>
							<ul>
								{detail!.readiness.reasons.map((reason) => (
									<li key={reason}>{reason}</li>
								))}
							</ul>
						</div>
					) : null}

					<div className="row-actions submission-actions">
						<button type="button" className="btn-ghost" onClick={() => void deriveChecklist()} disabled={busy}>
							Re-derive checklist
						</button>
						{record.reuseState === 'unconfirmed' ? (
							<button type="button" className="btn-ghost" onClick={() => void confirmReuse()} disabled={busy}>
								Confirm reuse disclosure (human)
							</button>
						) : (
							<span className="mono-id">
								reuse disclosure confirmed{record.reuseConfirmedBy ? ` by ${record.reuseConfirmedBy}` : ''}
							</span>
						)}
						<button type="button" className="btn-key" onClick={() => void exportNow()} disabled={busy}>
							Export snapshot
						</button>
						<button type="button" className="btn-ghost" onClick={() => void copyLatestExport()} disabled={busy || detail!.exports.length === 0}>
							Copy latest export
						</button>
					</div>

					<h3 className="ev-head">Checklist ({detail!.checklist.length})</h3>
					{detail!.checklist.length === 0 ? (
						<p className="state-detail">
							No submission rules are on record for this project — the checklist stays empty. Nothing is
							assumed about videos, repositories, licenses or hosting.
						</p>
					) : (
						<ul className="disc-list">
							{detail!.checklist.map((item) => {
								const badge = STATUS_BADGE[item.status];
								return (
									<li key={item.id} className="disc-item">
										<div className="disc-head">
											<code>{item.kind}</code>
											<span className="badge" data-tone={badge.tone}>
												{badge.label}
											</span>
											<span className="disc-claim-line">{item.requirementText}</span>
										</div>
										<div className="disc-meta">
											cited: <code>{item.citation.claimId}</code> — “{item.citation.quote}” ·{' '}
											<a href={item.citation.url} rel="noreferrer noopener" target="_blank">
												{item.citation.url}
											</a>
										</div>
										{item.evidence.length > 0 ? (
											<div className="disc-meta">
												backed by: {item.evidence.map((ref) => (
													<code key={ref.refId}>
														{ref.refId} ({ref.basis})
													</code>
												))}
											</div>
										) : null}
									</li>
								);
							})}
						</ul>
					)}

					<h3 className="ev-head">Exports ({detail!.exports.length})</h3>
					<ul className="disc-list">
						{detail!.exports.map((export_) => (
							<li key={export_.id} className="disc-item">
								<div className="disc-meta">
									<code>{export_.exportHash.slice(0, 19)}…</code> · rules version{' '}
									<code>{export_.requirementsVersion.slice(0, 14)}…</code> · {export_.createdAt}
									{export_.requirementsVersion !== detail!.readiness.currentRequirementsVersion ? (
										<span className="badge" data-tone="warn"> — STALE (rules changed after this export)</span>
									) : null}
								</div>
							</li>
						))}
					</ul>

					<div className="row-actions">
						<button type="button" className="btn-ghost" data-testid="video-link-open" onClick={() => setVideoOpen((value) => !value)}>
							{videoOpen ? 'Close video link' : 'Add the demo video link'}
						</button>
						<button
							type="button"
							className="btn-key"
							data-testid="record-submission-open"
							onClick={() => setRecordOpen(true)}
							disabled={busy || detail!.exports.length === 0}
						>
							I've submitted
						</button>
					</div>

					{videoOpen ? (
						<div className="modal-backdrop" data-testid="video-link-backdrop" onMouseDown={() => setVideoOpen(false)}>
							<div className="commit-panel card-surface" data-testid="video-link-window" onMouseDown={(e) => e.stopPropagation()}>
								<p className="kicker" data-tone="action">
									DEMO VIDEO LINK
								</p>
								<h3 className="state-title">Where is the demo video?</h3>
								<p className="state-detail">
									Paste the public link (e.g. YouTube). It is kept on this device and copied with the
									other fields below — Caddie never uploads or submits anything.
								</p>
								<input
									type="url"
									className="input"
									placeholder="https://youtube.com/watch?v=…"
									data-testid="video-link-input"
									value={videoLink}
									onChange={(event) => setVideoLink(event.target.value)}
								/>
								<div className="row-actions">
									<button type="button" className="btn-key" onClick={() => setVideoOpen(false)}>
										Done
									</button>
								</div>
							</div>
						</div>
					) : null}

					{recordOpen ? (
						<div className="modal-backdrop" data-testid="record-submission-backdrop" onMouseDown={() => setRecordOpen(false)}>
							<div className="commit-panel card-surface" data-testid="record-submission-window" onMouseDown={(e) => e.stopPropagation()}>
					<div className="submission-attest">
						<h3 className="ev-head">Record the submission (after YOU submit)</h3>
						<p className="state-detail">
							This tool never submits anywhere. After you submit on the contest portal yourself, record
							that fact — it is stored separately from the prepared package.
						</p>
						<label className="judge-risks-label">
							your attestations (one per line, required)
							<textarea
								className="input"
								value={attestationsText}
								rows={2}
								data-testid="attestations"
								onChange={(event) => setAttestationsText(event.target.value)}
							/>
						</label>
						<label className="judge-score-label">
							note (optional){' '}
							<input
								type="text"
								className="input"
								value={confirmationNote}
								data-testid="confirmation-note"
								onChange={(event) => setConfirmationNote(event.target.value)}
							/>
						</label>
						<div className="row-actions">
							<button
								type="button"
								className="btn-key"
								onClick={() => void recordSubmitted()}
								disabled={busy || detail!.exports.length === 0}
							>
								Record submitted
							</button>
							<span className="mono-id">
								records YOUR attestation only — nothing is submitted anywhere by this tool
							</span>
						</div>

						{detail!.confirmations.length > 0 ? (
							<ul className="disc-list">
								{detail!.confirmations.map((confirmation) => (
									<li key={confirmation.id} className="disc-item">
										<div className="disc-meta">
											CONFIRMED SUBMITTED · export <code>{confirmation.exportHash.slice(0, 19)}…</code> ·{' '}
											{confirmation.attestations.join(' / ')}
											{confirmation.note ? ` — ${confirmation.note}` : ''}
										</div>
									</li>
								))}
							</ul>
						) : null}
					</div>
						<div className="row-actions">
							<button type="button" className="btn-ghost" onClick={() => setRecordOpen(false)}>
								Close
							</button>
						</div>
							</div>
						</div>
					) : null}

					{/* Fields ready to copy (§4): the video draft rides along. */}
					{videoLink ? (
						<p className="state-detail" data-testid="video-link-copied">
							Demo video: <code>{videoLink}</code>
						</p>
					) : null}
				</>
			)}
		</section>
	);
}
