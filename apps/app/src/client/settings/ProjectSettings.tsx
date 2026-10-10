import { useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Project } from '@caddie/contracts';
import { failureKind, StatePanel } from '../states.tsx';
import { Memory } from '../memory/Memory.tsx';
import { Schedules } from '../tasks/Schedules.tsx';
import { RepositoryPicker, type SelectedRepository } from '../repositories/RepositoryPicker.tsx';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { fetchJson, postJson } from '../api.ts';

/**
 * Project settings (v2, HANDOFF §4 + §2 route table) — a NEW route at
 * /project/settings. Sections: General ("What it is" + the edit-description
 * window), Code (connect a repository), Routines, What Caddie knows, and
 * Archive or delete.
 *
 * Delete: the server has NO permanent delete today — only archive (§8.4).
 * The window is therefore labelled "Archive project" and requires typing the
 * project name; it never pretends to delete anything.
 */
export function ProjectSettingsPage(): ReactElement {
	return (
		<>
			<div className="shell-loading shell-page">
				<div className="page-col">
					<ProjectGate2>{(projectId) => <ProjectSettingsBody projectId={projectId} />}</ProjectGate2>
				</div>
			</div>
		</>
	);
}

/** Quiet gate: children render only when a project resolves. */
function ProjectGate2(props: { children: (projectId: string) => ReactElement }): ReactElement | null {
	const chrome = useWorkspaceChrome();
	if (!chrome.authenticated) return <StatePanel kind="error" title="Sign in to see this project's settings" />;
	if (chrome.projectsPending) return <StatePanel kind="loading" title="Fetching your projects…" />;
	if (!chrome.effectiveProjectId) {
		return (
			<StatePanel
				kind="error"
				title="That project is not in your list"
				detail="The link points at a project your account cannot see (or that no longer exists)."
				onRetry={chrome.clearProjectParam}
				retryLabel="Back to your projects"
			/>
		);
	}
	return props.children(chrome.effectiveProjectId);
}

