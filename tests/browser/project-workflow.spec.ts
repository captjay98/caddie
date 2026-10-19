import { expect, test, type BrowserContext, type Route } from '@playwright/test';

/** Real composed SPA + real Flue SDK HTTP requests; auth, workflows, model
 * transcript and generated HTML are SIMULATED at their network boundaries.
 * This suite proves UI/admission/ack behavior, not live model or sandbox success.
 * Run after `bun run build` so ProjectWorkflow is in the composed client. */
const BASE = 'http://127.0.0.1:4173';
const NOW = '2026-10-11T10:00:00.000Z';
const OFFSET = '0000000000000000_0000000000000001';
const HOME = { id: 'home-workflow', workspaceId: 'ws-workflow', name: 'Home', description: null, status: 'active', kind: 'home', createdAt: NOW, updatedAt: NOW };
const PROJECT = { ...HOME, id: 'proj-workflow', name: 'Todoer', description: 'A modern minimal todo app', kind: 'standard' };
const binding = (projectId: string, conversationId: string) => ({ runId: `run-${projectId}`, projectId, conversationId, submissionId: `sub-${projectId}`, planRevision: 'rev-1', stackId: 'react-hono', payerId: 'actor-workflow', modelRouteId: 'nemotron-3-super', pricingVersion: 'v1', createdBy: 'actor-workflow', createdAt: NOW });
const plan = (revision: number) => ({ id: `plan-${revision}`, projectId: PROJECT.id, kind: 'prd', revision, bodyHash: `sha256-plan-${revision}`, body: `# Minimal Todo app\n\n## What you can do\n\n- Add tasks\n- Complete and delete tasks\n- Save tasks in your browser${revision > 1 ? '\n- Filter active and completed tasks' : ''}`, createdBy: 'actor-workflow', createdAt: NOW });
const TODO = `<!doctype html><html><head><title>Todoer</title></head><body><h1>Todoer</h1><form><input aria-label="New task"><button>Add task</button></form><ul></ul><script>
var todos = JSON.parse(localStorage.getItem('todos') || '[]');
function render() { document.querySelector('ul').replaceChildren(...todos.map(function(task) { var li = document.createElement('li'); li.textContent = task; return li; })); }
document.querySelector('form').addEventListener('submit', function(event) { event.preventDefault(); todos.push(document.querySelector('input').value); localStorage.setItem('todos', JSON.stringify(todos)); document.querySelector('input').value = ''; render(); }); render();
</script></body></html>`;

type Phase = 'planning' | 'review' | 'design' | 'design-review' | 'building' | 'blocked' | 'ready';
interface Admission { conversationId: string; body: Record<string, unknown> }
function json(route: Route, status: number, value: unknown) { return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) }); }

