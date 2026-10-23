import type { ReactElement } from 'react';
import * as v from 'valibot';
import {
	ProjectExperienceSchema,
	type ModuleProgressItem,
	type ModuleProgressState,
	type SpendStop,
} from '@caddie/contracts';
import { useProjectExperience } from '../queries.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { Icon } from '../icons.tsx';

/**
 * Build progress for a BIG app (team mode, plan part P and section 7, screen 2):
 * its parts (modules) side by side, each with its state in the plain word the
 * person reads — waiting, building, joined, not joined or stopped. A big app
 * splits into parts built by several builders at once, so this replaces the
 * single server-and-screens view a small app shows.
 *
 * It also shows the spending-limit stop (part A): when a build stops because it
 * reached its limit, the limit message and what is saved.
 *
 * Self-fetched from the shared experience projection. It renders NOTHING for a
 * small app (no module board) — the small app shows its server and screens
 * parts through BuildProgress/FeatureChecklist instead.
 */
export function ModuleProgress(props: { projectId: string }): ReactElement | null {
	const chrome = useWorkspaceChrome();
	const experience = useProjectExperience({ actorId: chrome.actorId }, props.projectId);
	if (!experience.data) return null;
	const parsed = v.safeParse(ProjectExperienceSchema, experience.data);
	if (!parsed.success) return null;
	const modules = parsed.output.modules;
	const spendStop = parsed.output.spendStop;
	if ((!modules || modules.length === 0) && !spendStop) return null;
	return (
		<>
			{spendStop ? <SpendStopPanel stop={spendStop} /> : null}
			{modules && modules.length > 0 ? <ModuleBoard modules={modules} /> : null}
		</>
	);
}

/** The parts side by side (pure presentation, so it can be read from a prop). */
export function ModuleBoard(props: { modules: readonly ModuleProgressItem[] }): ReactElement {
	const joined = props.modules.filter((m) => m.state === 'joined').length;
	return (
		<section className="module-progress" data-testid="module-progress" aria-label="Your app's parts">
			<h4 className="module-progress-head">
				Your app’s parts · {joined} of {props.modules.length} joined
			</h4>
			<ol className="module-progress-list">
				{props.modules.map((module) => (
					<li
						key={module.id}
						className="module-progress-item"
						data-state={module.state}
						data-testid={`module-${module.id}`}
					>
						<span className="module-progress-mark" aria-hidden="true">
							<ModuleMark state={module.state} />
						</span>
						<span className="module-progress-body">
							<span className="module-progress-title">{module.plain}</span>
							<span className="module-progress-state" data-testid={`module-state-${module.id}`}>
								{stateLine(module)}
							</span>
						</span>
					</li>
				))}
			</ol>
		</section>
	);
}

/** The spending-limit stop panel (part A). */
export function SpendStopPanel(props: { stop: SpendStop }): ReactElement {
	return (
		<section className="spend-stop" data-testid="spend-stop" role="status">
			<span className="spend-stop-mark" aria-hidden="true">
				<Icon name="alert" title="" />
			</span>
			<div className="spend-stop-body">
				<p className="spend-stop-message" data-testid="spend-stop-message">
					{props.stop.message}
				</p>
				<p className="spend-stop-saved" data-testid="spend-stop-saved">
					{props.stop.saved}
				</p>
			</div>
		</section>
	);
}

function ModuleMark({ state }: { state: ModuleProgressState }): ReactElement {
	if (state === 'joined') return <Icon name="check" title="joined" />;
	if (state === 'building') return <span className="module-progress-spinner" />;
	if (state === 'not-joined' || state === 'stopped') return <Icon name="alert" title={state} />;
	return <span className="module-progress-dot" />;
}

/** One plain line per part — what is happening to it, never an internal word. */
function stateLine(module: ModuleProgressItem): string {
	switch (module.state) {
		case 'joined':
			return 'In your app';
		case 'building':
			return 'Building now';
		case 'not-joined':
			return 'Couldn’t be joined — the rest of your app still works';
		case 'stopped':
			return 'Stopped — the rest of your app still works';
		case 'waiting':
		default:
			return module.waitingFor && module.waitingFor.length > 0
				? `Waiting for ${joinPlain(module.waitingFor)}`
				: 'Waiting to start';
	}
}

/** "Farms and Feed" from a list of plain part names. */
function joinPlain(items: readonly string[]): string {
	if (items.length <= 1) return items.join('');
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
