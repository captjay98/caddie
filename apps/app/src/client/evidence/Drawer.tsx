import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { formatTimeAgo } from '@caddie/ui/time';
import { authorityLabel, authorityRank, isSourceAuthority } from '../../server/evidence/authority.ts';
import { StatePanel } from '../states.tsx';
import { CopyableId } from '../copyable.tsx';

/**
 * P10 evidence inspector (feature-ledger H7) — rebuilt on the shared token
 * system and mounted at /evidence behind the project gate (UI review board
 * screen 09: this component had never been rendered by the product).
 *
 * Honesty rules rendered into the UI (contracts "UI and evidence"):
 *   - authority is shown from the ONE shared vocabulary (authority.ts) — the
 *     same module storage and reconciliation use — as RANK, not just a word:
 *     a chip carries label · rank, and UNKNOWN renders dashed with
 *     "never wins reconciliation";
 *   - every claim shows its EXACT snapshot id + content hash (full length,
 *     copyable — a hash you cannot copy cannot be verified) + quote +
 *     locator + provenance + extraction version;
 *   - freshness is the source's lastOutcome/observedAt rendered as a labelled
 *     status with a human timestamp and the exact ISO on demand — never the
 *     storage column name;
 *   - confidence numbers are NEVER displayed: a confidence number is not
 *     truth, authority + provenance are the weighing signals;
 *   - retained conflicts name BOTH sides (claim ids, values, sources,
 *     authority + rank) and the rule that kept them; they are never silently
 *     resolved.
 *
 * Each section loads and fails independently (board screen 09: one refused
 * fetch must never blank the other two), with its own skeleton, empty state
 * and typed retry.
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

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, { credentials: 'same-origin' });
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
		throw new Error(body.message ?? body.error ?? `request failed (${response.status})`);
	}
	return (await response.json()) as T;
}

function AuthorityChip({ value }: { value: string }): ReactElement {
	const known = isSourceAuthority(value);
	const rank = known ? authorityRank(value) : null;
	return (
		<span className={`badge${known ? '' : ' badge-unknown'}`} data-tone={known ? 'neutral' : 'roadmap'} title={known ? undefined : 'unknown authority never wins reconciliation'}>
			{known ? authorityLabel(value) : 'unknown'} · rank {rank ?? 'null'}
		</span>
	);
}

/** Full identifier + a copy affordance — truncation destroys checkability. */
function Ident({ value, label }: { value: string; label: string }): ReactElement {
	return <CopyableId value={value} label={label} />;
}

function SectionStates(props: {
	pending: boolean;
	empty: boolean;
	emptyTitle: string;
	emptyDetail: string;
	error: unknown;
	onRetry: () => void;
	children: ReactElement;
}): ReactElement | null {
	if (props.error) {
		return (
			<StatePanel
				flat
				kind="error"
				title="This section failed to load"
				detail={props.error instanceof Error ? props.error.message : undefined}
				onRetry={props.onRetry}
				retryLabel="Retry this section"
			/>
		);
	}
	if (props.pending) {
		return <StatePanel flat kind="loading" title="Reading this section…" />;
	}
	if (props.empty) {
		return <StatePanel flat kind="empty" title={props.emptyTitle} detail={props.emptyDetail} />;
	}
	return props.children;
}