async function fixture(context: BrowserContext, options: { phase?: Phase; pending?: boolean; failAdmission?: number; failPreview?: number; repeatHandoff?: boolean; planBody?: string; features?: Record<string, unknown>[]; approved?: boolean; designBody?: string; github?: boolean; keys?: boolean; publish?: boolean; versions?: number; ai?: { calls: number; usedPercent: number; limitReached: boolean }; inbox?: Array<{ to: string; code: string; createdAt: string }>; imported?: { status: 'checking' | 'ready' | 'failed'; noWorkflow?: boolean; checksUntilReady?: number; message?: string; example?: boolean } } = {}) {
	let currentPlan = options.planBody ? { ...plan(1), body: options.planBody } : plan(1);
	let features = options.features ?? [];
	const rollbacks: Record<string, unknown>[] = [];
	let failedAdmissions = options.failAdmission ?? 0;
	let failedPreviews = options.failPreview ?? 0;
	const workflow = {
		projectId: PROJECT.id, runId: 'run-project-workflow', conversationId: 'conv-project-workflow', sourceConversationId: 'conv-home-workflow',
		brief: 'Build a modern beautiful minimal todo app.', phase: options.phase ?? 'review' as Phase, planId: currentPlan.id,
		previewId: options.phase === 'ready' ? 'output-workflow' : null as string | null,
		pendingKey: options.pending ? 'intake:workflow-key' : null as string | null,
		pendingBody: options.pending ? 'Prepare the original todo app request.' : null as string | null,
		detail: null as string | null, updatedAt: NOW,
	};
	const decisions: Record<string, unknown>[] = [];
	const admissions: Admission[] = [];
	const acks: Record<string, unknown>[] = [];
  const stops: string[] = [];
	let previewReads = 0;
	// "Start from my GitHub repo": the copied app's preview, in the server's shape.
	const imported = options.imported
		? {
				status: options.imported.status,
				versionSeq: 1,
				origin: options.imported.example ? 'example' : 'github',
				repoFullName: options.imported.example ? 'Farm Log' : 'octo-farm/farm-log',
				outputId: options.imported.status === 'ready' ? 'output-imported' : (null as string | null),
				hasServer: false,
				message: options.imported.message ?? null,
			}
		: null;
	const importChecks: string[] = [];
	const design = options.designBody
		? { id: 'design-1', projectId: PROJECT.id, kind: 'design', revision: 2, bodyHash: 'sha256-design-1', body: options.designBody, createdBy: 'actor-workflow', createdAt: NOW }
		: null;
	const snapshot = () => ({ workflow: options.imported?.noWorkflow ? null : { ...workflow }, plan: currentPlan, approval: options.approved ? { id: 'apr-workflow', status: 'approved' } : null, design, designApproval: null, ...(options.keys || options.inbox ? { previewHasServer: true } : {}), importPreview: imported });
	// App keys for a backend app: names and status only, exactly like the server.
	const keys = {
		list: [
			{ name: 'WEATHER_API_KEY', status: 'requested', description: 'Lets the app read the forecast from OpenWeather.', helpUrl: 'https://home.openweathermap.org/api_keys', requested: true, createdAt: NOW, updatedAt: NOW },
		] as Array<Record<string, unknown>>,
		writes: [] as Array<{ method: string; name: string; body: unknown }>,
	};
	const keysRoute = (route: Route, method: string, path: string): Promise<void> | null => {
		if (!options.keys || !/\/keys(\/|$)/.test(path)) return null;
		const name = decodeURIComponent(path.split('/keys/')[1] ?? '');
		if (method === 'GET' && !name) return json(route, 200, { configured: true, keys: keys.list });
		if (method === 'PUT' && name) {
			const body = route.request().postDataJSON() as { value?: string };
			keys.writes.push({ method, name, body });
			if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) return json(route, 400, { error: 'invalid_input', message: 'A key name uses capital letters, digits and underscores, like WEATHER_API_KEY.' });
			const existing = keys.list.find((k) => k.name === name);
			const key = { ...(existing ?? { name, description: null, helpUrl: null, requested: false, createdAt: NOW }), status: 'set', updatedAt: NOW };
			keys.list = existing ? keys.list.map((k) => (k.name === name ? key : k)) : [...keys.list, key];
			return json(route, 200, { key });
		}
		if (method === 'DELETE' && name) {
			keys.writes.push({ method, name, body: null });
			const existing = keys.list.find((k) => k.name === name);
			if (!existing) return json(route, 404, { error: 'key_not_found', message: 'This app has no key with that name.' });
			if (existing.requested) {
				const back = { ...existing, status: 'requested' };
				keys.list = keys.list.map((k) => (k.name === name ? back : k));
				return json(route, 200, { key: back });
			}
			keys.list = keys.list.filter((k) => k.name !== name);
			return json(route, 200, { key: null });
		}
		return json(route, 405, { error: 'method_not_allowed' });
	};
	// Publishing: the server's status shape; publish only after the exact intent was approved.
	const intentFor = (n: number) => ({ projectId: PROJECT.id, action: 'deploy-production', resourceId: `app:${PROJECT.id}`, revisionHash: `sha-manifest#${n}`, policyVersion: 'publish/2026-10-18' });
	const publish = {
		calls: [] as string[],
		approvals: [] as unknown[],
		deployments: 1,
		/** Status reads a publish stays "being checked" for (0 = the check passes at once). */
		checkPolls: 0,
		pendingSlug: null as string | null,
		status: {
			available: true, reason: null as string | null, appsDomain: 'caddieapps.test', publication: null as Record<string, unknown> | null,
			pendingCheck: null as { startedAt: string } | null,
			current: { outputId: 'output-workflow', publishable: true, upToDate: false, intent: intentFor(1), destructive: [] },
			suggestedSlug: 'todoer', missingKeys: [] as string[], runs: [] as unknown[], versions: [] as unknown[],
		},
	};
	const goLive = (slug: string, outputId: string) => {
		publish.deployments += 1;
		publish.status.pendingCheck = null;
		publish.status.publication = { slug, url: `https://${slug}.caddieapps.test/`, status: 'live', outputId, publishedAt: NOW, hasServer: false, blockedReason: null };
		publish.status.current = { ...publish.status.current, upToDate: true, intent: intentFor(publish.deployments) };
		publish.status.runs = [{ id: 'pub-1', kind: 'publish', status: 'succeeded', error: null, steps: [], startedAt: NOW }];
		publish.status.versions = [{ outputId, publishedAt: NOW, live: true, intent: intentFor(publish.deployments) }];
	};
	// Versions: every checked build; Restore makes an earlier one current as a NEW version.
	const commit = (n: number) => n.toString(16).padStart(40, 'a');
	const versionTitles = ['Add tasks', 'Add tasks, Complete and delete tasks', 'Add tasks, Complete and delete tasks, Save tasks in your browser'];
	const versions = {
		restores: [] as Array<{ commitId: string; key: string }>,
		list: Array.from({ length: options.versions ?? 0 }, (_, i) => ({
			commitId: commit(i + 1), seq: i + 1, kind: 'build', title: versionTitles[i] ?? `Build ${i + 1}`, createdAt: NOW, current: i + 1 === (options.versions ?? 0), restorable: i + 1 !== (options.versions ?? 0),
		})).reverse() as Array<Record<string, unknown>>,
	};
	const versionsRoute = (route: Route, method: string, path: string): Promise<void> | null => {
		if (!options.versions || !/\/versions(\/|$)/.test(path)) return null;
		if (method === 'GET' && path.endsWith('/versions')) return json(route, 200, { versions: versions.list, blockedReason: null });
		const match = path.match(/\/versions\/([0-9a-f]{40})\/restore$/);
		if (method === 'POST' && match) {
			const body = route.request().postDataJSON() as { key: string };
			versions.restores.push({ commitId: match[1]!, key: body.key });
			const target = versions.list.find((v) => v.commitId === match[1]);
			if (!target) return json(route, 404, { error: 'version_not_found', message: 'No such version.' });
			const seq = versions.list.length + 1;
			versions.list = [
				{ commitId: commit(seq), seq, kind: 'restore', title: `Restored version ${target.seq}`, createdAt: NOW, current: true, restorable: false },
				...versions.list.map((v) => ({ ...v, current: false, restorable: true })),
			];
			workflow.detail = `Restored version ${target.seq}. You're trying it below. Publish it to put it on the web.`;
			return json(route, 200, { restored: true, ...snapshot() });
		}
		return json(route, 405, { error: 'method_not_allowed' });
	};
	const publishRoute = (route: Route, method: string, path: string): Promise<void> | null => {
		if (!options.publish) return null;
		const request = route.request();
		if (path === '/api/approvals' && method === 'POST') {
			publish.calls.push('approval');
			publish.approvals.push(request.postDataJSON());
			return json(route, 200, { approval: { id: `apr-${publish.approvals.length}`, status: 'approved' } });
		}
		if (!path.endsWith('/publish') && !path.includes('/publish/')) return null;
		if (method === 'GET') {
			if (publish.status.pendingCheck && publish.pendingSlug && --publish.checkPolls <= 0) goLive(publish.pendingSlug, 'output-workflow');
			return json(route, 200, publish.status);
		}
		const approved = (intent: unknown) => publish.approvals.some((a) => JSON.stringify((a as { intent: unknown }).intent) === JSON.stringify(intent));
		if (path.endsWith('/publish')) {
			publish.calls.push('publish');
			if (!approved(publish.status.current.intent)) return json(route, 403, { error: 'STALE_APPROVAL', message: 'no approved record covers this exact intent' });
			const body = request.postDataJSON() as { outputId: string; slug?: string };
			const slug = (publish.status.publication?.slug as string | undefined) ?? body.slug ?? 'todoer';
			if (publish.checkPolls > 0) {
				publish.pendingSlug = slug;
				publish.status.pendingCheck = { startedAt: NOW };
				publish.status.runs = [{ id: 'pub-1', kind: 'publish', status: 'running', error: null, steps: [], startedAt: NOW }];
				return json(route, 200, publish.status);
			}
			goLive(slug, body.outputId);
			return json(route, 200, publish.status);
		}
		if (path.endsWith('/publish/unpublish')) {
			publish.calls.push('unpublish');
			publish.status.publication = { ...publish.status.publication!, status: 'paused' };
			publish.status.current = { ...publish.status.current, upToDate: false };
			publish.status.versions = (publish.status.versions as Record<string, unknown>[]).map((v) => ({ ...v, live: false }));
			return json(route, 200, publish.status);
		}
		return json(route, 405, { error: 'method_not_allowed' });
	};
	// "Save the code to GitHub": a linked repo, the server-side save, and the
	// merge that only runs once an approval for the exact head commit exists.
	const repo = { projectId: PROJECT.id, installationId: '6100001', repoFullName: 'octo/todoer', visibility: 'private', origin: 'connected', htmlUrl: 'https://github.com/octo/todoer' };
	const HEAD = 'abc1234def5678abc1234def5678abc1234def56';
	const mergeIntent = { projectId: PROJECT.id, action: 'merge-default-branch', resourceId: 'octo/todoer#12', revisionHash: HEAD, policyVersion: 'policies/2026-10-05' };
	const github = {
		calls: [] as string[],
		saves: [] as Record<string, unknown>[],
		approvals: [] as Record<string, unknown>[],
		merges: [] as Record<string, unknown>[],
		status: { save: null, pullRequest: null, pullRequestError: null, mergeIntent: null } as Record<string, unknown>,
	};
	const githubRoute = (route: Route, method: string, path: string): Promise<void> | null => {
		if (!options.github) return null;
		const request = route.request();
		if (path.endsWith('/github/repo')) return json(route, 200, { repo });
		if (path.endsWith('/github/source') && method === 'GET') return json(route, 200, github.status);
		if (path.endsWith('/github/source') && method === 'POST') {
			github.calls.push('source');
			github.saves.push(request.postDataJSON() as Record<string, unknown>);
			const save = {
				outputId: 'output-workflow', repoFullName: repo.repoFullName, headBranch: 'caddie/source-0123456789ab', pullRequestNumber: 12,
				htmlUrl: 'https://github.com/octo/todoer/pull/12', fileCount: 5, deleted: [], createdAt: NOW,
				skipped: [{ path: 'node_modules/', reason: 'dependencies' }, { path: 'dist/', reason: 'build-output' }, { path: '.env', reason: 'secret' }, { path: '.DS_Store', reason: 'noise' }],
			};
			github.status = { save, pullRequest: { number: 12, state: 'open', mergeable: true, headSha: HEAD, baseBranch: 'main', htmlUrl: save.htmlUrl }, pullRequestError: null, mergeIntent };
			return json(route, 201, { save, reconciled: false });
		}
		if (path === '/api/approvals' && method === 'POST') {
			github.calls.push('approval');
			github.approvals.push(request.postDataJSON() as Record<string, unknown>);
			return json(route, 200, { approval: { status: 'approved' } });
		}
		if (path.endsWith('/github/pulls/12/merge')) {
			github.calls.push('merge');
			github.merges.push(request.postDataJSON() as Record<string, unknown>);
			const approved = github.approvals.some((a) => JSON.stringify(a['intent']) === JSON.stringify(mergeIntent) && a['decision'] === 'approved');
			if (!approved) return json(route, 403, { error: 'STALE_APPROVAL', message: 'no approved record covers this exact intent', intent: mergeIntent });
			github.status = { ...github.status, pullRequest: { ...(github.status['pullRequest'] as object), state: 'merged' }, mergeIntent: null };
			return json(route, 200, { pullRequest: { merged: true, mergeCommitSha: 'm1', baseBranch: 'main' }, reconciled: false });
		}
		return null;
	};
	await context.route('**/api/**', async route => {
		const request = route.request(), path = new URL(request.url()).pathname;
		const githubReply = githubRoute(route, request.method(), path);
		if (githubReply) return githubReply;
		const keysReply = keysRoute(route, request.method(), path);
		if (keysReply) return keysReply;
		const publishReply = publishRoute(route, request.method(), path);
		if (publishReply) return publishReply;
		const versionsReply = versionsRoute(route, request.method(), path);
		if (versionsReply) return versionsReply;
		if (options.ai && path.endsWith('/ai-usage')) return json(route, 200, { available: true, month: '2026-10', renewsOn: '2026-11-01', ...options.ai });
		if (path.endsWith('/workflow/test-inbox')) return json(route, 200, { messages: options.inbox ?? [] });
		if (path === '/api/auth/status') return json(route, 200, { authenticated: true });
		if (path === '/api/onboarding') return json(route, 200, { completedAt: NOW });
		if (path === '/api/auth/get-session') return json(route, 200, { session: { userId: 'actor-workflow' }, user: { id: 'actor-workflow', name: 'Ada', email: 'ada@example.test' } });
		if (path === '/api/home-project') return json(route, 200, { project: HOME });
		if (path === '/api/profile') return json(route, 200, { profile: null });
		if (path === '/api/projects') return json(route, 200, { projects: [HOME, PROJECT] });
		if (path === '/api/brief') return json(route, 200, { cards: [], unseenCount: 0, projects: [HOME, PROJECT], asOf: NOW });
		if (path.endsWith('/brief/read')) return json(route, 200, { marked: 0 });
		if (path === '/api/usage') return json(route, 200, { payer: { payerId: 'actor-workflow', limitMinorUnits: 50000, currency: 'USD' }, totals: { reservedMinorUnits: 0, settledMinorUnits: 0, reservations: 0 } });
		if (path.endsWith('/workflow/rollback')) {
			const body = request.postDataJSON() as Record<string, unknown>;
			rollbacks.push(body);
			const target = features.find((f) => f.id === body.featureId) as { position: number; title: string } | undefined;
			features = features.map((f) => (Number(f.position) > (target?.position ?? 0)
				? { ...f, status: 'pending', testsPassed: null, passedAt: null, canRollBack: false }
				: { ...f, canRollBack: false }));
			workflow.phase = 'blocked'; workflow.previewId = null;
			workflow.detail = `Rolled back to just after “${target?.title}”. The app's files are exactly as they were when it passed; 1 later feature will be built again when you press Retry.`;
			return json(route, 200, snapshot());
		}
		if (path.endsWith('/activity')) return json(route, 200, {
			projectId: PROJECT.id, phase: workflow.phase, building: workflow.phase === 'building', steps: [], rounds: [], openIssues: 0, features,
			timeline: { phase: workflow.phase, startedAt: NOW, lastActivityAt: NOW, elapsedMs: 60_000, idleMs: 5_000, quiet: false, summary: 'Caddie is writing the app.', stages: [], scope: [], files: [], fileAreas: { app: 0, test: 0, style: 0, config: 0, server: 0 }, commands: [], tests: null, checks: [] },
		});
		if (path.endsWith('/workflow/stop')) {
      stops.push(path); workflow.phase = 'blocked'; workflow.pendingKey = null; workflow.pendingBody = null;
      workflow.detail = 'Stop requested. Your plan and files are retained.';
      return json(route, 200, snapshot());
    }
    if (path.endsWith('/workflow/design-decision')) {
			const body = request.postDataJSON() as Record<string, unknown>;
			decisions.push(body);
			workflow.phase = body.decision === 'approved' ? 'building' : 'design';
			return json(route, 200, snapshot());
		}
    if (path.endsWith('/workflow/decision')) {
			const body = request.postDataJSON() as Record<string, unknown>;
			decisions.push(body);
			if (body.planId !== currentPlan.id) return json(route, 409, { error: 'STALE_PLAN', message: 'The plan changed. Review the latest version.' });
			workflow.phase = body.decision === 'approved' ? 'building' : 'planning';
			// R02: the SERVER delivers the pending message to the coordinator DO and
			// acks it inside this route — so the response carries no pending slot and
			// the browser performs no admission/ack of its own.
			workflow.pendingKey = null;
			workflow.pendingBody = null;
			return json(route, 200, snapshot());
		}
		if (path.endsWith('/workflow/ack')) {
			const body = request.postDataJSON() as Record<string, unknown>;
			acks.push(body);
			if (body.key === workflow.pendingKey) { workflow.pendingKey = null; workflow.pendingBody = null; }
			return json(route, 200, { acknowledged: true });
		}
		if (path.endsWith('/import-preview/check') && request.method() === 'POST') {
			importChecks.push(path);
			if (imported && imported.status === 'checking' && importChecks.length >= (options.imported?.checksUntilReady ?? 1)) {
				imported.status = 'ready';
				imported.outputId = 'output-imported';
			}
			return json(route, 200, { importPreview: imported });
		}
		if (path.includes('/workflow/preview/')) {
			previewReads++;
			if (failedPreviews-- > 0) return json(route, 403, { error: 'preview_denied' });
			return route.fulfill({ contentType: 'text/html', body: TODO });
		}
		if (path.endsWith('/workflow')) return json(route, 200, path.includes(HOME.id) ? { workflow: null, plan: null, approval: null } : snapshot());
		if (path.endsWith('/run-bindings')) return json(route, 200, { runBindings: [path.includes(HOME.id) ? binding(HOME.id, 'conv-home-workflow') : binding(PROJECT.id, workflow.conversationId)] });
		if (path.endsWith('/brief')) return json(route, 200, { cards: [] });
		if (path.endsWith('/plan-docs')) return json(route, 200, { revisions: [currentPlan], latest: currentPlan });
		if (path.endsWith('/plan-decisions')) return json(route, 200, { decisions: [] });
		if (path.endsWith('/tasks')) return json(route, 200, { tasks: [] });
		if (path.endsWith('/previews')) return json(route, 200, { previews: [] });
		if (path.endsWith('/artifact-revisions')) return json(route, 200, { artifacts: [], latest: null });
		return json(route, 200, {});
	});
	await context.route('**/agents/coordinator/**', async route => {
		const request = route.request(), url = new URL(request.url());
		const conversationId = url.pathname.split('/').pop()!;
    if (request.method() === 'POST' && url.pathname.endsWith('/abort')) {
      stops.push(url.pathname); return json(route, 200, { aborted: true });
    }
		if (request.method() === 'POST') {
			admissions.push({ conversationId, body: request.postDataJSON() as Record<string, unknown> });
			if (failedAdmissions-- > 0) return json(route, 503, { error: { code: 'test_connection', message: 'Simulated connection failure' } });
			return json(route, 202, { streamUrl: `${BASE}${url.pathname}`, offset: OFFSET, submissionId: 'sub-admitted', uid: 'uid-workflow' });
		}
		if (url.searchParams.get('view') === 'updates') {
			return route.fulfill({ contentType: 'text/event-stream', body: `event: control\ndata: {"streamNextOffset":"${OFFSET}","upToDate":true}\n\n` });
		}
		const messages = conversationId === 'conv-home-workflow' ? [{ id: 'message-created-project', role: 'assistant', purpose: 'assistant', display: 'visible', timestamp: NOW, parts: [
			{ type: 'text', text: 'I created Todoer for your request. Review its plan here.', state: 'done' },
			{ type: 'data-projectWorkflow', data: { projectId: PROJECT.id, name: PROJECT.name } },
		] }] : [];
		return route.fulfill({ contentType: 'application/json', headers: { 'stream-next-offset': OFFSET, 'stream-up-to-date': 'true' }, body: JSON.stringify({ v: 1, conversationId, offset: OFFSET, messages: options.repeatHandoff ? [...messages, ...messages.map(m => ({...m, id: m.id + '-continued'}))] : messages, settlements: [] }) });
	});
	return {
		workflow, decisions, admissions, acks, stops, rollbacks, github, keys, publish, versions, imported, importChecks,
		get previewReads() { return previewReads; },
		revise() { currentPlan = plan(currentPlan.revision + 1); workflow.planId = currentPlan.id; workflow.phase = 'review'; workflow.pendingKey = null; workflow.pendingBody = null; },
		ready() { workflow.phase = 'ready'; workflow.previewId = 'output-workflow'; workflow.pendingKey = null; workflow.pendingBody = null; },
	};
}

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); });

