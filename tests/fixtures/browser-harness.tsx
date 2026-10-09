// Direct file imports into the app package's react install: react is not
// hoisted to the repo-root node_modules, so bare specifiers cannot resolve
// from tests/ (bun build resolves relative to the importer, not the cwd).
import { createElement } from '../../apps/app/node_modules/react/index.js';
import { createRoot } from '../../apps/app/node_modules/react-dom/client.js';
import { ArtifactViewer } from '../../apps/app/src/client/artifacts/Viewer.tsx';
import { DesignReview } from '../../apps/app/src/client/planning/DesignReview.tsx';

/**
 * P07 browser-test harness (TEST-SIDE ONLY, never part of the app Worker or
 * the composed SPA): mounts the REAL ArtifactViewer and DesignReview
 * components with fixed props so tests/browser/artifacts.spec.ts can drive
 * them against network-stubbed /api routes.
 *
 * The .tsx extension keeps this file OUT of the root tsc program (whose
 * tests include-glob has no DOM lib and no react types on the tests/
 * resolution path) — the components themselves are typechecked by the app
 * program (`bun run typecheck`). The spec bundles this entry with
 * `bun build --target=browser` and fulfills the script through Playwright
 * route interception, so no built artifact is added to the SPA. A mistake
 * here surfaces as a loud browser-spec failure, never a silent pass.
 */

const NOW = '2026-10-05T12:00:00.000Z';

const REVISIONS = [
	{
		id: 'art-rev-3',
		kind: 'plan',
		planRevision: 3,
		sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
		size: 2048,
		contentType: 'text/markdown',
		filename: 'plan-r3.md',
		status: 'current' as const,
		createdAt: NOW,
	},
	{
		id: 'art-rev-2',
		kind: 'plan',
		planRevision: 2,
		sha256: 'ca3d1a4b26d9f2c3a35d26e5f9184cd2bd1e7dfb35e5e6f7a8b9c0d1e2f3a4b5',
		size: 1024,
		contentType: 'text/markdown',
		filename: 'plan-r2.md',
		status: 'stale' as const,
		createdAt: NOW,
	},
	{
		id: 'art-rev-1',
		kind: 'test-result',
		planRevision: 2,
		sha256: '185f8db32271fe25f561a6fc938b2e264306ec304eda518007d1764826381969',
		size: 64,
		contentType: 'text/plain',
		filename: 'results-r2.txt',
		status: 'current' as const,
		createdAt: NOW,
	},
];

const PLAN_REVISIONS = [
	{
		id: 'pdr-latest',
		revision: 2,
		bodyHash: 'sha256-abc123def456abc123def456abc12345',
		createdAt: NOW,
		body: 'Build a solar dashboard.\n\n- read the telemetry endpoint\n- render a live chart\n- keep a local cache\n\nEvidence: cl-team-1, cl-solar-1.',
	},
	{
		id: 'pdr-older',
		revision: 1,
		bodyHash: 'sha256-00011122233300011122233300011122',
		createdAt: NOW,
		body: 'Draft: solar dashboard, first cut.',
	},
];

const viewerRoot = createRoot(document.getElementById('viewer-root')!);
viewerRoot.render(
	createElement(ArtifactViewer, { projectId: 'proj-p7', revisions: REVISIONS }),
);

const reviewRoot = createRoot(document.getElementById('review-root')!);
reviewRoot.render(
	createElement(DesignReview, {
		projectId: 'proj-p7',
		planRevisions: PLAN_REVISIONS,
		policyVersion: 'v1',
	}),
);
