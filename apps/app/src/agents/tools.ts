import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { isProtectedPath, mentionsProtectedPath } from './permissions.ts';

/**
 * P05 agent tools — Valibot schemas (flue contract lesson), one definition
 * per policy name in permissions.ts. Tools are pure definitions here; the
 * sandbox-backed ones receive the driver through their closure at mount time
 * (specialists mount with their role's subset — mounting is the permission
 * enforcement point: a role can never call a tool its policy omits because
 * the definition is never in its render).
 *
 * Everything execution-shaped flows through the P04 SandboxDriver, which
 * carries operation keys, quotas, and abort semantics. Nothing here spawns
 * processes or touches the network beyond that driver.
 */

export interface SandboxToolDeps {
	/** Minimal surface of the P04 driver this module depends on. */
	execute(input: {
		sessionId: string;
		command: string;
		operationKey: string;
		timeoutMs: number;
		signal?: AbortSignal;
	}): Promise<{ remoteId: string; exitCode?: number | null; stdout?: string; stderr?: string; outputTruncated?: boolean; timedOut?: boolean }>;
	readFile(input: { sessionId: string; path: string }): Promise<string>;
	writeFile(input: { sessionId: string; path: string; content: string }): Promise<void>;
}

const ReadProjectContextInput = v.object({
	paths: v.array(v.string()),
});
const WritePlanNoteInput = v.object({
	kind: v.picklist(['kernel', 'scope', 'prd', 'design', 'spec', 'note']),
	body: v.string(),
	planRevision: v.string(),
});
const SandboxPathInput = v.object({
	sessionId: v.string(),
	path: v.string(),
});
const SandboxExecInput = v.object({
	sessionId: v.string(),
	command: v.string(),
	timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const WriteSandboxFileInput = v.object({
	sessionId: v.string(),
	path: v.string(),
	content: v.string(),
});
const DelegateRepairInput = v.object({
	issue: v.string(),
	round: v.picklist(['diagnosis', 'repair_attempt', 'verification']),
	toRole: v.picklist(['tech-lead', 'frontend', 'backend', 'mobile']),
	task: v.string(),
});
const RecordVerificationInput = v.object({
	check: v.string(),
	passed: v.boolean(),
	evidence: v.string(),
	planRevision: v.string(),
});

export type ToolContextLike = {
	/** Current plan revision of the run, injected from the durable run binding. */
	currentPlanRevision: string;
	/** Durable run id; tool results are stamped with it for staleness checks. */
	runId: string;
};

/**
 * Refuse to read or write anything on the protected acceptance surfaces. Used
 * by every read/write path tool (defense in depth: the mount policy already
 * omits write tools from QA; this guard stops ANY role from grading its own
 * homework through a read path that returns acceptance content it could then
 * rewrite via another surface).
 */
export function assertNotProtectedPath(path: string): void {
	if (isProtectedPath(path)) {
		throw new Error(
			`PROTECTED_PATH: ${path} is part of the acceptance harness and is not writable through agent tools`,
		);
	}
}

/** Read-only project context: plan notes and repo docs for the bound project. */
export function makeReadProjectContext(deps: {
	readPlanNote: (kind: string) => Promise<string | null>;
}) {
	return defineTool({
		name: 'read_project_context',
		description:
			'Read the current project context: the latest plan documents for the bound project.',
		input: ReadProjectContextInput,
		run: async (ctx) => {
			const sections: string[] = [];
			for (const kind of ctx.data.paths) {
				assertNotProtectedPath(kind);
				const body = await deps.readPlanNote(kind);
				if (body !== null) sections.push(`## ${kind}\n\n${body}`);
			}
			return { output: sections.join('\n\n') || '(no plan documents yet)' };
		},
	});
}

/** Plan-note write: appends an immutable revision note via the caller hook. */
export function makeWritePlanNote(deps: {
	writePlanNote: (input: { kind: string; body: string; planRevision: string }) => Promise<void>;
}) {
	return defineTool({
		name: 'write_plan_note',
		description:
			'Append a plan note (kernel/scope/prd/spec/note) to the project. Immutable revisions; never edits acceptance surfaces.',
		input: WritePlanNoteInput,
		run: async (ctx) => {
			await deps.writePlanNote({
				kind: ctx.data.kind,
				body: ctx.data.body,
				planRevision: ctx.data.planRevision,
			});
			return { output: `SAVED: plan note ${ctx.data.kind} recorded by the host as a new immutable revision.` };
		},
	});
}

/** Execute a command in the run's sandbox session (P04 driver). */
export function makeSandboxExec(deps: {
	driver: SandboxToolDeps;
	sessionId: string;
	runId: string;
}) {
	return defineTool({
		name: 'sandbox_exec',
		description:
			'Run a command inside the project sandbox session. Time- and output-quota bound; cancellations are propagated.',
		input: SandboxExecInput,
		run: async (ctx) => {
			// Protected surfaces can also be written via shell redirection —
			// scan the command string for each protected prefix before any
			// dispatch (string-level, documented; the P09 manifest hash check
			// is the tamper-evident backstop).
			if (mentionsProtectedPath(ctx.data.command)) {
				throw new Error(
					`PROTECTED_PATH: command references an acceptance-harness path and was not dispatched`,
				);
			}
			const result = await deps.driver.execute({
				sessionId: deps.sessionId,
				command: ctx.data.command,
				// One durable tool delivery is one logical attempt. The host adds the real run id.
                // A later re-run of the same command must produce a fresh receipt.
				operationKey: `tool:${ctx.toolCallId}`,
				timeoutMs: ctx.data.timeoutMs,
				signal: ctx.signal,
			});
			return { output: JSON.stringify({ ...result, command: ctx.data.command }) };
		},
	});
}

/** Read a file from the sandbox session, refusing protected paths. */
export function makeReadSandboxFile(deps: {
	driver: SandboxToolDeps;
	sessionId: string;
}) {
	return defineTool({
		name: 'read_sandbox_file',
		description: 'Read a file from the sandbox session. Acceptance surfaces are read-allowed; writes to them are not.',
		input: SandboxPathInput,
		run: async (ctx) => {
			// Reads of protected paths are allowed (verification needs them);
			// writes are the guarded operation.
			const content = await deps.driver.readFile({ sessionId: deps.sessionId, path: ctx.data.path });
			return { output: content };
		},
	});
}

/** Write a file in the sandbox session — THE protected-path enforcement point. */
export function makeWriteSandboxFile(deps: {
	driver: SandboxToolDeps;
	sessionId: string;
}) {
	return defineTool({
		name: 'write_sandbox_file',
		description:
			'Write a file inside the sandbox. Protected acceptance surfaces (tests/acceptance/**, evaluator manifests, verifiers) are refused.',
		input: WriteSandboxFileInput,
		run: async (ctx) => {
			assertNotProtectedPath(ctx.data.path);
			await deps.driver.writeFile({
				sessionId: deps.sessionId,
				path: ctx.data.path,
				content: ctx.data.content,
			});
			return { output: `wrote ${ctx.data.path}` };
		},
	});
}

/** Tech-lead only: hand a repair round to a specialist (ledger-recorded). */
export function makeDelegateRepair(deps: {
	delegate: (input: { issue: string; round: string; toRole: string; task: string }) => Promise<void>;
}) {
	return defineTool({
		name: 'delegate_repair',
		description:
			'Delegate a repair round to a specialist. Rounds are ledger-recorded; three failed repair_attempts on one issue pause the run.',
		input: DelegateRepairInput,
		run: async (ctx) => {
			await deps.delegate({
				issue: ctx.data.issue,
				round: ctx.data.round,
				toRole: ctx.data.toRole,
				task: ctx.data.task,
			});
			return { output: `Repair proposal recorded for ${ctx.data.toRole}; invoke that specialist to execute the work.` };
		},
	});
}

/** QA only: append a verification result to the trusted evidence log. */
export function makeRecordVerification(deps: {
	record: (input: {
		check: string;
		passed: boolean;
		evidence: string;
		planRevision: string;
	}) => Promise<void>;
}) {
	return defineTool({
		name: 'record_verification',
		description:
			'Record a verification result (check, pass/fail, evidence). Appends only — recorded results are never editable by any agent.',
		input: RecordVerificationInput,
		run: async (ctx) => {
			await deps.record({
				check: ctx.data.check,
				passed: ctx.data.passed,
				evidence: ctx.data.evidence,
				planRevision: ctx.data.planRevision,
			});
			return { output: `verification recorded for ${ctx.data.check}` };
		},
	});
}

// --- acceptance gate (coordinator only) ---------------------------------------------

const RecordAcceptanceInput = v.object({
	check: v.string(),
	/** The exact command that produced the evidence (machine-checked, not prose). */
	command: v.string(),
	/** Exit code of that command — 0 is the only passing value. */
	exitCode: v.pipe(v.number(), v.integer()),
	/** Short digest of the command output used as evidence. */
	outputDigest: v.string(),
	/** The sandbox_exec operation key that ran this command — binds the
	 *  record to an actual execution instead of a self-report. */
	operationKey: v.pipe(v.string(), v.minLength(8)),
	planRevision: v.string(),
});

export interface GateRecord {
	check: string;
	command: string;
	exitCode: number;
	outputDigest: string;
	operationKey: string;
	planRevision: string;
	recordedAt: string;
}

export const GATE_DIR = '.caddie/gates';

/**
 * Coordinator-only: append an acceptance record to the run's gate ledger in
 * the sandbox (`.caddie/gates/<planRevision>.jsonl`). This is the
 * adjudication-proven write-path pattern — the completion gate reads this
 * file; agent write tools refuse the path, so only verified command evidence
 * can create it. Requires a harness with a declared sandbox; the pure
 * evaluator in coordinator.ts decides completion from the file's contents.
 */
export function makeRecordAcceptance(currentRevision?: () => string) {	return defineTool({
		name: 'record_acceptance',
		description:
			'Record an acceptance result for the run gate. Input must be REAL command evidence (exact command and exit code); the completion gate reads these records and refuses completion without a passing one under the current plan revision.',
		input: RecordAcceptanceInput,
		harness: true,
		run: async (ctx) => {
            return { output: 'record refused: caller-supplied acceptance is not evidence. Use verify_build to execute host checks and record machine receipts.' };
		},
	});
}

// --- home-conversation capabilities (product charter: the chat is the
// --- universal interface) ---------------------------------------------------

const CreateProjectInput = v.pipe(
	v.object({
		name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
		description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
	}),
	v.readonly(),
);

/**
 * Home runs only: create a project in the actor's own workspace. The host
 * closure performs the real, permission-checked creation with the same
 * service the REST route uses — the tool never fabricates success.
 */
export function makeCreateProject(deps: {
	createProject: (input: { name: string; description?: string }) => Promise<{
		id: string;
		name: string;
		workspaceId: string;
	}>;
}) {
	return defineTool({
		name: 'create_project',
		description:
			"Create a new project in the user's workspace. Use this whenever the user asks to start a new project — never tell them to create it themselves outside the chat.",
		input: CreateProjectInput,
		run: async (ctx) => {
			// Defensive trim: the schema trims when the runtime parses input, but
			// the service deserves clean values even from a direct call.
			const name = ctx.data.name.trim();
			const description = ctx.data.description?.trim();
			const project = await deps.createProject({
				name,
				description: description || undefined,
			});
			return {
				output: `Created project "${project.name}" (id ${project.id}, workspace ${project.workspaceId}). It is in the user's project list now: opening it in the workspace and sending a message there starts its run. Tell the user it is ready and what to do next.`,
			};
		},
	});
}

/**
 * Home runs only: the honest stack catalog, straight from the shared registry
 * (src/server/stacks.ts). Stack-availability answers come from this tool —
 * the model must not invent a stack list.
 */
export function makeListStacks(deps: {
	listStacks: () => Promise<readonly { id: string; status: string; note?: string }[]>;
}) {
	return defineTool({
		name: 'list_stacks',
		description:
			'List the output stacks this deployment of Caddie can actually build with. Answer stack-availability questions ONLY from this tool result — never from general knowledge.',
		input: v.pipe(v.object({}), v.readonly()),
		run: async () => {
			const stacks = await deps.listStacks();
			const lines = stacks.map((stack) => `- ${stack.id} — ${stack.status}${stack.note ? ` (${stack.note})` : ''}`);
			return { output: `Available stacks:\n${lines.join('\n')}` };
		},
	});
}

/** QA executes the host-owned checks; no caller supplies pass flags or evidence. */
export function makeVerifyBuild(deps: {verify:(operationKey:string, signal?:AbortSignal)=>Promise<unknown>}) {
 return defineTool({name:'verify_build',description:'Run the host-owned test and bundle checks against the approved current plan, record actual sandbox receipts and produce an isolated preview if they pass.',input:v.object({}),async run(ctx){return {output:JSON.stringify(await deps.verify(ctx.toolCallId, ctx.signal))};}});
}

/**
 * Build roles: run the SAME host-owned checks as verify_build (install,
 * `bun test src/`, browser build) without publishing a preview. The only way
 * a builder runs tests — shell test commands are refused by the host — so
 * every test run produces a real receipt and every failure counts toward the
 * repair pause.
 */
export function makeRunChecks(deps: { run: (operationKey: string, signal?: AbortSignal) => Promise<unknown> }) {
	return defineTool({
		name: 'run_checks',
		description:
			"Run the project's checks exactly as the host verifies them: install dependencies, run the behavior tests (`bun test src/`), then build the browser bundle. This is the ONLY way to run tests; shell test commands are refused. Every failing run counts toward this build's repair limit, so read the failure output and fix the cause before running it again. It does not publish a preview (QA's verify_build does).",
		input: v.object({}),
		async run(ctx) {
			return { output: JSON.stringify(await deps.run(ctx.toolCallId, ctx.signal)) };
		},
	});
}

// --- "Caddie learns you" capture tools (feature: capture → infer → surface) ---

/** The profile fields the coordinator may set from conversation. These are
 *  PREFERENCES describing the builder — never authorization. Budget is
 *  deliberately NOT settable here: a budget is a spending-comfort signal that
 *  stays an explicit, separately-gated action, so the model can never grant
 *  spending by "remembering" a number. */
const UpdateProfileInput = v.pipe(
	v.strictObject({
		skills: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)))),
		interests: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60)))),
		experienceLevel: v.optional(v.picklist(['beginner', 'intermediate', 'senior'])),
		formatPreference: v.optional(v.picklist(['online', 'in_person', 'either'])),
		weeklyHours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(80))),
		stackIds: v.optional(v.array(v.string())),
	}),
	v.readonly(),
);