const FEATURE_PLAN = [
	'# Farm log', '', 'Log feed and see it on a dashboard.', '',
	'```caddie-features',
	JSON.stringify([
		{ id: 'log-feed', title: 'Log daily feed', doneWhen: ['Saving 12 kg shows 12 kg in today’s list', 'The entry is still there after a reload'] },
		{ id: 'view-dashboard', title: 'See the feed dashboard', doneWhen: ['The dashboard totals this week’s feed'] },
	]),
	'```',
].join('\n');
const featureView = (id: string, title: string, position: number, extra: Record<string, unknown> = {}) =>
	({ id, title, doneWhen: ['check'], position, status: 'passed', attempts: 0, testsPassed: position, passedAt: NOW, canRollBack: false, ...extra });

const mockScreen = (heading: string, inner: string) =>
	`<main style="display:grid;gap:12px;padding:16px;max-width:880px;margin:0 auto"><h1 style="margin:0;font-size:20px">${heading}</h1>${inner}</main>`;
const DESIGN_BRIEF = [
	'# Farm log design', '', '## Screen inventory', '', '- Today (home) · History · Add entry', '',
	'```html-mock Today',
	mockScreen('Today', '<section style="background:var(--color-panel);color:var(--color-bright);border:1px solid var(--color-line);border-radius:12px;padding:12px">Morning feed · 12 kg</section><button style="background:var(--color-action);color:var(--color-ink);border:0;border-radius:9px;padding:10px 14px">Log feed</button>'),
	'```', '',
	'```html-mock Today · empty',
	mockScreen('Today', '<p style="color:var(--color-muted)">Nothing logged yet</p><script>document.body.dataset.ran = "yes"</script>'),
	'```', '',
	'```html-mock Add entry · error',
	mockScreen('Add entry', '<p role="alert" style="color:var(--color-danger)">Enter the weight as a number, like 12.</p>'),
	'```', '', '## Accessibility', '', 'Every control is reachable by keyboard.',
].join('\n');

