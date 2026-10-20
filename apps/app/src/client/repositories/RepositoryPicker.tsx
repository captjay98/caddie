import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, fetchJson } from '../api.ts';
import { failureKind, StatePanel } from '../states.tsx';

/**
 * Repository picker (P08 slice 3) — the user-facing surface over the GitHub
 * App routes:
 *
 *   GET  /api/github/installations?workspaceId=…   installations of the workspace
 *   GET  /api/github/app?workspaceId=…&returnTo=…   the Connect GitHub link, carrying
 *                                                  Caddie's signed request; GitHub's
 *                                                  return connects (plan 6.1)
 *   POST /api/github/installations/bind            explicit binding by installation id (fallback)
 *   GET  /api/github/installations/:id/repos       selected repositories
 *
 * Honesty rules mirrored from the server: only installations explicitly bound
 * to this workspace appear; revoked installations render as revoked instead of
 * disappearing (the denial is real); binding requires the exact installation
 * id and reports typed conflicts (already bound / suspended / missing
 * permissions) instead of pretending success. Picking a repo only reports the
 * choice upward — import/delivery stay server-side operations.
 */

interface InstallationView {
	installationId: string;
	accountLogin: string;
	status: 'active' | 'revoked' | 'suspended';
	appSlug: string;
	permissions: Record<string, string>;
	workspaceId: string | null;
}

interface RepoSelectionView {
	repoFullName: string;
	status: 'selected' | 'deselected';
}

export interface SelectedRepository {
	installationId: string;
	repoFullName: string;
}

