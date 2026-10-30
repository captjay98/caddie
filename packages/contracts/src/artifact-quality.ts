import * as v from 'valibot';
export const ARTIFACT_QUALITY_POLICY = 'quality-v1';
export const QualityFindingSchema = v.strictObject({
 severity:v.picklist(['blocking','advisory']),
 criterion:v.pipe(v.string(),v.minLength(1),v.maxLength(120)),
 detail:v.pipe(v.string(),v.minLength(1),v.maxLength(1200)),
});
export const ArtifactQualityReviewSchema = v.strictObject({
 verdict:v.picklist(['pass','revise']),
 findings:v.pipe(v.array(QualityFindingSchema),v.maxLength(30)),
});
export type ArtifactQualityReview = v.InferOutput<typeof ArtifactQualityReviewSchema>;
export type QualityStage = 'prd'|'looks'|'design';

/**
 * ONE checklist per visual stage, shared word for word by the author and the
 * independent reviewer (owner 2026-10-29: "deliver something the reviewer will
 * pass on most attempts"). The designer self-checks against exactly what the
 * reviewer judges, so a first draft can pass; the reviewer judges only these,
 * so it cannot move the goalposts mid-step.
 */
export const PRD_REVIEW_CRITERIA: readonly string[] = [
 'FIRST VERSION, THEN ADD AFTER: the list is sized by what the owner asked for (a todo app is 1-3 items; a farm business app can be 10-12). Items without "later" are the first version: what the owner asked for in their own words plus what those things need to work (setup, sign-in, saving, the contest rule), at most 3 items, at most 3 doneWhen checks each. Everything else carries "later": true. An item that cannot work without an earlier one names it in "needs". A missing nice-to-have is never a reason to block; ask for less in the first version, not more.',
 'PLAIN ITEM TITLES: every item title is something the owner does or sees, in plain words a non-technical person reads at a glance (no "sync", "dashboard", "flagged", "API"), 10 words or fewer.',
 'SETUP FIRST: the plan has a first-class setup journey (create the primary record(s), start the first working session, add the first needed resource) with its own screens and doneWhen checks.',
 'EVERY SCOPE AREA HAS A JOURNEY: each area in scope (data model entry, screen, feature) appears in at least one user journey with a screen and a doneWhen check.',
 'OFFLINE AND LINKED UPDATES ARE STATED: if the plan promises offline or linked writes, it says exactly what happens while offline, what the server recomputes and what the user sees after syncing.',
 'CONTEST RULE MET: when the brief names a contest, the plan quotes the one rule the entry must satisfy and points at where the plan satisfies it.',
 'AI FAILURE PATHS: every AI-powered flow has a doneWhen for its failure path (a clear message, the app stays usable).',
 'NO ORPHAN PROMISES: every capability stated in the header, problem or demo contract (installable, sharing, export, notifications, privacy claims) appears as a feature with a doneWhen, and no claim contradicts the plan\'s own data model.',
 'INTERNAL NOTES STAY INTERNAL: the plan names no model, provider, AI tier or cost; the app simply uses "Caddie\'s AI", with the depth of the core call stated as "(a deep answer)" or "(a quick answer)".',
];
/**
 * Host fact both the plan author and the plan reviewer need. A plan may not
 * name the model (the INTERNAL NOTES criterion), so without this the reviewer blocked every
 * hackathon plan for "contest AI requirement unsubstantiated" — a loop no
 * revision could escape (Poultry Tracker, three rounds, 2026-10-29).
 */
export const PLATFORM_AI_FACT = 'HOST FACT: every "Caddie\'s AI" call in a generated app runs on an NVIDIA Nemotron open model served by Nebius Token Factory; the host enforces this. A plan whose core AI feature goes through Caddie\'s AI therefore satisfies a contest rule requiring an NVIDIA model or Nebius — the plan says it uses Caddie\'s AI and never needs to name the model.';
export const LOOKS_REVIEW_CRITERIA: readonly string[] = [
 'The 2-3 looks are clearly different from each other: different structure and information hierarchy, not one layout recoloured.',
 'Each look is readable on a phone at 390px: text and controls contrast with their background, body text is at least 16px, tap targets are at least 44px tall, nothing overflows or is cut off.',
 'Each look suits the stated audience and where they use the app.',
 'Every look has its own rendered screen (a real key screen with real-looking data and one primary action).',
];
export const LOOKS_REVIEW_NOT_JUDGED = 'Not judged at this step: more screens, flows, navigation, features, data or checks. The owner only picks a style here; every screen is designed in the next step.';
export const DESIGN_REVIEW_CRITERIA: readonly string[] = [
 'Every feature in the approved plan has a screen in the screen inventory, and each key screen has a rendered mock.',
 'Everything that loads or saves has its empty, loading and error state shown or described.',
 'Every screen is readable on a phone at 390px: contrast, body text at least 16px, tap targets at least 44px tall, nothing overflows or is cut off.',
 'The chosen look\'s theme is applied unchanged.',
 'No screen shows a capability the approved plan does not include.',
];
/**
 * The acceptance checks are run against the real app in the build step, where
 * a weak check fails visibly. At the design step they are advice: the first
 * design pass got 23 blocking findings, almost all about check wording
 * (2026-10-29).
 */
export const DESIGN_CHECK_ADVICE = 'Write each acceptance check so it asserts the exact outcome the plan promises the user can see (the saved value, the alert, the named message), switches to the other person first when the check is about another person or device, and asserts the promised failure state on a failure path.';
export const DESIGN_REVIEW_NOT_JUDGED = 'Not judged at this step (the build step checks them in the running app): the wording of acceptance checks, how the app installs (manifest, service worker), offline storage internals, server and database design, deployment and performance. Raise these as advisory at most, never blocking.';
/**
 * Stable reviews (2026-10-29): six plan rounds each raised a blocker the
 * previous round never mentioned. One pass names every blocker; a revision is
 * judged against those first.
 */
export const REVIEW_STABILITY_RULE = 'Name EVERY blocking issue in this one pass; do not hold any back for a later round. When the context has yourEarlierFindings, this is a revision: first check each earlier blocking finding is fixed. Raise a NEW blocking finding only when it would make the app fail its owner or break a stated rule; anything else you notice now is advisory.';
/** Keeps a review short enough to finish inside its output limit. */
export const REVIEW_OUTPUT_LIMIT = 'Report at most 8 findings, most important first, each detail under 300 characters. Think briefly; do not restate the candidate.';
/** The checklist as one instruction line. */
export function reviewChecklist(criteria: readonly string[]): string {
 return criteria.map((line, index) => `(${index + 1}) ${line}`).join(' ');
}
export interface ReviewImage {
 stateId:string; viewport:'phone'|'desktop'; width:number; height:number;
 documentHash:string; pngSha256:string; pngBase64:string;
}
/** Review text is untrusted data, never permission to publish, build, or approve. */
export function parseArtifactQualityReview(value:unknown):ArtifactQualityReview {
 const parsed=v.safeParse(ArtifactQualityReviewSchema,value);
 if(!parsed.success) throw new Error('Invalid independent review response');
 if(parsed.output.verdict==='pass' && parsed.output.findings.some(row=>row.severity==='blocking'))
  throw new Error('A blocking finding cannot receive a passing verdict');
 return parsed.output;
}
