import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "../api.ts";
import { Icon } from "../icons.tsx";

/**
 * AI in the app (Publish programme stage 9). Caddie runs and pays for the
 * AI an app's server asks for (env.CADDIE.ai), up to a monthly allowance per
 * app. Shown only once the app has used AI: how many answers this month and
 * how much of the allowance that took — never money, models or tokens.
 */

interface AiUsage {
  available: boolean;
  month: string;
  calls: number;
  usedPercent: number;
  limitReached: boolean;
  renewsOn: string;
}

function renewDate(isoDay: string): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDay;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", timeZone: "UTC" });
}

export function AppAi(props: { actorId: string; projectId: string }): ReactElement | null {
  const usage = useQuery({
    queryKey: ["ai-usage", props.actorId, props.projectId],
    queryFn: () => fetchJson<AiUsage>(`/api/projects/${encodeURIComponent(props.projectId)}/ai-usage`),
  });
  const data = usage.data;
  if (!data || !data.available || (data.calls === 0 && !data.limitReached)) return null;
  const percent = Math.max(0, Math.min(100, Math.round(Number(data.usedPercent) || 0)));
  const answers = data.calls === 1 ? "1 answer" : `${data.calls} answers`;

  return (
    <div className="app-ai" data-testid="app-ai">
      <div className="app-ai-head">
        <Icon name="sparkle" title="" />
        <h4>AI in your app</h4>
        {data.limitReached ? (
          <span className="badge" data-tone="warn">
            Paused
          </span>
        ) : null}
      </div>
      <p className="state-detail app-ai-intro">Caddie runs your app&rsquo;s AI and pays for it, up to a monthly allowance.</p>
      <div className="app-ai-row">
        <span className="app-ai-what">This month</span>
        <span className="app-ai-meta" data-testid="app-ai-summary">
          {answers} · {percent}% used
        </span>
        <span className="app-ai-bar" role="img" aria-label={`${percent}% of this month's AI allowance used`}>
          <span style={{ width: `${percent}%` }} data-tone={data.limitReached ? "warn" : "ok"} />
        </span>
      </div>
      {data.limitReached ? (
        <p className="state-detail app-ai-paused" data-testid="app-ai-paused">
          This month&rsquo;s allowance is used up. Your app&rsquo;s AI answers again on {renewDate(data.renewsOn)}.
        </p>
      ) : null}
    </div>
  );
}
