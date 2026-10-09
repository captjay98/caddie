import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { formatTimeAgo } from '@caddie/ui/time';
import { fetchJson } from '../api.ts';

/**
 * Schedules — minimal project-scoped list of P12 schedules (feature-ledger
 * C19): cron, timezone, computed next slot, pause state and last result, with
 * run-now and pause/unpause actions over the real P12 REST surface.
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

export function Schedules(props: { projectId: string | null }): ReactElement {
	const [state, setState] = useState<LoadState>({ kind: 'loading' });
	const [busyId, setBusyId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<{ scheduleId: string; message: string } | null>(null);

	const load = useCallback(async (projectId: string) => {
		setState({ kind: 'loading' });
		try {
			const payload = await fetchJson<{ schedules: ScheduleRow[] }>(
				`/api/projects/${encodeURIComponent(projectId)}/schedules`,
			);
			setState({ kind: 'ready', schedules: payload.schedules });
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
			<p className="state-detail">Loading schedules…</p>
		</section>
		);
	}

	return (
		<section className="state-panel card-surface" data-testid="schedules-panel">
			<p className="kicker" data-tone="action">
				BUILD
			</p>
			<h3 className="state-title">Automation</h3>
			<p className="page-lede">Checks Caddie runs on a schedule — contest feeds watched, reminders kept — without you asking.</p>
			{state.schedules.length === 0 ? (
				<p className="state-detail" data-testid="schedules-empty">
					No schedules in this project yet. When Caddie sets up a scheduled check, it appears here.
				</p>
			) : (
				<div data-testid="schedules-list">
					{state.schedules.map((schedule) => (
						<div className="inspector-row" key={schedule.id} data-testid="schedule-row" data-paused={schedule.paused}>
							<div className="row-main">
								<span className="row-title">{schedule.name}</span>
								<span className="row-status" data-status={schedule.paused ? 'paused' : 'active'}>
									{schedule.paused ? 'paused' : 'active'}
								</span>
							</div>
							<div className="row-main">
								<span className="mono-id">
									{schedule.cron} · {schedule.timezone}
								</span>
								<span className="mono-id" data-testid={`schedule-next-${schedule.id}`}>
									next {formatTimeAgo(schedule.nextRunAt)} · {schedule.nextRunAt}
								</span>
							</div>
							<div className="row-main">
								<span className="mono-id">
									{schedule.payload.sourceId
										? `watching source ${shortId(schedule.payload.sourceId)}`
										: schedule.payload.runId
											? `bound to run ${shortId(schedule.payload.runId)}`
											: 'notify only'}
								</span>
								{schedule.lastResult ? (
									<span className="mono-id">last: {schedule.lastResult}</span>
								) : null}
							</div>
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
									<span className="mono-id">
										run now dispatches one run — it appears in Runs with its own id and receipts
									</span>
								</div>
								{actionError && actionError.scheduleId === schedule.id ? (
									<div role="alert" className="row-error" data-testid={`schedule-error-${schedule.id}`}>
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
