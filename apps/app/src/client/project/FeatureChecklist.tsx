import { useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { parsePlanFeatures, WHOLE_PLAN_FEATURE, type BuildFeatureView } from '@caddie/contracts';
import { Icon } from '../icons.tsx';
import { postJson } from '../api.ts';
import { useBuildActivity } from '../queries.ts';

/**
 * The plan's feature list, as the person approving it reads it: what will be
 * built, in order, and how each one is checked. The same list is what the
 * host builds one feature at a time, so approving the plan approves this.
 * Plans without a list (approved before lists existed) render nothing.
 */
export function PlanFeatureList(props: { body: string }): ReactElement | null {
	const parsed = parsePlanFeatures(props.body);
	if (!parsed.ok) return null;
	return (
		<section className="plan-features" data-testid="plan-features" aria-label="What Caddie will build">
			<h4 className="plan-features-head">What Caddie will build · {parsed.features.length}</h4>
			<ol className="plan-features-list">
				{parsed.features.map((feature) => (
					<li key={feature.id} className="plan-feature" data-testid={`plan-feature-${feature.id}`}>
						<span className="plan-feature-title">{feature.title}</span>
						<ul className="plan-feature-checks" aria-label={`How “${feature.title}” is checked`}>
							{feature.doneWhen.map((check, i) => (
								<li key={i}>{check}</li>
							))}
						</ul>
					</li>
				))}
			</ol>
		</section>
	);
}

/** True when the build has a real feature list (not the one whole-plan fallback). */
export function hasFeatureList(features: readonly BuildFeatureView[]): boolean {
	return features.length > 1 || (features.length === 1 && features[0]!.id !== WHOLE_PLAN_FEATURE.id);
}

/**
 * The feature list for a finished or stopped build, where the save points are
 * actionable (rollback is refused while a build runs). Reads the same polled
 * activity query as the progress view.
 */
export function SavedFeatures(props: { actorId: string; projectId: string }): ReactElement | null {
	const activity = useBuildActivity({ actorId: props.actorId }, props.projectId);
	const features = activity.data?.features ?? [];
	if (!hasFeatureList(features)) return null;
	return <BuildFeatureList projectId={props.projectId} features={features} />;
}

/**
 * Where each feature stands while the app is built, with a save point to roll
 * back to on every finished feature that has later work after it. Rolling back
 * is two clicks: the first states exactly what will be undone.
 */
export function BuildFeatureList(props: { projectId: string; features: readonly BuildFeatureView[] }): ReactElement {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const done = props.features.filter((f) => f.status === 'passed').length;

	const rollBack = async (feature: BuildFeatureView) => {
		setBusy(true);
		setError(null);
		try {
			await postJson(`/api/projects/${encodeURIComponent(props.projectId)}/workflow/rollback`, {
				featureId: feature.id,
				key: `rollback:${feature.id}:${globalThis.crypto.randomUUID()}`,
			});
			setConfirming(null);
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ['build-activity'] }),
				queryClient.invalidateQueries({ queryKey: ['build-workflow'] }),
			]);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : 'The rollback did not go through.');
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="build-features" data-testid="build-features" aria-label="Features">
			<h4 className="build-features-head">
				Features · {done} of {props.features.length} done
			</h4>
			<ol className="build-features-list">
				{props.features.map((feature) => {
					const later = props.features.filter((f) => f.position > feature.position && f.status !== 'pending').length;
					return (
						<li key={feature.id} className="build-feature" data-status={feature.status} data-testid={`build-feature-${feature.id}`}>
							<span className="build-feature-mark" aria-hidden="true">
								<FeatureMark status={feature.status} />
							</span>
							<span className="build-feature-body">
								<span className="build-feature-title">
									{feature.position}. {feature.title}
								</span>
								<span className="build-feature-meta">{statusLine(feature)}</span>
							</span>
							{feature.canRollBack && confirming !== feature.id ? (
								<button
									type="button"
									className="btn-ghost build-feature-rollback"
									data-testid={`rollback-${feature.id}`}
									disabled={busy}
									onClick={() => setConfirming(feature.id)}
								>
									<Icon name="arrowLeft" title="" /> Roll back to here
								</button>
							) : null}
							{confirming === feature.id ? (
								<span className="build-feature-confirm" role="group" aria-label={`Roll back to after “${feature.title}”`}>
									<span className="build-feature-confirm-text">
										Undo everything after this? {later === 1 ? '1 later feature goes' : `${later} later features go`} back to the
										list and will be built again when you press Retry.
									</span>
									<button
										type="button"
										className="btn-key"
										data-testid={`rollback-confirm-${feature.id}`}
										disabled={busy}
										onClick={() => void rollBack(feature)}
									>
										{busy ? 'Rolling back…' : 'Roll back'}
									</button>
									<button type="button" className="btn-ghost" disabled={busy} onClick={() => setConfirming(null)}>
										Keep it
									</button>
								</span>
							) : null}
						</li>
					);
				})}
			</ol>
			{error ? (
				<p className="build-features-error" role="alert">
					{error}
				</p>
			) : null}
		</section>
	);
}

function FeatureMark({ status }: { status: BuildFeatureView['status'] }): ReactElement {
	if (status === 'passed') return <Icon name="check" title="done" />;
	if (status === 'failed') return <Icon name="alert" title="stuck" />;
	if (status === 'building') return <span className="build-stage-spinner" />;
	return <span className="build-stage-dot" />;
}

/** One plain line per feature: what happened, not internal state names. */
function statusLine(feature: BuildFeatureView): string {
	const tries = feature.attempts === 1 ? '1 failed try' : `${feature.attempts} failed tries`;
	switch (feature.status) {
		case 'passed':
			return feature.testsPassed !== null
				? `Done · ${feature.testsPassed} ${feature.testsPassed === 1 ? 'test' : 'tests'} passing`
				: 'Done';
		case 'building':
			return feature.attempts > 0 ? `Building now · ${tries}` : 'Building now';
		case 'failed':
			return `Stuck after ${tries}`;
		default:
			return 'Up next';
	}
}
