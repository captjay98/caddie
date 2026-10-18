import { createElement } from '../../apps/app/node_modules/react/index.js';
import { createRoot } from '../../apps/app/node_modules/react-dom/client.js';
import { InteractivePreview } from '../../apps/app/src/client/artifacts/InteractivePreview.tsx';

const search = new URLSearchParams(location.search);
const backend = search.has('backend');
createRoot(document.getElementById('root')!).render(createElement(InteractivePreview, {
	projectId: search.get('project') ?? 'project-one',
	actorId: search.get('actor') ?? 'actor-one',
	artifactId: 'output-one',
	contentUrl: search.has('workflow') || backend ? '/api/projects/project-one/workflow/preview/output-one' : undefined,
	...(backend
		? {
				appRequestUrl: '/api/projects/project-one/workflow/preview/output-one/app',
				onResetData: async () => {
					await fetch('/api/projects/project-one/workflow/preview-data/reset', { method: 'POST' });
				},
			}
		: {}),
}));
