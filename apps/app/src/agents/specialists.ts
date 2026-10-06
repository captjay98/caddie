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
	type SandboxToolDeps,
} from './tools.ts';
import type { ToolDefinition } from '@flue/runtime';
import { useInstruction, useSkill, useSubagent, useTool } from '@flue/runtime';

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
	{ role: 'qa', name: 'qa', description: 'Runs the checks and records verification evidence; has no write tools at all.', skills: ['build-verify'] },
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
		'You verify. Run the project checks and the acceptance harness, and record what actually happened with exact evidence. You have no write tools — you cannot change the product or the checks, only measure them.',
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
		return SPECIALIST_INSTRUCTIONS[role];
	};
}

/**
 * The seven delegate definitions for the coordinator's useSubagent calls —
 * declared here (model omitted: inherits the coordinator's turn) so the
 * coordinator module stays the only place that names models.
 */
export function buildSpecialistDeclarations(context: SpecialistBuildContext) {
	return SPECIALIST_CATALOG.map((descriptor) => ({
		name: descriptor.name,
		description: descriptor.description,
		agent: buildSpecialist(descriptor.role, context),
	}));
}

export { useSubagent };