/**
 * Set profile PREFERENCES the user tells Caddie in conversation (e.g. "I'm a
 * React developer" → skills+stack; "I have about 8 hours a week" →
 * weeklyHours). The host closure writes through the real profile service with
 * the actor re-verified server-side; the body can never name a user. Budget
 * and spending are intentionally not settable here.
 */
export function makeUpdateProfile(deps: {
	updateProfile: (input: {
		skills?: string[];
		interests?: string[];
		experienceLevel?: 'beginner' | 'intermediate' | 'senior';
		formatPreference?: 'online' | 'in_person' | 'either';
		weeklyHours?: number;
		stackIds?: string[];
	}) => Promise<{ applied: string[] }>;
}) {
	return defineTool({
		name: 'update_profile',
		description:
			"Record a profile PREFERENCE the user stated (skills, interests, experience level, participation format, weekly hours, or a preferred stack). Use when the user tells you something durable about themselves — never guess, and never set spending/budget here (that stays a separate explicit decision).",
		input: UpdateProfileInput,
		run: async (ctx) => {
			const result = await deps.updateProfile(ctx.data);
			return {
				output:
					result.applied.length > 0
						? `Updated profile: ${result.applied.join(', ')}. Tell the user plainly what you noted.`
						: 'No profile fields were provided to update.',
			};
		},
	});
}

