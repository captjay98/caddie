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

/**
 * Brief-in-chat summary (R05, user direction: "if there is a brief, chat will
 * show it and link to the brief"). A COMPACT projection of the SAME
 * `GET /api/brief` the Brief destination reads — counts come from one source,
 * so chat ("2 need you") and Brief (the 2 cards) can never drift. Rendered as
 * an in-transcript card with a link-through; it carries no actions of its own.
 */
export const BriefSummarySchema = v.pipe(
	v.strictObject({
		/** Unseen actionable items (needs-you / changed / blocked, not seen). */
		needsYouCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
		/** Meaningful finished updates (handled results/previews). */
		updatesCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
		/** Total open (unresolved) cards. */
		openCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
		/** One short, user-facing line derived from the counts (no internal IDs). */
		headline: v.string(),
		/** The deep link to the full Brief destination. */
		href: v.string(),
		asOf: v.pipe(v.string(), v.isoTimestamp()),
	}),
	v.readonly(),
);
export type BriefSummary = v.InferOutput<typeof BriefSummarySchema>;

/**
 * The hackathon-results card (chat context card). The coordinator emits this
 * from the REAL discovery/find_hackathons results so ranked candidates render
 * as structured cards instead of hand-rolled markdown the model can invent or
 * overflow. HONESTY is in the shape: platform/startsAt/prize are NULLABLE and
 * render as "unknown"/omitted when absent — never a fabricated date or prize;
 * `url` is the cited source; `eligibility` is the conservative engine verdict
 * ('unknown' never upgraded); `gaps` carries the feed's honest limitations.
 */
export const HackathonCandidateSchema = v.strictObject({
	id: v.string(),
	title: v.string(),
	/** Cited source URL from the tool output (click-through). */
	url: v.string(),
	/** Platform host (e.g. "devpost.com"); null when not determinable. */
	platform: v.nullable(v.string()),
	summary: v.string(),
	/** Only set when the tool genuinely carries a date — null is honest "unknown". */
	startsAt: v.nullable(v.string()),
	/** Only set when present in tool output — null means no prize shown, never guessed. */
	prize: v.nullable(v.string()),
	/**
	 * Parsed DISPLAY fields (card redesign) — rendered as chips. Every one is
	 * honest-nullable: parsed from the real event text, null when not
	 * determinable (the chip is then omitted, never fabricated). Optional +
	 * defaulted so older emitters stay valid.
	 */
	endsAt: v.optional(v.nullable(v.string()), null),
	deadline: v.optional(v.nullable(v.string()), null),
	participants: v.optional(v.nullable(v.number()), null),
	format: v.optional(v.nullable(v.union([v.literal('online'), v.literal('in-person'), v.literal('hybrid')])), null),
	/** The organiser named by the source (Devpost API), or null — never inferred from the title. */
	organizer: v.optional(v.nullable(v.string()), null),
	/** The source's own theme tags (Devpost API), empty when it has none. */
	themes: v.optional(v.array(v.string()), []),
	/**
	 * Card redesign: the single first-ranked card gets the rich "top pick"
	 * (Option 6) treatment ONLY when its AI fit is strong. Everything else uses
	 * the default (Option 1) card. Defaulted false for back-compat.
	 */
	topPick: v.optional(v.boolean(), false),
	eligibility: v.union([v.literal('eligible'), v.literal('ineligible'), v.literal('unknown')]),
	/**
	 * Eligibility WORDING for the card, derived from quoted rules without changing
	 * the verdict: "You can enter", "Only open to US", "Open to NG · confirm
	 * you're 18+". '' when no rules were read (the chip then says unknown).
	 */
	eligibilityNote: v.optional(v.string(), ''),
	/** The verbatim official-rules text that decided eligibility; null when none. */
	eligibilityQuote: v.optional(v.nullable(v.string()), null),
	/** True when only profile-uncheckable rules (age, student) remain — the user must confirm. */
	eligibilityNeedsConfirm: v.optional(v.boolean(), false),
	/** The official rules page the quote came from; null when none. */
	rulesUrl: v.optional(v.nullable(v.string()), null),
	/** True when the event came from a web-search backup and its open status is unverified. */
	openStatusUnverified: v.optional(v.boolean(), false),
	/** Drives the Save button state (B01 saved shortlist). */
	saved: v.boolean(),
	/**
	 * AI fit verdict from the inspection step — a FIT signal only, SEPARATE from
	 * `eligibility` (rule-based) so neither masquerades as the other. 'unknown'
	 * is the honest default when the model did not score it or the text was too
	 * thin. Optional + defaulted so older emitters remain valid (back-compat).
	 */
	aiFit: v.optional(
		v.union([v.literal('strong'), v.literal('possible'), v.literal('weak'), v.literal('unknown')]),
		'unknown',
	),
	/** The AI's one-line, user-facing reason for the fit verdict. '' when none — never a guess. */
	aiFitReason: v.optional(v.string(), ''),
	/** The AI's self-reported confidence 0..1, or null when not given. */
	aiFitConfidence: v.optional(v.nullable(v.number()), null),
});
export type HackathonCandidate = v.InferOutput<typeof HackathonCandidateSchema>;

