import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Project } from '@caddie/contracts';
import { Markdown } from '@caddie/ui/Markdown';
import { failureKind, StatePanel } from '../states.tsx';
import { Icon } from '../icons.tsx';
import { Memory } from '../memory/Memory.tsx';
import { Schedules } from '../tasks/Schedules.tsx';
import { RepositoryPicker, type SelectedRepository } from '../repositories/RepositoryPicker.tsx';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { useProjectRepo } from '../queries.ts';
import { fetchJson, postJson } from '../api.ts';

/**
 * Project settings (v2, HANDOFF §4 + §2 route table) — a NEW route at
 * /project/settings. Sections: General ("What it is" + the edit-description
 * window), Code (GitHub is the home for this project's code — shows the ONE
 * linked repo read live from GET /github/repo, or create-new / connect-existing
 * when none), Routines, What Caddie knows, and Archive or delete.
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
	const [section, setSection] = useState<'general' | 'code' | 'routines' | 'knows' | 'archive'>('general');

	// Old deep links land here with a hash (/schedules → #routines,
	// /repositories → #code): open the section they name, not General.
	useEffect(() => {
		const hash = window.location.hash.replace('#', '') as typeof section;
		if (hash === 'code' || hash === 'routines' || hash === 'knows' || hash === 'archive') setSection(hash);
	}, []);

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

	const SECTIONS = [
		{ id: 'general' as const, label: 'General', lede: 'What this project is, so Caddie stays on target.' },
		{ id: 'code' as const, label: 'Code', lede: 'Connect a repository for Caddie to read.' },
		{ id: 'routines' as const, label: 'Routines', lede: 'Scheduled checks Caddie runs for this project.' },
		{ id: 'knows' as const, label: 'What Caddie knows', lede: 'What Caddie remembers about this project.' },
		{ id: 'archive' as const, label: 'Archive', lede: 'Hide this project and stop its routines.' },
	];
	const current = SECTIONS.find((s) => s.id === section)!;

	return (
		<div className="shell-page" data-testid="project-settings-screen">
			<div className="settings-layout">
				<nav className="settings-rail" aria-label="Project settings sections" data-testid="ps-tabs">
					<div className="settings-rail-group" role="group" aria-label={project.name}>
						<p className="settings-rail-label" aria-hidden="true">{project.name}</p>
						{SECTIONS.map((s) => (
							<button
								key={s.id}
								type="button"
								className="settings-tab"
								data-testid={`ps-tab-${s.id}`}
								aria-current={section === s.id ? 'page' : undefined}
								onClick={() => setSection(s.id)}
							>
								{s.label}
							</button>
						))}
					</div>
				</nav>
				<div className="settings-content" data-section={section}>
					<header className="settings-head">
						{/* Back is always reachable — settings is one click from the
						    project page and one click home (owner steering, 2026-10-15). */}
						<div className="ps-back-row">
							<button
								type="button"
								className="btn-ghost ps-back"
								data-testid="ps-back"
								onClick={() => chrome.goProjectTab('/project', { project: props.projectId })}
							>
								<Icon name="arrowLeft" title="" />
								<span>Back to {project.name}</span>
							</button>
						</div>
						<p className="kicker" data-tone="action">Project settings</p>
						<h1 className="page-title">{current.label}</h1>
						<p className="page-lede">{current.lede}</p>
					</header>

					{section === 'general' ? (
						<section className="settings-section-body ps-general-body" data-testid="ps-general">
							<div className="ps-field">
								<span className="settings-field-label">Name</span>
								<p className="ps-field-value">{project.name}</p>
							</div>
							<div className="ps-field">
								<span className="settings-field-label">What it&rsquo;s for</span>
								{project.description ? (
									<div className="ps-field-value ps-brief-md" data-testid="ps-description">
										<Markdown text={project.description} />
									</div>
								) : (
									<p className="ps-field-value" data-testid="ps-description">
										Not written yet.
									</p>
								)}
							</div>
							<div className="settings-save">
								<button type="button" className="btn-ghost" data-testid="edit-description-open" onClick={() => setEditOpen(true)}>
									Edit name or purpose
								</button>
							</div>
						</section>
					) : null}

					{section === 'code' ? (
						<section className="settings-section-body" data-testid="ps-code">
							<CodeSection project={project} />
						</section>
					) : null}

					{section === 'routines' ? (
						<section className="settings-section-body" data-testid="ps-routines">
							<Schedules projectId={props.projectId} embedded />
						</section>
					) : null}

					{section === 'knows' ? (
						<section className="settings-section-body" data-testid="ps-knows">
							<Memory embedded />
						</section>
					) : null}

					{section === 'archive' ? (
						<section className="settings-section-body" data-testid="ps-archive">
							<p className="state-detail">
								Archiving hides the project from your lists and stops its routines. Nothing is
								permanently deleted today.
							</p>
							<div className="settings-save">
								<button type="button" className="btn-ghost btn-danger" data-testid="archive-open" onClick={() => setArchiveOpen(true)}>
									Archive project
								</button>
							</div>
						</section>
					) : null}
				</div>
			</div>

			{editOpen ? (
				<EditDescriptionWindow
					project={project}
					onClose={() => setEditOpen(false)}
					onSave={(name, description) => saveDescription(name, description)}
				/>
			) : null}
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

