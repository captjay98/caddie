'use agent';
import {
	useAgentFinish,
	useInstruction,
	useModel,
	useSkill,
	useSubagent,
	useTool,
} from '@flue/runtime';
import { findModelRoute, registerNebiusProvider } from './providers.ts';
import { makeRecordAcceptance } from './tools.ts';
import { evaluateGateLedger, gatePathFor } from './completion-gate.ts';
import { buildSpecialistDeclarations, SPECIALIST_INSTRUCTIONS, type SpecialistBuildContext } from './specialists.tsx';

/**
 * P05 coordinator — the one durable conversation agent. Registered by the
 * generated router under /agents/coordinator with the conversation guard
 * (P05 routes) ahead of it. Delegates all build/verify work to the seven
 * restricted specialists via useSubagent (model on the DEFINITION inherits
 * the coordinator's turn; subagent renders never call useModel).
 *
 * The completion gate: useAgentFinish reads the sandbox gate ledger and
 * refuses completion without a passing machine-checked record under the
 * current plan revision — by appending a corrective instruction, which
 * continues the run instead of settling it. When the sandbox is unavailable
 * (no factory declared), the gate fails closed: no evidence, no completion.
 *
 * Live model/round-trip verification is tests/live/flue-lifecycle.spec.ts —
 * BLOCKED without NEBIUS_API_KEY. Everything testable without a provider is
 * in tests/agent-permissions.test.ts (pure gate evaluator, catalog, skills).
 */

registerNebiusProvider();

const ROUTE = findModelRoute('nemotron-3-super');

/**
 * Runtime wiring the coordinator needs from the host (app.ts at mount time):
 * the specialist build context and the current plan revision getter. Provided
 * through a module-scoped slot so the agent function stays a zero-arg
 * exported function (its name is its durable identity).
 */
let hostContext: (SpecialistBuildContext & { currentPlanRevision: () => string }) | null = null;

export function provideCoordinatorContext(
	context: SpecialistBuildContext & { currentPlanRevision: () => string },
): void {
	hostContext = context;
}

function requireHostContext(): SpecialistBuildContext & { currentPlanRevision: () => string } {
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

	useSkill({
		name: 'build-verify',
		description: 'build-verify (v1.0.0)',
		instructions: `Coordinator discipline: delegate build and repair work to specialists; require exact command evidence for every claim; record passing evidence with record_acceptance before considering the run complete.`,
	});

	const context = requireHostContext();
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
