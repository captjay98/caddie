import type { ReactElement, ReactNode } from "react";
import { Markdown } from "@caddie/ui/Markdown";
import { splitFeatureBlock, parsePlanFeatures } from "@caddie/contracts";
import { PlanFeatureList } from "../project/FeatureChecklist.tsx";

/**
 * PlanReview — the ONE structured, scannable presentation of a plan that is
 * ready for review, shared by both entry points (DesignReviewBody at
 * /design-review and ProjectWorkspace's review phase at /project) so clicking
 * "Review plan" and clicking the project name land on identical content.
 *
 * It owns only the PRESENTATION of the plan body. Each caller keeps its own
 * data fetching and its real approve/reject logic and passes those controls in
 * as the `decision` node, which is rendered FIRST (the owner: lead with the
 * decision, then what a non-technical user cares about — what Caddie will
 * build — and keep the technical detail one tap away).
 *
 * The PRD body is markdown whose `##` section headings (Overview, Goals,
 * Non-goals, Data model, API surface, …) become collapsible cards:
 *   - Overview and Goals open by default;
 *   - a PROMOTED accent card "What Caddie will build" (the feature checklist)
 *     sits above the reference set;
 *   - every remaining section folds under a "Reference" subheading.
 * Sections are parsed from `splitFeatureBlock(body).display` — the prose a
 * person reads, with the machine-readable feature block removed (the feature
 * list renders that).
 */

/** A `##` section of the PRD prose: its heading and the markdown beneath it. */
interface PlanSection {
  heading: string;
  body: string;
}

/** The prose before the first `##` (keeps the `# H1` and any lead paragraph). */
interface ParsedPlan {
  intro: string;
  sections: PlanSection[];
}

/** Section headings shown open by default (matched case-insensitively). */
const OPEN_SECTIONS = new Set(["overview", "goals"]);

/** Same name ignoring case, spacing and punctuation ("Farmhand" = "farmhand."). */
function sameName(a: string, b: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a) !== "" && norm(a) === norm(b);
}

/**
 * Split PRD prose into the lead (before the first `##`) and its `##` sections.
 * `#` (H1) and `###`+ stay inside whatever section contains them, so only the
 * top-level `##` headings become cards.
 */
export function parsePlanSections(display: string): ParsedPlan {
  const lines = display.split("\n");
  const sections: PlanSection[] = [];
  const introLines: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    const match = /^##[ \t]+(.+?)[ \t]*#*\s*$/.exec(line);
    if (match && !line.startsWith("###")) {
      if (current) sections.push({ heading: current.heading, body: current.lines.join("\n").trim() });
      current = { heading: match[1]!.trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      introLines.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join("\n").trim() });
  return { intro: introLines.join("\n").trim(), sections };
}

/** One collapsible `##` section as a card. */
function SectionCard(props: { heading: string; body: string; open: boolean }): ReactElement {
  return (
    <details className="plan-review-section" open={props.open}>
      <summary className="plan-review-section-head">{props.heading}</summary>
      <div className="plan-review-section-body">
        <Markdown text={props.body} />
      </div>
    </details>
  );
}

export function PlanReview(props: {
  /** The full PRD body (with the feature block); the feature list reads it. */
  body: string;
  /** The approve/reject controls from the caller, rendered first. Optional:
   *  a caller that keeps its decision bar as a separate section omits this. */
  decision?: ReactNode;
  /** Plan / project name shown on the title line. */
  title?: string;
  /** Plan revision number, shown as "· plan version N" when known. */
  version?: number;
  /** The project's name: a plan `# Title` that only repeats it is not shown. */
  projectName?: string;
}): ReactElement {
  const { display } = splitFeatureBlock(props.body);
  const { intro, sections } = parsePlanSections(display);
  const features = parsePlanFeatures(props.body);
  const featureCount = features.ok ? features.features.length : 0;

  // Overview + Goals lead (open); everything else is reference (collapsed).
  const open: PlanSection[] = [];
  const reference: PlanSection[] = [];
  for (const section of sections) {
    (OPEN_SECTIONS.has(section.heading.toLowerCase()) ? open : reference).push(section);
  }
  // A plan with no `##` sections (e.g. a one-line brief) still shows its body.
  // The plan's own `# Title` is dropped when it only repeats the project's
  // name: the page header already shows it, and a lone "Farmhand" card pushed
  // the plan down (owner 2026-10-23). A different title ("Minimal Todo app"
  // for project "Todoer") says something, so it stays — as a plain heading.
  const h1 = /^#[ \t]+([^\n]*)\n?/.exec(intro);
  const repeatsName = Boolean(h1 && props.projectName && sameName(h1[1]!, props.projectName));
  const lead = (repeatsName ? intro.slice(h1![0].length) : intro).trim();
  const hasIntro = lead.length > 0;

  return (
    <div className="plan-review">
      {props.decision ? <div className="plan-review-decision">{props.decision}</div> : null}

      {props.title ? (
        <p className="plan-review-title" data-testid="plan-review-title">
          {props.title}
          {typeof props.version === "number" ? (
            <span className="plan-review-version"> · plan version {props.version}</span>
          ) : null}
        </p>
      ) : null}

      {hasIntro ? (
        <div className="plan-review-lead" data-plan-intro="">
          <Markdown text={lead} />
        </div>
      ) : null}

      {open.map((section) => (
        <SectionCard key={section.heading} heading={section.heading} body={section.body} open />
      ))}

      {/* PROMOTED: what a non-technical person actually cares about — the
          feature list in a prominent accent-bordered card, above the reference
          detail. PlanFeatureList self-nulls for a plan with no feature block. */}
      {featureCount > 0 ? (
        <section className="plan-review-build" data-testid="plan-review-build">
          <span className="plan-review-build-count" aria-hidden="true">
            {featureCount} {featureCount === 1 ? "feature" : "features"}
          </span>
          <PlanFeatureList body={props.body} />
        </section>
      ) : (
        <PlanFeatureList body={props.body} />
      )}

      {reference.length > 0 ? (
        <div className="plan-review-reference" data-testid="plan-review-reference">
          <p className="plan-review-reference-head">Technical detail</p>
          {reference.map((section) => (
            <SectionCard key={section.heading} heading={section.heading} body={section.body} open={false} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