/**
 * Code (§4, v2 "GitHub is the home for each project's code"): shows the ONE
 * repo this project's code lives in, read live from GET /github/repo. When
 * none is linked yet, the user creates a new repo or connects an existing one
 * right here — the same server flow the in-chat guided card uses. Caddie reads
 * the repo to plan and gather evidence; writing, merging and deploying stay
 * behind their own separate approvals.
 */
function CodeSection(props: { project: Project }): ReactElement {
	const chrome = useWorkspaceChrome();
	const queryClient = useQueryClient();
	const actor = useMemo(() => ({ actorId: chrome.actorId }), [chrome.actorId]);
	const repoQuery = useProjectRepo(actor, props.project.id);
	const [mode, setMode] = useState<'idle' | 'create' | 'connect'>('idle');

	function refresh() {
		void queryClient.invalidateQueries({ queryKey: ['project-repo', chrome.actorId, props.project.id] });
		void repoQuery.refetch();
		setMode('idle');
	}

	if (repoQuery.isPending) return <p className="state-detail">Checking for a connected repo…</p>;
	if (repoQuery.isError) {
		return (
			<StatePanel
				kind={failureKind(repoQuery.error)}
				title="Could not read the connected repo"
				detail={repoQuery.error instanceof Error ? repoQuery.error.message : undefined}
				onRetry={() => void repoQuery.refetch()}
			/>
		);
	}

	const repo = repoQuery.data?.repo ?? null;

	if (repo) {
		return (
			<div className="ps-code-connected" data-testid="ps-code-connected">
				<div className="ps-field">
					<span className="settings-field-label">This project&rsquo;s code lives at</span>
					<p className="ps-field-value">
						<a className="r-link" href={repo.htmlUrl} target="_blank" rel="noopener noreferrer" data-testid="ps-repo-link">
							<Icon name="github" title="" /> {repo.repoFullName}
						</a>
					</p>
				</div>
				<div className="ps-code-chips" data-testid="ps-repo-meta">
					<span className="project-chip" data-tone="neutral">{repo.visibility === 'public' ? 'Public' : 'Private'}</span>
					<span className="project-chip" data-tone="neutral">{originLabel(repo.origin)}</span>
				</div>
				<p className="state-detail">
					Caddie reads this repo to plan and gather evidence. Writing, merging and deploying stay
					behind their own separate approvals — connecting a repo never grants Caddie write access.
				</p>
			</div>
		);
	}

	if (mode === 'idle') {
		return (
			<div className="ps-code-empty" data-testid="ps-code-empty">
				<p className="state-detail">
					No repo is connected yet. GitHub is the home for this project&rsquo;s code — create a new
					repo for it, or connect one you already have. Caddie reads it to plan and gather evidence;
					it never writes without your OK.
				</p>
				<div className="settings-save">
					<button type="button" className="btn-key" data-testid="ps-code-create" onClick={() => setMode('create')}>
						Create a repo
					</button>
					<button type="button" className="btn-ghost" data-testid="ps-code-connect" onClick={() => setMode('connect')}>
						Connect existing
					</button>
				</div>
			</div>
		);
	}

	return (
		<RepoLinkForm
			project={props.project}
			mode={mode}
			onDone={refresh}
			onCancel={() => setMode('idle')}
		/>
	);
}

