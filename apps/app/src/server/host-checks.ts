import { FLUTTER_SCAFFOLD_COMMANDS } from "../../../../stacks/flutter/scaffold.ts";
import { SCAFFOLD_COMMANDS } from "../../../../stacks/react-hono/scaffold.ts";
import { parseTestCounts } from "./build-timeline.ts";
import { VERIFIED_INSTALL_COMMAND } from "./verified-install.ts";
import { generateContractFiles, type ContractKind } from "./contract-files.ts";
import type { ArchitectureBlock } from "@caddie/contracts";

/**
 * The host-owned checks for each kind of app, in order. Fixed recipe commands
 * (never model-supplied); every one is receipt-checked by coordinator-host.ts.
 *
 *   web app      install packages, behaviour tests, browser build
 *   Android app  (Track 3) Android + web project setup and pub packages, then
 *                the same three for the Flutter app and its server. The
 *                timeouts are longer: the first setup creates the Android
 *                project, and flutter's test and web build compile Dart.
 */
export interface HostCheck {
	check: "app-setup" | "dependencies" | "behavior-tests" | "browser-bundle";
	command: string;
	timeoutMs: number;
}

export function hostCheckCommands(stack: "react-hono" | "flutter"): HostCheck[] {
	if (stack === "flutter") {
		return [
			{ check: "app-setup", command: FLUTTER_SCAFFOLD_COMMANDS.appSetup, timeoutMs: 10 * 60_000 },
			{ check: "dependencies", command: VERIFIED_INSTALL_COMMAND, timeoutMs: 10 * 60_000 },
			{ check: "behavior-tests", command: FLUTTER_SCAFFOLD_COMMANDS.test.join(" && "), timeoutMs: 10 * 60_000 },
			{ check: "browser-bundle", command: FLUTTER_SCAFFOLD_COMMANDS.build.join(" && "), timeoutMs: 10 * 60_000 },
		];
	}
	return [
		{ check: "dependencies", command: VERIFIED_INSTALL_COMMAND, timeoutMs: 120_000 },
		{ check: "behavior-tests", command: SCAFFOLD_COMMANDS.test.join(" && "), timeoutMs: 120_000 },
		{ check: "browser-bundle", command: SCAFFOLD_COMMANDS.build.join(" && "), timeoutMs: 120_000 },
	];
}

/**
 * A test run counts only when at least one test passed and none failed, read
 * from the runner's own summary (bun's "N pass", flutter's "+N: All tests
 * passed!", or both added up). The exit code is checked separately.
 */
export function testsPassed(output: string): boolean {
	const counts = parseTestCounts(output);
	return counts !== null && counts.passed > 0 && counts.failed === 0;
}

// ---------------------------------------------------------------------------
// Team mode: the contract checks (plan part E, steps 1-9).
//
// When a workflow has teamMode = 1, the host also runs the generated contract
// test (caddie/contract.test.ts) in phases, in order, against ONE file database
// at CADDIE_TEST_DB_FILE — so create (process 1) and read (process 2) really do
// cross a restart. Each phase gates on BOTH the exit code AND the parsed test
// counts (a thrown hook can still exit 0, and a file that ran zero tests proves
// nothing), and a failed phase is reported as a plain sentence a non-technical
// person can act on.
//
// The generated files (contract.ts, api.ts, router.tsx, contract.test.ts and
// test/setup/d1-file.ts) must be WRITTEN into the app before each run — when a
// feature is handed out and before every check run — so the test always matches
// the approved design. `writeContractFiles` is the hook the coordinator-host
// calls to do that; it is kept here so the generation and the checks live
// together.
// ---------------------------------------------------------------------------

/** The phases part E runs, in order. The restart lives between `create` and `read`. */
export const CONTRACT_PHASES = ["create", "read", "privacy-screen", "test-mode"] as const;
export type ContractPhase = (typeof CONTRACT_PHASES)[number];

/** The required checks that gate a team-mode publish (part G); mapped from phases here. */
export const CONTRACT_CHECK_NAMES = ["sign-in", "second-person", "restart"] as const;
export type ContractCheckName = (typeof CONTRACT_CHECK_NAMES)[number];

export interface ContractPhaseResult {
	readonly phase: ContractPhase;
	/** The child process exit code. */
	readonly exitCode: number;
	/** The parsed pass/fail counts, or null when the runner printed none. */
	readonly counts: { passed: number; failed: number } | null;
	readonly passed: boolean;
	/** A plain sentence when the phase failed, else null. */
	readonly failureSentence: string | null;
	/** The raw output, kept for the receipt. */
	readonly output: string;
}

export interface ContractCheckOutcome {
	readonly passed: boolean;
	readonly phases: readonly ContractPhaseResult[];
	/** The first plain failure sentence, for the build card; null when all green. */
	readonly failureSentence: string | null;
	/**
	 * Per required check, green/red — written to the output's verify receipts so
	 * part G (publish-safety) can bind a team-mode publish to this exact output.
	 */
	readonly checks: Readonly<Record<ContractCheckName, boolean>>;
}

/** How one phase is run. Injected, so the host wires `bun test` and tests stub it. */
export type PhaseRunner = (phase: ContractPhase) => Promise<{ exitCode: number; output: string }> | { exitCode: number; output: string };

