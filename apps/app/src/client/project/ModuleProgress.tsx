import * as v from 'valibot';
import { useState, type ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
	ProjectExperienceSchema,
	type ModuleProgressItem,
	type ModuleProgressState,
	type SpendStop,
} from '@caddie/contracts';
import { useProjectExperience } from '../queries.ts';
import { postJson } from '../api.ts';
import { useWorkspaceChrome } from '../workspace/Chrome.tsx';
import { Icon } from '../icons.tsx';

/**
 * Build progress for a BIG app (team mode, plan part P and section 7, screen 2):
 * its parts (modules) side by side, each with its state in the plain word the
 * person reads — waiting, building, built (joining next), joined, not joined
 * or stopped. A big app
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
export function ModuleProgress(props: { projectId: string; missingOnly?: boolean }): ReactElement | null {
	const chrome = useWorkspaceChrome();
	const client = useQueryClient();
	const experience = useProjectExperience({ actorId: chrome.actorId }, props.projectId);
	const [failed, setFailed] = useState<string | null>(null);
	const retry = useMutation({
		mutationFn: (moduleId: string) =>
			postJson(`/api/projects/${encodeURIComponent(props.projectId)}/workflow/parts/${encodeURIComponent(moduleId)}/retry`, {
				key: `part-retry:${moduleId}:${Date.now().toString(36)}`,
			}),
		onMutate: () => setFailed(null),
		onError: (_error, moduleId) => setFailed(moduleId),
		onSettled: async () => {
			await client.invalidateQueries({ queryKey: ['experience', chrome.actorId ?? 'pending', props.projectId] });
		},
	});
	if (!experience.data) return null;
	const parsed = v.safeParse(ProjectExperienceSchema, experience.data);
	if (!parsed.success) return null;
	const modules = parsed.output.modules;
	const spendStop = parsed.output.spendStop;
	if ((!modules || modules.length === 0) && !spendStop) return null;
	// The ready card shows the board only for an app finished without some parts.
	if (props.missingOnly && !(modules ?? []).some((m) => m.state !== 'joined')) return null;
	return (
		<>
			{spendStop && !props.missingOnly ? <SpendStopPanel stop={spendStop} /> : null}
			{modules && modules.length > 0 ? (
				<ModuleBoard
					modules={modules}
					onRetry={(moduleId) => retry.mutate(moduleId)}
					retrying={retry.isPending ? (retry.variables ?? null) : null}
					failed={failed}
				/>
			) : null}
		</>
	);
}

/** The parts side by side (pure presentation, so it can be read from a prop). */
export function ModuleBoard(props: {
	modules: readonly ModuleProgressItem[];
	/** Try again on a part that stopped or couldn't be joined (its item says canRetry). */
	onRetry?: (moduleId: string) => void;
	/** The part whose Try again is in flight. */
	retrying?: string | null;
	/** The part whose Try again just failed. */
	failed?: string | null;
}): ReactElement {
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
							{props.failed === module.id ? (
								<span className="module-progress-error" role="alert">
									Couldn’t start it again. Try once more in a moment.
								</span>
							) : null}
						</span>
						{module.canRetry && props.onRetry ? (
							<button
								type="button"
								className="btn-ghost module-progress-retry"
								data-testid={`module-retry-${module.id}`}
								aria-label={`Try ${module.plain} again`}
								disabled={props.retrying === module.id}
								onClick={() => props.onRetry?.(module.id)}
							>
								{props.retrying === module.id ? 'Starting…' : 'Try again'}
							</button>
						) : null}
					</li>
				))}
			</ol>
		</section>
	);
}

/** The spending-limit stop (part A): only what the blocker sentence leaves out — what retrying does. */
export function SpendStopPanel(props: { stop: SpendStop }): ReactElement {
	return (
		<p className="spend-stop" data-testid="spend-stop">
			{props.stop.note}
		</p>
	);
}

function ModuleMark({ state }: { state: ModuleProgressState }): ReactElement {
	if (state === 'joined' || state === 'built') return <Icon name="check" title={state === 'joined' ? 'joined' : 'built'} />;
	if (state === 'building') return <span className="module-progress-spinner" />;
	if (state === 'not-joined' || state === 'stopped') return <Icon name="alert" title={state} />;
	return <span className="module-progress-dot" />;
}

/** One plain line per part — what is happening to it, never an internal word. */
function stateLine(module: ModuleProgressItem): string {
	switch (module.state) {
		case 'joined':
			return 'In your app';
		case 'built':
			return 'Built · joining your app next';
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
