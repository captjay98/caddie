import { useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { formatTimeAgo } from '@caddie/ui/time';
import { fetchJson } from '../api.ts';
import { StatePanel, failureKind } from '../states.tsx';
import { Icon } from '../icons.tsx';
import { CopyableId } from '../copyable.tsx';

/**
 * ArtifactViewer — revisions list, line-diff view and downloads over the
 * REAL P07 artifact surface (feature-ledger C13: the plan/spec viewer with
 * versioned, hash-addressed revisions), rebuilt per UI review board
 * screen 10:
 *
 *   - the diff gets a visual grammar: token tints for add/del, line numbers,
 *     pre-wrap spacing, a header echoing the compared pair with its +/− counts;
 *   - status becomes a state, not a word: current/stale use the tone grammar;
 *   - the hash is shown IN FULL beside a copy action — content-addressed bytes
 *     must be checkable;
 *   - the download states its consequence (a verifiable local file; nothing
 *     is published) and goes through the authenticated client, so a dead
 *     session surfaces as a typed failure with a retry instead of a
 *     top-level JSON error page.
 *
 * Presentational + explicit state: data arrives via props (the shell wires
 * queries), every failure renders the shared state grammar, and the two
 * server authorities — immutable bytes (sha256 per row) and the
 * server-computed diff — are consumed through the real routes:
 *
 *   GET /api/projects/:id/artifact-revisions/:toId/diff?from=<id>
 *   GET /api/projects/:id/artifact-revisions/:id/download   (sandboxed export)
 */

export interface ViewerRevision {
	readonly id: string;
	readonly kind: string;
	readonly planRevision: number;
	readonly sha256: string;
	readonly size: number;
	readonly contentType: string;
	readonly filename: string;
	/** 'stale' = a newer plan revision exists; marked, never erased. */
	readonly status: 'current' | 'stale';
	readonly createdAt: string;
}

interface DiffLine {
	readonly type: 'context' | 'add' | 'del';
	readonly text: string;
}

interface DiffPayload {
	readonly from: { id: string };
	readonly to: { id: string };
	readonly lines: readonly DiffLine[];
}

function shortHash(sha256: string): string {
	const hex = sha256.startsWith('sha256-') ? sha256.slice(7) : sha256;
	return hex.slice(0, 12);
}

function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function optionLabel(revision: ViewerRevision): string {
	return `r${revision.planRevision} · ${revision.filename} · ${shortHash(revision.sha256)}`;
}

export function ArtifactViewer(props: {
	projectId: string;
	/** Newest first, matching the list route's ordering. */
	revisions: readonly ViewerRevision[];
	isPending?: boolean;
	error?: unknown;
	retry?: () => void;
}): ReactElement {
	const [fromId, setFromId] = useState<string>(() => props.revisions[1]?.id ?? '');
	const [toId, setToId] = useState<string>(() => props.revisions[0]?.id ?? '');
	const [diff, setDiff] = useState<DiffPayload | null>(null);
	const [diffBusy, setDiffBusy] = useState(false);
	const [diffError, setDiffError] = useState<string | null>(null);
	const [downloadError, setDownloadError] = useState<string | null>(null);
	const [downloading, setDownloading] = useState<string | null>(null);

	const loadDiff = async () => {
		if (!fromId || !toId || fromId === toId) return;
		setDiffBusy(true);
		setDiffError(null);
		try {
			const payload = await fetchJson<{ diff: DiffPayload }>(
				`/api/projects/${encodeURIComponent(props.projectId)}/artifact-revisions/${encodeURIComponent(toId)}/diff?from=${encodeURIComponent(fromId)}`,
			);
			setDiff(payload.diff);
		} catch (error) {
			setDiff(null);
			setDiffError(error instanceof Error ? error.message : 'The diff could not be computed.');
		} finally {
			setDiffBusy(false);
		}
	};

	/** Authenticated download: a dead session is a typed failure, never a
	 * top-level JSON error page replacing the workspace. The anchor keeps its
	 * real href (save-as and deep links stay possible); the click goes through
	 * the authenticated client instead. */
	const download = async (revision: ViewerRevision, event: MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		setDownloadError(null);
		setDownloading(revision.id);
		try {
			const response = await fetch(
				`/api/projects/${encodeURIComponent(props.projectId)}/artifact-revisions/${encodeURIComponent(revision.id)}/download`,
				{ credentials: 'same-origin' },
			);
			if (!response.ok) {
				const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
				throw new Error(body.message ?? body.error ?? `download failed (${response.status})`);
			}
			const bytes = await response.blob();
			const url = URL.createObjectURL(bytes);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = revision.filename;
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
		} catch (error) {
			setDownloadError(
				error instanceof Error
					? `${error.message} — the export was not produced; nothing was written or published.`
					: 'The export failed; nothing was written or published.',
			);
		} finally {
			setDownloading(null);
		}
	};

	if (props.isPending) {
		return (
			<div data-testid="artifact-viewer">
				<StatePanel kind="loading" />
			</div>
		);
	}
	if (props.error) {
		return (
			<div data-testid="artifact-viewer">
				<StatePanel
					kind={failureKind(props.error)}
					detail={props.error instanceof Error ? props.error.message : undefined}
					onRetry={props.retry}
				/>
			</div>
		);
	}
	if (props.revisions.length === 0) {
		return (
			<div data-testid="artifact-viewer">
				<StatePanel
					kind="empty"
					title="No artifact revisions yet"
					detail="Plan, test-result, browser-capture and diff revisions land here, content-addressed by SHA-256."
				/>
			</div>
		);
	}

	const fromRevision = props.revisions.find((revision) => revision.id === fromId);
	const toRevision = props.revisions.find((revision) => revision.id === toId);
	const addCount = diff ? diff.lines.filter((line) => line.type === 'add').length : 0;
	const delCount = diff ? diff.lines.filter((line) => line.type === 'del').length : 0;

	return (
		<div data-testid="artifact-viewer" className="artifact-panel settings-stack">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						content-addressed
					</p>
					<h2 className="ev-title">Artifact revisions</h2>
				</div>
				<span className="count">{props.revisions.length} immutable</span>
			</div>
			<div className="row-list">
				{props.revisions.map((revision) => (
					<div
						className="inspector-row"
						data-testid="artifact-revision-row"
						data-status={revision.status}
						key={revision.id}
					>
						<div className="row-main">
							<span className="row-title">
								{revision.kind} <span className="mono-id">r{revision.planRevision}</span> · {revision.filename}
							</span>
							<span className="badge" data-tone={revision.status === 'stale' ? 'warn' : 'ok'} data-testid="artifact-revision-status">
								{revision.status === 'stale' ? 'stale — newer plan revision exists' : 'current'}
							</span>
						</div>
						<div className="row-details">
							<span className="ev-field">
								<span className="fk">bytes sha-256</span>
								<CopyableId value={revision.sha256} label="content hash" />
							</span>
							<span className="mono-id">
								{humanSize(revision.size)} · {revision.contentType} · captured {formatTimeAgo(revision.createdAt)}
							</span>
						</div>
						<div className="row-actions">
							<a
								className="btn-ghost"
								href={`/api/projects/${encodeURIComponent(props.projectId)}/artifact-revisions/${encodeURIComponent(revision.id)}/download`}
								download={revision.filename}
								data-testid="artifact-download"
								data-revision={revision.id}
								aria-disabled={downloading === revision.id}
								onClick={(event) => void download(revision, event)}
							>
								<Icon name="download" title="download verified copy" />
								{downloading === revision.id ? 'Exporting…' : `Download ${revision.filename}`}
							</a>
							<span className="mono-id">produces a verifiable local file · nothing is published</span>
						</div>
					</div>
				))}
			</div>
			{downloadError ? (
				<StatePanel kind="error" title="The export failed" detail={downloadError} />
			) : null}

			<section className="card-surface settings-panel">
				<h3 className="ev-head">Compare revisions — server-computed, never implied</h3>
				<div className="row" data-testid="artifact-diff-controls">
					<label>
						<span className="mono-id">from</span>
						<select
							className="input"
							value={fromId}
							onChange={(event) => {
								setFromId((event.target as HTMLSelectElement).value);
								setDiff(null);
							}}
							data-testid="artifact-diff-from"
						>
							{props.revisions.map((revision) => (
								<option value={revision.id} key={revision.id}>
									{optionLabel(revision)}
								</option>
							))}
						</select>
					</label>
					<label>
						<span className="mono-id">to</span>
						<select
							className="input"
							value={toId}
							onChange={(event) => {
								setToId((event.target as HTMLSelectElement).value);
								setDiff(null);
							}}
							data-testid="artifact-diff-to"
						>
							{props.revisions.map((revision) => (
								<option value={revision.id} key={revision.id}>
									{optionLabel(revision)}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						className="btn-key"
						disabled={diffBusy || !fromId || !toId || fromId === toId}
						onClick={() => void loadDiff()}
						data-testid="artifact-diff-show"
					>
						{diffBusy ? 'Diffing…' : 'Show diff'}
					</button>
				</div>
				{diffError ? (
					<StatePanel kind="error" title="Diff failed" detail={diffError} />
				) : diff ? (
					<div className="diff-view" data-testid="artifact-diff-view">
						<p className="mono-id">
							{fromRevision ? optionLabel(fromRevision) : fromId} → {toRevision ? optionLabel(toRevision) : toId} · +
							{addCount} −{delCount}
						</p>
						<div className="diff-body">
							{diff.lines.length === 0 ? (
								<span className="mono-id">identical content — stated, never implied</span>
							) : (
								diff.lines.map((line, index) => (
									<span className="diff-line" data-diff-type={line.type} key={index}>
										<span className="ln">{index + 1}</span>
										<span className="tx">
											{line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
											{line.text}
										</span>
									</span>
								))
							)}
						</div>
					</div>
				) : null}
			</section>
		</div>
	);
}