export const HackathonResultsCardSchema = v.pipe(
	v.strictObject({
		candidates: v.array(HackathonCandidateSchema),
		/** Honest limitations from the feed (stale dates, unknown rules, outages). */
		gaps: v.array(v.string()),
		/** The profile country the eligibility read used, or null. */
		profileCountry: v.nullable(v.string()),
	}),
	v.readonly(),
);
export type HackathonResultsCard = v.InferOutput<typeof HackathonResultsCardSchema>;

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

// --- multimodal input parts (user → coordinator) ------------------------------
//
// The parts a USER may attach to a message, beyond text. Strict + serializable:
// the Composer builds these, the send path carries them, and the server routes
// an image to a vision model / extracts text from a file. Deliberately NARROW:
// a part carries a reference and metadata the client already knows, never a
// server-trusted authority field.
//
// HONESTY: `mediaType` is the browser-reported MIME; the server re-validates it
// (a client cannot assert "this is a safe image" and have it believed). Size is
// bytes, bounded by the Composer AND re-checked server-side (fail closed).

/** Hard ceilings shared by client guard + server re-check (one source). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB

/** Image MIME types a vision model can accept. */
export const ImageMediaType = v.union([
	v.literal('image/png'),
	v.literal('image/jpeg'),
	v.literal('image/webp'),
	v.literal('image/gif'),
]);
export type ImageMediaType = v.InferOutput<typeof ImageMediaType>;

/** File MIME types we extract text from (fed to the model as text). */
export const FileMediaType = v.union([
	v.literal('application/pdf'),
	v.literal('text/plain'),
	v.literal('text/markdown'),
	v.literal('text/csv'),
]);
export type FileMediaType = v.InferOutput<typeof FileMediaType>;

/**
 * An attached image. `url` is a reference the client resolved (object URL for
 * an in-flight send, or a stored URL after upload) — NOT inline base64 in the
 * contract (large payloads do not belong in a serializable boundary type).
 */
export const ImageInputPartSchema = v.pipe(
	v.strictObject({
		kind: v.literal('image'),
		mediaType: ImageMediaType,
		/** Reference URL to the image bytes (object URL / stored URL). */
		url: v.string(),
		/** Original filename for display; may be empty. */
		filename: v.string(),
		/** Size in bytes; bounded by MAX_IMAGE_BYTES (re-checked server-side). */
		sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_IMAGE_BYTES)),
	}),
	v.readonly(),
);
export type ImageInputPart = v.InferOutput<typeof ImageInputPartSchema>;

/** An attached file whose text is extracted and fed to the model. */
export const FileInputPartSchema = v.pipe(
	v.strictObject({
		kind: v.literal('file'),
		mediaType: FileMediaType,
		url: v.string(),
		filename: v.string(),
		sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_FILE_BYTES)),
	}),
	v.readonly(),
);
export type FileInputPart = v.InferOutput<typeof FileInputPartSchema>;

/** Any non-text input part a user may attach. */
export const InputAttachmentSchema = v.variant('kind', [ImageInputPartSchema, FileInputPartSchema]);
export type InputAttachment = v.InferOutput<typeof InputAttachmentSchema>;

/**
 * A user message as the send path carries it: the typed text plus zero or more
 * attachments. `text` may be empty ONLY when at least one attachment is present
 * (an empty message with no attachment is not a message).
 */
export const UserMessageInputSchema = v.pipe(
	v.strictObject({
		text: v.string(),
		attachments: v.array(InputAttachmentSchema),
	}),
	v.readonly(),
	v.check(
		(m) => m.text.trim().length > 0 || m.attachments.length > 0,
		'a message must carry text or at least one attachment',
	),
);
export type UserMessageInput = v.InferOutput<typeof UserMessageInputSchema>;

