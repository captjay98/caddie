import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { postJson } from '../api.ts';
import { ProjectDialog } from './ProjectDialog.tsx';

/**
 * Ask for a change on a finished app (2026-10-27 plan P0-2): the request is
 * recorded for review — Caddie replies with a scoped proposal in the project
 * conversation, and nothing rebuilds until it is approved. The last working
 * preview stays open the whole time.
 */
export function AskForChange({ projectId }: { projectId: string }) {
  const chrome = useWorkspaceChrome();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/projects/${encodeURIComponent(projectId)}/workflow/change`, {
        request: text.trim(),
      });
      setOpen(false);
      setText('');
      chrome.refreshAll();
      // Caddie's proposal arrives in the project conversation.
      void navigate({ to: '/project', search: { project: projectId, pane: 'channel' } as never });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change request could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return <>
    <button type="button" className="btn-key" onClick={() => setOpen(true)} data-testid="ask-for-change">Ask for a change</button>
    <ProjectDialog open={open} onClose={() => { setOpen(false); setError(null); }} title="What would you like to change?">
      <div className="change-dialog">
        <p className="state-detail">Describe what you’d like. Caddie will reply with a plan for the change to approve — your app keeps working exactly as it is until then.</p>
        <label htmlFor="change-request">Your change</label>
        <textarea id="change-request" className="input" rows={4} value={text} onChange={event => setText(event.target.value)} maxLength={2000} placeholder="For example, make it easier to find my records" />
        {error ? <p role="alert" className="state-detail">{error}</p> : null}
        <div className="row-actions">
          <button type="button" className="btn-key" disabled={!text.trim() || busy} onClick={() => void send()} data-testid="send-change-request">
            {busy ? 'Sending…' : 'Send change request'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      </div>
    </ProjectDialog>
  </>;
}