const RememberInput = v.pipe(
	v.strictObject({
		content: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
		kind: v.optional(v.picklist(['preference', 'fact'])),
		/** True when this is INFERRED (from code, context) rather than stated
		 *  outright. Inferred facts are proposed and await the user's confirm. */
		inferred: v.optional(v.boolean()),
	}),
	v.readonly(),
);

/**
 * Propose a memory fact about the user. Everything proposed starts as a
 * PROPOSAL that only enters future context once the user confirms it (the R04
 * rule: inferred memory requires confirmation). The host closure routes to the
 * real memory service, stamping the source run so a proposal is always
 * traceable. A statement that reads as authorization ("ok to spend $50") is
 * refused — memory never grants a capability.
 */
export function makeRememberFact(deps: {
	remember: (input: { content: string; kind: 'preference' | 'fact' }) => Promise<{ proposed: boolean }>;
}) {
	return defineTool({
		name: 'remember',
		description:
			"Propose something worth remembering about the user (a durable preference or fact). It is saved as a PROPOSAL and only used in future conversations after the user confirms it. Never record anything that reads as permission to spend, deploy or change data — memory describes the user, it never authorises an action.",
		input: RememberInput,
		run: async (ctx) => {
			// Refuse authorization-shaped memory outright (defence in depth; the
			// service also never grants capability from memory).
			if (/\b(ok|okay|allowed|permission|authori[sz]e[d]?|go ahead)\b.*\b(spend|deploy|merge|delete|drop|purchase|pay)\b/i.test(ctx.data.content)
				|| /\b(spend|deploy|merge|delete|drop|purchase|pay)\b.*\b(approved|authori[sz]ed|allowed)\b/i.test(ctx.data.content)) {
				return { output: 'refused: that reads like an authorization, not a memory. Spending/deploys/merges are separate explicit decisions — do not record them as memory.' };
			}
			const result = await deps.remember({ content: ctx.data.content, kind: ctx.data.kind ?? 'preference' });
			return {
				output: result.proposed
					? 'Noted as a proposal. Ask the user to confirm it so it sticks for next time; it is NOT in effect until they do.'
					: 'Nothing was recorded.',
			};
		},
	});
}

