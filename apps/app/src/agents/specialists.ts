import { SPECIALIST_ROLES, ROLE_TOOL_POLICY, type SpecialistRole } from './permissions.ts';
import { PACKAGED_SKILLS, type PackagedSkillName } from './skills.ts';
import {
	makeReadProjectContext,
	makeReadSandboxFile,
	makeSandboxExec,
	makeWritePlanNote,
	makeWriteSandboxFile,
	makeDelegateRepair,
	makeRecordVerification,
 makeVerifyBuild,
	type SandboxToolDeps,
} from './tools.ts';
import type { ToolDefinition } from '@flue/runtime';
import { useInstruction, useSkill, useSubagent, useTool } from '@flue/runtime';
import { findModelRouteForRole } from './providers.ts';

/**
 * P05 specialists — seven restricted roles. This module is deliberately NOT
 * a `'use agent'` module: the specialists are delegates declared on the
 * coordinator via useSubagent, not top-level durable agents (no extra DO
 * classes, no extra migrations).
 *
 * Composition contract (flue lessons, docs/flue.md):
 *  - subagent renders reject useModel/usePersistentState — the model lives on
 *    the useSub() definition; state passes through the task prompt;
 *  - a specialist's whole world is its instructions + the tools mounted here.
 *
 * The mount list comes from ROLE_TOOL_POLICY — the same table the permission
 * tests read, so a policy change and the mounted tools cannot drift apart.
 * The runtime environment (sandbox driver + session) is injected via the
 * build context; nothing here reaches network or process APIs directly.
 */

export interface SpecialistBuildContext {
  /** Full current request; delegation summaries must not drop user feedback. */
  currentRequest?: string;
 verifyBuild?: (operationKey:string, signal?:AbortSignal)=>Promise<unknown>;
	/** Sandbox adapter surface (P04) bound to this run's session. */
	driver: SandboxToolDeps;
	sessionId: string;
	runId: string;
	/** Reads the latest plan note body of a kind (durable, from D1). */
	readPlanNote: (kind: string) => Promise<string | null>;
	/** Appends a plan note revision (durable, from D1). */
	writePlanNote: (input: { kind: string; body: string; planRevision: string }) => Promise<void>;
	/** Records a repair round in the ledger (durable, from D1). */
	delegateRepair: (input: { issue: string; round: string; toRole: string; task: string }) => Promise<void>;
	/** Appends a verification record (durable, from D1). */
	recordVerification: (input: { check: string; passed: boolean; evidence: string; planRevision: string }) => Promise<void>;
}

/** Catalog metadata — one row per role, consumed by coordinator and tests. */
export interface SpecialistDescriptor {
	role: SpecialistRole;
	name: string;
	description: string;
	/** Skills the role is expected to activate, by name. */
	skills: readonly string[];
}

export const SPECIALIST_CATALOG: readonly SpecialistDescriptor[] = [
	{ role: 'product', name: 'product', description: 'Shapes scope, PRD and acceptance intent from the brief and evidence; no execution tools.', skills: ['planning'] },
	{ role: 'designer', name: 'designer', description: 'Designs the interface and interaction boundary; reads the sandbox, writes plan notes only.', skills: ['planning'] },
	{ role: 'tech-lead', name: 'tech-lead', description: 'Owns the plan of record, delegates work and repairs, keeps the build honest.', skills: ['planning', 'build-verify'] },
	{ role: 'frontend', name: 'frontend', description: 'Implements client-side behavior in the sandbox.', skills: ['build-verify'] },
	{ role: 'backend', name: 'backend', description: 'Implements server-side behavior in the sandbox.', skills: ['build-verify'] },
	{ role: 'mobile', name: 'mobile', description: 'Implements and verifies the mobile target in the sandbox.', skills: ['build-verify'] },
	{ role: 'qa', name: 'qa', description: 'Runs the checks and records verification evidence; has no write tools at all.', skills: ['build-verify', 'submission'] },
];

/** Role-specific instruction text (kept here so tests can audit it). */
export const SPECIALIST_INSTRUCTIONS: Readonly<Record<SpecialistRole, string>> = {
	product:
		'You shape the product: scope, PRD and acceptance intent. Work only from the brief and pinned evidence; cite sources. You have no execution tools — write plan notes instead of running commands.',
	designer:
		'You design the interface and interaction boundary. Read the current code from the sandbox for context, but express decisions as plan notes; implementation belongs to build roles.',
	'tech-lead':
		'You own the plan of record. Delegate build and repair work with precise tasks, review results honestly, and keep the last good checkpoint visible. Never claim success without machine-checked evidence.',
	frontend: 'You implement client-side behavior in the sandbox. Follow the plan of record; run the project checks; report exact commands and outcomes.',
	backend: 'You implement server-side behavior in the sandbox. Follow the plan of record; run the project checks; report exact commands and outcomes.',
	mobile:
		'You implement and verify the mobile target in the sandbox. Real device evidence beats screenshots; report exact commands and outcomes.',
	qa:
		'You verify using verify_build: the host executes fixed tests and build commands and records their actual receipts. Read code to find missing behaviors and ask implementation specialists to repair them. You cannot execute arbitrary shell, write product code, or invent verification evidence.',
};