test('design review shows each mocked screen at phone and desktop width, script-free, then approves the build', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'design-review', approved: true, designBody: DESIGN_BRIEF });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'design-review');
	await expect(card.getByRole('heading', { name: 'Your design is ready' })).toBeVisible();
	// The prose renders without the raw mock fences.
	await expect(card.getByTestId('workflow-design-brief').getByRole('heading', { name: 'Accessibility' })).toBeVisible();
	await expect(card).not.toContainText('html-mock');

	const preview = card.getByTestId('design-mock-preview');
	await expect(preview.getByTestId('design-mock-screens').getByRole('button')).toHaveText(['Today', 'Today · empty', 'Add entry · error']);
	const iframe = preview.getByTestId('design-mock-frame').locator('iframe');
	// The frame runs no scripts: empty sandbox + a script-forbidding CSP.
	await expect(iframe).toHaveAttribute('sandbox', '');
	await expect(iframe).toHaveAttribute('srcdoc', /script-src 'none'/);
	const frame = preview.getByTestId('design-mock-frame').frameLocator('iframe');
	await expect(frame.getByText('Morning feed · 12 kg')).toBeVisible();
	await expect(frame.getByRole('button', { name: 'Log feed' })).toBeVisible();
	// The mock paints with the app's REAL tokens (Caddie dark: action #4d9fff on page #090b10).
	await expect(frame.getByRole('button', { name: 'Log feed' })).toHaveCSS('background-color', 'rgb(77, 159, 255)');
	await expect(frame.locator('body')).toHaveCSS('background-color', 'rgb(9, 11, 16)');
	if (process.env.DESIGN_MOCK_SHOTS) await preview.screenshot({ path: `${process.env.DESIGN_MOCK_SHOTS}/design-mock-desktop-phone.png` });

	// Phone is the default: the mock lays out at 390px.
	await expect(preview).toHaveAttribute('data-device', 'phone');
	await expect(iframe).toHaveCSS('width', '390px');

	// Switching screens swaps the frame; a script inside a mock never runs.
	await preview.getByTestId('design-mock-screen-1').click();
	await expect(preview.getByTestId('design-mock-screen-1')).toHaveAttribute('aria-pressed', 'true');
	await expect(frame.getByText('Nothing logged yet')).toBeVisible();
	await expect(frame.locator('body')).not.toHaveAttribute('data-ran', 'yes');
	await preview.getByTestId('design-mock-screen-2').click();
	await expect(frame.getByRole('alert')).toHaveText('Enter the weight as a number, like 12.');

	// Desktop lays out at 1280px and scales down to fit the card.
	await preview.getByTestId('design-mock-desktop').click();
	await expect(preview).toHaveAttribute('data-device', 'desktop');
	await expect(iframe).toHaveCSS('width', '1280px');
	await expect(iframe).toHaveAttribute('style', /scale\(0\.\d+\)/);
	const cardBox = await card.boundingBox();
	await expect.poll(async () => (await preview.getByTestId('design-mock-frame').boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(cardBox?.width ?? 0);
	if (process.env.DESIGN_MOCK_SHOTS) await preview.screenshot({ path: `${process.env.DESIGN_MOCK_SHOTS}/design-mock-desktop-desktop.png` });

	// "View full size" opens a modal dialog where the desktop layout reads at 1:1.
	await preview.getByTestId('design-mock-full').click();
	const dialog = page.getByTestId('design-mock-dialog');
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('design-mock-full-desktop')).toHaveAttribute('aria-pressed', 'true');
	const fullIframe = dialog.locator('iframe');
	await expect(fullIframe).toHaveCSS('width', '1280px');
	await expect(fullIframe).not.toHaveAttribute('style', /scale\(/);
	await expect(dialog.frameLocator('iframe').getByRole('alert')).toHaveText('Enter the weight as a number, like 12.');
	if (process.env.DESIGN_MOCK_SHOTS) await page.screenshot({ path: `${process.env.DESIGN_MOCK_SHOTS}/design-mock-full-size.png` });
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();

	// On a phone-sized screen the phone mock still fits without overflow.
	await page.setViewportSize({ width: 390, height: 844 });
	await preview.getByTestId('design-mock-phone').click();
	await preview.getByTestId('design-mock-screen-0').click();
	await expect.poll(async () => {
		const narrow = await preview.getByTestId('design-mock-frame').boundingBox();
		return narrow && narrow.x >= 0 ? narrow.x + narrow.width : Infinity;
	}).toBeLessThanOrEqual(390);
	await expect(frame.getByText('Morning feed · 12 kg')).toBeVisible();
	if (process.env.DESIGN_MOCK_SHOTS) await card.screenshot({ path: `${process.env.DESIGN_MOCK_SHOTS}/design-mock-mobile.png` });

	await card.getByTestId('workflow-approve-design').click();
	await expect(card).toHaveAttribute('data-phase', 'building');
	expect(state.decisions).toEqual([{ designId: 'design-1', decision: 'approved' }]);
});

