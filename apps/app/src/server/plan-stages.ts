/**
 * Staged builds (owner 2026-10-30: "stages is best … we are building for non
 * technical people first").
 *
 * The plan's feature list is approved WHOLE, then built in stages:
 *   1. at approval the owner may move items between "your first version" and
 *      "you can add these after"; the choice becomes the first build's rows;
 *   2. once the app is ready, "Add this" queues ONE approved item and builds
 *      it as a change on the working app: the last checked version stays open
 *      until the new one passes its checks, and a failure leaves it unchanged.
 *
 * Nothing here can add scope the owner did not approve: every item comes from
 * the approved plan revision, and the plan approval is re-checked before each
 * build (decideReadyChange).
 */
import { createHash } from 'node:crypto';
import { firstVersionChoiceError, parsePlanFeatures, PLAN_ITEM_REQUEST_PREFIX, type PlanFeature, type Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';
import { chooseFirstVersion, listBuildFeatures, queuePlanItem } from './build-features.ts';
import { decideReadyChange, decideWorkflow, openReadyChange, workflowSnapshot } from './build-workflow.ts';

export { PLAN_ITEM_REQUEST_PREFIX };

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();

/**
 * Approve (or send back) the plan, with the owner's first-version choice when
 * they made one. The choice is checked BEFORE the approval is recorded, so a
 * choice that cannot be built refuses without approving anything.
 */
export async function decidePlan(
	db: D1Database,
	scope: Scope,
	input: { planId: string; decision: 'approved' | 'rejected'; note?: string; firstVersion?: unknown },
	limits?: unknown,
) {
	const choice = input.firstVersion;
	if (choice !== undefined && (!Array.isArray(choice) || choice.length > 12 || choice.some((id) => typeof id !== 'string')))
		throw new ScopeError(400, 'FIRST_VERSION_INVALID', 'Pick the first version from the plan’s own list.');
	const ids = (choice as string[] | undefined) ?? null;
	if (input.decision === 'approved' && ids) {
		const { plan } = await workflowSnapshot(db, scope);
		const parsed = plan && plan.id === input.planId ? parsePlanFeatures(plan.body) : null;
		if (parsed?.ok) {
			const issue = firstVersionChoiceError(parsed.features, ids);
			if (issue) throw new ScopeError(400, 'FIRST_VERSION_INVALID', issue);
		}
	}
	const { firstVersion: _choice, ...decision } = input;
	const snapshot = await decideWorkflow(db, scope, decision, limits);
	if (input.decision === 'approved' && ids && snapshot.workflow && snapshot.plan?.id === input.planId)
		await chooseFirstVersion(db, scope, snapshot.workflow.runId, snapshot.plan, ids);
	return snapshot;
}

/** What the coordinator is told when the owner adds one approved item. */
export function addItemMessage(feature: Pick<PlanFeature, 'title'>): string {
	return [
		`The owner chose to add the next part of their approved plan to the finished app: “${feature.title}”. The last working preview stays live until the new one passes its checks.`,
		'Call build_next_feature: it returns exactly this part with its doneWhen checks. Delegate ONLY it to the implementation specialist, building on the app as it stands: do not rebuild earlier parts, and do not change the plan or the design. Get run_checks green, call finish_feature, then ask QA to run verify_build so the new version replaces the old one only after it passes.',
	].join('\n');
}

/**
 * "Add this": build one approved "add after" item on the finished app. The
 * owner's tap IS the decision, so the host writes the change and approves it
 * in one step; the build then runs through the normal feature loop and
 * publishes a new version only when every check passes. Idempotent per key.
 */
export async function addPlanItem(
	db: D1Database,
	scope: Scope,
	input: { featureId: string; key: string },
	limits?: unknown,
) {
	if (typeof input.featureId !== 'string' || typeof input.key !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(input.key))
		throw new ScopeError(400, 'invalid_input', 'Choose an idea from your plan.');
	const { workflow, plan } = await workflowSnapshot(db, scope);
	if (!workflow || !plan) throw new ScopeError(404, 'workflow_not_found', 'No app exists yet.');
	const changeId = `chg_add_${hash(`${scope.projectId}|${input.key}`).slice(0, 32)}`;
	const replay = (await db.prepare('select 1 from ready_changes where id = ?').bind(changeId).all()).results;
	if (replay.length) return workflowSnapshot(db, scope);
	if (workflow.phase !== 'ready' || !workflow.previewId)
		throw new ScopeError(409, 'NOT_READY', 'Caddie adds the next part once your app is ready.');
	if (await openReadyChange(db, scope.projectId))
		throw new ScopeError(409, 'CHANGE_IN_REVIEW', 'Caddie is already working on a change to your app. Wait for it to finish.');
	const before = await listBuildFeatures(db, scope.projectId, plan.id);
	const feature = await queuePlanItem(db, scope, workflow.runId, plan, input.featureId);
	const request = `${PLAN_ITEM_REQUEST_PREFIX}${feature.title}`;
	const requestHash = hash(`${scope.actorId}|${scope.projectId}|${request}`);
	const proposal = {
		summary: `Add “${feature.title}” from your approved plan.`,
		affected: ['The screens and saved records for this part'],
		risks: ['Everything already in your app stays as it is; its checks run again'],
		checks: [...feature.doneWhen],
	};
	const proposalHash = hash(JSON.stringify([scope.projectId, changeId, workflow.previewId, requestHash, proposal]));
	const stamp = now();
	await db
		.prepare('insert into ready_changes (id,projectId,runId,baseOutputId,request,requestHash,proposalJson,proposalHash,status,createdBy,createdAt,updatedAt) values (?,?,?,?,?,?,?,?,?,?,?,?)')
		.bind(changeId, scope.projectId, workflow.runId, workflow.previewId, request, requestHash, JSON.stringify(proposal), proposalHash, 'proposed', scope.actorId, stamp, stamp)
		.run();
	try {
		return await decideReadyChange(db, scope, { changeId, decision: 'approved', requestHash, proposalHash }, limits, { message: addItemMessage(feature) });
	} catch (error) {
		// Refused (judge limit, an expired plan approval, a moved app): nothing
		// starts, and the item is offered again exactly as it was.
		await db.batch([
			db.prepare("update ready_changes set status='cancelled', failure=?, updatedAt=? where id=? and status in ('proposed','approved')")
				.bind(error instanceof Error ? error.message.slice(0, 500) : 'Refused', now(), changeId),
			db.prepare('delete from build_features where projectId=? and planId=? and featureId=? and status=\'pending\'').bind(scope.projectId, plan.id, feature.id),
			...before
				.filter((row) => row.status !== 'passed' && row.featureId !== feature.id)
				.map((row) =>
					db.prepare('insert or ignore into build_features ("projectId","runId","planId","featureId","position","title","doneWhen","status","attempts","updatedAt") values (?,?,?,?,?,?,?,?,?,?)')
						.bind(row.projectId, row.runId, row.planId, row.featureId, row.position, row.title, JSON.stringify(row.doneWhen), row.status, row.attempts, now()),
				),
		]);
		throw error;
	}
}
