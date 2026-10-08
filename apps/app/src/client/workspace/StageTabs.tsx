import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';

/**
 * StageTabs — the sibling links inside one stage of the loop (product charter
 * §2, docs/reviews/2026-10-08-product-charter.md). Build carries Activity ·
 * Files · Automation; Prove carries Evidence · Judge review. Rendered on
 * every sibling page so a stage's surfaces are never orphaned: the nav row
 * enters the stage, the tab strip moves between its surfaces, and the
 * current one is marked aria-current.
 */

export type StageId = 'build' | 'prove';

const STAGE_TABS: Record<
	StageId,
	ReadonlyArray<{ id: string; label: string; to: string; testid: string }>
> = {
	build: [
		{ id: 'runs', label: 'Activity', to: '/runs', testid: 'stage-tab-activity' },
		{ id: 'artifacts', label: 'Files', to: '/artifacts', testid: 'stage-tab-files' },
		{ id: 'schedules', label: 'Automation', to: '/schedules', testid: 'stage-tab-automation' },
	],
	prove: [
		{ id: 'evidence', label: 'Evidence', to: '/evidence', testid: 'stage-tab-evidence' },
		{ id: 'judge', label: 'Judge review', to: '/judge', testid: 'stage-tab-judge' },
	],
};

export function StageTabs(props: { stage: StageId; current: string }): ReactElement {
	return (
		<nav className="stage-tabs" aria-label={`${props.stage} surfaces`}>
			{STAGE_TABS[props.stage].map((tab) => (
				<Link
					key={tab.id}
					to={tab.to}
					data-testid={tab.testid}
					aria-current={props.current === tab.id ? 'page' : undefined}
					search={(prev: Record<string, unknown>) => ({ ...prev })}
				>
					{tab.label}
				</Link>
			))}
		</nav>
	);
}
