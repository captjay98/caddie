import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import * as v from 'valibot';
import { GuidedStepsCardSchema, type JoinStep } from '@caddie/contracts';
import { Icon } from '../icons.tsx';
import { postJson } from '../api.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { useGithubImports, usePlanDocRevisions } from '../queries.ts';
import { RepositoryPicker, type SelectedRepository } from '../repositories/RepositoryPicker.tsx';
import { deriveJoinSteps, joinStepsComplete, readGithubSkipped, writeGithubSkipped } from '../join/progress.ts';

/**
 * In-chat guided join → build → GitHub card (packet R-guided-steps).
 *
 * The coordinator emits a `data-guidedSteps` part carrying ONLY the project id
 * + contest context. The card then reads LIVE server state (a connected repo,
 * a plan draft) and the per-project GitHub-skip flag, derives the three steps
 * with the SAME deriveJoinSteps the Overview stepper uses, and renders exactly
 * one actionable step. State is never trusted from the payload — a reload
 * reflects the server, mirroring the ApprovalCard contract.
 *
 * GitHub step actions: Create a new repo (private/public), Connect an existing
 * one (the real RepositoryPicker), or Skip for now (reversible, client-local).
 * Skipping never walls the Build step. Build routes to the project's Plan.
 */

export const GuidedStepsCardData = GuidedStepsCardSchema;
export type GuidedStepsCardPayload = v.InferOutput<typeof GuidedStepsCardSchema>;

export function GuidedStepsCardView(props: { data: GuidedStepsCardPayload }): ReactElement {
	const { data } = props;
	const chrome = useWorkspaceChrome();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const project = chrome.buildProjects.find((p) => p.id === data.projectId) ?? null;

	// Live signals (real server state) — never the frozen payload.
	const imports = useGithubImports(actor, data.projectId);
	const planDocs = usePlanDocRevisions(actor, data.projectId);
	const [skipped, setSkipped] = useState(() => readGithubSkipped(data.projectId));
	const [ghMode, setGhMode] = useState<'idle' | 'create' | 'connect'>('idle');

	const hasRepo = (imports.data?.imports.length ?? 0) > 0;
	const hasPlanDraft = (planDocs.data?.revisions.length ?? 0) > 0;

	const steps = useMemo(
		() => deriveJoinSteps({ projectExists: !!project, hasRepo, githubSkipped: skipped, hasPlanDraft }),
		[project, hasRepo, skipped, hasPlanDraft],
	);
	const complete = joinStepsComplete(steps);

	function onSkip() {
		writeGithubSkipped(data.projectId, true);
		setSkipped(true);
		setGhMode('idle');
	}

	function onConnected() {
		// A connected repo supersedes a skip; refetch imports so hasRepo flips.
		writeGithubSkipped(data.projectId, false);
		setSkipped(false);
		void imports.refetch();
		setGhMode('idle');
	}

	function onShapeBuild() {
		chrome.goProjectTab('/project', { project: data.projectId, view: 'plan' });
	}

	return (
		<section className="guided-steps card-surface" data-testid="guided-steps-card">
			<header className="guided-steps-head">
				<p className="guided-steps-kick">You're in — here's the path</p>
				<p className="guided-steps-ctx">
					{data.contestUrl ? (
						<a href={data.contestUrl} target="_blank" rel="noreferrer noopener">
							{data.contestTitle}
						</a>
					) : (
						data.contestTitle
					)}
					{data.contestContext ? <span className="guided-steps-sub">{data.contestContext}</span> : null}
				</p>
			</header>

			<ol className="guided-steps-list" data-testid="guided-steps-list">
				{steps.map((step) => (
					<li
						key={step.id}
						className={`guided-step guided-step--${step.state}`}
						data-testid={`guided-step-${step.id}`}
						data-state={step.state}
					>
						<span className="guided-step-mark" aria-hidden="true">
							{step.state === 'done' ? (
								<Icon name="check" title="Done" />
							) : step.state === 'skipped' ? (
								<Icon name="x" title="Skipped" />
							) : step.id === 'github' ? (
								<Icon name="github" title="GitHub" />
							) : step.id === 'build' ? (
								<Icon name="target" title="Build" />
							) : (
								<Icon name="check" title="Project" />
							)}
						</span>
						<div className="guided-step-body">
							<p className="guided-step-title">{step.title}</p>
							<p className="guided-step-detail">{step.detail}</p>
							{step.id === 'github' && step.state === 'active' ? (
								<GithubStepActions
									project={project}
									projectId={data.projectId}
									mode={ghMode}
									setMode={setGhMode}
									onSkip={onSkip}
									onConnected={onConnected}
								/>
							) : null}
							{step.id === 'build' && step.state === 'active' ? (
								<div className="guided-step-actions">
									<button type="button" className="btn-key" data-testid="guided-shape-build" onClick={onShapeBuild}>
										Shape the first step
									</button>
								</div>
							) : null}
						</div>
						<span className="guided-step-pill" data-testid={`guided-step-pill-${step.id}`}>
							{step.state === 'done' ? 'Done' : step.state === 'skipped' ? 'Skipped' : step.state === 'active' ? '' : 'Next'}
						</span>
					</li>
				))}
			</ol>

			{complete ? (
				<p className="guided-steps-foot" data-testid="guided-steps-complete">
					You're set up. {data.contestUrl ? 'Remember to register on the contest site before the deadline.' : ''}
				</p>
			) : null}
		</section>
	);
}

