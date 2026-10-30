import { useState, type ReactElement } from 'react';
import type { BuildFeatureView } from '@caddie/contracts';
import { Icon } from '../icons.tsx';
import type { BuildActivityView } from '../queries.ts';
import { browserChecksInRun, clockTime, partAttempts, type AttemptEntry, type PartAttempts } from './build-checks-model.ts';

/**
 * The Checks view (owner 2026-10-30): where the CURRENT part is in its loop
 * (write → its own tests → Caddie's browser checks, repeated until all pass),
 * every part's state, and the latest build check. Replaces a straight-line
 * stage list that read "Write the app: Done … Final checks: In progress"
 * while the build went back to writing.
 */
export function BuildChecksView({ data, now }: { data: BuildActivityView; now?: Date }): ReactElement {
	const t = data.timeline;
	const features = data.features ?? [];
	const parts = partAttempts(data);
	const current = features.find((feature) => feature.status === 'building') ?? (data.phase === 'blocked' ? features.find((feature) => feature.status === 'failed') : undefined);
	const part = current ? parts.find((entry) => entry.featureId === current.id) : undefined;
	const total = current ? browserChecksInRun(features, current.id) : null;
	const activeKey = t.stages.find((stage) => stage.state === 'active')?.key;
	const writing = activeKey === 'write' || activeKey === 'setup';
	const testing = activeKey === 'test' || activeKey === 'check';
	const done = features.filter((feature) => feature.status === 'passed').length;
	return (
		<div className="build-checks-view" data-testid="build-checks-view">
			{data.phase === 'building' || current ? (
				<section className="checks-now" aria-labelledby="checks-now-h">
					<p className="checks-kicker">
						{current ? `Now · part ${current.position} of ${features.length}` : 'Now'}
					</p>
					<h3 id="checks-now-h">{current ? plainTitle(current) : 'Building your app'}</h3>
					<ol className="build-loop" data-testid="build-stages" aria-label="How each part is built">
						<LoopStep
							label="Write the app"
							state={writing ? 'active' : 'idle'}
							detail={t.files.length ? `${t.files.length} file${t.files.length === 1 ? '' : 's'} so far` : 'Not started'}
						/>
						<LoopStep
							label="Run its own tests"
							state={testing ? 'active' : part?.latestOwn ? (part.latestOwn.passed === part.latestOwn.total ? 'ok' : 'failed') : t.tests ? (t.tests.failed ? 'failed' : 'ok') : 'idle'}
							detail={
								part?.latestOwn
									? `Last run: ${part.latestOwn.passed} of ${part.latestOwn.total} passed · ${clockTime(part.latestOwn.at, now)}`
									: t.tests
										? `Last run: ${t.tests.passed} of ${t.tests.passed + t.tests.failed} passed · ${clockTime(t.tests.at, now)}`
										: 'Not run yet'
							}
						/>
						<LoopStep
							label="Caddie’s browser checks"
							state={part?.latestBrowser ? (part.latestBrowser.failed ? 'failed' : 'ok') : 'idle'}
							detail={
								part?.latestBrowser
									? `Last run: ${part.latestBrowser.failed ? `${part.latestBrowser.failed}${total ? ` of ${total}` : ''} failed` : 'all passed'} · ${clockTime(part.latestBrowser.at, now)}`
									: 'Runs when the part is handed in'
							}
						/>
					</ol>
					<p className="build-loop-note">
						Caddie repeats these until every check passes, then moves to the next part.
						{part && part.browserRuns > 0 ? ` This part has been handed in ${part.browserRuns} time${part.browserRuns === 1 ? '' : 's'} so far.` : ''}
					</p>
					{part?.latestBrowser?.failing.length ? (
						<div className="checks-failing" data-testid="checks-failing">
							<p className="checks-failing-title">Still failing</p>
							<ul>
								{part.latestBrowser.failing.map((text) => (
									<li key={text}>“{text}”</li>
								))}
							</ul>
						</div>
					) : null}
				</section>
			) : null}
			{features.length ? (
				<section className="checks-parts" aria-labelledby="checks-parts-h">
					<h3 id="checks-parts-h">
						Parts · {done} of {features.length} done
					</h3>
					<ul>
						{[...features].sort((a, b) => a.position - b.position).map((feature) => {
							const rounds = parts.find((entry) => entry.featureId === feature.id);
							return (
								<li key={feature.id} data-status={feature.status}>
									<PartMark status={feature.status} />
									<span className="checks-part-title">{plainTitle(feature)}</span>
									<span className="checks-part-meta">{partMeta(feature, rounds, now)}</span>
								</li>
							);
						})}
					</ul>
				</section>
			) : null}
			{t.checks.length ? (
				<section className="checks-host" aria-labelledby="checks-host-h">
					<h3 id="checks-host-h">Latest build check · {clockTime(t.checks[0]!.at, now)}</h3>
					<ul className="build-check-results">
						{t.checks.map((check, index) => (
							<li key={`${check.name}-${index}`} data-outcome={check.passed ? 'passed' : 'failed'}>
								<PartMark status={check.passed ? 'passed' : 'failed'} />
								<span>{check.label}</span>
								<span className="checks-part-meta">{check.passed ? 'Passed' : 'Failed'} · {formatSeconds(check.durationMs)}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	);
}

/**
 * The Attempts view: every recorded round, grouped by part, newest part
 * first, each round in plain words with its own clock time, repeats folded,
 * and the full recorded text one tap away.
 */
export function BuildAttemptsView({ data, now }: { data: BuildActivityView; now?: Date }): ReactElement {
	const parts = partAttempts(data);
	return (
		<section className="build-history" data-testid="build-history" aria-labelledby="build-history-h">
			<h3 id="build-history-h">Attempts, by part</h3>
			<p className="state-detail">
				Each part loops: Caddie writes code, runs the app’s own tests, then hands it in for Caddie’s browser checks. Its own test runs are free; a failed hand-in uses one of the part’s fix tries.
			</p>
			{parts.map((part, index) => (
				<PartHistory key={part.featureId || 'whole'} part={part} open={index === 0} now={now} />
			))}
		</section>
	);
}

const ENTRY_LIMIT = 12;

function PartHistory({ part, open, now }: { part: PartAttempts; open: boolean; now?: Date }): ReactElement {
	const [all, setAll] = useState(false);
	const shown = all ? part.entries : part.entries.slice(0, ENTRY_LIMIT);
	return (
		<details className="attempt-part" open={open} data-testid="attempt-part">
			<summary>
				<PartMark status={part.status === 'unknown' ? 'pending' : part.status} />
				<span className="attempt-part-title">{part.title}</span>
				<span className="checks-part-meta">
					{statusWord(part.status)} · {count(part.browserRuns, 'hand-in', 'hand-ins')} · {count(part.ownRuns, 'own test run', 'own test runs')} · {clockTime(part.firstAt, now)}–{clockTime(part.lastAt, now)}
				</span>
			</summary>
			<ul>
				{shown.map((entry, index) => (
					<AttemptRow key={`${entry.at}-${index}`} entry={entry} now={now} />
				))}
			</ul>
			{part.entries.length > ENTRY_LIMIT ? (
				<button type="button" className="build-text-action" onClick={() => setAll((value) => !value)}>
					{all ? 'Show fewer' : `Show all ${part.entries.length}`}
				</button>
			) : null}
		</details>
	);
}

function AttemptRow({ entry, now }: { entry: AttemptEntry; now?: Date }): ReactElement {
	return (
		<li data-outcome={entry.outcome} data-kind={entry.kind} data-testid="build-history-item">
			<PartMark status={entry.outcome === 'passed' ? 'passed' : entry.outcome === 'failed' ? 'failed' : 'pending'} />
			<span className="build-history-text">
				<b>{entry.title}</b>
				{entry.summary ? <span className="build-history-summary"> — {entry.summary}</span> : null}
				{entry.repeats > 1 ? <span className="checks-part-meta"> ×{entry.repeats}</span> : null}
				{entry.failing.length ? (
					<ul className="attempt-failing">
						{entry.failing.map((text) => (
							<li key={text}>“{text}”</li>
						))}
					</ul>
				) : null}
				{entry.detail && (entry.raw || entry.detail.length > entry.summary.length + 40 || entry.failing.length) ? (
					<details>
						<summary>{entry.raw ? 'Exact recorded result' : 'What Caddie saw'}</summary>
						<pre className="build-history-detail">{entry.detail}</pre>
					</details>
				) : null}
			</span>
			<time className="build-recorded-at" dateTime={entry.at}>{clockTime(entry.at, now)}</time>
		</li>
	);
}

function LoopStep({ label, state, detail }: { label: string; state: 'active' | 'ok' | 'failed' | 'idle'; detail: string }): ReactElement {
	return (
		<li className="build-loop-step" data-state={state}>
			<span className="build-stage-mark" aria-hidden="true">
				{state === 'active' ? <span className="build-stage-spinner" /> : state === 'ok' ? <Icon name="check" title="" /> : state === 'failed' ? <Icon name="alert" title="" /> : <span className="build-stage-dot" />}
			</span>
			<span className="build-loop-label">{label}</span>
			<span className="build-loop-detail">
				{state === 'active' ? 'Working now · ' : ''}
				{detail}
			</span>
		</li>
	);
}

function PartMark({ status }: { status: BuildFeatureView['status'] }): ReactElement {
	return (
		<span className="build-stage-mark" aria-hidden="true">
			{status === 'passed' ? <Icon name="check" title="" /> : status === 'failed' ? <Icon name="alert" title="" /> : status === 'building' ? <span className="build-stage-spinner" /> : <span className="build-stage-dot" />}
		</span>
	);
}

function plainTitle(feature: Pick<BuildFeatureView, 'title'>): string {
	return feature.title.replace(/^\s*\d+[.)]\s*/, '');
}

function statusWord(status: PartAttempts['status']): string {
	switch (status) {
		case 'passed':
			return 'Done';
		case 'building':
			return 'Working on it';
		case 'failed':
			return 'Stopped here';
		case 'pending':
			return 'Waiting';
		default:
			return 'Recorded';
	}
}

function partMeta(feature: BuildFeatureView, rounds: PartAttempts | undefined, now?: Date): string {
	const handIns = rounds ? count(rounds.browserRuns, 'hand-in', 'hand-ins') : null;
	if (feature.status === 'passed') return [feature.passedAt ? `Passed ${clockTime(feature.passedAt, now)}` : 'Passed', handIns].filter(Boolean).join(' · ');
	if (feature.status === 'building') return ['Working on it', handIns].filter(Boolean).join(' · ');
	if (feature.status === 'failed') return ['Stopped here', handIns].filter(Boolean).join(' · ');
	return 'Waiting';
}

function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

function formatSeconds(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}