test('the plan review lists what will be built as a checklist, never as raw JSON', async ({ page, context }) => {
	await fixture(context, { planBody: FEATURE_PLAN });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'review');
	const list = card.getByTestId('plan-features');
	await expect(list.getByRole('heading', { name: 'What Caddie will build · 2' })).toBeVisible();
	await expect(list.locator('.plan-feature-title')).toHaveText(['Log daily feed', 'See the feed dashboard']);
	await expect(card.getByTestId('plan-feature-log-feed').locator('li')).toHaveText(['Saving 12 kg shows 12 kg in today’s list', 'The entry is still there after a reload']);
	await expect(card).not.toContainText('caddie-features');
	await expect(card).not.toContainText('"doneWhen"');
});

test('a finished build shows each feature and rolls back to a save point in two clicks', async ({ page, context }) => {
	const state = await fixture(context, {
		phase: 'ready',
		approved: true,
		planBody: FEATURE_PLAN,
		features: [
			featureView('log-feed', 'Log daily feed', 1, { canRollBack: true }),
			featureView('view-dashboard', 'See the feed dashboard', 2),
		],
	});
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	const features = card.getByTestId('build-features');
	await expect(features.getByRole('heading', { name: 'Features · 2 of 2 done' })).toBeVisible();
	await expect(card.getByTestId('build-feature-log-feed')).toContainText('Done · 1 test passing');
	await expect(card.getByTestId('rollback-view-dashboard')).toHaveCount(0);
	await card.getByTestId('rollback-log-feed').click();
	// The first click only explains what will be undone; nothing is sent yet.
	await expect(card.getByTestId('build-feature-log-feed')).toContainText('Undo everything after this? 1 later feature goes back to the list');
	expect(state.rollbacks).toHaveLength(0);
	await card.getByTestId('rollback-confirm-log-feed').click();
	await expect(card).toHaveAttribute('data-phase', 'blocked');
	expect(state.rollbacks).toHaveLength(1);
	expect(state.rollbacks[0]?.featureId).toBe('log-feed');
	expect(String(state.rollbacks[0]?.key)).toMatch(/^rollback:log-feed:[0-9a-f-]{36}$/);
	await expect(card).toContainText('Rolled back to just after “Log daily feed”');
	await expect(card.getByRole('button', { name: 'Retry build' })).toBeVisible();
	await expect(card.getByTestId('build-feature-view-dashboard')).toHaveAttribute('data-status', 'pending');
});

test('Home chat shows a readable project plan; approval admits the correct build and acknowledges its durable key', async ({ page, context }) => {
	const state = await fixture(context);
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveCount(1);
	await expect(card).toHaveAttribute('data-phase', 'review');
	await expect(card.getByRole('heading', { name: 'Minimal Todo app' })).toBeVisible();
	await expect(card.locator('li')).toHaveText(['Add tasks', 'Complete and delete tasks', 'Save tasks in your browser']);
	await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'general');
	await card.getByRole('button', { name: 'Looks good — build it' }).click();
	await expect(card).toHaveAttribute('data-phase', 'building');
	expect(state.decisions).toEqual([{ planId: 'plan-1', decision: 'approved' }]);
	// R02: dispatch is server-owned. The browser makes NO coordinator admission
	// and NO ack of its own — the decision route delivered + acked server-side.
	expect(state.admissions).toHaveLength(0);
	expect(state.acks).toHaveLength(0);
	await expect(page).toHaveURL(`${BASE}/app/`);
	await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'general');
	await page.reload();
	await expect(page.getByTestId('channel').getByTestId('project-workflow')).toHaveAttribute('data-phase', 'building');
	expect(state.admissions).toHaveLength(0);
});

test('feedback requires text, continues planning in the target conversation and returns a new readable revision after reload', async ({ page, context }) => {
	const state = await fixture(context);
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await card.getByRole('button', { name: 'Suggest a change' }).click();
	await expect(card.getByRole('button', { name: 'Send feedback' })).toBeDisabled();
	await card.getByLabel('What should change?').fill('Please include active and completed filters.');
	await card.getByRole('button', { name: 'Send feedback' }).click();
	await expect(card).toHaveAttribute('data-phase', 'planning');
	expect(state.decisions).toEqual([{ planId: 'plan-1', decision: 'rejected', note: 'Please include active and completed filters.' }]);
	// R02: the server delivers the revise message to the coordinator; the browser
	// makes no admission of its own.
	expect(state.admissions).toHaveLength(0);
	state.revise();
	await page.reload();
	await expect(page.getByTestId('channel').getByTestId('project-workflow')).toHaveAttribute('data-phase', 'review');
	await expect(page.getByTestId('channel').getByTestId('project-workflow').locator('li')).toContainText(['Filter active and completed tasks']);
	await page.getByTestId('channel').getByTestId('project-workflow').getByRole('button', { name: 'Looks good — build it' }).click();
	await expect(page.getByTestId('channel').getByTestId('project-workflow')).toHaveAttribute('data-phase', 'building');
	expect(state.decisions[1]).toEqual({ planId: 'plan-2', decision: 'approved' });
	expect(state.admissions).toHaveLength(0);
});

test('R02: a pending planning project is server-owned — the browser makes no admission and shows no client-dispatch error', async ({ page, context }) => {
	// Pre-R02 the browser drove dispatch on a pending slot and could error; R02
	// moved that to the server, so the tab only OBSERVES. A planning project
	// with a pending slot must not trigger a browser coordinator admission and
	// must not surface a "could not continue" client error.
	const state = await fixture(context, { phase: 'planning', pending: true });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'planning');
	// No client-driven dispatch: no admission, no ack, no continuation error.
	expect(state.admissions).toHaveLength(0);
	expect(state.acks).toHaveLength(0);
	await expect(card.getByRole('alert')).toHaveCount(0);
});

test('ready app remains inside Home chat, has access-error retry, and persists generated todos across reload', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'ready', failPreview: 1 });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	await expect(card.getByRole('alert')).toContainText('You do not have access');
	await card.getByRole('button', { name: 'Try again' }).click();
	const preview = card.frameLocator('iframe');
	await preview.getByRole('textbox', { name: 'New task' }).fill('Review real Caddie journey');
	await preview.getByRole('button', { name: 'Add task' }).click();
	await expect(preview.getByRole('listitem')).toHaveText('Review real Caddie journey');
	await expect.poll(() => page.evaluate("localStorage.getItem('caddie:preview:actor-workflow:proj-workflow')")).toContain('Review real Caddie journey');
	await page.reload();
	await expect(page.getByTestId('channel').getByTestId('project-workflow').frameLocator('iframe').getByRole('listitem')).toHaveText('Review real Caddie journey');
	await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'general');
	expect(state.admissions).toHaveLength(0);
	expect(state.previewReads).toBe(3);
});

