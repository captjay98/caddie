import { useId, useState, type ReactElement, type ReactNode } from "react";
import { Mascot } from "@caddie/ui/Mascot";
import { Markdown } from "@caddie/ui/Markdown";
import { splitFeatureBlock, parsePlanFeatures } from "@caddie/contracts";
import { PlanFeatureList } from "../project/FeatureChecklist.tsx";
import { ProjectDialog } from "../project/ProjectDialog.tsx";
import { CopyableId } from "../copyable.tsx";
import {
  parsePlanSections,
  planSectionGroup,
  embeddedPlanCaveats,
  planOverview,
  planJourneys,
  planDecisionWarnings,
  type PlanSection,
} from "./plan-sections.ts";
export { parsePlanSections } from "./plan-sections.ts";

function SectionText({ section }: { section: PlanSection }) {
  return (
    <section className="plan-review-source">
      <h3>{section.heading}</h3>
      <Markdown text={section.body} />
    </section>
  );
}
const TABS = ["scope", "checks", "technical"] as const;
type DetailTab = (typeof TABS)[number];
const LABELS: Record<DetailTab, string> = {
  scope: "Scope",
  checks: "Checks",
  technical: "Technical specification",
};

/** A short decision surface, with one optional place to inspect the full plan. */
export function PlanReview(props: {
  body: string;
  decision?: ReactNode;
  title?: string;
  version?: number;
  projectName?: string;
  revisionHash?: string;
  context?: ReactNode;
  history?: ReactNode;
}): ReactElement {
  const { display } = splitFeatureBlock(props.body);
  const { intro, sections } = parsePlanSections(display);
  const features = parsePlanFeatures(props.body);
  const grouped = (group: ReturnType<typeof planSectionGroup>) =>
    sections.filter((section) => planSectionGroup(section.heading) === group);
  const overview = planOverview(intro, sections);
  const journeys = planJourneys(sections);
  const warnings = planDecisionWarnings(sections);
  const caveats = embeddedPlanCaveats(sections);
  const [exploring, setExploring] = useState(false);
  const [tab, setTab] = useState<DetailTab>("scope");
  const tabId = useId();
  const rows = journeys.length
    ? journeys.map((journey) => journey.heading)
    : features.ok
      ? features.features.slice(0, 4).map((feature) => feature.title)
      : [];
  return (
    <div className="plan-review plan-review--guided plan-review--minimal">
      {props.title ? (
        <p className="plan-review-title" data-testid="plan-review-title">
          {props.title}
          {props.version ? (
            <span className="plan-review-version">
              {" "}
              · plan version {props.version}
            </span>
          ) : null}
        </p>
      ) : null}
      <section className="plan-review-note" data-testid="plan-outcomes">
        <h3>What your app will do</h3>
        {overview ? (
          <p className="plan-review-overview">{overview}</p>
        ) : (
          <p className="state-detail">
            Your plan is ready to review. Explore it below to see the full
            scope.
          </p>
        )}
        {rows.length ? (
          <ul className="plan-journey-rows">
            {rows.map((row, index) => (
              <li key={index}>{row}</li>
            ))}
          </ul>
        ) : null}
      </section>
      {warnings.length ? (
        <section data-testid="plan-before-approval">
          <h3 className="plan-caveat-title">Before you approve</h3>
          <ul className="plan-decision-warnings">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {props.decision ? (
        <section className="plan-review-decision">
          <div className="project-caddie-heading plan-review-guide">
            <Mascot mood="needs" size={48} />
            <h3>Does this plan look right?</h3>
          </div>
          {props.decision}
        </section>
      ) : null}
      <button
        type="button"
        className="plan-explore-link"
        onClick={() => {
          setTab("scope");
          setExploring(true);
        }}
      >
        Explore the full plan <span aria-hidden="true">↗</span>
      </button>
      <ProjectDialog
        open={exploring}
        onClose={() => setExploring(false)}
        title="Explore the full plan"
        wide
      >
        <div
          className="plan-detail-tabs"
          role="tablist"
          aria-label="Full plan sections"
          onKeyDown={(event) => {
            const index = TABS.indexOf(tab);
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % TABS.length
                : event.key === "ArrowLeft"
                  ? (index + TABS.length - 1) % TABS.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? TABS.length - 1
                      : null;
            if (next === null) return;
            event.preventDefault();
            setTab(TABS[next]!);
            event.currentTarget
              .querySelectorAll<HTMLButtonElement>('[role="tab"]')
              [next]?.focus();
          }}
        >
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`${tabId}-${item}`}
              aria-selected={tab === item}
              aria-controls={`${tabId}-panel`}
              tabIndex={tab === item ? 0 : -1}
              onClick={() => setTab(item)}
            >
              {LABELS[item]}
            </button>
          ))}
        </div>
        <div
          className="plan-detail-content"
          role="tabpanel"
          id={`${tabId}-panel`}
          aria-labelledby={`${tabId}-${tab}`}
          tabIndex={0}
        >
          {tab === "scope" ? (
            <>
              <h3>What’s included</h3>
              {features.ok ? (
                <PlanFeatureList body={props.body} showChecks={false} />
              ) : (
                grouped("outcomes").map((section, index) => (
                  <SectionText key={index} section={section} />
                ))
              )}
              {journeys.map((section, index) => (
                <SectionText key={`journey-${index}`} section={section} />
              ))}
              <section data-testid="plan-scope">
                <h3>What’s left for later</h3>
                {grouped("scope").length ? (
                  grouped("scope").map((section, index) => (
                    <SectionText key={index} section={section} />
                  ))
                ) : (
                  <p className="state-detail">
                    This plan does not yet separate what’s included from what’s
                    left for later.
                  </p>
                )}
              </section>
              <section data-testid="plan-limitations">
                <h3>Assumptions and limitations</h3>
                {grouped("limitations").map((section, index) => (
                  <SectionText key={index} section={section} />
                ))}
                {caveats.map((line, index) => (
                  <Markdown key={index} text={line} />
                ))}
                {!grouped("limitations").length && !caveats.length ? (
                  <p className="state-detail">
                    No separate limitations or assumptions were recorded. That
                    does not mean there are none.
                  </p>
                ) : null}
              </section>
              {grouped("other").map((section, index) => (
                <SectionText key={index} section={section} />
              ))}
              {props.context}
            </>
          ) : tab === "checks" ? (
            <section data-testid="plan-checks">
              <h3>How Caddie will check it works</h3>
              {features.ok ? (
                <ul className="plan-review-acceptance">
                  {features.features.map((feature) => (
                    <li key={feature.id}>
                      <strong>{feature.title}</strong>
                      <ul>
                        {feature.doneWhen.map((check, index) => (
                          <li key={index}>{check}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : null}
              {grouped("checks").map((section, index) => (
                <SectionText key={index} section={section} />
              ))}
              {!features.ok && !grouped("checks").length ? (
                <p className="state-detail">
                  This plan does not yet state the checks that will demonstrate
                  it works.
                </p>
              ) : null}
            </section>
          ) : (
            <section data-testid="plan-review-reference">
              <h3>Technical specification</h3>
              <Markdown text={display} />
              {props.revisionHash ? (
                <div className="plan-revision-hash">
                  <span>Exact revision</span>
                  <CopyableId
                    value={props.revisionHash}
                    label="revision hash"
                  />
                </div>
              ) : null}
              {props.history}
            </section>
          )}
        </div>
      </ProjectDialog>
    </div>
  );
}
