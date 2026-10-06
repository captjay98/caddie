import { useEffect, useState } from 'react';

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

const STATUS_BADGE: Record<ChecklistItemRecord['status'], { label: string; background: string }> = {
	missing: { label: 'MISSING', background: '#fde5e5' },
	declared: { label: 'DECLARED', background: '#fff4d6' },
	verified: { label: 'VERIFIED', background: '#e6f6e6' },
	conflict: { label: 'CONFLICT', background: '#f2d6f5' },
};

const READINESS_LABEL: Record<ReadinessRecord['status'], string> = {
	no_export: 'NOT EXPORTED',
	stale: 'STALE — RULES CHANGED',
	blocked: 'BLOCKED (gaps on record)',
	ready: 'PREPARED (not submitted)',
};

export function SubmissionPackage(props: { projectId: string; apiBase?: string }) {
	const { projectId, apiBase = '' } = props;
	const [detail, setDetail] = useState<PackageDetail | null>(null);
	const [reuseRequired, setReuseRequired] = useState(false);
	const [attestationsText, setAttestationsText] = useState('');
	const [confirmationNote, setConfirmationNote] = useState('');
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
		<section aria-label="Submission package" style={{ maxWidth: 760, fontFamily: 'system-ui, sans-serif' }}>
			<header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
				<h2 style={{ margin: 0, fontSize: '1.1rem' }}>Submission package</h2>
				<button type="button" onClick={() => void load()} disabled={busy}>
					{busy ? 'Loading…' : 'Refresh'}
				</button>
			</header>

			{error ? (
				<p role="alert" style={{ color: '#a00' }}>
					{error}
				</p>
			) : null}

			{record === null ? (
				<div style={{ margin: '0.75rem 0' }}>
					<p style={{ color: '#556', fontSize: '0.85rem' }}>
						No package yet. The title comes from THIS project; the checklist derives only from cited
						requirement claims — with none on record it stays empty.
					</p>
					<label style={{ fontSize: '0.85rem', marginRight: 8 }}>
						<input
							type="checkbox"
							checked={reuseRequired}
							onChange={(event) => setReuseRequired(event.target.checked)}
						/>{' '}
						submitting requires a reuse disclosure
					</label>
					<button type="button" onClick={() => void createPackage()} disabled={busy}>
						Create package
					</button>
				</div>
			) : (
				<>
					<div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 8 }}>
						<strong>{record.title}</strong>
						<span style={{ background: '#f2f2f2', borderRadius: 4, padding: '0 0.35rem', fontSize: '0.8rem' }}>
							{READINESS_LABEL[detail!.readiness.status]}
						</span>
						<span style={{ fontSize: '0.8rem', color: '#556' }}>
							rules version <code>{record.requirementsVersion.slice(0, 14)}…</code>
						</span>
					</div>

					{detail!.readiness.reasons.length > 0 ? (
						<div role="status" style={{ border: '1px solid #d90', borderRadius: 6, padding: '0.5rem 0.75rem', margin: '0.5rem 0', fontSize: '0.85rem' }}>
							<strong>Readiness gaps</strong>
							<ul style={{ margin: '0.25rem 0 0' }}>
								{detail!.readiness.reasons.map((reason) => (
									<li key={reason}>{reason}</li>
								))}
							</ul>
						</div>
					) : null}

					<div style={{ margin: '0.5rem 0', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
						<button type="button" onClick={() => void deriveChecklist()} disabled={busy}>
							Re-derive checklist
						</button>
						{record.reuseState === 'unconfirmed' ? (
							<button type="button" onClick={() => void confirmReuse()} disabled={busy}>
								Confirm reuse disclosure (human)
							</button>
						) : (
							<span style={{ fontSize: '0.85rem', color: '#556' }}>
								reuse disclosure confirmed{record.reuseConfirmedBy ? ` by ${record.reuseConfirmedBy}` : ''}
							</span>
						)}
						<button type="button" onClick={() => void exportNow()} disabled={busy}>
							Export snapshot
						</button>
						<button type="button" onClick={() => void copyLatestExport()} disabled={busy || detail!.exports.length === 0}>
							Copy latest export
						</button>
					</div>

					<h3 style={{ fontSize: '1rem' }}>Checklist ({detail!.checklist.length})</h3>
					{detail!.checklist.length === 0 ? (
						<p style={{ color: '#556', fontSize: '0.85rem' }}>
							No submission rules are on record for this project — the checklist stays empty. Nothing is
							assumed about videos, repositories, licenses or hosting.
						</p>
					) : (
						<ul style={{ listStyle: 'none', padding: 0 }}>
							{detail!.checklist.map((item) => {
								const badge = STATUS_BADGE[item.status];
								return (
									<li key={item.id} style={{ borderTop: '1px solid #eee', padding: '0.5rem 0' }}>
										<div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
											<code>{item.kind}</code>
											<span style={{ background: badge.background, borderRadius: 4, padding: '0 0.35rem', fontSize: '0.8rem' }}>
												{badge.label}
											</span>
											<span style={{ fontSize: '0.85rem' }}>{item.requirementText}</span>
										</div>
										<div style={{ fontSize: '0.8rem', color: '#556' }}>
											cited: <code>{item.citation.claimId}</code> — “{item.citation.quote}” ·{' '}
											<a href={item.citation.url} rel="noreferrer noopener" target="_blank">
												{item.citation.url}
											</a>
										</div>
										{item.evidence.length > 0 ? (
											<div style={{ fontSize: '0.8rem', color: '#556' }}>
												backed by: {item.evidence.map((ref) => (
													<code key={ref.refId} style={{ marginRight: 6 }}>
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

					<h3 style={{ fontSize: '1rem' }}>Exports ({detail!.exports.length})</h3>
					<ul style={{ listStyle: 'none', padding: 0, fontSize: '0.85rem' }}>
						{detail!.exports.map((export_) => (
							<li key={export_.id} style={{ borderTop: '1px solid #eee', padding: '0.35rem 0' }}>
								<code>{export_.exportHash.slice(0, 19)}…</code> · rules version{' '}
								<code>{export_.requirementsVersion.slice(0, 14)}…</code> · {export_.createdAt}
								{export_.requirementsVersion !== detail!.readiness.currentRequirementsVersion ? (
									<span style={{ color: '#a00' }}> — STALE (rules changed after this export)</span>
								) : null}
							</li>
						))}
					</ul>

					<h3 style={{ fontSize: '1rem' }}>Record the submission (after YOU submit)</h3>
					<p style={{ color: '#556', fontSize: '0.85rem' }}>
						This tool never submits anywhere. After you submit on the contest portal yourself, record
						that fact — it is stored separately from the prepared package.
					</p>
					<label style={{ display: 'block', fontSize: '0.85rem' }}>
						your attestations (one per line, required)
						<textarea
							value={attestationsText}
							rows={2}
							style={{ width: '100%' }}
							onChange={(event) => setAttestationsText(event.target.value)}
						/>
					</label>
					<label style={{ display: 'block', fontSize: '0.85rem', margin: '0.25rem 0' }}>
						note (optional){' '}
						<input type="text" value={confirmationNote} onChange={(event) => setConfirmationNote(event.target.value)} />
					</label>
					<button
						type="button"
						onClick={() => void recordSubmitted()}
						disabled={busy || detail!.exports.length === 0}
					>
						Record submitted
					</button>

					{detail!.confirmations.length > 0 ? (
						<ul style={{ listStyle: 'none', padding: 0, fontSize: '0.85rem' }}>
							{detail!.confirmations.map((confirmation) => (
								<li key={confirmation.id} style={{ borderTop: '1px solid #eee', padding: '0.35rem 0' }}>
									CONFIRMED SUBMITTED · export <code>{confirmation.exportHash.slice(0, 19)}…</code> ·{' '}
									{confirmation.attestations.join(' / ')}
									{confirmation.note ? ` — ${confirmation.note}` : ''}
								</li>
							))}
						</ul>
					) : null}
				</>
			)}
		</section>
	);
}