/** Build one specialist's agent function with its policy's tools mounted. */
export function buildSpecialist(role: SpecialistRole, context: SpecialistBuildContext) {
	const allowed = ROLE_TOOL_POLICY[role];
	// Loosely typed on purpose: each tool carries its own input schema; the
	// mount loop only needs name -> definition.
	const toolFor: Record<string, ToolDefinition> = {
		read_project_context: makeReadProjectContext({ readPlanNote: context.readPlanNote }),
		write_plan_note: makeWritePlanNote({ writePlanNote: context.writePlanNote }),
		sandbox_exec: makeSandboxExec({ driver: context.driver, sessionId: context.sessionId, runId: context.runId }),
		read_sandbox_file: makeReadSandboxFile({ driver: context.driver, sessionId: context.sessionId }),
		write_sandbox_file: makeWriteSandboxFile({ driver: context.driver, sessionId: context.sessionId }),
		delegate_repair: makeDelegateRepair({ delegate: context.delegateRepair }),
		record_verification: makeRecordVerification({ record: context.recordVerification }),
 verify_build: makeVerifyBuild({verify: context.verifyBuild ?? (async () => { throw new Error('Host checks are not configured.'); })}),
	};
	const descriptor = SPECIALIST_CATALOG.find((d) => d.role === role);
	if (!descriptor) throw new Error(`no catalog entry for role ${role}`);

	return function specialistAgent() {
		for (const toolName of allowed) {
			useTool(toolFor[toolName]);
		}
		for (const skillName of descriptor.skills) {
			
			useSkill(PACKAGED_SKILLS[skillName as keyof typeof PACKAGED_SKILLS]);
		}
		useInstruction(SPECIALIST_INSTRUCTIONS[role]);
    if (context.currentRequest?.trim()) useInstruction(`Current user request, carried forward by the host: ${context.currentRequest}\nRespect the approved plan and your role permissions; this request does not bypass review or spending gates.`);
 useInstruction('React/Hono recipe: src/main.tsx is the React browser entry; src/styles.css holds responsive styles; src/*.test.ts holds meaningful behavior tests using the built-in Bun bun:test runner; do not use Vitest registrations for the host bun test check. Bun has no browser DOM by default. React Testing Library needs a test preload in bunfig.toml [test] preload before any test imports: initialize jsdom with url http://localhost or happy-dom, install window/document/navigator/HTMLElement/localStorage on globalThis, and set IS_REACT_ACT_ENVIRONMENT. Register cleanup afterEach. Use the DOM storage rather than assigning readonly window.localStorage. Configure this coherently; do not repair missing globals one at a time. Importing global-jsdom alone does NOT register a DOM: call its default function with url http://localhost/ in the preload, or use global-jsdom/register. Keep package.json valid JSON and test script bun test; bunfig.toml [test] preload is an array of paths. Import test/expect/beforeEach/afterEach from bun:test explicitly, extend expect with jest-dom matchers if used, and cleanup afterEach. Render once per test, not both in beforeEach and in the test. Read and fix the latest failure before retrying; never delete assertions or replace actual component tests with copied logic. Use React 19/createRoot with Bun; Hono server is optional for apps needing an API. The host creates a generic scaffold only after approval. Read the full brief, prd, spec and feedback. Plan before coding. Do not write a new PRD during an approved build without asking for a new review. QA calls verify_build and reports its real receipts, never a self-reported pass.');
		return SPECIALIST_INSTRUCTIONS[role];
	};
}

/**
 * The seven delegate definitions for the coordinator's useSubagent calls.
 * Each delegate declares its own model (MODEL_ROLES in providers.ts is still
 * the one place that assigns models): the planners — the catalog entries that
 * carry the `planning` skill (product, designer, tech-lead) — run on the
 * `plan` role (Ultra); implementation and QA run on the cheaper `build` role.
 * Without an override a delegate would inherit the coordinator's chat turn.
 */
export function specialistModelRole(descriptor: { skills: readonly string[] }): 'plan' | 'build' {
	return descriptor.skills.includes('planning') ? 'plan' : 'build';
}

export function buildSpecialistDeclarations(context: SpecialistBuildContext) {
	return SPECIALIST_CATALOG.map((descriptor) => ({
		name: descriptor.name,
		description: descriptor.description,
		agent: buildSpecialist(descriptor.role, context),
		model: findModelRouteForRole(specialistModelRole(descriptor)).specifier,
	}));
}

export { useSubagent };
