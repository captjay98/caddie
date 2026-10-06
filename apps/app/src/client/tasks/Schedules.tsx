import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
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
		} catch {
			// The row keeps its previous state; the panel reloads to server truth.
			if (props.projectId) await load(props.projectId);
		} finally {
			setBusyId(null);
		}
	};

	if (state.kind === 'denied') {
		return (
			<section className="state-panel card-surface" data-testid="schedules-panel">
				<p className="kicker">SCHEDULES</p>
				<h3 className="state-title">Not your project</h3>
				<p className="state-detail">Your session has no membership in this project's workspace.</p>
			</section>
		);
	}
	if (state.kind === 'error') {
		return (
			<section className="state-panel card-surface" data-testid="schedules-panel">
				<p className="kicker">SCHEDULES</p>
				<h3 className="state-title">Could not load schedules</h3>
				<p className="state-detail">{state.message}</p>
			</section>
		);
	}
	if (state.kind === 'loading') {
		return (
			<section className="state-panel card-surface" data-testid="schedules-panel">
				<p className="kicker">SCHEDULES</p>
				<p className="state-detail">Loading schedules…</p>
			</section>
		);
	}

	return (
		<section className="state-panel card-surface" data-testid="schedules-panel">
			<p className="kicker">SCHEDULES</p>
			<h3 className="state-title">Scheduled checks</h3>
			{state.schedules.length === 0 ? (
				<p className="state-detail" data-testid="schedules-empty">
					No schedules in this project yet.
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
								<span className="mono-id">next {schedule.nextRunAt}</span>
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
									className="detail-toggle"
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
						</div>
					))}
				</div>
			)}
		</section>
	);
}
