import { planReviewState } from '../planning/plan-decision.ts';
import { buildPresentation } from '../project/build-presentation.ts';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useSearch } from '@tanstack/react-router';
import { useBuildActivity } from '../queries.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { workflowQueryOptions } from '../workflow-query.ts';
import { CardHeader } from '../brief/CardFrame.tsx';
import type { CardDesign } from '../brief/card-design.ts';
import { hasFeatureList } from '../project/FeatureChecklist.tsx';
import { importedAppTitle } from '../project/ImportedApp.tsx';

const EVER_APPROVED = new Set(['approved', 'revoked', 'expired']);

/** A live project pointer: the workspace owns approvals, previews and tools. */
export function ProjectChatSummary({ projectId, name }: {
	projectId: string;
	name?: string;
}): ReactElement | null {
	const chrome = useWorkspaceChrome();
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
	let design: CardDesign = 'plan';
	let headline = 'Caddie is writing your plan';
	let summary = 'You’ll review the plan and design before building starts.';
	let status = 'In progress';
	let action = 'View plan';
	let destination = '/design-review';
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
		destination = '/runs';
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
				headline = 'Caddie is preparing looks for your app';
				summary = 'The plan is approved. Next you pick how the app should look.';
				action = 'View plan';
				break;
			case 'looks-review':
				headline = 'Choose how your app should look';
				summary = 'Pick one of the looks. Caddie then designs every screen in it.';
				status = 'Needs you';
				action = 'Choose a look';
				break;
			case 'design':
				headline = 'Caddie is designing your app';
				summary = 'The plan is approved. You’ll review the screens and states next.';
				action = 'View design';
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
                headline = quiet ? observed!.title : repairing ? 'Caddie is fixing an issue it found' : 'Caddie is building your app';
                summary = observed?.summary ?? 'Waiting for the latest build activity.';
                status = quiet ? observed!.label : 'In progress';
                action = quiet ? 'Check build' : repairing ? 'View repair' : 'View build';
                destination = '/runs';
                break;
            }
			case 'blocked':
				design = 'update';
				headline = stopped ? 'Work on this project is paused' : planningBlocked ? 'The plan needs another pass' : 'The build needs attention';
				summary = stopped ? 'Your plan and saved files are retained. Open the project when you’re ready to resume.'
					: workflow.detail ?? 'Your plan and saved work are retained. Open the project to review the next step.';
				status = stopped ? 'Paused' : 'Needs attention';
				action = planningBlocked ? 'Review plan' : 'Review next step';
				destination = planningBlocked ? '/design-review' : '/runs';
				break;
			case 'ready':
				design = 'preview';
				headline = 'Your app is ready to try';
				summary = 'Build checks passed. Try the app and tell Caddie what to improve.';
				status = 'Ready to try';
				previewId = workflow.previewId;
				action = previewId ? 'Try your app' : 'Open project';
				destination = '/runs';
				break;
		}
	}
	const features = activity.data?.features ?? [];
	const showFeatures = hasFeatureList(features);
	const passed = features.filter(feature => feature.status === 'passed').length;
	const recorded = snapshot?.approval && snapshot.approval.status !== 'pending' ? snapshot.approval : null;
	const open = () => chrome.goProjectTab(previewId ? '/preview' : destination, {
		project: projectId,
		...(previewId ? { preview: previewId, source: 'workflow' } : {}),
	});

	return (
		<section className="caddie-card project-workflow project-chat-summary" data-testid="workflow-summary"
			data-phase={workflow?.phase ?? 'imported'} data-design={design}
			data-tone={design === 'preview' ? 'green' : design === 'repair' ? 'amber' : 'blue'} aria-label={`${title} project update`}>
			<CardHeader design={design} context={title} status={status} />
			<h3>{headline}</h3>
			<p className="state-detail" role="status">{summary}</p>
			<div className="row-actions">
				<button type="button" className="btn-key" data-testid="workflow-summary-open" onClick={open}>{action}</button>
			</div>
			{showFeatures ? (
				<details className="workflow-summary-progress">
					<summary>Feature progress · {passed} of {features.length} checked</summary>
					<ul className="workflow-summary-features">
						{features.map(feature => <li key={feature.id}>
							<span>{feature.title}</span>{' '}
							<span className="state-detail">{feature.status === 'passed' ? 'Checked' : feature.status === 'building' ? activity.data?.timeline?.quiet ? 'Last reported building' : 'In progress' : feature.status === 'failed' ? 'Needs attention' : 'Up next'}</span>
						</li>)}
					</ul>
				</details>
			) : null}
			{recorded ? (
				<details className="workflow-summary-history">
					<summary>Earlier · Plan decision</summary>
					<p className="state-detail">Decision: {recorded.status}. The original decision remains on record.</p>
					<button type="button" className="btn-ghost" onClick={() => chrome.goProjectTab('/design-review', { project: projectId, approval: recorded.id })}>Read original decision</button>
				</details>
			) : null}
		</section>
	);
}
