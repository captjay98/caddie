import { useEffect, useState } from 'react';
import { authorityLabel, isSourceAuthority } from '../../server/evidence/authority.ts';

/**
 * P10 evidence inspector (feature-ledger H7) — a standalone drawer component
 * reading the REAL evidence routes. Workspace-shell integration is P06/P11;
 * this component is deliberately mounted NOWHERE (it is exercised through the
 * P10 fixtures/tests and can be embedded under a project details route later).
 *
 * Honesty rules rendered into the UI (contracts "UI and evidence"):
 *   - authority is shown from the ONE shared vocabulary (authority.ts) — the
 *     same module storage and reconciliation use (defect #6);
 *   - every claim shows its EXACT snapshot id + content hash + quote +
 *     locator + provenance (original/processed) + extraction version — what
 *     the reading rests on (defect #1);
 *   - freshness is the source's lastOutcome/observedAt, never implied;
 *   - confidence numbers are NEVER displayed: a confidence number is not
 *     truth, authority + provenance are the weighing signals;
 *   - retained conflicts are shown as conflicts — never silently resolved.
 */

export interface EvidenceSource {
	id: string;
	canonicalUrl: string;
	kind: string;
	authority: string;
	displayName: string | null;
	latestSnapshotId: string | null;
	latestContentHash: string | null;
	lastOutcome: string;
	lastFailureReason: string | null;
	observedAt: string | null;
	attemptedAt: string | null;
}

export interface EvidenceClaim {
	id: string;
	claimType: string;
	value: string;
	quote: string;
	locator: string | null;
	extractionVersion: string;
	status: string;
	supersededBy: string | null;
	snapshotId: string;
	snapshotCapturedAt: string;
	sourceAuthority: string;
	snapshotContentHash: string;
	snapshotProvenance: string;
	canonicalUrl: string;
}

export interface EvidenceSurvey {
	claimType: string;
	winner: { claimId: string; value: string; sourceId: string } | null;
	conflict: { conflictId: string; claimIds: readonly string[] } | null;
}

function shortHash(hash: string): string {
	return hash.length > 16 ? `${hash.slice(0, 12)}…` : hash;
}

function authority(value: string): string {
	return isSourceAuthority(value) ? authorityLabel(value) : 'Unknown';
}

function when(iso: string | null): string {
	if (!iso) return 'never';
	const date = new Date(iso);
	return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
}

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, { credentials: 'same-origin' });
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `request failed (${response.status})`);
	}
	return (await response.json()) as T;
}