function ProjectSettingsBody(props: { projectId: string }): ReactElement {
	const chrome = useWorkspaceChrome();
	const project = chrome.selectedProject;
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [editOpen, setEditOpen] = useState(false);
	const [archiveOpen, setArchiveOpen] = useState(false);
	const [connectOpen, setConnectOpen] = useState(false);

	if (!project) return <StatePanel kind="loading" title="Loading project settings…" />;

	async function saveDescription(name: string, description: string): Promise<void> {
		await fetchJson<{ project: Project }>(`/api/projects/${encodeURIComponent(props.projectId)}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ...(name.trim() ? { name: name.trim() } : {}), description: description.trim() === '' ? null : description.trim() }),
		});
		void queryClient.invalidateQueries({ queryKey: ['projects', chrome.actorId] });
	}

	async function archive(): Promise<void> {
		await postJson(`/api/projects/${encodeURIComponent(props.projectId)}/archive`, {});
		void queryClient.invalidateQueries({ queryKey: ['projects', chrome.actorId] });
		void navigate({ to: '/projects', search: {} });
	}

	return (
		<div className="settings-stack">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						PROJECT SETTINGS
					</p>
					<h1 className="page-title">{project.name}</h1>
				</div>
			</div>

			{/* General — what it is */}
			<section className="card-surface settings-panel" id="general" data-testid="ps-general">
				<div className="r-section-head">
					<h2 className="ev-title">General</h2>
					<button type="button" className="btn-ghost" data-testid="edit-description-open" onClick={() => setEditOpen(true)}>
						Edit
					</button>
				</div>
				<dl className="kv">
					<dt>Name</dt>
					<dd>{project.name}</dd>
					<dt>What it's for</dt>
					<dd data-testid="ps-description">{project.description ?? 'Not written yet.'}</dd>
				</dl>
			</section>

			{/* Code — connect a repo */}
			<section className="card-surface settings-panel" id="code" data-testid="ps-code">
				<div className="r-section-head">
					<h2 className="ev-title">Code</h2>
					<button type="button" className="btn-ghost" data-testid="connect-repo-open" onClick={() => setConnectOpen(true)}>
						Connect a repo
					</button>
				</div>
				<p className="state-detail">
					Caddie reads the connected repository — writing, merging and deploying stay behind their own
					separate approvals.
				</p>
			</section>

			{/* Routines */}
			<section className="card-surface settings-panel" id="routines" data-testid="ps-routines">
				<h2 className="ev-title">Routines</h2>
				<p className="state-detail">Scheduled checks Caddie runs for this project.</p>
				<Schedules projectId={props.projectId} />
			</section>

			{/* What Caddie knows (project scope) */}
			<section className="card-surface settings-panel" id="knows" data-testid="ps-knows">
				<h2 className="ev-title">What Caddie knows</h2>
				<Memory />
			</section>

			{/* Archive or delete — archive-only until permanent delete exists (§8.4) */}
			<section className="card-surface settings-panel" id="archive" data-testid="ps-archive">
				<h2 className="ev-title">Archive or delete</h2>
				<p className="state-detail">
					Archiving hides the project from your lists and stops its routines. Nothing is permanently
					deleted today.
				</p>
				<div className="row-actions">
					<button type="button" className="btn-ghost btn-danger" data-testid="archive-open" onClick={() => setArchiveOpen(true)}>
						Archive project
					</button>
				</div>
			</section>

			{editOpen ? (
				<EditDescriptionWindow
					project={project}
					onClose={() => setEditOpen(false)}
					onSave={(name, description) => saveDescription(name, description)}
				/>
			) : null}
			{connectOpen ? <ConnectRepoWindow workspaceId={project.workspaceId} onClose={() => setConnectOpen(false)} /> : null}
			{archiveOpen ? (
				<ArchiveWindow project={project} onClose={() => setArchiveOpen(false)} onConfirm={archive} />
			) : null}
		</div>
	);
}

/** Edit "What it is" (§4 edit-description): can't save empty, notes that an
 *  approved plan isn't changed. PATCHes the real project route. */
function EditDescriptionWindow(props: {
	project: Project;
	onClose: () => void;
	onSave: (name: string, description: string) => Promise<void>;
}): ReactElement {
	const [name, setName] = useState(props.project.name);
	const [description, setDescription] = useState(props.project.description ?? '');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const LIMIT = 200;

	async function save() {
		setBusy(true);
		setError(null);
		try {
			await props.onSave(name, description);
			props.onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	return (
		<div className="modal-backdrop" data-testid="edit-description-backdrop" onMouseDown={props.onClose}>
			<div className="commit-panel card-surface" data-testid="edit-description-window" onMouseDown={(e) => e.stopPropagation()}>
				<p className="kicker" data-tone="action">
					EDIT — WHAT IT IS
				</p>
				<h3 className="state-title">Describe the project</h3>
				<p className="state-detail">Caddie uses this to stay on target. Changing it does not change an approved plan.</p>
				<label className="kicker" htmlFor="ps-name">
					Name
				</label>
				<input id="ps-name" className="input" data-testid="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
				<label className="kicker" htmlFor="ps-desc">
					What it's for ({description.length}/{LIMIT})
				</label>
				<textarea
					id="ps-desc"
					className="input"
					rows={3}
					maxLength={LIMIT}
					data-testid="edit-description"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
				/>
				{error ? (
					<div role="alert" className="sign-in-error" data-testid="edit-description-error">
						<b>Could not save.</b>
						<span> {error}</span>
					</div>
				) : null}
				<div className="row-actions">
					<button type="button" className="btn-key" disabled={busy || name.trim() === ''} onClick={() => void save()}>
						{busy ? 'Saving…' : 'Save'}
					</button>
					<button type="button" className="btn-ghost" onClick={props.onClose} disabled={busy}>
						Cancel
					</button>
				</div>
			</div>
		</div>
	);
}

/** Connect a repository (§4 connect-repo): the real GitHub installations
 *  picker; the import binds a read-only snapshot to THIS project. */
function ConnectRepoWindow(props: { workspaceId: string; onClose: () => void }): ReactElement {
	const [picked, setPicked] = useState<SelectedRepository | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const chrome = useWorkspaceChrome();

	async function connect() {
		if (!picked || busy) return;
		setBusy(true);
		setError(null);
		try {
			await fetchJson(`/api/projects/${encodeURIComponent(chrome.effectiveProjectId ?? '')}/github/imports`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ installationId: picked.installationId, repoFullName: picked.repoFullName }),
			});
			props.onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	return (
		<div className="modal-backdrop" data-testid="connect-repo-backdrop" onMouseDown={props.onClose}>
			<div className="commit-panel card-surface" data-testid="connect-repo-window" onMouseDown={(e) => e.stopPropagation()}>
				<p className="kicker" data-tone="action">
					CONNECT A REPO
				</p>
				{!picked ? (
					<>
						<h3 className="state-title">Which repository?</h3>
						<RepositoryPicker workspaceId={props.workspaceId} onSelected={setPicked} />
						<div className="row-actions">
							<button type="button" className="btn-ghost" onClick={props.onClose}>
								Cancel
							</button>
						</div>
					</>
				) : (
					<>
						<h3 className="state-title">Connect {picked.repoFullName}?</h3>
						<p className="state-detail">Caddie reads it to plan and gather evidence. It never writes without your OK.</p>
						{error ? (
							<div role="alert" className="sign-in-error" data-testid="connect-repo-error">
								<b>Could not connect.</b>
								<span> {error}</span>
							</div>
						) : null}
						<div className="row-actions">
							<button type="button" className="btn-key" disabled={busy} onClick={() => void connect()}>
								{busy ? 'Connecting…' : 'Connect'}
							</button>
							<button type="button" className="btn-ghost" onClick={() => setPicked(null)} disabled={busy}>
								Back
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

/** Archive (§4 delete-project, archive-only): typed name required. */
function ArchiveWindow(props: {
	project: Project;
	onClose: () => void;
	onConfirm: () => Promise<void>;
}): ReactElement {
	const [typed, setTyped] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			await props.onConfirm();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	return (
		<div className="modal-backdrop" data-testid="archive-backdrop" onMouseDown={props.onClose}>
			<div className="commit-panel card-surface" data-testid="archive-window" onMouseDown={(e) => e.stopPropagation()}>
				<p className="kicker" data-tone="danger">
					ARCHIVE PROJECT
				</p>
				<h3 className="state-title">Archive {props.project.name}?</h3>
				<p className="state-detail">
					It disappears from your lists and its routines stop. Nothing is permanently deleted; a
					restored archive keeps its history.
				</p>
				<label className="kicker" htmlFor="ps-archive-type">
					Type the project name to confirm
				</label>
				<input
					id="ps-archive-type"
					className="input"
					data-testid="archive-typed-name"
					value={typed}
					onChange={(e) => setTyped(e.target.value)}
				/>
				{error ? (
					<div role="alert" className="sign-in-error" data-testid="archive-error">
						<b>Could not archive.</b>
						<span> {error}</span>
					</div>
				) : null}
				<div className="row-actions">
					<button type="button" className="btn-ghost btn-danger" disabled={busy || typed.trim() !== props.project.name} onClick={() => void confirm()}>
						{busy ? 'Archiving…' : 'Archive project'}
					</button>
					<button type="button" className="btn-ghost" onClick={props.onClose} disabled={busy}>
						Cancel
					</button>
				</div>
			</div>
		</div>
	);
}
