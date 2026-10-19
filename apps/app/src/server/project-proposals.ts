import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { assertProjectScope, ScopeError } from './scope.ts';
import { startProjectFromChat } from './build-workflow.ts';
import { type AppStackId, flutterAppsEnabled } from './stacks.ts';

/**
 * Project proposals: Caddie suggests, the user decides.
 *
 * `proposeProject` only STORES a proposal for the Home chat to show as a card.
 * The project, its run and its planning intake are created by
 * `acceptProposal`, which runs only from the user's "Start this project"
 * click (an authenticated route) — never from a model tool call. "Keep
 * refining" is `dismissProposal`, which creates nothing.
 */

export type ProposalStatus = 'proposed' | 'accepted' | 'dismissed';

export interface ProjectProposal {
	readonly id: string;
	readonly homeProjectId: string;
	readonly name: string;
	readonly idea: string;
	readonly brief: string;
	readonly hackathonTitle: string | null;
	readonly hackathonUrl: string | null;
	readonly track: string | null;
	readonly firstStep: string | null;
	/** 'react-hono' (a web app) or 'flutter' (an Android app, Track 3). */
	readonly stackId: AppStackId;
	readonly status: ProposalStatus;
	readonly projectId: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ProposeProjectInput {
	readonly name: string;
	readonly idea: string;
	readonly brief: string;
	readonly hackathonTitle?: string | null;
	readonly hackathonUrl?: string | null;
	readonly track?: string | null;
	readonly firstStep?: string | null;
	/** Omitted means a web app. 'flutter' needs FLUTTER_APPS_ENABLED=1. */
	readonly stackId?: AppStackId;
	readonly sourceConversationId: string;
}

const ANDROID_OFF = "Android apps aren't switched on for this Caddie yet. Caddie can build it as a web app, which also installs on phones from the browser.";

/** Refuse an unknown app type, or an Android app while that is switched off. */
export function checkAppStack(stackId: unknown, env: unknown): AppStackId {
	const stack = stackId ?? 'react-hono';
	if (stack !== 'react-hono' && stack !== 'flutter') {
		throw new ScopeError(400, 'invalid_proposal', 'A project is a web app or an Android app.');
	}
	if (stack === 'flutter' && !flutterAppsEnabled(env)) throw new ScopeError(409, 'android_apps_off', ANDROID_OFF);
	return stack;
}

const now = () => new Date().toISOString();
const clean = (value: string | null | undefined, max: number): string | null => {
	if (typeof value !== 'string') return null;
	const text = value.replace(/\s+/g, ' ').trim().slice(0, max);
	return text.length > 0 ? text : null;
};

function fromRow(row: Record<string, unknown>): ProjectProposal {
	return {
		id: String(row['id']),
		homeProjectId: String(row['homeProjectId']),
		name: String(row['name']),
		idea: String(row['idea']),
		brief: String(row['brief']),
		hackathonTitle: (row['hackathonTitle'] as string | null) ?? null,
		hackathonUrl: (row['hackathonUrl'] as string | null) ?? null,
		track: (row['track'] as string | null) ?? null,
		firstStep: (row['firstStep'] as string | null) ?? null,
		stackId: row['stackId'] === 'flutter' ? 'flutter' : 'react-hono',
		status: row['status'] as ProposalStatus,
		projectId: (row['projectId'] as string | null) ?? null,
		createdAt: String(row['createdAt']),
		updatedAt: String(row['updatedAt']),
	};
}

/** Store a proposal for the Home chat card. Creates NO project. */
export async function proposeProject(db: D1Database, scope: Scope, input: ProposeProjectInput, env?: unknown): Promise<ProjectProposal> {
	const verified = await assertProjectScope(db, scope);
	const name = clean(input.name, 100);
	const idea = clean(input.idea, 600);
	const brief = typeof input.brief === 'string' ? input.brief.trim().slice(0, 16000) : '';
	if (!name || !idea || !brief) {
		throw new ScopeError(400, 'invalid_proposal', 'A proposal needs a name, a short idea and a brief.');
	}
	const stackId = checkAppStack(input.stackId, env);
	const url = clean(input.hackathonUrl, 500);
	if (url && !/^https?:\/\//i.test(url)) throw new ScopeError(400, 'invalid_proposal', 'The hackathon link must be an http(s) URL.');
	const id = `prop_${crypto.randomUUID()}`;
	const stamp = now();
	await db
		.prepare(
			'insert into "project_proposals" ("id","actorId","workspaceId","homeProjectId","sourceConversationId","name","idea","brief","hackathonTitle","hackathonUrl","track","firstStep","stackId","status","projectId","createdAt","updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
		)
		.bind(
			id,
			verified.actorId,
			verified.workspaceId,
			verified.projectId,
			input.sourceConversationId,
			name,
			idea,
			brief,
			clean(input.hackathonTitle, 200),
			url,
			clean(input.track, 120),
			clean(input.firstStep, 400),
			stackId,
			'proposed',
			null,
			stamp,
			stamp,
		)
		.run();
	return getProposal(db, verified, id);
}

/** Read one proposal; only its owner, through the Home project it was shown in. */
export async function getProposal(db: D1Database, scope: Scope, proposalId: string): Promise<ProjectProposal> {
	const verified = await assertProjectScope(db, scope);
	const result = await db
		.prepare('select * from "project_proposals" where "id" = ? and "homeProjectId" = ? and "actorId" = ?')
		.bind(proposalId, verified.projectId, verified.actorId)
		.all<Record<string, unknown>>();
	const row = result.results?.[0];
	if (!row) throw new ScopeError(404, 'proposal_not_found', 'That project proposal was not found.');
	return fromRow(row);
}

async function setStatus(db: D1Database, id: string, status: ProposalStatus, projectId: string | null): Promise<void> {
	await db
		.prepare('update "project_proposals" set "status" = ?, "projectId" = ?, "updatedAt" = ? where "id" = ?')
		.bind(status, projectId, now(), id)
		.run();
}

/**
 * The user pressed "Start this project": create the project, its run and its
 * planning intake through the same path a chat-created project always used
 * (`startProjectFromChat`, keyed by the proposal id so a double click or a
 * retried request returns the same project). A dismissed proposal can still
 * be started — the user may change their mind.
 */
export async function acceptProposal(
	db: D1Database,
	scope: Scope,
	proposalId: string,
	limits?: unknown,
): Promise<{ proposal: ProjectProposal; project: { id: string; name: string } }> {
	const proposal = await getProposal(db, scope, proposalId);
	const row = await db
		.prepare('select "sourceConversationId" from "project_proposals" where "id" = ?')
		.bind(proposal.id)
		.all<Record<string, unknown>>();
	const sourceConversationId = String(row.results?.[0]?.['sourceConversationId'] ?? '');
	const started = await startProjectFromChat(db, scope, {
		name: proposal.name,
		description: proposal.idea,
		brief: proposal.brief,
		operationKey: `proposal:${proposal.id}`,
		sourceConversationId,
		// Re-checked here: the switch may have gone off since the card was shown.
		stackId: checkAppStack(proposal.stackId, limits),
	}, limits);
	await setStatus(db, proposal.id, 'accepted', started.project.id);
	return {
		proposal: await getProposal(db, scope, proposal.id),
		project: { id: started.project.id, name: started.project.name },
	};
}

/** "Keep refining": the card is put aside and NOTHING is created. */
export async function dismissProposal(db: D1Database, scope: Scope, proposalId: string): Promise<ProjectProposal> {
	const proposal = await getProposal(db, scope, proposalId);
	if (proposal.status === 'accepted') {
		throw new ScopeError(409, 'proposal_already_started', 'This project has already been started.');
	}
	if (proposal.status !== 'dismissed') await setStatus(db, proposal.id, 'dismissed', null);
	return getProposal(db, scope, proposal.id);
}
