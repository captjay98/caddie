import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { formatTimeAgo } from '@caddie/ui/time';
import { fetchJson } from '../api.ts';
import { TeachingEmpty } from '../states.tsx';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { cronToWords } from './cron-words.ts';

/**
 * Schedules — project-scoped list of P12 schedules (feature-ledger C19): next
 * slot, pause state and last result, with run-now and pause/resume actions
 * over the real P12 REST surface.
 *
 * How routines come to exist (owner question, 2026-10-15): you ASK Caddie in
 * the project chat — "check the contest page every morning" — and Caddie sets
 * the schedule up; there is no manual cron form on purpose. This panel is
 * where they are MANAGED afterwards, and the empty state says exactly that
 * with a direct path back to the chat.
 *
 * Rows lead with plain words ("daily at 09:00"); the raw cron lives in the
 * row's developer fold — readable by humans first, exact for developers.
 *
 * All data comes from the server, keyed to the EXPLICIT ?project= id this
 * panel was opened with — nothing here derives a "current" project from
 * ambient state, so switching projects can never retarget a schedule.
 */

export interface ScheduleRow {
	readonly id: string;
	readonly name: string;
	readonly cron: string;
	readonly timezone: string;
	readonly nextRunAt: string;
	readonly lastResult: string | null;
	readonly paused: boolean;
	readonly payload: { sourceId?: string; runId?: string };
}

function shortId(id: string, keep = 14): string {
	return id.length > keep ? `${id.slice(0, keep)}…` : id;
}

type LoadState =
	| { readonly kind: 'loading' }
	| { readonly kind: 'ready'; readonly schedules: readonly ScheduleRow[] }
	| { readonly kind: 'denied' }
	| { readonly kind: 'error'; readonly message: string };

