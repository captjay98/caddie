import type { BuildActivityView } from "../queries.ts";

/** Describe observed activity; a workflow label alone is not proof of work. */
export function buildPresentation(
  data: Pick<BuildActivityView, "phase" | "openIssues" | "timeline">,
  unavailable = false,
) {
  if (unavailable && data.phase === "building")
    return {
      quiet: true,
      repairing: false,
      title: "Build status is unavailable.",
      label: "Couldn’t refresh",
      summary:
        "Caddie couldn’t read the latest build activity. Check the status before deciding what to do next.",
      mood: "needs" as const,
    };
  const quiet = data.phase === "building" && data.timeline.quiet;
  const repairing =
    data.phase === "building" &&
    (data.openIssues > 0 ||
      data.timeline.stages.some((stage) => stage.state === "failed"));
  if (quiet)
    return {
      quiet,
      repairing,
      title: "Let’s check this build.",
      label: "No recent activity",
      summary:
        "No new activity has been reported. I can’t confirm the build is still running.",
      mood: "needs" as const,
    };
  if (data.phase === "blocked")
    return {
      quiet,
      repairing,
      title: "The build has stopped.",
      label: "Needs attention",
      summary:
        "Your plan and saved files are retained. Review what happened before trying again.",
      mood: "stuck" as const,
    };
  if (data.phase === "ready")
    return {
      quiet,
      repairing,
      title: "Your app is ready to try.",
      label: "Ready to try",
      summary:
        "Build checks passed. Try the main journeys yourself before publishing.",
      mood: "done" as const,
    };
  // While it runs, the title is the whole message (owner 2026-10-29: less
  // text, one level each). The feature list below says what is being built.
  return {
    quiet,
    repairing,
    title: repairing ? "Fixing a check that failed." : "Building your app.",
    label: "Caddie is working",
    summary: "",
    mood: "building" as const,
  };
}