/** A plain sentence for a phase that failed. Part E: "name the record and the step". */
function phaseFailureSentence(phase: ContractPhase, reason: "exit" | "counts" | "zero"): string {
	switch (phase) {
		case "create":
			return reason === "zero"
				? "The app's save-and-check didn't run, so we can't tell if your data is really saved."
				: "Something you add to the app can't be saved.";
		case "read":
			return "Something you saved is gone after the app restarts.";
		case "privacy-screen":
			return "One person can see another person's private data, or a screen doesn't show what was saved.";
		case "test-mode":
			return "A test-mode feature (payments, emails, a job or a file) doesn't behave as the plan says.";
	}
}

/** A phase passed only when the process exited 0 AND at least one test passed and none failed. */
function evaluatePhase(phase: ContractPhase, exitCode: number, output: string): ContractPhaseResult {
	const counts = parseTestCounts(output);
	if (exitCode !== 0) {
		return { phase, exitCode, counts, passed: false, failureSentence: phaseFailureSentence(phase, "exit"), output };
	}
	if (counts === null || (counts.passed === 0 && counts.failed === 0)) {
		// A phase with no tests to run (e.g. test-mode when nothing is declared) is
		// allowed to pass vacuously ONLY for the optional trailing phase; the core
		// phases must run at least one test.
		if (phase === "test-mode") {
			return { phase, exitCode, counts, passed: true, failureSentence: null, output };
		}
		return { phase, exitCode, counts, passed: false, failureSentence: phaseFailureSentence(phase, "zero"), output };
	}
	if (counts.failed > 0) {
		return { phase, exitCode, counts, passed: false, failureSentence: phaseFailureSentence(phase, "counts"), output };
	}
	return { phase, exitCode, counts, passed: true, failureSentence: null, output };
}

/** Which required check a passed phase proves. */
const PHASE_TO_CHECK: Record<ContractPhase, ContractCheckName | null> = {
	create: "sign-in",
	read: "restart",
	"privacy-screen": "second-person",
	"test-mode": null,
};

/**
 * Run the team-mode contract phases in order against one file database. Stops
 * at the first failed phase (a failed create makes read meaningless). Returns
 * the per-phase results, the first plain failure sentence, and the per-check
 * green/red map the output's receipts carry for part G.
 */
export async function runTeamModeContractChecks(run: PhaseRunner): Promise<ContractCheckOutcome> {
	const phases: ContractPhaseResult[] = [];
	const checks: Record<ContractCheckName, boolean> = { "sign-in": false, "second-person": false, restart: false };
	let failureSentence: string | null = null;

	for (const phase of CONTRACT_PHASES) {
		const { exitCode, output } = await run(phase);
		const result = evaluatePhase(phase, exitCode, output);
		phases.push(result);
		if (result.passed) {
			const check = PHASE_TO_CHECK[phase];
			if (check) checks[check] = true;
		} else {
			failureSentence = result.failureSentence;
			break; // a later phase can't be trusted once an earlier one failed
		}
	}

	const passed = phases.length === CONTRACT_PHASES.length && phases.every((p) => p.passed);
	return { passed, phases, failureSentence, checks };
}

/** The most output a contract receipt hands the builder (the failure lines first). */
const CONTRACT_RECEIPT_CHARS = 6000;

/**
 * The failed contract phase as a check receipt, shaped like the base checks'
 * receipts, so the builder's repair sees WHY it failed: the generated test's
 * own error and (fail) lines first, then the end of the output. The plain
 * failureSentence is for the person; this is for the builder. Null when every
 * phase passed.
 */
export function contractFailureReceipt(
	outcome: ContractCheckOutcome,
	operationKey: string,
): { check: string; passed: false; exitCode: number; stdout: string; stderr: string; operationKey: string } | null {
	const failed = outcome.phases.find((phase) => !phase.passed);
	if (!failed) return null;
	const lines = failed.output.split("\n");
	const marked = lines.filter((line) => /^(error: |\(fail\) |Expected|Received)/.test(line.trim()));
	const head = [...new Set(marked)].join("\n");
	const rest = CONTRACT_RECEIPT_CHARS - head.length - 40;
	const tailText = rest > 0 ? failed.output.slice(-rest) : "";
	return {
		check: `contract-${failed.phase}`,
		passed: false,
		exitCode: failed.exitCode,
		stdout: (head ? `${head}\n--- end of the contract test output ---\n${tailText}` : tailText).slice(0, CONTRACT_RECEIPT_CHARS),
		stderr: "",
		operationKey: `${operationKey}:${failed.phase}`,
	};
}

/**
 * The generated contract files for an app, from its approved architecture
 * block. The coordinator-host writes these into the working copy before every
 * check run (and when a feature is handed out), so the contract test always
 * matches the approved design. Thin wrapper over the generator so generation
 * and the checks stay in one module.
 *
 * `features`: the features built so far (passed plus the current one). The
 * generated test then checks only their routes and screens (plan part E); the
 * route table stays whole. Omit it for the final check of the whole design.
 */
export function writeContractFiles(
	block: ArchitectureBlock,
	kind: ContractKind,
	features?: readonly string[],
): Readonly<Record<string, string>> {
	return generateContractFiles(block, { kind, ...(features ? { features } : {}) }).files;
}
