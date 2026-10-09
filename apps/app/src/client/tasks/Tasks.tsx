import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { formatTimeAgo } from '@caddie/ui/time';
import { fetchJson } from '../api.ts';

/**
 * Tasks — project-scoped human task list over the REAL P12 routes
 * (server/routes/tasks.ts, server/tasks.ts): create, complete, cancel,
 * reopen. Every mutation failure is named in-row — a refused action is never
 * silent (audit F12/S25).
 */

export interface TaskRow {
	readonly id: string;
	readonly projectId: string;
	readonly title: string;
	readonly status: 'open' | 'done' | 'cancelled';
	readonly dueAt: string | null;
	readonly linkedRunId: string | null;
	readonly createdBy: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

type LoadState =
	| { readonly kind: 'loading' }
	| { readonly kind: 'ready'; readonly tasks: readonly TaskRow[] }
	| { readonly kind: 'denied' }
	| { readonly kind: 'error'; readonly message: string };

export function Tasks(props: { projectId: string | null }): ReactElement {
	const [state, setState] = useState<LoadState>({ kind: 'loading' });
	const [busyId, setBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<{ taskId: string; message: string } | null>(null);
	const [title, setTitle] = useState('');
	const [dueAt, setDueAt] = useState('');
	const [createError, setCreateError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const load = useCallback(async (projectId: string) => {
		setState({ kind: 'loading' });
		try {
			const payload = await fetchJson<{ tasks: TaskRow[] }>(
				`/api/projects/${encodeURIComponent(projectId)}/tasks`,
			);
			setState({ kind: 'ready', tasks: payload.tasks });
		} catch (error) {
			const kind = (error as { kind?: string }).kind;
			if (kind === 'denied') setState({ kind: 'denied' });
			else
				setState({
					kind: 'error',
					message: (error as Error).message || 'The task list could not be loaded.',
				});
		}
	}, []);

	useEffect(() => {
		if (props.projectId) void load(props.projectId);
		else setState({ kind: 'ready', tasks: [] });
	}, [props.projectId, load]);

	const create = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!props.projectId || creating) return;
		const trimmed = title.trim();
		if (trimmed === '') return;
		setCreating(true);
		setCreateError(null);
		try {
			await fetchJson(`/api/projects/${encodeURIComponent(props.projectId)}/tasks`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: trimmed, dueAt: dueAt.trim() === '' ? null : dueAt.trim() }),
			});
			setTitle('');
			setDueAt('');
			await load(props.projectId);
		} catch (error) {
			setCreateError((error as Error).message || 'The task could not be created.');
		} finally {
			setCreating(false);
		}
	};

	const act = async (taskId: string, status: 'done' | 'cancelled' | 'open'): Promise<void> => {
		if (!props.projectId) return;
		setBusyId(taskId);
		setActionError(null);
		try {
			await fetchJson(`/api/projects/${encodeURIComponent(props.projectId)}/tasks/${encodeURIComponent(taskId)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ status }),
			});
			await load(props.projectId);
		} catch (error) {
			setActionError({
				taskId,
				message: (error as Error).message || `The task could not be updated.`,
			});
			if (props.projectId) await load(props.projectId);
		} finally {
			setBusyId(null);
		}
	};

	if (state.kind === 'denied') {
		return (
			<section className="state-panel card-surface" data-testid="tasks-panel">
				<p className="kicker">BUILD</p>
				<h3 className="state-title">Not your project</h3>
				<p className="state-detail">Your session has no membership in this project's workspace.</p>
			</section>
		);
	}
	if (state.kind === 'error') {
		return (
			<section className="state-panel card-surface" data-testid="tasks-panel">
				<p className="kicker">BUILD</p>
				<h3 className="state-title">Could not load tasks</h3>
				<p className="state-detail">{state.message}</p>
			</section>
		);
	}
	if (state.kind === 'loading') {
		return (
			<section className="state-panel card-surface" data-testid="tasks-panel">
				<p className="kicker">BUILD</p>
				<p className="state-detail">Loading tasks…</p>
			</section>
		);
	}

	return (
		<section className="state-panel card-surface" data-testid="tasks-panel">
			<p className="kicker" data-tone="action">
				BUILD
			</p>
			<h3 className="state-title">Tasks</h3>
			<p className="page-lede">
				Human to-dos on this build — yours and the specialists', kept next to the runs that produced them.
			</p>
			<form className="task-create" onSubmit={create} data-testid="task-create">
				<input
					type="text"
					className="input"
					placeholder="New task — e.g. “record the demo video”"
					aria-label="New task title"
					data-testid="task-title"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
				/>
				<input
					type="date"
					className="input"
					aria-label="Due date (optional)"
					data-testid="task-due"
					value={dueAt}
					onChange={(event) => setDueAt(event.target.value)}
				/>
				<button type="submit" className="btn-key" disabled={creating || title.trim() === ''} data-testid="task-add">
					{creating ? 'Adding…' : 'Add task'}
				</button>
			</form>
			{createError ? (
				<div role="alert" className="row-error" data-testid="task-create-error">
					<b>The task was not created.</b> {createError}
				</div>
			) : null}
			{state.tasks.length === 0 ? (
				<p className="state-detail" data-testid="tasks-empty">
					No tasks in this project yet. Add the first one above.
				</p>
			) : (
				<div data-testid="tasks-list">
					{state.tasks.map((task) => (
						<div className="inspector-row" key={task.id} data-testid="task-row" data-status={task.status}>
							<div className="row-main">
								<span className="row-title">{task.title}</span>
								<span className="row-status" data-status={task.status}>
									{task.status}
								</span>
							</div>
							<div className="row-main">
								<span className="mono-id">
									{task.dueAt ? `due ${formatTimeAgo(task.dueAt)} · ${task.dueAt}` : 'no due date'}
								</span>
								{task.linkedRunId ? (
									<span className="mono-id">bound to run {task.linkedRunId.slice(0, 14)}…</span>
								) : null}
							</div>
							<div className="row-actions">
								{task.status === 'open' ? (
									<>
										<button
											type="button"
											className="btn-ghost"
											disabled={busyId === task.id}
											data-testid={`task-done-${task.id}`}
											onClick={() => void act(task.id, 'done')}
										>
											Done
										</button>
										<button
											type="button"
											className="detail-toggle"
											disabled={busyId === task.id}
											data-testid={`task-cancel-${task.id}`}
											onClick={() => void act(task.id, 'cancelled')}
										>
											Cancel
										</button>
									</>
								) : (
									<button
										type="button"
										className="detail-toggle"
										disabled={busyId === task.id}
										data-testid={`task-reopen-${task.id}`}
										onClick={() => void act(task.id, 'open')}
									>
										Reopen
									</button>
								)}
							</div>
							{actionError && actionError.taskId === task.id ? (
								<div role="alert" className="row-error" data-testid={`task-error-${task.id}`}>
									<b>The action was refused.</b> {actionError.message}
								</div>
							) : null}
						</div>
					))}
				</div>
			)}
		</section>
	);
}