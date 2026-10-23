import type { RunStatus } from "./RunInspector.tsx";

/** The past build as one sentence (§4). Statuses come from real data only. */
export function buildSentence(status: RunStatus, when: string): string {
  switch (status) {
    case "running":
      return `Build in progress. Started ${when}.`;
    case "completed":
      return `Build attempt finished ${when}. Check the app’s results before relying on it.`;
    case "failed":
      return `A build stopped ${when} — the run was marked failed. Ask Caddie in the chat what happened.`;
    case "cancelled":
      return `A build was cancelled ${when}.`;
    default:
      return `Build request recorded ${when}. Its result is not confirmed here.`;
  }
}
