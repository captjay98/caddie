/**
 * P05 specialist permission policy — the single source of truth consumed by
 * both the agent definitions (apps/app/src/agents/specialists.ts) and the
 * permission tests. A specialist is instructions + allowed tools + skills +
 * scoped context; the policy below is the "allowed tools" contract.
 *
 * Threat model: role naming grants nothing — only these lists (enforced where
 * tools are mounted) plus the protected-path guard in tools.ts authorize
 * writes. QA verifies; it cannot mutate the product or the acceptance
 * harness. Nobody writes the protected acceptance surfaces through agent
 * tools at all.
 */

export const SPECIALIST_ROLES = [
	'product',
	'designer',
	'tech-lead',
	'frontend',
	'backend',
	'mobile',
	'qa',
] as const;

export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

/** Tool names mounted per role. Must match the definitions in tools.ts. */
export const ROLE_TOOL_POLICY: Readonly<Record<SpecialistRole, readonly string[]>> = {
	// Product shapes scope and acceptance intent, but holds no execution tools.
	product: ['read_project_context', 'write_plan_note'],
	designer: ['read_project_context', 'write_plan_note', 'read_sandbox_file'],
	'tech-lead': [
		'read_project_context',
		'write_plan_note',
		'sandbox_exec',
		'read_sandbox_file',
		'write_sandbox_file',
		'delegate_repair',
	],
	frontend: ['read_project_context', 'sandbox_exec', 'read_sandbox_file', 'write_sandbox_file'],
	backend: ['read_project_context', 'sandbox_exec', 'read_sandbox_file', 'write_sandbox_file'],
	mobile: ['read_project_context', 'sandbox_exec', 'read_sandbox_file', 'write_sandbox_file'],
	// QA verifies only: read + execute the project's own checks. No write tool
	// at all, so protected checks cannot be overwritten by QA even in error.
	qa: ['read_project_context', 'read_sandbox_file', 'verify_build'],
};

/** Everything a tool could ever write through, for cross-checks in tests. */
export const ALL_TOOL_NAMES: readonly string[] = [
	...new Set(SPECIALIST_ROLES.flatMap((role) => ROLE_TOOL_POLICY[role])),
];

/**
 * Paths agent write-tools must refuse outright. These surfaces decide whether
 * work is accepted; mutating them through an agent tool would let the
 * specialist grade its own homework. (Independent acceptance harness files,
 * the immutable evaluator manifest, the verifier, and the delivery ledger.)
 */
export const PROTECTED_PATH_PREFIXES: readonly string[] = [
	'tests/acceptance/',
	'tests/fixtures/forge-task-tracker/',
	'scripts/verify-packet.ts',
	'scripts/run-journey.ts',
	// The completion gate's own evidence: only the coordinator's acceptance
	// tool writes here (via harness.sandbox); agent write tools refuse it.
	'.caddie/gates/',
];

export function isProtectedPath(path: string): boolean {
	const normalized = path.replaceAll('\\','/').split('/').reduce<string[]>((parts,part) => { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); return parts; }, []).join('/');
 return PROTECTED_PATH_PREFIXES.some(prefix => normalized === prefix.replace(/\/$/,'') || normalized.startsWith(prefix) || normalized.includes(`/${prefix}`));
}

/**
 * For command strings (sandbox_exec): the protected path may appear anywhere
 * in the command (e.g. after a redirect). Broader than isProtectedPath —
 * a false positive blocks a legitimate command, a false negative writes the
 * acceptance harness. Deliberately biased to blocking.
 */
export function mentionsProtectedPath(command: string): boolean {
	return PROTECTED_PATH_PREFIXES.some((prefix) => command.includes(prefix));
}

/**
 * Repair-ledger round taxonomy (adjudication harness pattern): retries,
 * diagnosis, transport problems and framework recovery are NOT repairs — the
 * pause rule counts only `repair_attempt` failures per issue.
 */
export const REPAIR_ROUND_KINDS = [
	'diagnosis',
	'repair_attempt',
	'verification',
	'transport_retry',
	'framework_recovery',
] as const;

export type RepairRoundKind = (typeof REPAIR_ROUND_KINDS)[number];

/** Failed repair attempts on the SAME issue before the run pauses. */
export const REPAIR_PAUSE_THRESHOLD = 3;
