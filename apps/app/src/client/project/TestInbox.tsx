import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "../api.ts";
import { Icon } from "../icons.tsx";

/**
 * The preview's test inbox (Publish programme stage 7). When the app signs
 * people in, Caddie keeps the codes it would have emailed here instead, so
 * the owner can sign in to their own app as anyone while trying it. Shown only
 * once the app has sent a code; refreshes on its own while the card is open.
 */

interface InboxMessage {
  to: string;
  code: string;
  createdAt: string;
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(seconds) || seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function TestInbox(props: { actorId: string; projectId: string }): ReactElement | null {
  const inbox = useQuery({
    queryKey: ["test-inbox", props.actorId, props.projectId],
    queryFn: () => fetchJson<{ messages: InboxMessage[] }>(`/api/projects/${encodeURIComponent(props.projectId)}/workflow/test-inbox`),
    refetchInterval: 4000,
  });
  const messages = inbox.data?.messages ?? [];
  if (messages.length === 0) return null;
  const now = Date.now();

  return (
    <div className="test-inbox" data-testid="test-inbox">
      <div className="test-inbox-head">
        <Icon name="mail" title="" />
        <h4>Test inbox</h4>
      </div>
      <p className="state-detail test-inbox-intro">Sign-in codes your app sent while you tried it. They stay in Caddie; nobody gets an email.</p>
      <ul className="test-inbox-list">
        {messages.map((message) => (
          <li key={`${message.createdAt}-${message.to}`} className="test-inbox-row" data-testid="test-inbox-message">
            <span className="test-inbox-to">{message.to}</span>
            <span className="test-inbox-code" aria-label={`Code ${message.code.split("").join(" ")}`}>
              {message.code}
            </span>
            <span className="test-inbox-when">{ago(message.createdAt, now)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
