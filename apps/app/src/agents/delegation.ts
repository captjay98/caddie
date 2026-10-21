/**
 * Who writes a feature's CODE, and who does not.
 *
 * A leaf module on purpose: the rule is prompt text, and the server modules
 * that drive the build loop (coordinator-host.ts, build-workflow.ts) must be
 * able to import it without dragging the agent skills — which are `.md`
 * imports — into every worker that loads them (the schedules fixture worker
 * has no `.md` loader and fails to boot when it does).
 *
 * Why the rule exists: the build loop used to say "delegate to the
 * implementation specialist", which named nobody. The coordinator then picked
 * `tech-lead` — the role that owns the plan of record and repair — and
 * `tech-lead` carries the `planning` skill, so it runs on the PLAN model
 * (GLM-5.3-Flash). Every feature's code was therefore written by the weaker
 * model while the strong implementation specialists (Super VL) sat unused.
 * HerdVoice, 2026-10-20: feature 4 failed three repair rounds over a one-line
 * missing `catch`.
 */
export const FEATURE_DELEGATION_RULE =
	"Delegate a feature's CODE to the specialist whose surface it touches, never to tech-lead: " +
	"client-side behavior (src/*.tsx, src/styles.css, the browser app) to frontend, " +
	"server-side behavior (src/server.ts, migrations/) to backend, " +
	"the Android target to mobile. " +
	"If a feature needs both sides, delegate the client part to frontend and the server part to backend, in that order, and tell each one the other part's contract (routes, request and response shape) so they fit. " +
	"tech-lead keeps the plan of record, the review and the repair decisions; it does not write the feature. " +
	"Give every delegate the feature's doneWhen checks verbatim and require a test per check.";