export function Schedules(props: { projectId: string | null; /** Settings embed: no own card — the settings section names it. */ embedded?: boolean }): ReactElement {
	const chrome = useWorkspaceChrome();
	const [state, setState] = useState<LoadState>({ kind: 'loading' });
	const [busyId, setBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<{ scheduleId: string; message: string } | null>(null);

	const load = useCallback(async (projectId: string) => {
		setState({ kind: 'loading' });
		try {
			const payload = await fetchJson<{ schedules: ScheduleRow[] }>(
				`/api/projects/${encodeURIComponent(projectId)}/schedules`,
			);
			// Defensive: a payload without the schedules array is an empty list,
			// not a crash — the surrounding page keeps rendering.
			setState({ kind: 'ready', schedules: Array.isArray(payload.schedules) ? payload.schedules : [] });
		} catch (error) {
			const kind = (error as { kind?: string }).kind;
			if (kind === 'denied') setState({ kind: 'denied' });
			else
				setState({
					kind: 'error',
					message: (error as Error).message || 'The schedules could not be loaded.',
				});
		}
	}, []);

	useEffect(() => {
		if (props.projectId) void load(props.projectId);
		else setState({ kind: 'ready', schedules: [] });
	}, [props.projectId, load]);

	const act = async (scheduleId: string, action: 'run-now' | 'pause' | 'resume'): Promise<void> => {
		if (!props.projectId) return;
		setBusyId(scheduleId);
		setActionError(null);
		try {
			if (action === 'run-now') {
				await fetchJson(`/api/projects/${encodeURIComponent(props.projectId)}/schedules/${encodeURIComponent(scheduleId)}/run-now`, {
					method: 'POST',
				});
			} else {
				await fetchJson(`/api/projects/${encodeURIComponent(props.projectId)}/schedules/${encodeURIComponent(scheduleId)}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ paused: action === 'pause' }),
				});
			}
			await load(props.projectId);
		} catch (error) {
			// The row keeps its previous state; the panel reloads to server truth
			// AND the failure is named in-row — a refused action is never silent.
			setActionError({
				scheduleId,
				message: (error as Error).message || `The ${action.replace('-', ' ')} action failed.`,
			});
			if (props.projectId) await load(props.projectId);
		} finally {
			setBusyId(null);
		}
	};

	function askCaddie() {
		if (props.projectId) chrome.openProject(props.projectId, true);
	}

	const empty = (
		<TeachingEmpty
			testid="schedules-empty"
			icon="clock"
			title="No routines yet"
			detail="Scheduled checks Caddie runs on its own — a contest page watched, a reminder kept — without you asking. Ask for one in this project's chat, e.g. “check the contest page every morning and tell me what changed”, and it appears here to pause, resume or run early."
			action={{ label: 'Ask Caddie to set one up', onClick: askCaddie, testid: 'schedules-ask' }}
		/>
	);

	const lede = (
		<p className="page-lede">
			Checks Caddie runs on a schedule for this project — a contest page watched, a reminder kept —
			without you asking. Ask for one in the chat; manage it here.
		</p>
	);

	// Narrow once: `body` is built eagerly but only rendered in the ready branch
	// (loading/denied/error return earlier). TypeScript cannot narrow a const
	// across those guards — an empty list in every non-ready state is never shown.
	const schedules = state.kind === 'ready' ? state.schedules : [];

	const body = (
		<>
			{props.embedded ? null : lede}
			{schedules.length === 0 ? (
				empty
			) : (
				<div data-testid="schedules-list">
					{schedules.map((schedule) => {
						const words = cronToWords(schedule.cron);
						const next = formatTimeAgo(schedule.nextRunAt);
						return (
							<div className="schedule-row" key={schedule.id} data-testid="schedule-row" data-paused={schedule.paused}>
								<div className="row-main">
									<span className="row-title">{schedule.name}</span>
									<span className="row-status" data-status={schedule.paused ? 'paused' : 'active'}>
										{schedule.paused ? 'Paused' : 'On'}
									</span>
								</div>
								<span className="schedule-words">
									{words ?? schedule.cron}
									{schedule.timezone && schedule.timezone !== 'UTC' ? ` · ${schedule.timezone}` : ''}
								</span>
								<div className="row-main" data-testid={`schedule-next-${schedule.id}`}>
									<span className="schedule-next">{schedule.paused ? 'Paused — nothing scheduled' : `Next run ${next}`}</span>
									{schedule.lastResult ? <span className="schedule-last">Last: {schedule.lastResult}</span> : null}
								</div>
								<details className="schedule-devdetail">
									<summary className="kicker">For developers</summary>
									<span className="mono-id">
										{schedule.cron} · {schedule.timezone}
									</span>
									<span className="mono-id">
										{schedule.payload.sourceId
											? `watching source ${shortId(schedule.payload.sourceId)}`
											: schedule.payload.runId
												? `bound to run ${shortId(schedule.payload.runId)}`
												: 'notify only'}
									</span>
								</details>
								<div className="row-actions">
									<button
										type="button"
										className="btn-ghost"
										disabled={busyId === schedule.id}
										data-testid={`schedule-run-now-${schedule.id}`}
										onClick={() => void act(schedule.id, 'run-now')}
									>
										Run now
									</button>
									<button
										type="button"
										className="detail-toggle"
										disabled={busyId === schedule.id}
										data-testid={`schedule-toggle-${schedule.id}`}
										onClick={() => void act(schedule.id, schedule.paused ? 'resume' : 'pause')}
									>
										{schedule.paused ? 'Resume' : 'Pause'}
									</button>
								</div>
								{actionError && actionError.scheduleId === schedule.id ? (
									<div role="alert" className="row-error" data-testid={`schedule-error-${schedule.id}`}>
										<b>The action was refused.</b> {actionError.message}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			)}
		</>
	);

	if (props.embedded) {
		if (state.kind === 'denied') {
			return (
				<div data-testid="schedules-panel" className="state-detail">
					Your account isn't a member of this project's workspace, so its routines can't be shown.
				</div>
			);
		}
		if (state.kind === 'error') {
			return (
				<div data-testid="schedules-panel" role="alert" className="state-detail">
					The routines could not be loaded: {state.message}
				</div>
			);
		}
		if (state.kind === 'loading') {
			return (
				<div data-testid="schedules-panel" className="state-detail">
					Loading routines…
				</div>
			);
		}
		return (
			<div data-testid="schedules-panel" className="schedules-embedded">
				{body}
			</div>
		);
	}

	if (state.kind === 'denied') {
		return (
			<section className="state-panel card-surface" data-testid="schedules-panel">
				<p className="kicker">BUILD</p>
				<h3 className="state-title">Not your project</h3>
				<p className="state-detail">Your session has no membership in this project's workspace.</p>
			</section>
		);
	}
	if (state.kind === 'error') {
		return (
			<section className="state-panel card-surface" data-testid="schedules-panel">
				<p className="kicker">BUILD</p>
				<h3 className="state-title">Could not load schedules</h3>
				<p className="state-detail">{state.message}</p>
			</section>
		);
	}
	if (state.kind === 'loading') {
		return (
			<section className="state-panel card-surface" data-testid="schedules-panel">
				<p className="kicker">BUILD</p>
				<p className="state-detail">Loading routines…</p>
			</section>
		);
	}

	return (
		<section className="state-panel card-surface" data-testid="schedules-panel">
			<p className="kicker" data-tone="action">
				BUILD
			</p>
			<h3 className="state-title">Automation</h3>
			{body}
		</section>
	);
}
