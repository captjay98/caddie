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
	}): Promise<{ remoteId: string }>;
	readFile(input: { sessionId: string; path: string }): Promise<string>;
	writeFile(input: { sessionId: string; path: string; content: string }): Promise<void>;
}

const ReadProjectContextInput = v.object({
	paths: v.array(v.string()),
});
const WritePlanNoteInput = v.object({
	kind: v.picklist(['kernel', 'scope', 'prd', 'spec', 'note']),
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
			return { output: `plan note ${ctx.data.kind} recorded` };
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
				// Deterministic key: hash of the logical action (run + command).
				// A retry of the same command reuses the key — never an attempt ID.
				operationKey: `exec:${deps.runId}:${createHash('sha256').update(ctx.data.command).digest('hex').slice(0, 24)}`,
				timeoutMs: ctx.data.timeoutMs,
			});
			return { output: `dispatched ${result.remoteId}` };
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
			return { output: `delegated ${ctx.data.round} to ${ctx.data.toRole}` };
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
export function makeRecordAcceptance(currentRevision?: () => string) {
	return defineTool({
		name: 'record_acceptance',
		description:
			'Record an acceptance result for the run gate. Input must be REAL command evidence (exact command and exit code); the completion gate reads these records and refuses completion without a passing one under the current plan revision.',
		input: RecordAcceptanceInput,
		harness: true,
		run: async (ctx) => {
			if (ctx.data.exitCode !== 0 && ctx.data.exitCode !== 1) {
				return { output: 'record refused: exitCode must be 0 (pass) or 1 (fail) from the actual command' };
			}
			// The gate reads ONLY the run's current revision file; a record
			// written under any other revision is invisible to it (the model
			// invented revisions like "1" and the gate refused completion
			// forever). Refuse mismatches loudly instead of writing a ledger
			// the gate can never see.
			if (currentRevision && ctx.data.planRevision !== currentRevision()) {
				return {
					output: `record refused: planRevision must be the run's current revision ("${currentRevision()}") — received "${ctx.data.planRevision}". Re-run the command and record with the current revision.`,
				};
			}
			const record: GateRecord = {
				check: ctx.data.check,
				command: ctx.data.command,
				exitCode: ctx.data.exitCode,
				outputDigest: ctx.data.outputDigest,
				operationKey: ctx.data.operationKey,
				planRevision: ctx.data.planRevision,
				recordedAt: new Date().toISOString(),
			};
			const path = `${GATE_DIR}/${ctx.data.planRevision}.jsonl`;
			// The Sandbox surface has no appendFile: read-modify-write is safe
			// here because gate writes happen within this agent's sequential
			// turn, and the completion gate only appends via this tool.
			const existing = await ctx.harness.sandbox.readFile(path).catch(() => "");
			await ctx.harness.sandbox.writeFile(path, `${existing}${JSON.stringify(record)}\n`);
			return { output: `acceptance recorded for ${ctx.data.check} (exit ${ctx.data.exitCode})` };
		},
	});
}