export function EvidenceDrawer(props: { projectId: string; focusClaimType?: string }): ReactElement {
	const { projectId } = props;
	const queryClient = useQueryClient();
	const base = `/api/projects/${encodeURIComponent(projectId)}/evidence`;

	const sources = useQuery({
		queryKey: ['evidence-sources', projectId],
		queryFn: () => fetchJson<{ sources: EvidenceSource[] }>(`${base}/sources`),
	});
	const claims = useQuery({
		queryKey: ['evidence-claims', projectId],
		queryFn: () => fetchJson<{ claims: EvidenceClaim[] }>(`${base}/claims`),
	});
	const surveys = useQuery({
		queryKey: ['evidence-surveys', projectId],
		queryFn: () => fetchJson<{ surveys: EvidenceSurvey[] }>(`${base}/conflicts`),
	});

	const sourceList = sources.data?.sources ?? [];
	const claimList = claims.data?.claims ?? [];
	const surveyList = surveys.data?.surveys ?? [];
	const conflicts = surveyList.filter((survey) => survey.conflict);
	const winners = surveyList.filter((survey) => survey.winner);
	const claimsById = new Map(claimList.map((claim) => [claim.id, claim]));
	const activeClaims = claimList.filter((claim) => claim.status !== 'superseded');
	const historyClaims = claimList.filter((claim) => claim.status === 'superseded');
	// Caddie has read nothing at all: one honest intro instead of three empty
	// cards stacked in cards (owner steering, 2026-10-15).
	const sectionsSettled = !sources.isPending && !claims.isPending && !surveys.isPending;
	const nothingAtAll =
		sectionsSettled &&
		!sources.error &&
		!claims.error &&
		!surveys.error &&
		sourceList.length === 0 &&
		claimList.length === 0 &&
		surveyList.length === 0;

	function retry(section: 'sources' | 'claims' | 'surveys') {
		const key =
			section === 'sources' ? ['evidence-sources', projectId] : section === 'claims' ? ['evidence-claims', projectId] : ['evidence-surveys', projectId];
		void queryClient.refetchQueries({ queryKey: key });
	}

	return (
		<section className="evidence-panel settings-stack" aria-label="Evidence inspector" data-testid="evidence-drawer">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						PROVE
					</p>
					<h2 className="ev-title">What Caddie saw</h2>
					<p className="page-lede">
						Everything Caddie claims about this hackathon or your project, it saw somewhere — and it
						kept a copy. Each line below links back to exactly what it read, so nothing here is a guess.
						If a page refused to load, you'll see that too, with the reason.
					</p>
				</div>
				<span className="count">
					{sourceList.length} pages read · {activeClaims.length} things found · {conflicts.length} still unsettled
				</span>
			</div>

			{nothingAtAll ? (
				<StatePanel
					flat
					kind="empty"
					title="Nothing yet — Caddie hasn't read anything for this project"
					detail="As soon as Caddie reads a hackathon's rules page, your repo, or any page it builds on, it shows up here: the facts it found, the pages it read, and whether each page opened cleanly — each with a link back to the exact source, so nothing is a guess."
				/>
			) : (
				<>
				<section className="evidence-section" data-testid="evidence-conflicts-section">
					<h3 className="ev-head">Still unsettled</h3>
					<p className="state-detail">
						Two sources Caddie trusts equally said different things. It keeps both instead of quietly
						picking one — resolve it in the chat when it matters.
					</p>
					<SectionStates
					pending={surveys.isPending}
					empty={conflicts.length === 0 && winners.length === 0}
					emptyTitle="Nothing read yet"
					emptyDetail="As soon as Caddie reads a hackathon's rules page or your repo, what it saw shows up here — with a link back to the exact page."
					error={surveys.error}
					onRetry={() => retry('surveys')}
				>
					<>
						{conflicts.map((survey) => {
							const sides = survey.conflict!.claimIds
								.map((claimId) => claimsById.get(claimId))
								.filter((claim): claim is EvidenceClaim => claim != null);
							const historyAvailable = claims.isPending || claims.error != null;
							return (
								<div key={survey.conflict!.conflictId} className="ev-conflict" data-testid="evidence-conflict">
									<b>Retained — winner is null.</b> Sources of equal authority state different
									{' '}
									{survey.claimType} values, so neither outranks the other and the disagreement is
									kept instead of being resolved. Nothing has been built on either reading.
									{sides.length === 0 && !historyAvailable ? (
										<p className="state-detail">
											The conflicting claim rows are not loaded — retry the claims section below.
										</p>
									) : (
										<div className="ev-sides">
											{sides.map((claim) => (
												<ClaimRow key={claim.id} claim={claim} />
											))}
										</div>
									)}
								</div>
							);
						})}
						{winners.length > 0 ? (
							<p className="mono-id" data-testid="evidence-winners">
								Current readings with a winner:{' '}
								{winners.map((survey) => `${survey.claimType} = ${survey.winner!.value}`).join(' · ')}
								. Unknown authority has no rank: it can never win a reconciliation.
							</p>
						) : null}
					</>
				</SectionStates>
			</section>

			<section className="evidence-section" data-testid="evidence-claims-section">
				<h3 className="ev-head">What Caddie found</h3>
				<SectionStates
					pending={claims.isPending}
					empty={claimList.length === 0}
					emptyTitle="Nothing found yet"
					emptyDetail="When Caddie reads a page, the facts it picks up — a deadline, who can enter, what to submit — land here. It never fills this in from memory."
					error={claims.error}
					onRetry={() => retry('claims')}
				>
					<>
						{activeClaims.length > 0 ? (
							<div className="row-list">
								{activeClaims.map((claim) => (
									<ClaimRow key={claim.id} claim={claim} />
								))}
							</div>
						) : (
							<p className="state-detail">No active claims — every extracted reading has been superseded.</p>
						)}
						{historyClaims.length > 0 ? (
							<details className="ev-history" data-testid="evidence-history">
								<summary className="kicker">
									EARLIER READINGS ({historyClaims.length}) — replaced by a newer read, kept so you can see what changed
								</summary>
								<div className="row-list">
									{historyClaims.map((claim) => (
										<ClaimRow key={claim.id} claim={claim} />
									))}
								</div>
							</details>
						) : null}
					</>
				</SectionStates>
			</section>

			<section className="evidence-section" data-testid="evidence-sources-section">
				<h3 className="ev-head">Pages Caddie read — and whether they still open</h3>
				<SectionStates
					pending={sources.isPending}
					empty={sourceList.length === 0}
					emptyTitle="No pages yet"
					emptyDetail="The pages Caddie checks — a rules page, your repo — show up here, each with whether it opened cleanly or refused to load."
					error={sources.error}
					onRetry={() => retry('sources')}
				>
					<div className="row-list">
						{sourceList.map((source) => (
							<div key={source.id} className="inspector-row" data-testid="evidence-source">
								<div className="row-main">
									<span className="row-title">{source.displayName ?? source.canonicalUrl}</span>
									<AuthorityChip value={source.authority} />
								</div>
								<div className="row-details">
									<span className="mono-id">{source.canonicalUrl}</span>
									<span className="mono-id" data-testid="evidence-source-freshness">
										{source.lastOutcome === 'succeeded' ? 'read ok' : source.lastOutcome === 'blocked' ? 'blocked' : source.lastOutcome === 'failed' ? 'failed' : source.lastOutcome === 'unchanged' ? 'unchanged' : 'never attempted a successful fetch'}
										{source.observedAt ? ` · observed ${formatTimeAgo(source.observedAt)}` : ''}
										{source.lastFailureReason ? ` · ${source.lastFailureReason}` : ''}
									</span>
									{source.latestSnapshotId ? (
										<span className="ev-field">
											<span className="fk">latest snapshot</span>
											<Ident value={source.latestSnapshotId} label="snapshot id" />
											<Ident value={source.latestContentHash ?? ''} label="content hash" />
										</span>
									) : (
										<span className="mono-id">no snapshot yet</span>
									)}
								</div>
							</div>
						))}
					</div>
					</SectionStates>
			</section>
				</>
			)}
		</section>
	);
}