// --- vision model capability (provider route extension) -----------------------
//
// The provider's ModelRoute (apps/app/src/agents/providers.ts) stays the pricing
// authority; this is the SHARED, serializable description of what input
// modalities a route accepts, so the server can pick a vision-capable route for
// an image message and refuse honestly when none is configured.

export const InputModality = v.union([v.literal('text'), v.literal('image')]);
export type InputModality = v.InferOutput<typeof InputModality>;

export const ModelCapabilitySchema = v.pipe(
	v.strictObject({
		routeId: v.string(),
		/** Modalities this route accepts as INPUT. 'image' marks a vision route. */
		inputModalities: v.array(InputModality),
	}),
	v.readonly(),
);
export type ModelCapability = v.InferOutput<typeof ModelCapabilitySchema>;

// --- guided join → build → GitHub steps --------------------------------------
//
// After the user commits to a hackathon (Discover "Explore ideas" → create
// project, OR saying "let's join X" in chat), Caddie hands them a PATH instead
// of ending at "go register on Devpost": a project is created, a repo is
// connected or created (or skipped), and the first build step is shaped. The
// SAME three-step shape renders two ways — an in-chat card the coordinator
// emits once, and a collapsible stepper on the project Overview — so the two
// surfaces can never disagree about where the user is.
//
// HONESTY: step state is DERIVED from real signals (a project row, a GitHub
// import/binding, a plan draft), never a self-reported flag the model sets.
// 'skipped' is only ever the user's own choice for the GitHub step; it never
// means "we think this is fine".

export const JoinStepId = v.union([
	v.literal('project'),
	v.literal('github'),
	v.literal('build'),
]);
export type JoinStepId = v.InferOutput<typeof JoinStepId>;

export const JoinStepState = v.union([
	v.literal('done'),
	v.literal('active'),
	v.literal('todo'),
	v.literal('skipped'),
]);
export type JoinStepState = v.InferOutput<typeof JoinStepState>;

export const JoinStepSchema = v.pipe(
	v.strictObject({
		id: JoinStepId,
		state: JoinStepState,
		/** Short user-facing title, e.g. "Connect a GitHub repo". */
		title: v.string(),
		/** One-line, honest detail. No invented status. */
		detail: v.string(),
	}),
	v.readonly(),
);
export type JoinStep = v.InferOutput<typeof JoinStepSchema>;

export const GuidedStepsCardSchema = v.pipe(
	v.strictObject({
		projectId: v.string(),
		/** The contest this path is for (display context). */
		contestTitle: v.string(),
		/** The cited contest URL (click-through), or null when none. */
		contestUrl: v.nullable(v.string()),
		/** A short deadline/eligibility context line, or '' when none. */
		contestContext: v.optional(v.string(), ''),
		/** Exactly the three steps, in order: project → github → build. */
		steps: v.array(JoinStepSchema),
	}),
	v.readonly(),
);
export type GuidedStepsCard = v.InferOutput<typeof GuidedStepsCardSchema>;

// --- GitHub repo creation (initialise a repo directly) ------------------------
//
// Distinct from connecting a pre-existing repo (the RepositoryPicker + import
// flow): this creates a NEW repo under the project's bound installation. The
// GitHub App needs `administration: write`; the server route fails CLOSED with
// a typed error when that permission is absent, so this ships safely and lights
// up once the permission is granted — it is never faked.

export const RepoVisibility = v.union([v.literal('private'), v.literal('public')]);
export type RepoVisibility = v.InferOutput<typeof RepoVisibility>;

export const CreateRepoRequestSchema = v.pipe(
	v.strictObject({
		/** The installation (account) the repo is created under. */
		installationId: v.string(),
		/** Repo name (no owner); the server owns owner resolution + validation. */
		name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
		visibility: RepoVisibility,
	}),
	v.readonly(),
);
export type CreateRepoRequest = v.InferOutput<typeof CreateRepoRequestSchema>;

export const CreateRepoResultSchema = v.pipe(
	v.strictObject({
		/** `owner/name` of the created repo. */
		repoFullName: v.string(),
		visibility: RepoVisibility,
		/** The repo's web URL (click-through). */
		htmlUrl: v.string(),
		/** True when the repo already existed and was adopted rather than created. */
		adopted: v.optional(v.boolean(), false),
	}),
	v.readonly(),
);
export type CreateRepoResult = v.InferOutput<typeof CreateRepoResultSchema>;

// --- projects (P02) -----------------------------------------------------------

export * from './projects.ts';

// --- experience projection (R01) ----------------------------------------------

export * from './experience.ts';
export * from './interests.ts';
export * from './features.ts';
export * from './app-icon.ts';
export * from './publish.ts';
