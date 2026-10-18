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
		'run_checks',
		'delegate_repair',
		'request_app_key',
	],
	// Build roles run the project's tests ONLY through run_checks (host-run,
	// fixed commands, every failure counted toward the repair pause); shell
	// test commands are refused at the host (isShellTestCommand). They can ask
	// the owner for an app key (request_app_key) but never receive its value.
	frontend: ['read_project_context', 'sandbox_exec', 'read_sandbox_file', 'write_sandbox_file', 'run_checks', 'request_app_key'],
	backend: ['read_project_context', 'sandbox_exec', 'read_sandbox_file', 'write_sandbox_file', 'run_checks', 'request_app_key'],
	mobile: ['read_project_context', 'sandbox_exec', 'read_sandbox_file', 'write_sandbox_file', 'run_checks', 'request_app_key'],
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
	// The generated app's test harness (stacks/react-hono/scaffold.ts): the
	// builder writes tests, never the DOM/Testing Library setup that runs them.
	'bunfig.toml',
	'test/setup/',
	// Caddie's runtime files in every app (D1 types, the Workers compatibility
	// check that runs in the build): the builder uses them, never edits them.
	'caddie/',
];

export function isProtectedPath(path: string): boolean {
	const normalized = path.replaceAll('\\','/').split('/').reduce<string[]>((parts,part) => { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); return parts; }, []).join('/');
 return PROTECTED_PATH_PREFIXES.some(prefix => normalized === prefix.replace(/\/$/,'') || normalized.startsWith(prefix) || normalized.includes(`/${prefix}`));
}

/**
 * For command strings (sandbox_exec): the protected path may appear anywhere
 * in the command (e.g. after a redirect, or as an `rm` target). Broader than
 * isProtectedPath — a false positive blocks a legitimate command, a false
 * negative writes the acceptance harness. Deliberately biased to blocking.
 *
 * A plain `command.includes(prefix)` was a bypass: every prefix carries a
 * trailing slash, so `rm -rf tests/acceptance` (no slash) slipped through even
 * though it destroys the whole protected directory. Match each prefix with its
 * trailing slash OPTIONAL, bounded so the match is a real path token — the
 * directory itself (`tests/acceptance`), anything under it
 * (`tests/acceptance/foo`), and a `./`-relative form all count, while an
 * unrelated longer name (`tests/acceptance-notes`) does not falsely trip.
 */
export function mentionsProtectedPath(command: string): boolean {
	const normalized = command.replaceAll('\\', '/');
	return PROTECTED_PATH_PREFIXES.some((prefix) => {
		const bare = prefix.replace(/\/$/, '');
		const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		// Left boundary: start, whitespace, or a shell separator / `./` lead-in.
		// Right boundary: end, a slash (into the dir), whitespace, or a separator —
		// so the token is the protected path itself or something inside it, not a
		// different path that merely shares its prefix.
		const pattern = new RegExp(`(^|[\\s;&|()'"=]|\\./)${escaped}($|/|[\\s;&|()'"])`);
		return pattern.test(normalized);
	});
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

/**
 * Does a shell command run a test runner? Build roles must test through
 * run_checks instead: a shell test run escaped the repair counter (FarmLog AI,
 * 2026-10-15: `bun test … | head -14` reported head's exit 0). Biased to
 * refusing — a false positive costs one redirected call, a false negative an
 * uncounted test loop. Installing a package whose name contains a runner
 * (`bun add @testing-library/jest-dom`) is not a test run and passes.
 */
export function isShellTestCommand(command: string): boolean {
	const c = command.replaceAll('\\', '/');
	return (
		/\bbun\s+(?:run\s+)?test\b/.test(c) ||
		/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/.test(c) ||
		/\b(?:npx|bunx|bun\s+x)\s+(?:vitest|jest|mocha|playwright)\b/.test(c) ||
		/(?:^|[;&|(]|\$\()\s*(?:\w+=\S*\s+)*(?:vitest|jest|mocha)\b/.test(c)
	);
}

/**
 * Sandbox actions (commands + file writes + host checks) one build window may
 * spend before the host stops it honestly. A user retry opens a fresh window.
 */
export const BUILD_ACTION_BUDGET = 150;

/** The same action repeated this many times in a row, with nothing else between, is refused. */
export const REPEATED_ACTION_LIMIT = 3;

/**
 * The coordinator's Flue submission bound (Coordinator.durability). Explicit
 * rather than Flue's silent default (1 hour, 10 attempts) so the build bounds
 * are readable in one place. A submission that exceeds it is aborted and
 * settled failed by Flue; no hook observes that settlement, so the app's stall
 * watchdog (build-workflow.ts BUILD_STALL_MS, shorter than this) is what turns
 * the resulting silence into an honest, retryable `blocked` state.
 */
export const COORDINATOR_DURABILITY = { timeoutMs: 60 * 60_000, maxAttempts: 3 } as const;