function ClaimRow({ claim }: { claim: EvidenceClaim }): ReactElement {
	return (
		<div className="inspector-row ev-claim" data-testid="evidence-claim" data-status={claim.status}>
			<div className="row-main">
				<span className="row-title">
					<code>{claim.claimType}</code> = {claim.value}
					{claim.status === 'superseded' ? <span className="mono-id"> · superseded — history</span> : null}
				</span>
				<AuthorityChip value={claim.sourceAuthority} />
			</div>
			<blockquote className="ev-quote">
				“{claim.quote}”
				{claim.locator ? <em> — {claim.locator}</em> : null}
			</blockquote>
			<details className="ev-devdetail">
				<summary className="kicker">For developers — exact snapshot &amp; hash</summary>
				<div className="row-details">
				<span className="ev-field">
					<span className="fk">claim id</span>
					<Ident value={claim.id} label="claim id" />
				</span>
				<span className="ev-field">
					<span className="fk">snapshot</span>
					<Ident value={claim.snapshotId} label="snapshot id" />
				</span>
				<span className="ev-field">
					<span className="fk">content hash</span>
					<Ident value={claim.snapshotContentHash} label="content hash" />
				</span>
				<span className="ev-field">
					<span className="fk">provenance</span>
					<span className="fv mono">{claim.snapshotProvenance}</span>
				</span>
				<span className="ev-field">
					<span className="fk">extraction</span>
					<span className="fv mono">{claim.extractionVersion}</span>
				</span>
				<span className="ev-field">
					<span className="fk">captured</span>
					<span className="fv">
						{formatTimeAgo(claim.snapshotCapturedAt)} · <span className="mono-id">{claim.snapshotCapturedAt}</span>
					</span>
				</span>
				{claim.status === 'superseded' && claim.supersededBy ? (
					<span className="ev-field">
						<span className="fk">superseded by</span>
						<Ident value={claim.supersededBy} label="superseding claim id" />
					</span>
				) : null}
				<span className="mono-id">{claim.canonicalUrl}</span>
			</div>
			</details>
		</div>
	);
}