function GithubStepActions(props: {
	project: { id: string; workspaceId: string } | null;
	projectId: string;
	mode: 'idle' | 'create' | 'connect';
	setMode: (m: 'idle' | 'create' | 'connect') => void;
	onSkip: () => void;
	onConnected: () => void;
}): ReactElement {
	const { project, projectId, mode, setMode } = props;
	const [name, setName] = useState('');
	const [visibility, setVisibility] = useState<'private' | 'public'>('private');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// A create needs a bound installation; the RepositoryPicker surfaces it and
	// reports the chosen installation up. Until one is chosen, create is blocked
	// with a clear message (Connect binds an account first).
	const [installationId, setInstallationId] = useState<string | null>(null);

	async function createRepo() {
		if (busy) return;
		const trimmed = name.trim();
		if (!trimmed) {
			setError('Give the repo a name.');
			return;
		}
		if (!installationId) {
			setError('Choose a GitHub account above first, then create the repo.');
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await postJson(`/api/projects/${encodeURIComponent(projectId)}/github/repos`, {
				installationId,
				name: trimmed,
				visibility,
			});
			props.onConnected();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function connectRepo(sel: SelectedRepository) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await postJson(`/api/projects/${encodeURIComponent(projectId)}/github/repo/connect`, {
				installationId: sel.installationId,
				repoFullName: sel.repoFullName,
			});
			props.onConnected();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	if (mode === 'idle') {
		return (
			<div className="guided-step-actions" data-testid="guided-github-actions">
				<button type="button" className="btn-key" data-testid="guided-github-create" onClick={() => setMode('create')}>
					Create a repo
				</button>
				<button type="button" className="btn-ghost" data-testid="guided-github-connect" onClick={() => setMode('connect')}>
					Connect existing
				</button>
				<button type="button" className="btn-ghost guided-skip" data-testid="guided-github-skip" onClick={props.onSkip}>
					Skip for now
				</button>
			</div>
		);
	}

	if (mode === 'create') {
		return (
			<form
				className="guided-github-create-form"
				data-testid="guided-github-create-form"
				onSubmit={(e) => {
					e.preventDefault();
					void createRepo();
				}}
			>
				{/* Binding a GitHub account is a precondition for creating under it. */}
				{project ? (
					<RepositoryPicker
						workspaceId={project.workspaceId}
						onSelected={(sel) => setInstallationId(sel.installationId)}
					/>
				) : null}
				<label className="kicker" htmlFor="guided-repo-name">
					Repo name
				</label>
				<input
					id="guided-repo-name"
					className="input"
					data-testid="guided-repo-name"
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					placeholder="my-hackathon-project"
				/>
				<div className="guided-visibility" role="radiogroup" aria-label="Visibility">
					<button
						type="button"
						role="radio"
						aria-checked={visibility === 'private'}
						className="disc-filter"
						data-testid="guided-visibility-private"
						onClick={() => setVisibility('private')}
					>
						Private
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={visibility === 'public'}
						className="disc-filter"
						data-testid="guided-visibility-public"
						onClick={() => setVisibility('public')}
					>
						Public
					</button>
				</div>
				{error ? (
					<p role="alert" className="guided-step-error" data-testid="guided-github-error">
						{error}
					</p>
				) : null}
				<div className="guided-step-actions">
					<button type="submit" className="btn-key" data-testid="guided-create-submit" disabled={busy}>
						{busy ? 'Creating…' : 'Create repo'}
					</button>
					<button type="button" className="btn-ghost" onClick={() => setMode('idle')} disabled={busy}>
						Back
					</button>
				</div>
			</form>
		);
	}

	// connect
	return (
		<div className="guided-github-connect" data-testid="guided-github-connect-panel">
			{project ? (
				<RepositoryPicker workspaceId={project.workspaceId} onSelected={(sel) => void connectRepo(sel)} />
			) : (
				<p role="alert" className="guided-step-error">
					No build project in scope to connect a repo to.
				</p>
			)}
			{error ? (
				<p role="alert" className="guided-step-error" data-testid="guided-github-error">
					{error}
				</p>
			) : null}
			<div className="guided-step-actions">
				<button type="button" className="btn-ghost" onClick={() => props.setMode('idle')} disabled={busy}>
					Back
				</button>
			</div>
		</div>
	);
}
