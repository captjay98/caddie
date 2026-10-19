import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type { ImportPreviewView } from '../../server/import-preview.ts';
import { postJson } from '../api.ts';
import { InteractivePreview } from '../artifacts/InteractivePreview.tsx';
import { Icon } from '../icons.tsx';

/** The heading the card shows for the copied app, by status. */
export function importedAppTitle(preview: ImportPreviewView): string {
	if (preview.origin === 'example') return 'An example app to try';
	if (preview.status === 'ready') return 'Your app from GitHub';
	if (preview.status === 'failed') return 'Your code is copied';
	return 'Getting your app ready to try';
}

/**
 * "Start from my GitHub repo": the copied app, right after the copy. While
 * Caddie builds it the section keeps the build moving (one request at a time,
 * each may run for minutes); once ready it is an ordinary preview to try.
 * Shown until the first build has a preview of its own.
 */
export function ImportedApp(props: {
	actorId: string;
	projectId: string;
	preview: ImportPreviewView;
	/** Re-read the card after each step. */
	onChange: () => void;
	/** Inside a card that already has a heading (planning), the section names itself. */
	titled?: boolean;
}): ReactElement {
	const { preview, projectId } = props;
	const onChange = useRef(props.onChange);
	onChange.current = props.onChange;
	const base = `/api/projects/${encodeURIComponent(projectId)}`;

	useEffect(() => {
		if (preview.status !== 'checking') return;
		let stopped = false;
		void (async () => {
			while (!stopped) {
				try {
					const result = await postJson<{ importPreview: ImportPreviewView }>(`${base}/import-preview/check`, {});
					if (!stopped) onChange.current();
					if (result.importPreview.status !== 'checking') return;
				} catch {
					// The next pass tries again; Caddie's background job also finishes it.
				}
				await new Promise((resolve) => setTimeout(resolve, 3000));
			}
		})();
		return () => {
			stopped = true;
		};
	}, [preview.status, base]);

	return (
		<div className="imported-app" data-testid="imported-app" data-status={preview.status} {...(props.titled ? { 'data-titled': '' } : {})}>
			{props.titled ? (
				<div className="imported-app-head">
					<Icon name={preview.origin === 'example' ? 'box' : 'github'} title="" />
					<h4>{importedAppTitle(preview)}</h4>
				</div>
			) : null}
			{preview.status === 'checking' ? (
				<p role="status" className="state-detail" data-testid="imported-app-checking">
					Caddie is building the app copied from <b>{preview.repoFullName}</b> so you can try it here.
				</p>
			) : null}
			{preview.status === 'failed' ? (
				<p className="state-detail" data-testid="imported-app-failed">
					{preview.message}
				</p>
			) : null}
			{preview.status === 'ready' && preview.outputId ? (
				<>
					<p className="state-detail" data-testid="imported-app-ready">
						{preview.origin === 'example' ? (
							<>
								Caddie built <b>{preview.repoFullName}</b>. Try it, then tell Caddie what you&rsquo;d like to change, and it builds on
								this code.
							</>
						) : (
							<>
								This is <b>{preview.repoFullName}</b> as Caddie copied it (version {preview.versionSeq}). Try it, then tell
								Caddie what you&rsquo;d like to change.
							</>
						)}
					</p>
					<InteractivePreview
						actorId={props.actorId}
						projectId={projectId}
						artifactId={preview.outputId}
						contentUrl={`${base}/workflow/preview/${encodeURIComponent(preview.outputId)}`}
						{...(preview.hasServer
							? {
									appRequestUrl: `${base}/workflow/preview/${encodeURIComponent(preview.outputId)}/app`,
									onResetData: async () => {
										await postJson(`${base}/workflow/preview-data/reset`, {});
									},
								}
							: {})}
					/>
				</>
			) : null}
		</div>
	);
}
