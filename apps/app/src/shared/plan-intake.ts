/**
 * The planning intake rides the person's message lane into their new project
 * (workflow-dispatch: `intake:` keeps the owner voice), but its first line is
 * Caddie's own instruction to itself. The chat shows only the request part, so
 * the person never sees "You: Prepare a clear plan…" (FarmLog AI, 2026-10-29).
 *
 * The instruction names the product specialist explicitly (model check
 * 2026-10-29: without it the coordinator wrote the PRD itself on the chat
 * model instead of the plan-author route the owner chose).
 */
export const PLAN_INTAKE_PREFIX =
	"Prepare a clear plan for this request. Delegate the product specialist to author the PRD (it saves it with write_plan_note kind:'prd'); do not write the plan yourself. Do not build until the plan is approved using the review controls.\n\n";

/** Earlier wording, still in saved conversations. */
const LEGACY_PREFIXES = [
	'Prepare a clear plan for this request. Do not build until the plan is approved using the review controls.\n\n',
];

/** The request text of a planning intake, or the text unchanged when it is not one. */
export function ownerWordsFromIntake(text: string): string {
	for (const prefix of [PLAN_INTAKE_PREFIX, ...LEGACY_PREFIXES]) {
		if (text.startsWith(prefix)) return text.slice(prefix.length);
	}
	return text;
}