export function RepositoryPicker(props: {
	workspaceId: string;
	/** Called when the user picks a selected repository. */
	onSelected?: (selection: SelectedRepository) => void;
	/**
	 * The Caddie page GitHub's return comes back to (plan 6.1); defaults to
	 * this page. A page whose section lives in the hash names it here.
	 */
	returnTo?: string;
}): ReactElement {
	const { workspaceId, returnTo } = props;
	const [installations, setInstallations] = useState<InstallationView[] | null>(null);
	const [loadError, setLoadError] = useState<Error | null>(null);
	const [reloadKey, setReloadKey] = useState(0);

	const [bindId, setBindId] = useState('');
	const [bindBusy, setBindBusy] = useState(false);
	const [bindMessage, setBindMessage] = useState<string | null>(null);

	// The App's own install page (null when the slug isn't configured — we never
	// fabricate a URL). When present it leads the connect flow so the user
	// authorizes on GitHub and comes back, instead of pasting an id blind.
	const [installUrl, setInstallUrl] = useState<string | null>(null);

	const [openInstallation, setOpenInstallation] = useState<string | null>(null);
	const [repos, setRepos] = useState<RepoSelectionView[] | null>(null);
	const [reposError, setReposError] = useState<Error | null>(null);

	const load = useCallback(async (): Promise<void> => {
		setLoadError(null);
		try {
			const body = await fetchJson<{ installations: InstallationView[] }>(
				`/api/github/installations?workspaceId=${encodeURIComponent(workspaceId)}`,
			);
			setInstallations(body.installations);
		} catch (error) {
			setInstallations(null);
			setLoadError(error instanceof Error ? error : new Error(String(error)));
		}
	}, [workspaceId]);

	useEffect(() => {
		setInstallations(null);
		void load();
	}, [load, reloadKey]);

	// Best-effort: learn the App's install URL so we can lead with Connect
	// GitHub. It carries Caddie's own signed request for this workspace and
	// page, which GitHub hands back so its return connects in one click (plan
	// 6.1). A failure (or an unconfigured slug) just leaves installUrl null —
	// the id-paste fallback below still works.
	useEffect(() => {
		let live = true;
		const page =
			returnTo ??
			(typeof window === 'undefined' ? '/app/' : `${window.location.pathname}${window.location.search}${window.location.hash}`);
		const query = new URLSearchParams({ workspaceId, returnTo: page });
		void fetchJson<{ installUrl: string | null }>(`/api/github/app?${query.toString()}`)
			.then((body) => {
				if (live) setInstallUrl(body.installUrl);
			})
			.catch(() => {
				if (live) setInstallUrl(null);
			});
		return () => {
			live = false;
		};
	}, [workspaceId, returnTo]);

	const openRepos = useCallback(async (installationId: string): Promise<void> => {
		setOpenInstallation(installationId);
		setRepos(null);
		setReposError(null);
		try {
			const body = await fetchJson<{ repositories: RepoSelectionView[] }>(
				`/api/github/installations/${encodeURIComponent(installationId)}/repos`,
			);
			// Board screen 12: deselected repositories stay visible as removed —
			// a deliberate removal is never indistinguishable from never offered.
			setRepos(body.repositories);
		} catch (error) {
			setRepos(null);
			setReposError(error instanceof Error ? error : new Error(String(error)));
		}
	}, []);

	const bind = useCallback(async (): Promise<void> => {
		const installationId = bindId.trim();
		if (!installationId) return;
		setBindBusy(true);
		setBindMessage(null);
		try {
			await fetchJson(`/api/github/installations/bind`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ installationId, workspaceId }),
			});
			setBindId('');
			setBindMessage(`Bound installation ${installationId}.`);
			setReloadKey((key) => key + 1);
		} catch (error) {
			if (error instanceof ApiError) {
				const copy: Record<string, string> = {
					installation_already_bound:
						'This installation is already bound to another workspace.',
					installation_suspended: 'This installation is suspended at GitHub.',
					installation_missing_permissions:
						'The installation must grant contents:read and pull_requests:write.',
					installation_not_found: 'No such installation for the configured GitHub App.',
				};
				setBindMessage(
					copy[error.code ?? ''] ??
						`Binding failed (${error.code ?? `HTTP ${error.status ?? '?'}`}): ${error.message}`,
				);
			} else {
				setBindMessage('Binding failed: you appear to be offline.');
			}
		} finally {
			setBindBusy(false);
		}
	}, [bindId, workspaceId]);

	if (loadError) {
		return (
			<div className="repository-picker" data-testid="repository-picker">
				<StatePanel
					kind={failureKind(loadError)}
					title="Installations could not be loaded"
					detail={loadError.message}
					onRetry={() => setReloadKey((key) => key + 1)}
				/>
			</div>
		);
	}
	if (installations === null) {
		return (
			<div className="repository-picker" data-testid="repository-picker">
				<StatePanel kind="loading" title="Checking GitHub installations…" />
			</div>
		);
	}

	return (
		<div className="repository-picker" data-testid="repository-picker">
			<div className="r-section-head">
				<div>
					<p className="kicker" data-tone="action">
						github app
					</p>
					<h3 className="ev-title">What Caddie may read, and what it may not do with it</h3>
				</div>
				<button type="button" className="btn-ghost" onClick={() => setReloadKey((key) => key + 1)}>
					Reload installations
				</button>
			</div>

			{installations.length === 0 ? (
				<StatePanel
					kind="empty"
					title="No GitHub App installation is bound to this workspace"
					detail="Connect GitHub below: GitHub asks what Caddie may read, then brings you back here. Caddie reads only what you grant."
				/>
			) : (
				<ul className="repository-picker__installations" data-testid="installation-list">
					{installations.map((installation) => (
						<li key={installation.installationId} data-status={installation.status}>
							<div className="repository-picker__installation">
								<span className="repository-picker__account">{installation.accountLogin}</span>
								<span
									className="badge"
									data-tone={installation.status === 'active' ? 'ok' : installation.status === 'suspended' ? 'warn' : 'danger'}
									data-testid={`installation-status-${installation.installationId}`}
								>
									{installation.status}
								</span>
								<span className="repository-picker__meta">
									installation {installation.installationId} · {installation.appSlug || 'github app'}
								</span>
								{installation.status === 'active' ? (
									<button
										type="button"
										className="btn-ghost"
										onClick={() => void openRepos(installation.installationId)}
										aria-expanded={openInstallation === installation.installationId}
									>
										{openInstallation === installation.installationId ? 'Hide repositories' : 'Show repositories'}
									</button>
								) : installation.status === 'suspended' ? (
									<span className="repository-picker__denied" data-testid="installation-suspended">
										Suspended at GitHub — the installation still exists and can be resumed; nothing
										new is read while it is suspended.
									</span>
								) : (
									<span className="repository-picker__denied" data-testid="installation-revoked">
										Revoked — no further imports or deliveries are possible. Plans already drafted
										keep the evidence they captured.
									</span>
								)}
							</div>
							<div className="repository-picker__perms">
								<span className="fk">permissions</span>
								{Object.entries(installation.permissions).length > 0 ? (
									Object.entries(installation.permissions).map(([name, level]) => (
										<span
											key={name}
											className={`badge${name === 'contents' && level === 'read' ? '' : name === 'pull_requests' && level === 'write' ? '' : ' badge-optional'}`}
											data-tone={name === 'contents' || name === 'pull_requests' ? 'action' : 'neutral'}
											title={name === 'contents' || name === 'pull_requests' ? 'required for binding' : 'granted, not required for binding'}
										>
											{name}:{level}
										</span>
									))
								) : (
									<span className="badge badge-unknown" data-tone="roadmap">
										none recorded
									</span>
								)}
							</div>
							{openInstallation === installation.installationId && installation.status === 'active' ? (
								<div className="repository-picker__repos" data-testid="repo-list">
									{reposError ? (
										<StatePanel
											kind={failureKind(reposError)}
											title="Repositories could not be loaded"
											detail={reposError.message}
											onRetry={() => void openRepos(installation.installationId)}
										/>
									) : repos === null ? (
										<StatePanel kind="loading" title="Loading selected repositories…" />
									) : repos.length === 0 ? (
										<StatePanel
											kind="empty"
											title="No repositories are selected for this installation"
											detail="Select repositories in the GitHub App configuration; they appear here through webhook events."
										/>
									) : (
										<ul>
											{repos.map((repo) => (
												<li key={repo.repoFullName} data-status={repo.status}>
													<button
														type="button"
														className="btn-ghost"
														data-testid={`pick-repo-${repo.repoFullName}`}
														onClick={() =>
															props.onSelected?.({
																installationId: installation.installationId,
																repoFullName: repo.repoFullName,
															})
														}
													>
														{repo.repoFullName}
													</button>
													{repo.status === 'deselected' ? (
														<span className="badge" data-tone="roadmap">
															removed — kept in the list, never silently deleted
														</span>
													) : null}
												</li>
											))}
										</ul>
									)}
								</div>
							) : null}
						</li>
					))}
				</ul>
			)}

			<div className="repository-picker__connect" data-testid="repository-picker-connect">
				<p className="kicker" data-tone="action">
					connect an account · you authorize on GitHub · Caddie never guesses access
				</p>
				{installUrl ? (
					<p className="repository-picker__install">
						{/* The same tab: GitHub's return lands back on this page (plan 6.1). */}
						<a className="btn-key" data-testid="github-install-link" href={installUrl}>
							Connect GitHub
						</a>
						<span className="repository-picker__meta">
							GitHub asks which account and repositories Caddie may use, then brings you back here.
						</span>
					</p>
				) : (
					<p className="repository-picker__meta" data-testid="github-install-unconfigured">
						Install the Caddie GitHub App on your account from GitHub, then bind it below. (The
						direct install link isn't configured in this environment.)
					</p>
				)}

				<details className="repository-picker__bind-fallback">
					<summary data-testid="bind-fallback-toggle">Connect by installation number instead</summary>
					<form
						className="repository-picker__bind"
						onSubmit={(event) => {
							event.preventDefault();
							void bind();
						}}
					>
						<p className="kicker">explicit human action · typed conflicts, never a silent success</p>
						<label>
							<span>Installation id</span>
							<input
								className="input"
								value={bindId}
								onChange={(event) => setBindId(event.target.value)}
								placeholder="GitHub App installation id"
								inputMode="numeric"
								disabled={bindBusy}
							/>
						</label>
						<button type="submit" className="btn-key" disabled={bindBusy || bindId.trim() === ''}>
							{bindBusy ? 'Binding…' : 'Bind installation'}
						</button>
						{bindMessage ? <p data-testid="bind-message">{bindMessage}</p> : null}
					</form>
				</details>
			</div>
		</div>
	);
}