/** Plain words for the repo origin. */
function originLabel(origin: 'created' | 'adopted' | 'connected'): string {
	switch (origin) {
		case 'created':
			return 'Created by Caddie';
		case 'adopted':
			return 'Adopted';
		default:
			return 'Connected';
	}
}

/**
 * This project's Code section: GitHub's return after connecting comes back
 * here (plan 6.1); the section opens from the hash.
 */
function codeSectionPath(projectId: string): string {
	return `/app/project/settings?project=${encodeURIComponent(projectId)}#code`;
}

/**
 * Create-new or connect-existing a repo for THIS project, over the real
 * /github/repos and /github/repo/connect routes (same as the guided card).
 * A create needs a bound installation, surfaced by the RepositoryPicker.
 */
function RepoLinkForm(props: {
	project: Project;
	mode: 'create' | 'connect';
	onDone: () => void;
	onCancel: () => void;
}): ReactElement {
	const [installationId, setInstallationId] = useState<string | null>(null);
	const [name, setName] = useState('');
	const [visibility, setVisibility] = useState<'private' | 'public'>('private');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function createRepo() {
		if (busy) return;
		const trimmed = name.trim();
		if (!trimmed) {
			setError('Give the repo a name.');
			return;
		}
		if (!installationId) {
			setError('Choose a GitHub account above first, then create the repo.');
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await postJson(`/api/projects/${encodeURIComponent(props.project.id)}/github/repos`, {
				installationId,
				name: trimmed,
				visibility,
			});
			props.onDone();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	async function connectRepo(sel: SelectedRepository) {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await postJson(`/api/projects/${encodeURIComponent(props.project.id)}/github/repo/connect`, {
				installationId: sel.installationId,
				repoFullName: sel.repoFullName,
			});
			props.onDone();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setBusy(false);
		}
	}

	if (props.mode === 'connect') {
		return (
			<div className="ps-code-connect" data-testid="ps-code-connect-form">
				<RepositoryPicker
					workspaceId={props.project.workspaceId}
					onSelected={(sel) => void connectRepo(sel)}
					returnTo={codeSectionPath(props.project.id)}
				/>
				{error ? (
					<div role="alert" className="sign-in-error" data-testid="ps-code-error">
						<b>Could not connect.</b> <span>{error}</span>
					</div>
				) : null}
				<div className="row-actions">
					<button type="button" className="btn-ghost" onClick={props.onCancel} disabled={busy}>
						Back
					</button>
				</div>
			</div>
		);
	}

	return (
		<form
			className="ps-code-create"
			data-testid="ps-code-create-form"
			onSubmit={(e) => {
				e.preventDefault();
				void createRepo();
			}}
		>
			<RepositoryPicker
				workspaceId={props.project.workspaceId}
				onSelected={(sel) => setInstallationId(sel.installationId)}
				returnTo={codeSectionPath(props.project.id)}
			/>
			<label className="kicker" htmlFor="ps-repo-name">
				Repo name
			</label>
			<input
				id="ps-repo-name"
				className="input"
				data-testid="ps-repo-name"
				value={name}
				onChange={(e) => setName(e.currentTarget.value)}
				placeholder="my-project"
			/>
			<div className="guided-visibility" role="radiogroup" aria-label="Visibility">
				<button
					type="button"
					role="radio"
					aria-checked={visibility === 'private'}
					className="disc-filter"
					data-testid="ps-visibility-private"
					onClick={() => setVisibility('private')}
				>
					Private
				</button>
				<button
					type="button"
					role="radio"
					aria-checked={visibility === 'public'}
					className="disc-filter"
					data-testid="ps-visibility-public"
					onClick={() => setVisibility('public')}
				>
					Public
				</button>
			</div>
			{error ? (
				<div role="alert" className="sign-in-error" data-testid="ps-code-error">
					<b>Could not create.</b> <span>{error}</span>
				</div>
			) : null}
			<div className="row-actions">
				<button type="submit" className="btn-key" disabled={busy} data-testid="ps-code-create-submit">
					{busy ? 'Creating…' : 'Create repo'}
				</button>
				<button type="button" className="btn-ghost" onClick={props.onCancel} disabled={busy}>
					Back
				</button>
			</div>
		</form>
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