test('a finished build saves its code as a pull request and merges it only after an explicit approval', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'ready', github: true });
	// Evidence only: CADDIE_SHOTS=<dir> saves each panel state; CADDIE_SHOTS_MOBILE=1 runs at 390px.
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	const panel = card.getByTestId('save-github');
	const shot = async (name: string) => {
		const dir = process.env.CADDIE_SHOTS;
		if (!dir) return;
		// Centre it first: a bottom-edge scroll leaves it under the fixed composer on mobile.
		await panel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await panel.screenshot({ path: `${dir}/save-github-${mobile ? 'mobile-' : ''}${name}.png` });
	};
	await expect(panel).toContainText('Nothing changes in the repo until you merge it.');
	await shot('1-save');
	await panel.getByTestId('save-github-save').click();
	const saved = panel.getByTestId('save-github-pr');
	await expect(saved).toContainText('Saved as pull request #12 on octo/todoer');
	await expect(saved.getByRole('link', { name: 'pull request #12' })).toHaveAttribute('href', 'https://github.com/octo/todoer/pull/12');
	await expect(panel).toContainText('5 files · left out node_modules/, dist/, .env');
	expect(state.github.saves).toEqual([{ outputId: 'output-workflow' }]);
	await shot('2-open');

	// Opening the confirmation records nothing; Cancel leaves no trace.
	await panel.getByTestId('save-github-merge').click();
	const confirm = panel.getByRole('group', { name: 'Merge pull request #12' });
	await expect(confirm).toContainText('Caddie merges exactly commit abc1234');
	await expect(confirm).toContainText('can’t be undone from Caddie');
	await shot('3-confirm');
	await confirm.getByRole('button', { name: 'Cancel' }).click();
	await expect(confirm).toHaveCount(0);
	expect(state.github.calls).toEqual(['source']);

	// Only the explicit click approves the exact head commit, and the merge follows it.
	await panel.getByTestId('save-github-merge').click();
	await panel.getByTestId('save-github-merge-confirm').click();
	await expect(panel.getByTestId('save-github-merged')).toContainText('Merged into main');
	await shot('4-merged');
	expect(state.github.calls).toEqual(['source', 'approval', 'merge']);
	expect(state.github.approvals).toEqual([{
		intent: { projectId: 'proj-workflow', action: 'merge-default-branch', resourceId: 'octo/todoer#12', revisionHash: 'abc1234def5678abc1234def5678abc1234def56', policyVersion: 'policies/2026-10-05' },
		decision: 'approved',
	}]);
	expect(state.github.merges).toEqual([{ repoFullName: 'octo/todoer', headSha: 'abc1234def5678abc1234def5678abc1234def56' }]);
});

test('an app with a server lists the keys it needs; a key is pasted once and never shown again', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'ready', keys: true });
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	const panel = card.getByTestId('app-keys');
	const shot = async (name: string) => {
		const dir = process.env.CADDIE_SHOTS;
		if (!dir) return;
		await panel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await panel.screenshot({ path: `${dir}/app-keys-${mobile ? 'mobile-' : ''}${name}.png` });
	};

	// The builder's request, in plain words, with where to get it.
	const weather = panel.getByTestId('app-key-WEATHER_API_KEY');
	await expect(panel.getByTestId('app-keys-needed')).toHaveText('1 needed');
	await expect(weather).toHaveAttribute('data-status', 'requested');
	await expect(weather).toContainText('Lets the app read the forecast from OpenWeather.');
	await expect(weather.getByRole('link', { name: 'Where to get it (home.openweathermap.org)' })).toHaveAttribute('href', 'https://home.openweathermap.org/api_keys');
	await shot('1-needed');

	// Paste once: a password field, then only "Saved" ever comes back.
	await weather.getByTestId('app-key-edit-WEATHER_API_KEY').click();
	const input = weather.getByTestId('app-key-input-WEATHER_API_KEY');
	await expect(input).toHaveAttribute('type', 'password');
	await input.fill('ow_live_not_a_real_key');
	await shot('2-paste');
	await weather.getByTestId('app-key-save-WEATHER_API_KEY').click();
	await expect(weather).toHaveAttribute('data-status', 'set');
	await expect(weather).toContainText('Saved');
	await expect(panel.getByTestId('app-keys-needed')).toHaveCount(0);
	await expect(page.getByText('ow_live_not_a_real_key')).toHaveCount(0);
	expect(state.keys.writes).toEqual([{ method: 'PUT', name: 'WEATHER_API_KEY', body: { value: 'ow_live_not_a_real_key' } }]);
	await shot('3-saved');

	// The owner's own key: the name is shaped as they type.
	await panel.getByTestId('app-keys-add').click();
	await panel.getByTestId('app-keys-new-name').fill('maps key');
	await expect(panel.getByTestId('app-keys-new-name')).toHaveValue('MAPS_KEY');
	await panel.getByTestId('app-keys-new-value').fill('maps-123');
	await panel.getByTestId('app-keys-new-save').click();
	await expect(panel.getByTestId('app-key-MAPS_KEY')).toHaveAttribute('data-status', 'set');

	// Removing asks first; a requested key goes back to needed, an own key disappears.
	await weather.getByTestId('app-key-remove-WEATHER_API_KEY').click();
	await expect(weather.getByRole('group', { name: 'Remove WEATHER_API_KEY' })).toContainText('The app will ask for it again.');
	await weather.getByTestId('app-key-remove-confirm-WEATHER_API_KEY').click();
	await expect(weather).toHaveAttribute('data-status', 'requested');
	await panel.getByTestId('app-key-remove-MAPS_KEY').click();
	await panel.getByTestId('app-key-remove-confirm-MAPS_KEY').click();
	await expect(panel.getByTestId('app-key-MAPS_KEY')).toHaveCount(0);
	expect(state.keys.writes.map((w) => `${w.method} ${w.name}`)).toEqual(['PUT WEATHER_API_KEY', 'PUT MAPS_KEY', 'DELETE WEATHER_API_KEY', 'DELETE MAPS_KEY']);
});

test('Publish puts the checked app on the web in one click, then unpublishes it on request', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'ready', publish: true });
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	const panel = card.getByTestId('publish-app');
	const shot = async (name: string) => {
		const dir = process.env.CADDIE_SHOTS;
		if (!dir) return;
		await panel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await panel.screenshot({ path: `${dir}/publish-${mobile ? 'mobile-' : ''}${name}.png` });
	};

	// Before: the address it will get, editable, and one button.
	await expect(panel).toHaveAttribute('data-state', 'unpublished');
	await expect(panel.getByTestId('publish-address')).toContainText('todoer.caddieapps.test');
	await shot('1-ready');
	await panel.getByTestId('publish-slug-change').click();
	await panel.getByTestId('publish-slug-input').fill('Todo Board');
	await expect(panel.getByTestId('publish-slug-input')).toHaveValue('todo-board');
	await panel.getByRole('button', { name: 'Use this address' }).click();
	await expect(panel.getByTestId('publish-address')).toContainText('todo-board.caddieapps.test');

	// One click = the recorded approval for exactly this version, then the publish.
	await panel.getByTestId('publish-go').click();
	await expect(panel).toHaveAttribute('data-state', 'live');
	const live = panel.getByTestId('publish-live');
	await expect(live.getByRole('link', { name: 'todo-board.caddieapps.test' })).toHaveAttribute('href', 'https://todo-board.caddieapps.test/');
	expect(state.publish.calls).toEqual(['approval', 'publish']);
	expect(state.publish.approvals).toEqual([
		{ intent: { projectId: 'proj-workflow', action: 'deploy-production', resourceId: 'app:proj-workflow', revisionHash: 'sha-manifest#1', policyVersion: 'publish/2026-10-18' }, decision: 'approved' },
	]);
	await expect(panel.getByTestId('publish-go')).toHaveCount(0); // nothing newer to publish
	await shot('2-live');

	// Unpublish asks first and keeps the data.
	await panel.getByTestId('publish-unpublish').click();
	const confirm = panel.getByRole('group', { name: 'Confirm unpublishing' });
	await expect(confirm).toContainText('Its data is kept');
	await shot('3-confirm-unpublish');
	await confirm.getByRole('button', { name: 'Keep it live' }).click();
	expect(state.publish.calls).toEqual(['approval', 'publish']);
	await panel.getByTestId('publish-unpublish').click();
	await panel.getByTestId('publish-unpublish-confirm').click();
	await expect(panel).toHaveAttribute('data-state', 'paused');
	await expect(panel.getByTestId('publish-paused')).toContainText('publish again to bring it back at todo-board.caddieapps.test');
	await expect(panel.getByTestId('publish-go')).toHaveText('Publish again');
	expect(state.publish.calls).toEqual(['approval', 'publish', 'unpublish']);
});

