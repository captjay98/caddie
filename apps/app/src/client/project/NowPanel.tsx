import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import * as v from 'valibot';
import { ProjectExperienceSchema } from '@caddie/contracts';
import { postJson } from '../api.ts';
import { useProjectExperience } from '../queries.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { nowPanelModel, type NowButton } from './now-panel.ts';
import { BuildProgress } from './BuildProgress.tsx';
import { SavedFeatures } from './FeatureChecklist.tsx';

/**
 * The project page's "Now" panel: what Caddie is doing on this project right
 * now and the one thing to do next, read from the shared ProjectExperience
 * projection (polled, so a running plan or build stays live). Renders
 * `fallback` when the project has no workflow yet.
 */
export function NowPanel(props: { projectId: string; fallback: ReactElement }): ReactElement {
	const chrome = useWorkspaceChrome();
	const experience = useProjectExperience({ actorId: chrome.actorId }, props.projectId);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const retryKey = useRef<string | null>(null);

	if (experience.isPending) {
		return (
			<section className="card-surface settings-panel now-panel" data-testid="overview-now" aria-busy="true">
				<p className="state-detail">Checking what Caddie is doing…</p>
			</section>
		);
	}
	if (experience.error || !experience.data) return props.fallback;
	// Never render from a payload that is not the contract shape (a stale
	// server, a proxy error page parsed as JSON): fall back to the next step.
	const parsed = v.safeParse(ProjectExperienceSchema, experience.data);
	if (!parsed.success) return props.fallback;
	const model = nowPanelModel(parsed.output, Date.now());
	if (!model) return props.fallback;
	const stage = parsed.output.stage;

	async function run(button: NowButton) {
		const search = { project: props.projectId };
		if (button.route.kind === 'tab') return chrome.goProjectTab(button.route.to, search);
		if (button.route.kind === 'chat') return chrome.openProject(props.projectId, true);
		setBusy(true);
		setError(null);
		try {
			const base = `/api/projects/${encodeURIComponent(props.projectId)}/${button.route.path}`;
			if (button.route.path === 'workflow/retry') {
				// Same key until a retry succeeds, so a double click or a resend is one retry.
				retryKey.current ??= `resume:${crypto.randomUUID()}`;
				await postJson(base, { key: retryKey.current });
				retryKey.current = null;
			} else {
				await postJson(base, {});
			}
			chrome.refreshAll();
			await experience.refetch();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'Caddie could not do that just now.');
		} finally {
			setBusy(false);
		}
	}

	return (
		<section
			className="card-surface settings-panel now-panel"
			data-testid="overview-now"
			data-stage={stage}
			data-working={model.working ? 'true' : 'false'}
		>
			<p className="now-head">
				{model.working ? <span className="now-live" aria-hidden="true" /> : null}
				<span className="kicker" data-tone="action">
					Now
				</span>
				{model.updated ? (
					<span className="now-updated" data-testid="overview-now-updated">
						{model.updated}
					</span>
				) : null}
			</p>
			<h2 className="ev-title" data-testid="overview-now-title">
				{model.title}
			</h2>
			<p className="page-lede" data-testid="overview-now-message" role="status">
				{model.message}
			</p>
			{stage === 'building' || stage === 'checking' || stage === 'repairing' ? (
				<BuildProgress actorId={chrome.actorId} projectId={props.projectId} />
			) : null}
			{(stage === 'ready' || stage === 'blocked' || stage === 'stopped') && chrome.actorId ? (
				<SavedFeatures actorId={chrome.actorId} projectId={props.projectId} />
			) : null}
			{model.buttons.length ? (
				<div className="row-actions">
					{model.buttons.map((button) => (
						<button
							key={button.kind}
							type="button"
							className={button.primary ? 'btn-key' : 'btn-ghost'}
							data-testid={`overview-now-${button.kind}`}
							disabled={!button.enabled || busy}
							title={button.reason ?? undefined}
							onClick={() => void run(button)}
						>
							{button.label}
						</button>
					))}
				</div>
			) : null}
			{model.buttons.some((b) => !b.enabled && b.reason) ? (
				<p className="state-detail">{model.buttons.find((b) => !b.enabled && b.reason)?.reason}</p>
			) : null}
			{error ? (
				<p role="alert" className="state-detail">
					{error}
				</p>
			) : null}
		</section>
	);
}
