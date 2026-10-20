/**
 * Deterministic policy for what a generated app may depend on.
 *
 * The platform rule (agents/specialists.ts `PLATFORM_AI_RULE`) already tells
 * every planner that an app's AI comes from Caddie (`c.env.CADDIE.ai`, Nebius,
 * paid by Caddie) and that Ollama / local / self-hosted models and third-party
 * AI keys are not allowed. Prompt text is not a guarantee: FarmLog AI's PRD
 * (2026-10-19) still planned an Ollama "insight engine" that could never run
 * in the preview or on a judge's machine.
 *
 * So the plan save is the enforcement point. A local-model mention is refused
 * before the revision is written, with the same instruction the planner can
 * act on. This is deliberately narrow: it matches the model runtimes Caddie
 * cannot run, not every use of the word "local" (local storage, local time).
 */

const BANNED_LOCAL_MODEL =
	/\bollama\b|\bself[- ]hosted\s+(?:llm|model)s?\b|\blocal(?:ly)?[- ](?:hosted\s+)?(?:llm|model)s?\b/gi;

/** The first banned mention in `body`, or null when the text is clean. */
export function bannedLocalModelMention(body: string): string | null {
	BANNED_LOCAL_MODEL.lastIndex = 0;
	const match = BANNED_LOCAL_MODEL.exec(body);
	return match ? match[0] : null;
}

/**
 * Refuse a plan body that names a local model runtime. Throws with an
 * actionable message; callers surface it as a tool error so the planner
 * revises and saves again (the plan is not written).
 */
export function assertNoBannedLocalModel(body: string): void {
	const mention = bannedLocalModelMention(body);
	if (!mention) return;
	throw new Error(
		`LOCAL_MODEL_BANNED: not saved — the plan mentions "${mention}". ` +
			'A Caddie app cannot run Ollama or a local/self-hosted model (the preview runs on Cloudflare Workers and a judge will not install one). ' +
			'Plan the feature on c.env.CADDIE.ai (NVIDIA Nemotron on Nebius, paid by Caddie, called from src/server.ts) and save the revision again.',
	);
}