test('a new version waits for the safety check, then goes live on its own', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'ready', publish: true });
	state.publish.checkPolls = 2;
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const panel = page.getByTestId('channel').getByTestId('project-workflow').getByTestId('publish-app');
	await panel.getByTestId('publish-go').click();
	const checking = panel.getByTestId('publish-checking');
	await expect(checking).toContainText('Caddie is checking the new version for safety before visitors see it.');
	await expect(panel.getByTestId('publish-go')).toHaveCount(0);
	await expect(panel.getByTestId('publish-slug-change')).toHaveCount(0);
	const dir = process.env.CADDIE_SHOTS;
	if (dir) {
		await panel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await panel.screenshot({ path: `${dir}/publish-${mobile ? 'mobile-' : ''}4-checking.png` });
	}
	// No click needed: the card keeps itself current while the check runs.
	await expect(panel).toHaveAttribute('data-state', 'live', { timeout: 15_000 });
	await expect(checking).toHaveCount(0);
	expect(state.publish.calls).toEqual(['approval', 'publish']);
});

test('a taken-down app says why and offers no way to publish', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'ready', publish: true });
	state.publish.status.publication = {
		slug: 'todoer', url: 'https://todoer.caddieapps.test/', status: 'blocked', outputId: 'output-workflow', publishedAt: NOW, hasServer: false,
		blockedReason: "Caddie's safety check flagged a new version (Phishing).",
	};
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const panel = page.getByTestId('channel').getByTestId('project-workflow').getByTestId('publish-app');
	const blocked = panel.getByTestId('publish-blocked');
	await expect(blocked).toContainText('This app was taken down for breaking Caddie’s rules');
	await expect(blocked).toContainText("Reason: Caddie's safety check flagged a new version (Phishing).");
	await expect(panel.getByTestId('publish-go')).toHaveCount(0);
	await expect(panel.getByTestId('publish-unpublish')).toHaveCount(0);
	const dir = process.env.CADDIE_SHOTS;
	if (dir) {
		await panel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await panel.screenshot({ path: `${dir}/publish-${mobile ? 'mobile-' : ''}5-taken-down.png` });
	}
});

test('Publish waits for the keys the app needs, and says plainly when publishing is not set up', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'ready', publish: true });
	state.publish.status.missingKeys = ['WEATHER_API_KEY'];
	await page.goto(`${BASE}/app/`);
	const panel = page.getByTestId('channel').getByTestId('project-workflow').getByTestId('publish-app');
	await expect(panel.getByTestId('publish-needs-keys')).toHaveText('Add the keys this app needs first: WEATHER_API_KEY.');
	await expect(panel.getByTestId('publish-go')).toBeDisabled();

	state.publish.status = { ...state.publish.status, available: false, reason: "Publishing isn't set up on this Caddie server yet." };
	await page.reload();
	await expect(page.getByTestId('channel').getByTestId('project-workflow').getByTestId('publish-unavailable')).toHaveText("Publishing isn't set up on this Caddie server yet.");
	await expect(page.getByTestId('channel').getByTestId('project-workflow').getByTestId('publish-go')).toHaveCount(0);
});

test('Versions lists every checked build and goes back to an earlier one in two clicks', async ({ page, context }) => {
	const state = await fixture(context, { phase: 'ready', versions: 3 });
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	const panel = card.getByTestId('app-versions');
	const shot = async (name: string) => {
		const dir = process.env.CADDIE_SHOTS;
		if (!dir) return;
		await panel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await panel.screenshot({ path: `${dir}/versions-${mobile ? 'mobile-' : ''}${name}.png` });
	};
	await panel.locator('summary').click();
	await expect(panel.getByTestId('version-3')).toHaveAttribute('data-current', 'true');
	await expect(panel.getByTestId('version-3')).toContainText('Showing');
	await expect(panel.getByTestId('version-restore-3')).toHaveCount(0);
	await expect(panel.getByTestId('version-1')).toContainText('Add tasks');
	await shot('1-list');

	await panel.getByTestId('version-restore-1').click();
	const confirm = panel.getByRole('group', { name: 'Go back to version 1' });
	await expect(confirm).toContainText('The newer versions stay in this list.');
	await shot('2-confirm');
	await panel.getByTestId('version-restore-confirm').click();

	await expect(card.getByTestId('workflow-ready-detail')).toHaveText("Restored version 1. You're trying it below. Publish it to put it on the web.");
	await expect(panel.getByTestId('version-4')).toHaveAttribute('data-current', 'true');
	await expect(panel.getByTestId('version-4')).toContainText('Restored version 1');
	expect(state.versions.restores.map((r) => r.commitId)).toEqual([(1).toString(16).padStart(40, 'a')]);
	expect(state.versions.restores[0]!.key).toMatch(/^restore-[0-9a-f]{12}-\d+$/);
});

test("AI in your app shows this month's answers and allowance; when it runs out it says when AI answers again", async ({ page, context }) => {
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	const shot = async (panel: import('@playwright/test').Locator, name: string) => {
		const dir = process.env.CADDIE_SHOTS;
		if (!dir) return;
		await panel.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await panel.screenshot({ path: `${dir}/ai-${mobile ? 'mobile-' : ''}${name}.png` });
	};
	const ai = { calls: 12, usedPercent: 4, limitReached: false };
	await fixture(context, { phase: 'ready', ai });
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	const panel = card.getByTestId('app-ai');
	await expect(panel.getByRole('heading', { name: 'AI in your app' })).toBeVisible();
	await expect(panel.getByTestId('app-ai-summary')).toHaveText('12 answers · 4% used');
	await expect(panel.getByRole('img', { name: "4% of this month's AI allowance used" })).toBeVisible();
	await expect(panel.getByTestId('app-ai-paused')).toHaveCount(0);
	await expect(panel).not.toContainText('Paused');
	await shot(panel, '1-used');

	// Later the same month: the allowance ran out.
	Object.assign(ai, { calls: 340, usedPercent: 100, limitReached: true });
	await page.reload();
	await expect(card).toHaveAttribute('data-phase', 'ready');
	await expect(panel).toContainText('Paused');
	await expect(panel.getByTestId('app-ai-summary')).toHaveText('340 answers · 100% used');
	await expect(panel.getByTestId('app-ai-paused')).toContainText('This month’s allowance is used up. Your app’s AI answers again on');
	await shot(panel, '2-paused');
});

test('the test inbox shows the sign-in codes the app sent while you tried it, newest first', async ({ page, context }) => {
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	const now = Date.now();
	await fixture(context, {
		phase: 'ready',
		inbox: [
			{ to: 'bo@example.com', code: '654321', createdAt: new Date(now - 5_000).toISOString() },
			{ to: 'ada.lovelace@example.com', code: '123456', createdAt: new Date(now - 3 * 60_000).toISOString() },
		],
	});
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	const inbox = card.getByTestId('test-inbox');
	await expect(inbox.getByRole('heading', { name: 'Test inbox' })).toBeVisible();
	await expect(inbox).toContainText('nobody gets an email');
	const rows = inbox.getByTestId('test-inbox-message');
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText('bo@example.com');
	await expect(rows.nth(0)).toContainText('654321');
	await expect(rows.nth(0)).toContainText('just now');
	await expect(rows.nth(1)).toContainText('123456');
	await expect(rows.nth(1)).toContainText('3 min ago');
	const dir = process.env.CADDIE_SHOTS;
	if (dir) {
		await inbox.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await inbox.screenshot({ path: `${dir}/inbox-${mobile ? 'mobile-' : ''}1-codes.png` });
	}
});

test('an app that sent no sign-in codes shows no test inbox', async ({ page, context }) => {
	await fixture(context, { phase: 'ready', inbox: [] });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	await expect(card.getByRole('link', { name: 'Download app' })).toBeVisible();
	await expect(card.getByTestId('test-inbox')).toHaveCount(0);
});

