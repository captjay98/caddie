import { planReviewState } from '../planning/plan-decision.ts';
import { buildPresentation } from '../project/build-presentation.ts';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { preparationLines } from '../project/preparation-progress.ts';
import { postJson } from '../api.ts';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useSearch } from '@tanstack/react-router';
import { useBuildActivity } from '../queries.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { workflowQueryOptions } from '../workflow-query.ts';
import { CardHeader } from '../brief/CardFrame.tsx';
import type { CardDesign } from '../brief/card-design.ts';
import { featureName, hasFeatureList } from '../project/FeatureChecklist.tsx';
import { importedAppTitle } from '../project/ImportedApp.tsx';
import { ProjectDialog } from '../project/ProjectDialog.tsx';
import { ProjectWorkflow } from './ProjectWorkflow.tsx';
import { pausedPreparation } from '../../shared/preparation-stage.ts';
import { AskForChange } from '../project/AskForChange.tsx';
import { AddNext } from '../project/AddNext.tsx';

const EVER_APPROVED = new Set(['approved', 'revoked', 'expired']);

/** A live project pointer: the workspace owns approvals, previews and tools. */
export function ProjectChatSummary({ projectId, name }: {
	projectId: string;
	name?: string;
}): ReactElement | null {
	const chrome = useWorkspaceChrome();
	const [reviewOpen, setReviewOpen] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | null>(null);
	const retryKey = useRef<string | null>(null);
	// Ticks the "Started N min ago" line while a step is being prepared.
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => { const timer = setInterval(() => setNowMs(Date.now()), 30_000); return () => clearInterval(timer); }, []);
	const hidden = chrome.homeProject?.id === projectId;
	// The Plan workspace (/project and /design-review) already renders the FULL workflow card. When
	// the chat is split BESIDE that tab for this same project, this summary is
	// pure duplication — hide it there only. Everywhere else it earns its place:
	// the Build/Check/Submit tabs (the page shows build/evidence/submission, not
	// the plan workflow), the chat-only view (?pane=channel, including mobile
	// where there is no page beside the chat), and the Home/general chat. We key
	// off the live route, so switching tabs flips it without a reload.
	const location = useLocation();
	const search = useSearch({ strict: false }) as { project?: string; pane?: string };
	const path = location.pathname.replace(/^\/app/, '') || '/';
	// The Plan tab shows the full workflow card ONLY for the pre-build phases
	// (review / looks / design and their reviews). Once building/ready/blocked
	// the Plan-tab page no longer owns that state, so the chat summary still
	// carries it. We therefore compute the phase first and only suppress the
	// summary beside the Plan tab for a phase the page itself renders.
	const state = useQuery({
		...workflowQueryOptions(chrome.actorId, projectId),
		enabled: Boolean(chrome.actorId && !hidden),
	});
	const snapshot = state.data;
	const workflow = snapshot?.workflow;
	const besideOwnPlanTab =
		chrome.isDesktop &&
		search.pane !== 'channel' &&
		(path === '/design-review' || path === '/project') &&
		chrome.conversation.kind === 'project' &&
		chrome.conversation.projectId === projectId &&
		search.project === projectId;
	const hasBuild = workflow && ['building', 'blocked', 'ready'].includes(workflow.phase);
	// Owner 2026-10-30: beside this project's Build / Preview / Submit page on
	// desktop, the card repeated the page's status with different buttons
	// ("Retry build" there, "Review next step" here). There it is one line; the
	// page owns the actions. Phones and the chat-only view keep the full card.
	const besideOwnProjectPage =
		chrome.isDesktop &&
		search.pane !== 'channel' &&
		['/runs', '/preview', '/submission', '/design-review', '/project'].includes(path) &&
		chrome.conversation.kind === 'project' &&
		chrome.conversation.projectId === projectId &&
		search.project === projectId;
	const activity = useBuildActivity({ actorId: chrome.actorId }, !hidden && hasBuild ? projectId : null);
	// The Plan-tab page renders the full workflow card only for the pre-build
	// phases; for those, the beside-the-Plan-tab summary is duplication. Once
	// the build starts the Plan tab no longer carries live status, so the
	// summary stays.
	const planTabOwnsPhase =
		workflow != null && ['review', 'looks', 'looks-review', 'design', 'design-review'].includes(workflow.phase);
	if (hidden || (besideOwnPlanTab && planTabOwnsPhase)) return null;
	if (state.isPending) return <p className="state-detail" role="status">Loading your project…</p>;
	if (state.isError) return (
		<p className="state-detail" role="alert">
			Your project could not be loaded.{' '}
			<button type="button" className="btn-ghost" onClick={() => void state.refetch()}>Try again</button>
		</p>
	);
	const copied = snapshot?.importPreview;
	if (!workflow && !copied) return null;
	const title = name ?? chrome.buildProjects.find(project => project.id === projectId)?.name ?? 'Your project';
	const repairing = workflow?.phase === 'building' && Boolean(activity.data && (
		activity.data.openIssues > 0 || activity.data.timeline?.stages.some(stage => stage.state === 'failed')
	));
	const stopped = workflow?.phase === 'blocked' && Boolean(workflow.detail?.startsWith('Stop requested.'));
	const planningBlocked = workflow?.phase === 'blocked' && !stopped && !EVER_APPROVED.has(snapshot?.approval?.status ?? '');
	const preparationBlocked = workflow ? pausedPreparation(workflow, EVER_APPROVED.has(snapshot?.approval?.status ?? '')) : null;
	let design: CardDesign = 'plan';
	let headline = 'Caddie is writing your plan';
	let summary = 'You’ll review the plan before anything is built.';
	let status = 'In progress';
	let action = 'View plan';
	let previewId: string | null = null;

	if (!workflow && copied) {
		design = copied.status === 'ready' ? 'preview' : 'update';
		headline = importedAppTitle(copied);
		summary = copied.status === 'ready'
			? 'The copied version is ready to try. Your original repository stays separate.'
			: copied.message ?? 'Caddie is checking the copied app before you try it.';
		status = copied.status === 'ready' ? 'Ready to try' : copied.status === 'failed' ? 'Needs attention' : 'Checking';
		previewId = copied.status === 'ready' ? copied.outputId : null;
		action = previewId ? 'Try your app' : 'View copied app';
	} else if (workflow) {
		switch (workflow.phase) {
			case 'review': {
				const review = planReviewState(snapshot?.plan, snapshot?.approval);
				headline = review.headline;
				summary = review.detail;
				status = review.label === 'Plan ready' ? 'Needs you' : review.label;
				action = review.action;
				break;
			}
			case 'looks':
				headline = 'Caddie is drawing 3 looks';
				summary = 'Pick one and building starts.';
				action = 'View plan';
				break;
			case 'looks-review':
				headline = 'Pick a look for your app';
				summary = 'Each one is your app’s first screen. Picking one starts the build.';
				status = 'Needs you';
				action = 'See the looks';
				break;
			case 'design':
				headline = 'Caddie is designing your app';
				summary = 'You’ll see every screen before anything is built.';
				// No design exists yet; the approved plan is what there is to open.
				action = 'View plan';
				break;
			case 'design-review':
				headline = 'Your design is ready to review';
				summary = 'Review the screens and request any changes before the build starts.';
				status = 'Needs you';
				action = 'Review design';
				break;
			case 'building': {
                const observed = activity.data?.timeline ? buildPresentation(activity.data, Boolean(activity.error)) : null;
                const quiet = observed?.quiet === true;
                design = quiet ? 'update' : repairing ? 'repair' : 'build';
                // Owner 2026-10-30: say plainly whether Caddie is fixing or moving
                // on, and which part, in one line instead of a stack of labels.
                const parts = activity.data?.features ?? [];
                const current = parts.find(part => part.status === 'building');
                const done = parts.filter(part => part.status === 'passed').length;
                const part = current ? `“${featureName(current)}”` : null;
                headline = quiet ? observed!.title : part ? `${repairing ? 'Fixing' : 'Building'} ${part}` : repairing ? 'Caddie is fixing an issue it found' : 'Caddie is building your app';
                summary = quiet ? observed!.summary : parts.length > 1
                  ? `${done} of ${parts.length} parts done. ${repairing ? 'A check found a problem in this part; Caddie is fixing it before moving on.' : 'Caddie moves to the next part when this one passes its checks.'}`
                  : observed?.summary ?? 'Waiting for the latest build activity.';
                // The header label ("Checking & repairing") and the headline
                // ("Fixing “X”") already say it: no third "Fixing" badge
                // (owner 2026-10-30).
                status = quiet ? observed!.label : '';
                action = quiet ? 'Check build' : repairing ? 'View repair' : 'View build';
                break;
            }
			case 'blocked':
				design = 'update';
				headline = stopped ? 'Work on this project is paused' : preparationBlocked === 'plan' ? 'Your plan needs another try' : preparationBlocked === 'looks' ? 'The looks need another try' : preparationBlocked === 'design' ? 'The screens need another try' : 'The build needs attention';
				summary = stopped ? 'Your plan and saved files are retained. Open the project when you’re ready to resume.'
					: workflow.detail ?? 'Your plan and saved work are retained. Open the project to review the next step.';
				status = stopped ? 'Paused' : 'Needs attention';
				// A paused preparation step is one tap to resume, right here; the
				// owner should not have to open a window or ask Caddie to continue.
				action = preparationBlocked ? 'Try again' : 'Review next step';
				break;
			case 'ready':
				design = 'preview';
				headline = 'Your app is ready to try';
				summary = 'Build checks passed. Try the app and tell Caddie what to improve.';
				status = 'Ready to try';
				previewId = workflow.previewId;
				action = previewId ? 'Try your app' : 'Open project';
				break;
		}
	}
	const features = activity.data?.features ?? [];
	// Feature progress is build news; before the build it only read "0 of 7".
	const showFeatures = Boolean(hasBuild) && !preparationBlocked && hasFeatureList(features);
	// The row lands with the activity read, after the card is already on screen,
	// and pushed "Earlier · Plan decision" 44px down while the owner had the
	// tab in front of them (2026-10-27). The row keeps its height from the
	// first paint and the answer fills it in place.
	const reserveFeatures = hasBuild && !preparationBlocked && !activity.data;
	const passed = features.filter(feature => feature.status === 'passed').length;
	const progress = snapshot?.dispatchStalled ? null : snapshot?.preparationProgress ?? null;
	const progressLines = progress ? preparationLines(progress, nowMs) : null;
	// A step with no recorded work for five minutes gets a real "Try again"
	// (stop what is not running, resume from saved work), not a clock that
	// keeps counting past its own range (owner 2026-10-29).
	const quietStep = progressLines?.quiet === true;
	const retryInPlace = Boolean(preparationBlocked && !stopped) || quietStep;
	const retry = async () => {
		// Same key until a retry lands, so a double tap is one retry.
		retryKey.current ??= `resume:${crypto.randomUUID()}`;
		setRetrying(true); setRetryError(null);
		try {
			if (quietStep) await postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/stop`, {});
			await postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/retry`, { key: retryKey.current });
			retryKey.current = null;
			await state.refetch();
		} catch {
			setRetryError('That didn’t go through. Try again in a moment.');
		} finally { setRetrying(false); }
	};
	const open = () => retryInPlace ? void retry() : previewId ? chrome.goProjectTab('/preview', {project: projectId, preview: previewId, source: 'workflow'}) : setReviewOpen(true);
	// While the plan is being written there is nothing to open yet: "View plan"
	// led to a window that only repeated "Caddie is turning your request into a
	// plan" inside a second card (owner 2026-10-29). A stalled hand-off gets a
	// real retry instead (the route re-runs its recovery with the same key).
	const planning = workflow?.phase === 'planning';
	const stalled = planning && snapshot?.dispatchStalled === true;
	if (stalled) {
		design = 'update';
		headline = 'Caddie couldn’t start your plan';
		summary = 'Your request is saved and nothing was charged. Try again and Caddie will pick it up.';
		status = 'Needs attention';
	} else if (planning) {
		summary = 'You’ll review it before anything is built.';
	}
	// In this project's own chat, "Chat about this project" would go nowhere.
	const inOwnChat = chrome.conversation.kind === 'project' && chrome.conversation.projectId === projectId;
	const showOpen = !planning || stalled;

	if (besideOwnProjectPage && hasBuild) return (
		<section className="caddie-card project-workflow project-chat-summary project-chat-summary--compact" data-testid="workflow-summary"
			data-phase={workflow?.phase ?? 'imported'} data-design={design} data-compact="true"
			data-tone={design === 'preview' ? 'green' : design === 'repair' ? 'amber' : 'blue'} aria-label={`${title} project update`}>
			<CardHeader design={design} context={title} status={status} />
			<p className="project-chat-summary-line" role="status">{headline}</p>
		</section>
	);

	return (
		<section className="caddie-card project-workflow project-chat-summary" data-testid="workflow-summary"
			data-phase={workflow?.phase ?? 'imported'} data-design={design}
			data-tone={design === 'preview' ? 'green' : design === 'repair' ? 'amber' : 'blue'} aria-label={`${title} project update`}>
			<CardHeader design={design} context={title} status={status} />
			<h3>{headline}</h3>
			{/* While a step is prepared, the progress line says it all (owner 2026-10-29: "too busy"). */}
			{progressLines ? null : <p className="state-detail" role="status">{summary}</p>}
			{workflow?.phase === 'ready' ? <AddNext projectId={projectId} compact /> : null}
			{progressLines ? (
				<div className="preparation-progress" data-testid="preparation-progress" role="status">
					<progress className="workflow-progress" aria-label={progressLines.stage} />
					<p className="state-detail">{progressLines.stage} · {progressLines.time}</p>
				</div>
			) : planning && !stalled ? <progress className="workflow-progress" aria-label="Writing your plan" /> : null}
			{showOpen || quietStep || !inOwnChat ? (
				<div className="row-actions">
					{stalled ? (
						<button type="button" className="btn-key" data-testid="workflow-summary-open" disabled={state.isFetching} onClick={() => void state.refetch()}>
							{state.isFetching ? 'Trying again…' : 'Try again'}
						</button>
					) : showOpen || quietStep ? (
						<button type="button" className="btn-key" data-testid="workflow-summary-open" disabled={retrying} onClick={open}>{retrying ? 'Starting again…' : quietStep ? 'Try again' : action}</button>
					) : null}
					{workflow?.phase === 'ready' ? <AskForChange projectId={projectId} /> : null}
					{inOwnChat ? null : <button type="button" className="btn-ghost" onClick={() => chrome.openProject(projectId, true)}>Chat about this project</button>}
				</div>
			) : null}
			{retryError ? <p className="form-error" role="alert">{retryError}</p> : null}
			<ProjectDialog open={reviewOpen} onClose={() => setReviewOpen(false)} title={title} wide>
				<ProjectWorkflow projectId={projectId} name={name} presentation="workspace" />
			</ProjectDialog>
			{showFeatures || reserveFeatures ? (
				<details className="workflow-summary-progress" data-reserved={showFeatures ? undefined : true}>
					<summary>{showFeatures ? `All parts · ${passed} of ${features.length} done` : 'All parts'}</summary>
					{showFeatures ? (
						<ul className="workflow-summary-features">
							{features.map(feature => <li key={feature.id}>
								<span>{featureName(feature)}</span>{' '}
								<span className="state-detail">{feature.status === 'passed' ? 'Checked' : feature.status === 'building' ? activity.data?.timeline?.quiet ? 'Last reported building' : 'In progress' : feature.status === 'failed' ? 'Needs attention' : 'Up next'}</span>
							</li>)}
						</ul>
					) : null}
				</details>
			) : null}
			{/* "Earlier · Plan decision" lived here; the owner asked what it was
			    doing on a build card (2026-10-30). The approved plan stays on the Plan tab. */}
		</section>
	);
}
