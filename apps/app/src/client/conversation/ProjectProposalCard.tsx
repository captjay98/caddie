import { useState } from 'react';
import type { ReactElement } from 'react';
import * as v from 'valibot';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../api.ts';
import { ProjectWorkflow } from './ProjectWorkflow.tsx';

/**
 * The in-chat project PROPOSAL card. Caddie proposes; the user creates.
 *
 * The data part carries only the server proposal id (+ the Home project it
 * belongs to); the card reads the proposal's content and state from the
 * server, so a reload shows the truth and chat text can never create a
 * project. "Start this project" calls the authenticated accept route — the
 * only thing that creates the project and starts planning — and the card then
 * becomes the normal project card. "Keep refining" dismisses it and creates
 * nothing.
 */
export const ProjectProposalData = v.pipe(
	v.object({ proposalId: v.string(), homeProjectId: v.string() }),
	v.readonly(),
);
export type ProjectProposalPayload = v.InferOutput<typeof ProjectProposalData>;

interface ProposalView {
	id: string;
	name: string;
	idea: string;
	hackathonTitle: string | null;
	hackathonUrl: string | null;
	track: string | null;
	firstStep: string | null;
	stackId?: 'react-hono' | 'flutter';
	status: 'proposed' | 'accepted' | 'dismissed';
	projectId: string | null;
}

export function ProjectProposalCard({ data }: { data: ProjectProposalPayload }): ReactElement {
	const queryClient = useQueryClient();
	const base = `/api/projects/${encodeURIComponent(data.homeProjectId)}/proposals/${encodeURIComponent(data.proposalId)}`;
	const key = ['project-proposal', data.proposalId];
	const proposal = useQuery({ queryKey: key, queryFn: () => fetchJson<{ proposal: ProposalView }>(base) });
	const [busy, setBusy] = useState<'accept' | 'dismiss' | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function act(kind: 'accept' | 'dismiss') {
		setBusy(kind);
		setError(null);
		try {
			const result = await postJson<{ proposal: ProposalView }>(`${base}/${kind}`, {});
			queryClient.setQueryData(key, { proposal: result.proposal });
			if (kind === 'accept') void queryClient.invalidateQueries({ queryKey: ['projects'] });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'That didn’t go through — try again.');
		} finally {
			setBusy(null);
		}
	}

	if (proposal.isPending) return <p className="tool-banner" data-testid="proposal-loading">Loading the project idea…</p>;
	if (proposal.error || !proposal.data) {
		return (
			<p role="alert" className="form-error" data-testid="proposal-error">
				The project idea couldn’t be loaded.
			</p>
		);
	}
	const p = proposal.data.proposal;
	if (p.status === 'accepted' && p.projectId) return <ProjectWorkflow projectId={p.projectId} name={p.name} />;

	return (
		<section className="proposal-card" data-testid="project-proposal" data-status={p.status}>
			<p className="proposal-kicker">Project idea</p>
			<h3 className="proposal-title">{p.name}</h3>
			<p className="proposal-idea">{p.idea}</p>
			<dl className="proposal-facts">
				{p.hackathonTitle ? (
					<div>
						<dt>Hackathon</dt>
						<dd>
							{p.hackathonUrl ? (
								<a href={p.hackathonUrl} target="_blank" rel="noreferrer noopener">
									{p.hackathonTitle}
								</a>
							) : (
								p.hackathonTitle
							)}
						</dd>
					</div>
				) : null}
				{p.track ? (
					<div>
						<dt>Track</dt>
						<dd>{p.track}</dd>
					</div>
				) : null}
				{p.firstStep ? (
					<div>
						<dt>Build first</dt>
						<dd>{p.firstStep}</dd>
					</div>
				) : null}
				{p.stackId === 'flutter' ? (
					<div data-testid="proposal-android">
						<dt>App</dt>
						<dd>Android app you can download and install, also runs in the browser</dd>
					</div>
				) : null}
			</dl>
			{p.status === 'dismissed' ? (
				<div className="proposal-actions">
					<p className="proposal-note" data-testid="proposal-dismissed">Kept as an idea — tell Caddie what to change.</p>
					<button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void act('accept')} data-testid="proposal-start">
						{busy === 'accept' ? 'Starting…' : 'Start it anyway'}
					</button>
				</div>
			) : (
				<div className="proposal-actions">
					<button type="button" className="btn-key" disabled={busy !== null} onClick={() => void act('accept')} data-testid="proposal-start">
						{busy === 'accept' ? 'Starting…' : 'Start this project'}
					</button>
					<button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void act('dismiss')} data-testid="proposal-refine">
						Keep refining
					</button>
					<span className="proposal-note">Nothing is created until you start it.</span>
				</div>
			)}
			{error ? (
				<p role="alert" className="form-error" data-testid="proposal-action-error">
					{error}
				</p>
			) : null}
		</section>
	);
}
