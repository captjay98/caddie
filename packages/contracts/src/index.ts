/**
 * Frozen shared boundary contracts (P00).
 *
 * Source of truth: docs/plans/2026-10-03-fresh-build/contracts.md. Serializable
 * schemas and pure helpers only — no I/O, no app state. All object schemas are
 * strict (unknown keys rejected) so body-supplied authorization fields can
 * never ride through a contract.
 */

import * as v from 'valibot';

// --- scope, authorization and run identity ---------------------------------

export const ScopeSchema = v.pipe(
	v.strictObject({
		actorId: v.string(),
		workspaceId: v.string(),
		projectId: v.string(),
	}),
	v.readonly(),
);
export type Scope = v.InferOutput<typeof ScopeSchema>;

export const StackId = v.union([
	v.literal('react-hono'),
	v.literal('tanstack-start'),
	v.literal('laravel-inertia'),
	v.literal('fastapi-react'),
	v.literal('flutter'),
]);
export type StackId = v.InferOutput<typeof StackId>;

export const STACK_IDS = [
	'react-hono',
	'tanstack-start',
	'laravel-inertia',
	'fastapi-react',
	'flutter',
] as const satisfies readonly StackId[];

export const RunBindingSchema = v.pipe(
	v.strictObject({
		runId: v.string(),
		projectId: v.string(),
		conversationId: v.string(),
		submissionId: v.string(),
		planRevision: v.string(),
		stackId: StackId,
		payerId: v.string(),
		modelRouteId: v.string(),
		pricingVersion: v.string(),
	}),
	v.readonly(),
);
export type RunBinding = v.InferOutput<typeof RunBindingSchema>;

// --- approval and effect ----------------------------------------------------

export const ApprovalAction = v.union([
	v.literal('design'),
	v.literal('feature-review'),
	v.literal('deploy-production'),
	v.literal('destructive-database-change'),
	v.literal('merge-default-branch'),
]);
export type ApprovalAction = v.InferOutput<typeof ApprovalAction>;

export const ApprovalIntentSchema = v.pipe(
	v.strictObject({
		projectId: v.string(),
		action: ApprovalAction,
		resourceId: v.string(),
		revisionHash: v.string(),
		policyVersion: v.string(),
	}),
	v.readonly(),
);
export type ApprovalIntent = v.InferOutput<typeof ApprovalIntentSchema>;

export const ApprovalRecordSchema = v.pipe(
	v.strictObject({
		projectId: v.string(),
		action: ApprovalAction,
		resourceId: v.string(),
		revisionHash: v.string(),
		policyVersion: v.string(),
		id: v.string(),
		intentHash: v.string(),
		decidedBy: v.nullable(v.string()),
		status: v.union([
			v.literal('pending'),
			v.literal('approved'),
			v.literal('rejected'),
			v.literal('revoked'),
			v.literal('expired'),
			v.literal('superseded'),
		]),
		expiresAt: v.pipe(v.string(), v.isoTimestamp()),
	}),
	v.readonly(),
);
export type ApprovalRecord = v.InferOutput<typeof ApprovalRecordSchema>;

/**
 * Canonical intent hash: deep key-sorted JSON of the exact
 * action/resource/revision with policy version (contracts.md — approval and
 * effect). Stale approvals fail against this hash at execution time. Web
 * Crypto so the same helper runs in bun, workerd, Node, AND the browser —
 * node:crypto externalizes in the client bundle and would kill the SPA.
 */
export async function approvalIntentHash(intent: ApprovalIntent): Promise<string> {
	const canonical = JSON.stringify(intent, (_, value) => {
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
					a < b ? -1 : 1,
				),
			);
		}
		return value;
	});
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
	const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	return `sha256-${hex}`;
}

export const ExternalOperationSchema = v.pipe(
	v.strictObject({
		id: v.string(),
		projectId: v.string(),
		runId: v.string(),
		operationKey: v.string(),
		provider: v.string(),
		remoteId: v.nullable(v.string()),
		status: v.union([
			v.literal('prepared'),
			v.literal('dispatched'),
			v.literal('succeeded'),
			v.literal('failed'),
			v.literal('cancel-requested'),
			v.literal('cancelled'),
			v.literal('reconciliation-required'),
		]),
		receiptId: v.nullable(v.string()),
	}),
	v.readonly(),
);
export type ExternalOperation = v.InferOutput<typeof ExternalOperationSchema>;

// --- UI and evidence ---------------------------------------------------------

export const DecisionCardSchema = v.pipe(
	v.strictObject({
		id: v.string(),
		projectId: v.string(),
		runId: v.optional(v.string()),
		kind: v.union([
			v.literal('approval'),
			v.literal('change'),
			v.literal('deadline'),
			v.literal('result'),
		]),
		headline: v.string(),
		summary: v.string(),
		evidenceIds: v.array(v.string()),
		status: v.union([
			v.literal('needs-you'),
			v.literal('changed'),
			v.literal('handled'),
			v.literal('blocked'),
		]),
		updatedAt: v.pipe(v.string(), v.isoTimestamp()),
		primaryAction: v.strictObject({
			label: v.string(),
			kind: v.union([
				v.literal('review'),
				v.literal('inspect'),
				v.literal('preview'),
			]),
			targetId: v.string(),
		}),
		/** Stable identity `<projectId>:<kind>:<targetId>` — set by the ACCOUNT
		 *  brief so read state can be persisted without a generic notification
		 *  platform. Absent on the per-project brief payload. */
		key: v.optional(v.string()),
		/** True once the actor has marked this card read (explicit action or
		 *  "mark all read"). Read state NEVER resolves the underlying work. */
		seen: v.optional(v.boolean()),
	}),
	v.readonly(),
);
export type DecisionCard = v.InferOutput<typeof DecisionCardSchema>;

/** The account-wide brief payload (`GET /api/brief`): every card the actor's
 *  authorised projects demand, grouped server-side per project, with
 *  per-actor read state and a fresh-as-of timestamp. */
export const AccountBriefPayloadSchema = v.pipe(
	v.strictObject({
		cards: v.array(DecisionCardSchema),
		unseenCount: v.number(),
		/** Project names for grouping UI — id -> display name. */
		projects: v.array(
			v.strictObject({
				id: v.string(),
				name: v.string(),
				kind: v.optional(v.string()),
			}),
		),
		asOf: v.pipe(v.string(), v.isoTimestamp()),
	}),
	v.readonly(),
);
export type AccountBriefPayload = v.InferOutput<typeof AccountBriefPayloadSchema>;

// --- stack recipe -------------------------------------------------------------

export const StackRecipeSchema = v.pipe(
	v.strictObject({
		id: StackId,
		version: v.string(),
		imageDigest: v.string(),
		install: v.array(v.string()),
		test: v.array(v.string()),
		build: v.array(v.string()),
		start: v.array(v.string()),
		requiredCapabilities: v.array(v.string()),
		artifacts: v.array(v.string()),
		preview: v.union([
			v.literal('static'),
			v.literal('server'),
			v.literal('android-emulator'),
		]),
		availability: v.union([
			v.literal('unverified'),
			v.literal('verified'),
			v.literal('blocked'),
		]),
	}),
	v.readonly(),
);
export type StackRecipe = v.InferOutput<typeof StackRecipeSchema>;

// --- projects (P02) -----------------------------------------------------------

export * from './projects.ts';
