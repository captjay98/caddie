/** Presentation only: preserve the saved wording and never infer approval or scope. */
export interface PlanSection {
  heading: string;
  body: string;
}
export interface ParsedPlan {
  intro: string;
  sections: PlanSection[];
}
export type PlanGroup =
  | "outcomes"
  | "scope"
  | "limitations"
  | "checks"
  | "technical"
  | "other";

export function parsePlanSections(display: string): ParsedPlan {
  const intro: string[] = [];
  const sections: PlanSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of display.split("\n")) {
    const match = /^##[ \t]+(.+?)[ \t]*#*\s*$/.exec(line);
    if (match) {
      if (current)
        sections.push({
          heading: current.heading,
          body: current.lines.join("\n").trim(),
        });
      current = { heading: match[1]!.trim(), lines: [] };
    } else if (current) current.lines.push(line);
    else intro.push(line);
  }
  if (current)
    sections.push({
      heading: current.heading,
      body: current.lines.join("\n").trim(),
    });
  return { intro: intro.join("\n").trim(), sections };
}

export function planSectionGroup(heading: string): PlanGroup {
  const h = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  // Scope/limitations take priority over technical words in mixed headings.
  if (
    /\b(non goals?|scope|included|excluded|out of scope|left for later|not included)\b/.test(
      h,
    )
  )
    return "scope";
  if (
    /\b(assumptions?|limitations?|risks?|constraints?|hackathon requirements?|contest requirements?|requirements from the|eligibility)\b/.test(
      h,
    )
  )
    return "limitations";
  if (
    /\b(acceptance|success metrics?|verification|testing|tests|done when|how .*check)\b/.test(
      h,
    )
  )
    return "checks";
  if (
    /\b(overview|goals?|user stories|user flows?|journeys?|what .*do|demo contract|product summary)\b/.test(
      h,
    )
  )
    return "outcomes";
  if (
    /^(data model|api|frontend|backend|architecture|technical|implementation|stack|dependencies|offline|sync|ai|integrations?|security|deployment|file structure)\b/.test(
      h,
    )
  )
    return "technical";
  return "other";
}

/** Surface explicitly labelled assumptions even when saved inside a technical section. */
export function embeddedPlanCaveats(
  sections: readonly PlanSection[],
): string[] {
  return [
    ...new Set(
      sections
        .filter((s) => planSectionGroup(s.heading) === "technical")
        .flatMap((s) => s.body.split(/\n\s*\n/))
        .filter((line) =>
          /\bassumptions?\b|\btext[- ]only\b|\bmock(?:ed|s)?\s*:/i.test(line),
        )
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/** A short excerpt, not an invented rewrite of the approved plan. */
export function planOverview(
  intro: string,
  sections: readonly PlanSection[],
): string | null {
  const overview = sections.find((s) =>
    /^(overview|what .*do|product summary)\b/i.test(s.heading),
  );
  const source = overview?.body ?? intro;
  const paragraphs = source.split(/\n\s*\n/).map((p) => p.trim());
  const prose = paragraphs.find(
    (p) => p && !/^(?:#|[-*]\s|\d+\.|\*\*[^*]+:\*\*)/.test(p),
  );
  if (!prose) return null;
  const sentence = prose.match(/^.*?[.!?](?:\s|$)/s)?.[0].trim() ?? prose;
  return sentence.length > 280
    ? sentence.slice(0, 277).trimEnd() + "…"
    : sentence;
}

export function planJourneys(sections: readonly PlanSection[]): PlanSection[] {
  const source = sections.filter((s) =>
    /user stories|user flows|journeys/i.test(s.heading),
  );
  return source.flatMap((section) => {
    const result: PlanSection[] = [];
    let current: PlanSection | null = null;
    for (const line of section.body.split("\n")) {
      const match = /^###\s+(.+)$/.exec(line);
      if (match) {
        if (current) result.push(current);
        if (
          /^###\s+(?:Flow|Journey)\s+\d+/im.test(section.body) &&
          !/^(?:Flow|Journey)\s+\d+/i.test(match[1]!)
        ) {
          current = null;
          continue;
        }
        current = {
          heading: match[1]!
            .replace(/^Flow\s+\d+\s*[—–:-]\s*/i, "")
            .replace(/\s*\(core,?\s*demo spine\)\s*$/i, "")
            .replace(/\s*\(added from [^)]*\)\s*$/i, ""),
          body: "",
        };
      } else if (current) current.body += (current.body ? "\n" : "") + line;
    }
    if (current) result.push(current);
    return result;
  });
}

/** Only explicit qualifications become a short callout; full wording stays inspectable. */
export function planDecisionWarnings(
  sections: readonly PlanSection[],
): string[] {
  const text = sections
    .filter(
      (s) =>
        planSectionGroup(s.heading) === "limitations" ||
        planSectionGroup(s.heading) === "technical",
    )
    .map((s) => s.body)
    .join("\n");
  const warnings: string[] = [];
  if (
    /photo|image|camera/i.test(text) &&
    /text[- ]only|text[- ]reasoning|image AI not confirmed/i.test(text)
  )
    warnings.push("Photo analysis is not confirmed in this plan.");
  if (/data[- ]model only|data model only/i.test(text))
    warnings.push("Some roles have no screens planned for this version.");
  return warnings;
}
