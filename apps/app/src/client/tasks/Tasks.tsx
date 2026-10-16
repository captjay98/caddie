import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { fetchJson } from '../api.ts';
import { TeachingEmpty } from '../states.tsx';

/**
 * Tasks — project-scoped human task list over the REAL P12 routes
 * (server/routes/tasks.ts, server/tasks.ts): create, complete, cancel,
 * reopen. Every mutation failure is named in-row — a refused action is never
 * silent (audit F12/S25).
 *
 * Presentation (owner steering, 2026-10-15): the section says in plain words
 * what a to-do is FOR (jobs a person does outside Caddie), rows read like a
 * checklist — a tick circle, the job, a human due date — instead of status
 * pills and raw ISO stamps, and `embedded` renders bare (no own card) so the
 * Overview fold doesn't nest a card inside a card.
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

/** "due Fri 18 Oct" from a YYYY-MM-DD (or ISO) stamp — never a raw ISO line. */
export function dueLabel(dueAt: string): string {
	const date = new Date(dueAt.length === 10 ? `${dueAt}T12:00:00` : dueAt);
	if (!Number.isFinite(date.getTime())) return `due ${dueAt}`;
	const label = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
	return `due ${label}`;
}

export function Tasks(props: {
	projectId: string | null;
	/** Overview embed: no own card/heading (the fold names it), form behind "Add a to-do". */
	embedded?: boolean;
}): ReactElement {
	const [state, setState] = useState<LoadState>({ kind: 'loading' });
	const [addOpen, setAddOpen] = useState(false);
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
			// Defensive: a payload without the tasks array is an empty list, not a
			// crash — the page around it keeps rendering.
			setState({ kind: 'ready', tasks: Array.isArray(payload.tasks) ? payload.tasks : [] });
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

	// `inner` is built eagerly but only ever RENDERED in the ready branch (the
	// loading/denied/error states return earlier). TypeScript cannot narrow a
	// const across those guards, so derive the list once with a narrowing it can
	// follow — an empty list in every non-ready state, which `inner` never shows.
	const tasks = state.kind === 'ready' ? state.tasks : [];

	const inner = (
		<>
			<p className="page-lede" data-testid="tasks-lede">
				Jobs a person still does outside Caddie — record the demo video, try the app on your phone,
				sign up for the contest. Yours to tick off; Caddie's specialists can add their own here too.
			</p>
			{props.embedded && !addOpen ? null : (
			<form className="task-create" onSubmit={create} data-testid="task-create">
				<input
					type="text"
					className="input"
					placeholder="New to-do — e.g. “record the demo video”"
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
					{creating ? 'Adding…' : 'Add to-do'}
				</button>
			</form>
			)}
			{createError ? (
				<div role="alert" className="row-error" data-testid="task-create-error">
					<b>The to-do was not added.</b> {createError}
				</div>
			) : null}
			{tasks.length === 0 ? (
				<TeachingEmpty
					testid="tasks-empty"
					icon="sparkCheck"
					title="No to-dos yet"
					detail="Jobs a person still does outside Caddie — record the demo video, try the app on your phone, register for the contest. Yours to tick off; Caddie's specialists can add their own here too."
					action={
						props.embedded
							? { label: 'Add the first to-do', onClick: () => setAddOpen(true), testid: 'tasks-empty-add' }
							: undefined
					}
				/>
			) : (
				<div data-testid="tasks-list">
					{tasks.map((task) => (
						<div className="task-row" key={task.id} data-testid="task-row" data-status={task.status}>
							{task.status === 'open' ? (
								<button
									type="button"
									className="task-tick"
									aria-label={`Mark done: ${task.title}`}
									disabled={busyId === task.id}
									data-testid={`task-done-${task.id}`}
									onClick={() => void act(task.id, 'done')}
								/>
							) : (
								<button
									type="button"
									className="task-tick"
									aria-label={`Reopen: ${task.title}`}
									data-testid={`task-reopen-${task.id}`}
									disabled={busyId === task.id}
									onClick={() => void act(task.id, 'open')}
								>
									✓
								</button>
							)}
							<div className="task-main">
								<span className="task-title">{task.title}</span>
								<span className="task-meta">
									{task.dueAt ? dueLabel(task.dueAt) : 'no due date'}
									{task.status === 'cancelled' ? ' · cancelled' : ''}
								</span>
							</div>
							{task.status === 'open' ? (
								<button
									type="button"
									className="detail-toggle"
									disabled={busyId === task.id}
									data-testid={`task-cancel-${task.id}`}
									onClick={() => void act(task.id, 'cancelled')}
								>
									Dismiss
								</button>
							) : null}
							{actionError && actionError.taskId === task.id ? (
								<div role="alert" className="row-error" data-testid={`task-error-${task.id}`}>
									<b>The action was refused.</b> {actionError.message}
								</div>
							) : null}
						</div>
					))}
				</div>
			)}
		</>
	);

	if (props.embedded) {
		// Inside the Overview fold: the fold carries the card and the heading;
		// this renders only content (state panels stay bare too).
		if (state.kind === 'denied') {
			return (
				<div data-testid="tasks-panel" className="state-detail">
					Your account isn't a member of this project's workspace, so its to-dos can't be shown.
				</div>
			);
		}
		if (state.kind === 'error') {
			return (
				<div data-testid="tasks-panel" role="alert" className="state-detail">
					The to-do list could not be loaded: {state.message}
				</div>
			);
		}
		if (state.kind === 'loading') {
			return (
				<div data-testid="tasks-panel" className="state-detail">
					Loading to-dos…
				</div>
			);
		}
		return (
			<div data-testid="tasks-panel" className="tasks-embedded">
				<div className="r-section-head">
					<h3 className="state-title">To-dos</h3>
					<button type="button" className="btn-ghost" data-testid="add-task-open" onClick={() => setAddOpen((value) => !value)}>
						{addOpen ? 'Close' : 'Add a to-do'}
					</button>
				</div>
				{inner}
			</div>
		);
	}

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
				<p className="state-detail">Loading to-dos…</p>
			</section>
		);
	}

	return (
		<section className="state-panel card-surface" data-testid="tasks-panel">
			<p className="kicker" data-tone="action">
				BUILD
			</p>
			<div className="r-section-head">
				<h3 className="state-title">To-dos</h3>
			</div>
			{inner}
		</section>
	);
}