/**
 * Read-only: look at what the user already built. Derives PROPOSED skills /
 * stack / working-style signals from the project's most recent imported
 * repository (CL3 pure inference). It writes NOTHING — the coordinator reads
 * the proposal, tells the user what it noticed, and only records anything the
 * user confirms via update_profile / remember. "I looked at your repos — looks
 * like TypeScript + React; want me to remember that?"
 */
export function makeInspectRepository(deps: {
	inspectRepository: () => Promise<{
		found: boolean;
		summary: string;
		skills: { skill: string; confidence: string }[];
		stacks: { stackId: string; confidence: string }[];
		notes: { content: string; kind: string }[];
	}>;
}) {
	return defineTool({
		name: 'inspect_repository',
		description:
			"Look at the user's most recently imported repository and infer what they build (languages, stack, whether they write tests). READ-ONLY and PROPOSAL-ONLY: it records nothing. Use it to personalize — tell the user what you noticed and, only if they confirm, call update_profile / remember. Never present an inference as a saved fact.",
		input: v.pipe(v.object({}), v.readonly()),
		run: async () => {
			const r = await deps.inspectRepository();
			if (!r.found) {
				return { output: 'No imported repository to inspect yet. Ask the user to connect a GitHub repo if they want Caddie to learn from their code.' };
			}
			return { output: JSON.stringify(r) };
		},
	});
}