test('an app that never used AI shows no AI section', async ({ page, context }) => {
	await fixture(context, { phase: 'ready' });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	await expect(card.getByRole('link', { name: 'Download app' })).toBeVisible();
	await expect(card.getByTestId('app-ai')).toHaveCount(0);
});

test('one version needs no Versions list', async ({ page, context }) => {
	await fixture(context, { phase: 'ready', versions: 1 });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	await expect(card.getByRole('link', { name: 'Download app' })).toBeVisible();
	await expect(card.getByTestId('app-versions')).toHaveCount(0);
});

test('a client-only app shows no Keys section', async ({ page, context }) => {
	await fixture(context, { phase: 'ready' });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	await expect(card.getByRole('link', { name: 'Download app' })).toBeVisible();
	await expect(card.getByTestId('app-keys')).toHaveCount(0);
});

test('mobile Home chat retains the embedded workflow and opens its explicit project only when requested', async ({ page, context }) => {
	await fixture(context);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/?pane=channel`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card.getByRole('heading', { name: 'Your plan is ready' })).toBeVisible();
	await card.getByRole('button', { name: 'Open project' }).click();
	await expect(page).toHaveURL(/project=proj-workflow/);
	await expect(page.getByTestId('conv-context')).toHaveAttribute('data-scope', 'project');
});


test('repeated project handoffs keep one live card and one preview', async ({ context, page }) => {
  await fixture(context, { phase: 'ready', repeatHandoff: true });
  await page.goto('/app/?pane=channel');
  await expect(page.getByTestId('project-workflow')).toHaveCount(1);
  await expect(page.getByTestId('interactive-preview')).toHaveCount(1);
  await expect(page.frameLocator('iframe[title="Your app preview"]').getByRole('heading', { name: 'Todoer' })).toBeVisible();
});


test('Stop build sends durable abort and retains the stopped project', async ({ context, page }) => {
  const fx = await fixture(context, { phase: 'building' });
  await page.goto('/app/?pane=channel');
  await page.getByRole('button', { name: 'Stop build', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await expect(page.getByTestId('project-workflow')).toContainText('Your plan and files are retained');
  // A user stop is a stopped BUILD (same rule as the server projection), never "the plan needs another pass".
  await expect(page.getByTestId('project-workflow').getByRole('button', { name: 'Retry build' })).toBeVisible();
  await expect(page.getByTestId('project-workflow').getByRole('button', { name: 'Continue the plan' })).toHaveCount(0);
  expect(fx.stops).toEqual(['/agents/coordinator/conv-project-workflow/abort', '/api/projects/proj-workflow/workflow/stop']);
  expect(fx.admissions).toHaveLength(0);
});

test('a plan stuck before approval reads as a plan to continue, never as a failed build', async ({ context, page }) => {
  await fixture(context, { phase: 'blocked' });
  await page.goto('/app/?pane=channel');
  const card = page.getByTestId('project-workflow');
  await expect(card.getByRole('heading', { name: 'Plan needs another pass' })).toBeVisible();
  await expect(card).toContainText("Caddie didn't finish the plan");
  await expect(card.getByRole('button', { name: 'Continue the plan' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Retry build' })).toHaveCount(0);
});

test('right after a GitHub import, the card builds the copied app and then shows it to try', async ({ page, context }) => {
	const state = await fixture(context, { imported: { status: 'checking', noWorkflow: true, checksUntilReady: 2 } });
	// Evidence only: CADDIE_SHOTS=<dir> saves each state; CADDIE_SHOTS_MOBILE=1 runs at 390px.
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	const shot = async (name: string) => {
		const dir = process.env.CADDIE_SHOTS;
		if (!dir) return;
		await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await card.screenshot({ path: `${dir}/imported-${mobile ? 'mobile-' : ''}${name}.png` });
	};
	// No plan yet: the card is the copied app, and Caddie is building it.
	await expect(card).toHaveAttribute('data-phase', 'imported');
	await expect(card.getByRole('heading', { name: 'Getting your app ready to try' })).toBeVisible();
	await expect(card.getByTestId('imported-app-checking')).toHaveText('Caddie is building the app copied from octo-farm/farm-log so you can try it here.');
	await shot('1-checking');
	// The card keeps the build moving until it is ready, then shows the app.
	await expect(card.getByRole('heading', { name: 'Your app from GitHub' })).toBeVisible({ timeout: 15_000 });
	await expect(card.getByTestId('imported-app-ready')).toHaveText('This is octo-farm/farm-log as Caddie copied it (version 1). Try it, then tell Caddie what you’d like to change.');
	const preview = card.frameLocator('iframe');
	await preview.getByRole('textbox', { name: 'New task' }).fill('Feed the goats');
	await preview.getByRole('button', { name: 'Add task' }).click();
	await expect(preview.getByRole('listitem')).toHaveText('Feed the goats');
	await shot('2-ready');
	expect(state.importChecks.length).toBe(2);
	// Ready: nothing keeps asking.
	await page.waitForTimeout(3500);
	expect(state.importChecks.length).toBe(2);
});

test("a judge's example (S07b) is ready to try at once, in its own words", async ({ page, context }) => {
	const state = await fixture(context, { imported: { status: 'ready', noWorkflow: true, example: true } });
	const mobile = Boolean(process.env.CADDIE_SHOTS_MOBILE);
	if (mobile) await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/app/${mobile ? '?pane=channel' : ''}`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'imported');
	await expect(card.getByRole('heading', { name: 'An example app to try' })).toBeVisible();
	await expect(card.getByTestId('imported-app-ready')).toHaveText('Caddie built Farm Log. Try it, then tell Caddie what you’d like to change, and it builds on this code.');
	await expect(card).not.toContainText('GitHub');
	await expect(card.frameLocator('iframe').getByRole('textbox', { name: 'New task' })).toBeVisible();
	if (process.env.CADDIE_SHOTS) {
		await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await card.screenshot({ path: `${process.env.CADDIE_SHOTS}/example-${mobile ? 'mobile-' : ''}ready.png` });
	}
	// Already checked: nothing is built for it.
	await page.waitForTimeout(3500);
	expect(state.importChecks).toHaveLength(0);
});

test('while Caddie plans, the copied app stays in the card under the plan', async ({ page, context }) => {
	await fixture(context, { phase: 'review', imported: { status: 'ready' } });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card.getByRole('heading', { name: 'Your plan is ready' })).toBeVisible();
	const section = card.getByTestId('imported-app');
	await expect(section.getByRole('heading', { name: 'Your app from GitHub' })).toBeVisible();
	await expect(section.frameLocator('iframe').getByRole('textbox', { name: 'New task' })).toBeVisible();
});

test("once the first build has its own preview, the copied app's section is gone", async ({ page, context }) => {
	await fixture(context, { phase: 'ready', imported: { status: 'ready' } });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card).toHaveAttribute('data-phase', 'ready');
	await expect(card.getByTestId('workflow-ready-detail')).toBeVisible();
	await expect(card.getByTestId('imported-app')).toHaveCount(0);
});

test("a copy Caddie couldn't build says why in plain words", async ({ page, context }) => {
	const message = "Caddie couldn't build this app the way it was copied, so there's nothing to try yet. Your code is saved as version 1. Tell Caddie what you'd like, and it fixes the build first.";
	const state = await fixture(context, { imported: { status: 'failed', noWorkflow: true, message } });
	await page.goto(`${BASE}/app/`);
	const card = page.getByTestId('channel').getByTestId('project-workflow');
	await expect(card.getByRole('heading', { name: 'Your code is copied' })).toBeVisible();
	await expect(card.getByTestId('imported-app-failed')).toHaveText(message);
	await expect(card.locator('iframe')).toHaveCount(0);
	expect(state.importChecks).toHaveLength(0);
});
