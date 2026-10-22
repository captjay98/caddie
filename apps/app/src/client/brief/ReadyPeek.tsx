import type { ReactElement } from 'react';
import type { DecisionCard as DecisionCardType } from '@caddie/contracts';
import { InteractivePreview } from '../artifacts/InteractivePreview.tsx';
import { useOptionalWorkspaceChrome } from '../workspace/Chrome.tsx';

/**
 * The ready card's app peek (owner, 2026-10-22): a LIVE view of the card's own
 * checked preview, scaled down and inert, so the card shows the real app
 * instead of a mockup picture. "Try the app" opens it for real. Absent when the
 * card names no preview, or outside the signed-in workspace.
 */
export function ReadyPeek(props: { card: DecisionCardType }): ReactElement | null {
	const chrome = useOptionalWorkspaceChrome();
	const peek = props.card.peek;
	if (!peek?.previewId || !chrome?.actorId) return null;
	const base = `/api/projects/${encodeURIComponent(props.card.projectId)}/workflow/preview/${encodeURIComponent(peek.previewId)}`;
	return (
		<figure className="compact-card-peek" data-testid="card-peek" data-kind={peek.previewKind ?? 'web'}>
			<figcaption className="compact-card-peek-head">
				<span>{peek.appName}</span>
				<span>Live preview</span>
			</figcaption>
			{/* inert: no clicks, focus or reading order inside the mini view. */}
			<div className="compact-card-peek-viewport" inert>
				<div className="compact-card-peek-frame">
					<InteractivePreview
						peek
						actorId={chrome.actorId}
						projectId={props.card.projectId}
						artifactId={peek.previewId}
						contentUrl={base}
						{...(peek.previewKind === 'flutter' ? { kind: 'flutter' as const } : {})}
						{...(peek.previewHasServer ? { appRequestUrl: `${base}/app` } : {})}
					/>
				</div>
			</div>
		</figure>
	);
}