export function EvidenceDrawer(props: { projectId: string; apiBase?: string }) {
	const { projectId, apiBase = '' } = props;
	const [sources, setSources] = useState<readonly EvidenceSource[] | null>(null);
	const [claims, setClaims] = useState<readonly EvidenceClaim[] | null>(null);
	const [surveys, setSurveys] = useState<readonly EvidenceSurvey[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const base = `${apiBase}/api/projects/${encodeURIComponent(projectId)}/evidence`;

	async function load() {
		setLoading(true);
		setError(null);
		try {
			const [sourcesBody, claimsBody, surveysBody] = await Promise.all([
				fetchJson<{ sources: EvidenceSource[] }>(`${base}/sources`),
				fetchJson<{ claims: EvidenceClaim[] }>(`${base}/claims`),
				fetchJson<{ surveys: EvidenceSurvey[] }>(`${base}/conflicts`),
			]);
			setSources(sourcesBody.sources);
			setClaims(claimsBody.claims);
			setSurveys(surveysBody.surveys);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void load();
	}, [projectId]);

	return (
		<aside
			aria-label="Evidence inspector"
			style={{
				border: '1px solid #ccc',
				borderRadius: 8,
				padding: '1rem',
				maxWidth: 720,
				fontFamily: 'system-ui, sans-serif',
			}}
		>
			<header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
				<h2 style={{ margin: 0, fontSize: '1.1rem' }}>Evidence</h2>
				<button type="button" onClick={() => void load()} disabled={loading}>
					{loading ? 'Loading…' : 'Refresh'}
				</button>
			</header>

			{error ? (
				<p role="alert" style={{ color: '#a00' }}>
					{error}
				</p>
			) : null}

			<section>
				<h3 style={{ fontSize: '0.95rem' }}>Sources</h3>
				{sources?.length ? (
					<ul style={{ listStyle: 'none', padding: 0 }}>
						{sources.map((source) => (
							<li key={source.id} style={{ borderTop: '1px solid #eee', padding: '0.5rem 0' }}>
								<div>
									<strong>{source.displayName ?? source.canonicalUrl}</strong>{' '}
									<span
										style={{
											background: '#eef',
											borderRadius: 4,
											padding: '0 0.35rem',
											fontSize: '0.8rem',
										}}
									>
										{authority(source.authority)}
									</span>
								</div>
								<div style={{ color: '#556', fontSize: '0.85rem' }}>
									freshness: lastOutcome={source.lastOutcome}, observed {when(source.observedAt)}
									{source.lastFailureReason ? ` — last failure: ${source.lastFailureReason}` : ''}
								</div>
								{source.latestSnapshotId ? (
									<div style={{ color: '#556', fontSize: '0.85rem' }}>
										latest snapshot {source.latestSnapshotId.slice(0, 18)}… hash{' '}
										{shortHash(source.latestContentHash ?? '')}
									</div>
								) : (
									<div style={{ color: '#556', fontSize: '0.85rem' }}>no snapshot yet</div>
								)}
							</li>
						))}
					</ul>
				) : (
					<p style={{ color: '#556' }}>{sources ? 'No sources registered.' : ''}</p>
				)}
			</section>

			<section>
				<h3 style={{ fontSize: '0.95rem' }}>Retained conflicts</h3>
				{surveys?.some((s) => s.conflict) ? (
					<ul>
						{surveys
							.filter((s) => s.conflict)
							.map((s) => (
								<li key={s.conflict!.conflictId}>
									<strong>{s.claimType}</strong>: equal-authority sources disagree — retained, not
									auto-resolved ({s.conflict!.claimIds.length} readings).
								</li>
							))}
					</ul>
				) : (
					<p style={{ color: '#556' }}>{surveys ? 'No unresolved conflicts.' : ''}</p>
				)}
				{surveys?.some((s) => s.winner) ? (
					<p style={{ color: '#556', fontSize: '0.85rem' }}>
						Current readings:{' '}
						{surveys
							.filter((s) => s.winner)
							.map((s) => `${s.claimType}=${s.winner!.value}`)
							.join('; ')}
					</p>
				) : null}
			</section>

			<section>
				<h3 style={{ fontSize: '0.95rem' }}>Claims</h3>
				{claims?.length ? (
					<ul style={{ listStyle: 'none', padding: 0 }}>
						{claims.map((claim) => (
							<li key={claim.id} style={{ borderTop: '1px solid #eee', padding: '0.5rem 0' }}>
								<div>
									<code>{claim.claimType}</code> = {claim.value}
									{claim.status === 'superseded' ? (
										<span style={{ color: '#a60' }}> (superseded — history)</span>
									) : null}
								</div>
								<blockquote style={{ margin: '0.25rem 0', borderLeft: '3px solid #ccd', paddingLeft: 8 }}>
									“{claim.quote}”
									{claim.locator ? <em> — {claim.locator}</em> : null}
								</blockquote>
								<div style={{ color: '#556', fontSize: '0.8rem' }}>
									snapshot {claim.snapshotId.slice(0, 18)}… ({claim.snapshotProvenance}) hash{' '}
									{shortHash(claim.snapshotContentHash)} · {authority(claim.sourceAuthority)} ·{' '}
									extraction {claim.extractionVersion} · captured {when(claim.snapshotCapturedAt)}
								</div>
							</li>
						))}
					</ul>
				) : (
					<p style={{ color: '#556' }}>{claims ? 'No claims extracted.' : ''}</p>
				)}
			</section>
		</aside>
	);
}
