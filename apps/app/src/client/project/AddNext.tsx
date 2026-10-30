import { useRef, useState, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { postJson } from '../api.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { workflowQueryOptions } from '../workflow-query.ts';
import { addNextView } from './add-next.ts';

/**
 * "Add next" on a finished app (staged builds, owner 2026-10-30): the next
 * idea from the approved plan with one tap, the time it takes, and the
 * promise that the app stays as it is until the new version passes. Compact
 * in the chat card (one suggestion); the project page lists every idea.
 */
export function AddNext({ projectId, compact = false }: { projectId: string; compact?: boolean }): ReactElement | null {
	const chrome = useWorkspaceChrome();
	const state = useQuery(workflowQueryOptions(chrome.actorId, projectId));
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showAll, setShowAll] = useState(false);
	// One key per item until its add lands, so a double tap starts one build.
	const keys = useRef(new Map<string, string>());
	const snapshot = state.data;
	if (!snapshot?.workflow || snapshot.workflow.phase !== 'ready' || !snapshot.workflow.previewId) return null;
	const view = addNextView(snapshot.planStages, snapshot.change);
	if (!view.next && !view.waiting.length) return null;

	async function add(featureId: string) {
		if (busy) return;
		const key = keys.current.get(featureId) ?? `add:${crypto.randomUUID()}`;
		keys.current.set(featureId, key);
		setBusy(featureId);
		setError(null);
		try {
			await postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/add-item`, { featureId, key });
			keys.current.delete(featureId);
			chrome.refreshAll();
			await state.refetch();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'That didn’t go through. Try again in a moment.');
		} finally {
			setBusy(null);
		}
	}

	const button = (featureId: string, label: string, primary: boolean) => (
		<button type="button" className={primary ? 'btn-key' : 'btn-ghost'} disabled={busy !== null} onClick={() => void add(featureId)} data-testid={`add-item-${featureId}`}>
			{busy === featureId ? 'Starting…' : label}
		</button>
	);

	return (
		<section className="add-next" data-testid="add-next" aria-label="Add the next part of your app">
			{view.failed ? <p className="add-next-failed" role="status">Caddie couldn’t add “{view.failed}” this time. Your app is unchanged.</p> : null}
			{view.next ? (
				<div className="add-next-row">
					<p className="add-next-title">
						<span className="add-next-kicker">Next</span>
						<span>{view.next.title}</span>
						<span className="add-next-time">· about {view.next.minutes} min</span>
					</p>
					{button(view.next.id, view.failed === view.next.title ? 'Try again' : 'Add this', true)}
				</div>
			) : null}
			<p className="add-next-note">Your app stays as it is until the new version passes its checks.</p>
			{!compact && (view.others.length || view.waiting.length) ? (
				<>
					<button type="button" className="add-next-more" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
						{showAll ? 'Hide other ideas' : `Other ideas · ${view.others.length + view.waiting.length}`}
					</button>
					{showAll ? (
						<ul className="add-next-list">
							{view.others.map((item) => (
								<li key={item.id}>
									<span>{item.title} <span className="add-next-time">· about {item.minutes} min</span></span>
									{button(item.id, 'Add this', false)}
								</li>
							))}
							{view.waiting.map((item) => (
								<li key={item.id} data-waiting="">
									<span>{item.title}</span>
									<span className="add-next-time">Needs “{item.needs.join('”, “')}” first</span>
								</li>
							))}
						</ul>
					) : null}
				</>
			) : null}
			{error ? <p className="form-error" role="alert">{error}</p> : null}
		</section>
	);
}
