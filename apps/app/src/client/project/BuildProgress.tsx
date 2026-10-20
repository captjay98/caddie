import type { ReactElement } from 'react';
import { Icon } from '../icons.tsx';
import { BuildFeatureList, hasFeatureList } from './FeatureChecklist.tsx';
import {
	useBuildActivity,
	type BuildTimelineView,
	type TimelineStageView,
} from '../queries.ts';

/**
 * Build progress — a real window into what Caddie is doing while a project
 * builds, instead of one frozen "Caddie is building and checking your app"
 * sentence.
 *
 * Driven entirely by the server-derived `timeline` (build-timeline.ts), which
 * turns the live stream of specialist hand-offs, file writes and commands into
 * one plain sentence everyone reads + five stages with elapsed time, plus a
 * power-user drill-down (every file, every command, REAL test pass/fail
 * counts). Honesty rules live in the model: scope is never ticked off from
 * file writes, silence is reported as silence, and the preview only appears
 * once the workflow phase reaches `ready`.
 *
 * Accessibility: the plain summary is announced via aria-live; the spinner is
 * decorative (aria-hidden) and CSS honours prefers-reduced-motion.
 */
export function BuildProgress(props: {
	actorId: string | null;
	projectId: string;
	/** The most recent assistant line from the coordinator transcript, if any. */
	latest?: string | null;
}): ReactElement | null {
	const activity = useBuildActivity({ actorId: props.actorId }, props.projectId);
	const data = activity.data;
	// Nothing to show until a build is under way (or just finished/stuck mid-build).
	// A response without a timeline (an older server mid-deploy) shows nothing
	// rather than taking the whole page down with it.
	if (!data || !data.timeline || data.phase === 'planning' || data.phase === 'review') return null;

	const t = data.timeline;
	const files = t.files.slice(0, 4);
	const moreFiles = t.files.length - files.length;
	const commands = t.commands.slice(0, 3);

	return (
		<section className="build-progress" data-testid="build-progress" data-phase={data.phase}>
			<header className="build-head">
				<span className="build-head-row">
					<span className="build-head-dot" data-phase={data.phase} aria-hidden="true" />
					<span className="build-head-kicker">{phaseKicker(data.phase)}</span>
					<span className="build-head-timing" data-testid="build-timing">
						{t.elapsedMs !== null ? (
							<span>
								{data.phase === 'ready' ? 'built in' : 'elapsed'} <b>{formatDuration(t.elapsedMs)}</b>
							</span>
						) : null}
						{t.idleMs !== null ? (
							<span>
								{' · '}last activity <b>{formatDuration(t.idleMs)} ago</b>
							</span>
						) : null}
					</span>
				</span>
				<p className="build-summary" role="status" aria-live="polite" data-testid="build-summary" data-quiet={t.quiet ? 'true' : undefined}>
					{t.summary}
				</p>
			</header>

			<ol className="build-stages" aria-label="Build stages" data-testid="build-stages">
				{t.stages.map((stage) => (
					<li
						key={stage.key}
						className="build-stage"
						data-state={stage.state}
						data-testid={`build-stage-${stage.key}`}
					>
						<span className="build-stage-top">
							<span className="build-stage-mark" aria-hidden="true">
								<StageMark state={stage.state} />
							</span>
							<span className="build-stage-label">{stage.label}</span>
						</span>
						<span className="build-stage-detail">
							{stage.detail ?? (stage.durationMs !== null ? formatDuration(stage.durationMs) : '—')}
						</span>
						{stage.detail && stage.durationMs !== null && stage.state !== 'pending' ? (
							<span className="build-stage-dur">{durationPhrase(stage, data.phase)}</span>
						) : null}
					</li>
				))}
			</ol>

			{hasFeatureList(data.features ?? []) ? (
				<BuildFeatureList projectId={props.projectId} features={data.features} />
			) : t.scope.length > 0 ? (
				<div className="build-scope" data-testid="build-scope">
					<span className="build-scope-head">What&rsquo;s being built</span>
					<div className="build-scope-chips">
						{t.scope.map((item, i) => (
							<span key={i} className="build-scope-chip">
								{item}
							</span>
						))}
					</div>
				</div>
			) : null}

			{t.files.length > 0 || t.commands.length > 0 ? (
				<div className="build-detail" data-testid="build-detail">
					{t.files.length > 0 ? (
						<div className="build-detail-card" data-testid="build-files">
							<div className="build-detail-head">
								Files written · {t.files.length}
								<span className="build-detail-sub"> {fileAreaBreakdown(t.fileAreas)}</span>
							</div>
							<ul className="build-detail-list">
								{files.map((f) => (
									<li key={f.path} data-area={f.area}>
										<span className="build-detail-mono">{f.path}</span>
										<span className="build-detail-meta">
											{f.writes > 1 ? `×${f.writes} · ` : ''}
											{f.bytes !== null ? formatBytes(f.bytes) : ''}
										</span>
									</li>
								))}
								{moreFiles > 0 ? (
									<li className="build-detail-more">
										…{moreFiles} more
									</li>
								) : null}
							</ul>
						</div>
					) : null}
					{t.commands.length > 0 ? (
						<div className="build-detail-card" data-testid="build-commands">
							<div className="build-detail-head">Commands · newest first</div>
							<ul className="build-detail-list">
								{commands.map((cmd, i) => (
									<li key={i} data-outcome={cmd.outcome}>
										<span className="build-cmd-mark" aria-hidden="true">
											{cmd.outcome === 'ok' ? (
												<Icon name="check" title="succeeded" />
											) : cmd.outcome === 'cancelled' ? (
												'∅'
											) : (
												<Icon name="alert" title="failed" />
											)}
										</span>
										<span className="build-detail-mono">{cmd.command}</span>
										<span className="build-detail-meta">
											{cmd.exitCode !== null ? `exit ${cmd.exitCode} · ` : ''}
											{formatDuration(cmd.durationMs)}
										</span>
									</li>
								))}
							</ul>
						</div>
					) : null}
				</div>
			) : null}

			{props.latest ? (
				<div className="build-latest" data-testid="build-latest">
					<span className="build-latest-head">Latest from Caddie</span>
					<p className="build-latest-text">{props.latest}</p>
				</div>
			) : null}

			{data.rounds.length > 0 ? (
				<details className="build-history" data-testid="build-history">
					<summary>Check history · {data.rounds.length}</summary>
					<ul>
						{data.rounds.map((round, i) => (
							<li key={`${round.issue}-${i}`} data-outcome={round.outcome} data-testid="build-history-item">
								<span className="build-history-outcome" aria-hidden="true">
									{round.outcome === 'failed' ? <Icon name="alert" title="failed" /> : <Icon name="check" title="passed" />}
								</span>
								<span className="build-history-text">
									<b>{roundLabel(round.round)}</b>
									{round.detail && !/^\s*[{[]/.test(round.detail) ? <span className="build-history-detail"> — {round.detail}</span> : null}
								</span>
							</li>
						))}
					</ul>
				</details>
			) : null}
		</section>
	);
}

function StageMark({ state }: { state: TimelineStageView['state'] }): ReactElement {
	if (state === 'done') return <Icon name="check" title="done" />;
	if (state === 'failed') return <Icon name="alert" title="failed" />;
	if (state === 'active') return <span className="build-stage-spinner" />;
	return <span className="build-stage-dot" />;
}

/** Short uppercase kicker for the phase, paired with the status dot. */
function phaseKicker(phase: BuildTimelineView['phase']): string {
	switch (phase) {
		case 'ready':
			return 'Ready';
		case 'blocked':
			return 'Stopped';
		case 'building':
			return 'Building';
		default:
			return 'Build';
	}
}

/** The stage's window as a plain compact duration (it sits on its own muted line). */
function durationPhrase(stage: TimelineStageView, _phase: BuildTimelineView['phase']): string {
	return formatDuration(stage.durationMs ?? 0);
}

/** "14 app · 6 tests · 3 config" — only the non-zero areas, plural-aware. */
function fileAreaBreakdown(areas: BuildTimelineView['fileAreas']): string {
	const names: Record<keyof typeof areas, [string, string]> = {
		app: ['app', 'app'],
		test: ['test', 'tests'],
		style: ['style', 'styles'],
		config: ['config', 'config'],
		server: ['server', 'server'],
	};
	const parts = (Object.keys(areas) as (keyof typeof areas)[])
		.filter((k) => areas[k] > 0)
		.map((k) => `${areas[k]} ${areas[k] === 1 ? names[k][0] : names[k][1]}`);
	return parts.length ? `(${parts.join(' · ')})` : '';
}

/** "40 s", "4 min", "1 h 05 min" — the client mirror of the model's formatter. */
export function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** "700 B", "1.5 KB", "2.3 MB" — compact file sizes. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}

/** Plain words for a run_rounds `round` kind. */
function roundLabel(round: string): string {
	switch (round) {
		case 'repair_attempt':
			return 'Tried a fix';
		case 'verification':
			return 'Ran a check';
		case 'diagnosis':
			return 'Looked into a problem';
		case 'transport_retry':
			return 'Retried after a hiccup';
		case 'framework_recovery':
			return 'Recovered and continued';
		default:
			return round;
	}
}
