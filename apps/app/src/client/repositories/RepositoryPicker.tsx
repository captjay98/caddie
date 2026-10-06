import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, fetchJson } from '../api.ts';
import { failureKind, StatePanel } from '../states.tsx';

/**
 * Repository picker (P08 slice 3) — the user-facing surface over the GitHub
 * App routes:
 *
 *   GET  /api/github/installations?workspaceId=…   installations of the workspace
 *   POST /api/github/installations/bind            explicit binding by installation id
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
}): ReactElement {
	const { workspaceId } = props;
	const [installations, setInstallations] = useState<InstallationView[] | null>(null);
	const [loadError, setLoadError] = useState<Error | null>(null);
	const [reloadKey, setReloadKey] = useState(0);

	const [bindId, setBindId] = useState('');
	const [bindBusy, setBindBusy] = useState(false);
	const [bindMessage, setBindMessage] = useState<string | null>(null);

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

	const openRepos = useCallback(async (installationId: string): Promise<void> => {
		setOpenInstallation(installationId);
		setRepos(null);
		setReposError(null);
		try {
			const body = await fetchJson<{ repositories: RepoSelectionView[] }>(
				`/api/github/installations/${encodeURIComponent(installationId)}/repos`,
			);
			setRepos(body.repositories.filter((repo) => repo.status === 'selected'));
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
			<h3>GitHub repositories</h3>

			{installations.length === 0 ? (
				<StatePanel
					kind="empty"
					title="No GitHub App installation is bound to this workspace"
					detail="Install the Caddie GitHub App on your account, paste the installation id below, then bind it here."
				/>
			) : (
				<ul className="repository-picker__installations" data-testid="installation-list">
					{installations.map((installation) => (
						<li key={installation.installationId} data-status={installation.status}>
							<div className="repository-picker__installation">
								<span className="repository-picker__account">{installation.accountLogin}</span>
								<span className="repository-picker__meta">
									installation {installation.installationId} · {installation.appSlug || 'github app'} ·{' '}
									{installation.status}
								</span>
								{installation.status === 'active' ? (
									<button
										type="button"
										onClick={() => void openRepos(installation.installationId)}
										aria-expanded={openInstallation === installation.installationId}
									>
										{openInstallation === installation.installationId ? 'Hide repositories' : 'Show repositories'}
									</button>
								) : (
									<span className="repository-picker__denied" data-testid="installation-revoked">
										Revoked — no further imports or deliveries are possible.
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
												<li key={repo.repoFullName}>
													<button
														type="button"
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

			<form
				className="repository-picker__bind"
				onSubmit={(event) => {
					event.preventDefault();
					void bind();
				}}
			>
				<label>
					<span>Bind an installation by id</span>
					<input
						value={bindId}
						onChange={(event) => setBindId(event.target.value)}
						placeholder="GitHub App installation id"
						inputMode="numeric"
						disabled={bindBusy}
					/>
				</label>
				<button type="submit" disabled={bindBusy || bindId.trim() === ''}>
					{bindBusy ? 'Binding…' : 'Bind installation'}
				</button>
				{bindMessage ? <p data-testid="bind-message">{bindMessage}</p> : null}
			</form>
		</div>
	);
}
