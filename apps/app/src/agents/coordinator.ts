'use agent';
import {
	sandboxFromDriver,
	useAgentFinish,
	useInstruction,
	useModel,
	useSandbox,
	useSkill,
	useSubagent,
	useTool,
	type SandboxDriver,
} from '@flue/runtime';
import { findModelRoute } from './providers.ts';
import { makeRecordAcceptance } from './tools.ts';
import { evaluateGateLedger, gatePathFor } from './completion-gate.ts';
import { buildSpecialistDeclarations, SPECIALIST_INSTRUCTIONS, type SpecialistBuildContext } from './specialists.ts';

/**
 * P05 coordinator — the one durable conversation agent. Registered by the
 * generated router under /agents/coordinator with the conversation guard
 * (P05 routes) ahead of it. Delegates all build/verify work to the seven
 * restricted specialists via useSubagent (model on the DEFINITION inherits
 * the coordinator's turn; subagent renders never call useModel).
 *
 * The model route is the FROZEN registration from providers.ts — the same
 * registry run creation validates against; an agent never falls back to a
 * different provider or price.
 *
 * The sandbox: the host context supplies a flue-compatible SandboxDriver
 * adapted from the P04 session driver; useSandbox declares it so tools and
 * the completion gate can reach the run's real environment. Without a
 * declared sandbox the gate fails closed.
 *
 * The completion gate: useAgentFinish reads the gate ledger from the sandbox
 * and refuses completion without passing machine-checked records under the
 * current plan revision — by appending a corrective signal, which continues
 * the run instead of settling it.
 *
 * Live model/round-trip verification is tests/live/flue-lifecycle.spec.ts —
 * BLOCKED without NEBIUS_API_KEY. Everything testable without a provider is
 * in tests/agent-permissions.test.ts.
 */

const ROUTE = findModelRoute('nemotron-3-super');

/**
 * Runtime wiring the coordinator needs from the host (app.ts at mount time):
 * the specialist build context, the current plan revision getter, and the
 * flue-compatible sandbox driver. Provided through a module-scoped slot so
 * the agent function stays a zero-arg exported function (its name is its
 * durable identity).
 */
let hostContext:
	| (SpecialistBuildContext & {
			currentPlanRevision: () => string;
			/** Flue-compatible driver for useSandbox; null = no sandbox configured. */
			sandboxDriver: SandboxDriver | null;
	  })
	| null = null;

export function provideCoordinatorContext(
	context: SpecialistBuildContext & {
		currentPlanRevision: () => string;
		sandboxDriver: SandboxDriver | null;
	},
): void {
	hostContext = context;
}

function requireHostContext(): NonNullable<typeof hostContext> {
	if (!hostContext) {
		throw new Error('coordinator host context not provided — call provideCoordinatorContext at mount');
	}
	return hostContext;
}

function currentRevision(): string {
	return hostContext?.currentPlanRevision() ?? '';
}

export function Coordinator() {
	useModel(ROUTE.specifier);

	const context = requireHostContext();
	if (context.sandboxDriver) {
		// The run's real environment (P04 session driver adapted to the flue
		// Sandbox interface). The factory is called once per initialized
		// harness and the sandbox is shared across its sessions.
		const driver = context.sandboxDriver;
		useSandbox({ createSandbox: async () => sandboxFromDriver(driver, '/workspace') }, {});
	}

	useSkill({
		name: 'build-verify',
		description: 'build-verify (v1.0.0)',
		instructions:
			'Coordinator discipline: delegate build and repair work to specialists; require exact command evidence for every claim; record passing evidence with record_acceptance (with the operation key of the command that produced it) before considering the run complete.',
	});

	for (const declaration of buildSpecialistDeclarations(context)) {
		useSubagent(declaration);
	}
	useTool(makeRecordAcceptance());

	useAgentFinish(async (ctx) => {
		let content: string | null = null;
		try {
			content = await ctx.harness.sandbox.readFile(gatePathFor(currentRevision()));
		} catch {
			content = null; // fail closed: no gate file, no completion
		}
		const verdict =
			content === null
				? {
						completable: false,
						reason: 'gate ledger unreadable or missing — record acceptance evidence first',
					}
				: evaluateGateLedger(content, currentRevision());
		if (!verdict.completable) {
			// AgentAppendMessage is the dispatch signal form: only kind 'signal'
			// is accepted — appending continues the run instead of settling it.
			ctx.append({
				kind: 'signal',
				type: 'completion_refused',
				body: `COMPLETION REFUSED: ${verdict.reason}. Do not claim success; run the machine checks and record the evidence with record_acceptance.`,
			});
		}
	});

	useInstruction(
		`You are Caddie's coordinator for this run. Model route ${ROUTE.id} is fixed for the whole run. ` +
			'Work through the specialists; never claim success without machine-checked evidence recorded via record_acceptance. ' +
			`Tool results from older plan revisions are stale and must be re-run. ` +
			SPECIALIST_INSTRUCTIONS['tech-lead'],
	);

	return `You are Caddie's coordinator: you delegate product, design, technical, frontend, backend, mobile and QA work to your specialists, keep the plan of record honest, and never report success that the machine checks do not back.`;
}
