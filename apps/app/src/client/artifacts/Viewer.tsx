import { useState } from 'react';
import type { ReactElement } from 'react';
import { formatTimeAgo } from '@caddie/ui/time';
import { fetchJson } from '../api.ts';
import { StatePanel, failureKind } from '../states.tsx';

/**
 * ArtifactViewer — revisions list, line-diff view and download links over the
 * REAL P07 artifact surface (feature-ledger C13: the plan/spec viewer with
 * versioned, hash-addressed revisions).
 *
 * Presentational + explicit state: data arrives via props (the shell wires
 * queries), every failure renders the shared state grammar, and the two
 * server authorities — immutable bytes (sha256 shown per row) and the
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

	return (
		<div data-testid="artifact-viewer">
			<div className="section-head">
				<h3>Artifact revisions</h3>
				<span className="mono-id">{props.revisions.length} immutable</span>
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
								{revision.kind} <span className="mono-id">r{revision.planRevision}</span>
								{revision.status === 'stale' ? (
									<span className="row-status" data-status="stale">
										stale
									</span>
								) : null}
							</span>
							<span className="mono-id">{formatTimeAgo(revision.createdAt)}</span>
						</div>
						<div className="row-main">
							<span className="mono-id">{revision.filename}</span>
							<span className="mono-id">
								{shortHash(revision.sha256)} · {humanSize(revision.size)} · {revision.contentType}
							</span>
						</div>
						<a
							className="detail-toggle"
							href={`/api/projects/${encodeURIComponent(props.projectId)}/artifact-revisions/${encodeURIComponent(revision.id)}/download`}
							download={revision.filename}
							data-testid="artifact-download"
						>
							Download {revision.filename}
						</a>
					</div>
				))}
			</div>

			<div className="section-head">
				<h3>Compare revisions</h3>
			</div>
			<div className="row-main" data-testid="artifact-diff-controls">
				<label>
					<span className="mono-id">from</span>
					<select
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
					className="btn-ghost"
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
				<div className="row-details" data-testid="artifact-diff-view">
					{diff.lines.length === 0 ? (
						<span className="mono-id">identical content</span>
					) : (
						diff.lines.map((line, index) => (
							<span className="mono-id" data-diff-type={line.type} key={index}>
								{line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
								{line.text}
							</span>
						))
					)}
				</div>
			) : null}
		</div>
	);
}
