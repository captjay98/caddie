import { fixtureLegacyQualityPolicy } from './fixtures/migrations.ts';
// Part G — publish safety for the exact output. Unit tests of the pure core
// (apps/app/src/server/publish-safety.ts): the bundle key scan, the team-mode
// receipt binding, and the kill switch. Each check has a mutation proof noted
// in docs/plans/2026-10-22-software-team-mode.md part G.
//
// Classification: LOCAL VERIFIED.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Scope } from '@caddie/contracts';
import { checkPublishSafety, isAppKeyName, type OutputVerifyReceipts } from '../apps/app/src/server/publish-safety.ts';
import type { D1Database } from '../apps/app/src/server/auth.ts';
import type { AppHost } from '../apps/app/src/server/app-host.ts';
import { publishApp, type PublishDeps } from '../apps/app/src/server/publish.ts';
import { requestAppSecret, setAppSecret } from '../apps/app/src/server/app-secrets.ts';
import { recordDecision } from '../apps/app/src/server/approvals.ts';
import { decideDesign, decideWorkflow, startProjectFromChat, storeBuildOutput, workflowSnapshot } from '../apps/app/src/server/build-workflow.ts';
import { createPlanDocRevision, ensureHomeProject } from '../apps/app/src/server/projects.ts';
import { createRun } from '../apps/app/src/server/runs.ts';
import { ScopeError, projectScopeForUser } from '../apps/app/src/server/scope.ts';
import { parseKeyring, type Keyring } from '../apps/app/src/server/secret-box.ts';
import { addUser, migratedDatabase } from './fixtures/sqlite-d1.ts';

const greenReceipts = (outputId: string): OutputVerifyReceipts => ({
	outputId,
	checks: { 'sign-in': true, 'second-person': true, restart: true },
});

const cleanBundle = { js: 'console.log("hi")', css: 'body{}', server: 'export default {}' };

describe('part G: publish safety — key scan', () => {
	test('a clean bundle (no team mode) is allowed', () => {
		const result = checkPublishSafety({
			outputId: 'out-1',
			...cleanBundle,
			savedKeyNames: ['WEATHER_API_KEY'],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(false);
		expect(result.findings).toHaveLength(0);
	});

	test('a bundle with a saved key VALUE in the browser code is refused', () => {
		// MUTATION: the real value "s3cr3t-weather-key-value" is shipped in dist/main.js.
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'const K = "s3cr3t-weather-key-value"; fetch("/x?key=" + K)',
			css: 'body{}',
			server: null,
			savedKeyNames: ['WEATHER_API_KEY'],
			savedKeyValues: ['s3cr3t-weather-key-value'],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'saved-key')).toBe(true);
	});

	test('a key-shaped string (sk-…) in the bundle is refused even if not a saved key', () => {
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'const token = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"; void token;',
			css: 'body{}',
			server: null,
			savedKeyNames: [],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'key-shaped')).toBe(true);
	});

	test('a key-shaped string in the SERVER code is also refused', () => {
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'console.log(1)',
			css: 'body{}',
			server: 'const k = "AKIAIOSFODNN7EXAMPLE";',
			savedKeyNames: [],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.where.includes('server'))).toBe(true);
	});

	test('a short saved value (< 8 chars) is not treated as a key (no false refusal)', () => {
		// MUTATION PROOF of the length guard: a 3-char "value" must not refuse.
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'const mode = "dev";',
			css: 'body{}',
			server: null,
			savedKeyNames: ['MODE'],
			savedKeyValues: ['dev'],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(false);
	});
});

describe('part G: publish safety — team-mode receipt binding', () => {
	test('team mode with green receipts for THIS output is allowed', () => {
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: true,
			publishSafety: 'on',
			receipts: greenReceipts('out-42'),
		});
		expect(result.refused).toBe(false);
		expect(result.findings).toHaveLength(0);
	});

	test('team mode with no receipts at all is refused (missing-receipt)', () => {
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: true,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'missing-receipt')).toBe(true);
	});

	test('a GREEN receipt for ANOTHER output does not count (wrong-output)', () => {
		// MUTATION: receipts are green, but they belong to out-7, not out-42.
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: true,
			publishSafety: 'on',
			receipts: greenReceipts('out-7'),
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'wrong-output')).toBe(true);
	});

	test('a RED check (restart not green) on this output is refused', () => {
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: true,
			publishSafety: 'on',
			receipts: { outputId: 'out-42', checks: { 'sign-in': true, 'second-person': true, restart: false } },
		});
		expect(result.refused).toBe(true);
		expect(result.findings.some((f) => f.kind === 'red-receipt' && f.where === 'restart')).toBe(true);
	});

	test('a NON-team-mode app does not need receipts', () => {
		const result = checkPublishSafety({
			outputId: 'out-42',
			...cleanBundle,
			savedKeyNames: [],
			teamMode: false,
			publishSafety: 'on',
			receipts: null,
		});
		expect(result.refused).toBe(false);
	});
});

describe('part G: publish safety — kill switch', () => {
	test('publish_safety=off logs the findings but does not refuse', () => {
		const result = checkPublishSafety({
			outputId: 'out-1',
			js: 'const token = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";',
			css: 'body{}',
			server: null,
			savedKeyNames: [],
			teamMode: true, // even in team mode with no receipts
			publishSafety: 'off',
			receipts: null,
		});
		expect(result.refused).toBe(false);
		expect(result.findings.length).toBeGreaterThan(0); // still computed for logging
		expect(result.message).toContain('Publish safety is off');
	});
});

describe('part G: app key name shape', () => {
	test('WEATHER_API_KEY is a valid app-key name; a lowercase one is not', () => {
		expect(isAppKeyName('WEATHER_API_KEY')).toBe(true);
		expect(isAppKeyName('weatherApiKey')).toBe(false);
	});
});


// --- integration: the call site passes the saved VALUES (plan part G) --------
// Part G's saved-value scan is only live if the publish call site reads the
// keys' values and passes them to checkPublishSafety. This exercises the REAL
// deployOutput path (through publishApp): an app whose bundle ships the value of
// a saved key is refused with PUBLISH_UNSAFE, before any Cloudflare call. The
// AppHost is a stub that throws if touched, so reaching it would fail loudly —
// proving the refusal happens at the safety gate, not downstream.
//
// Classification: LOCAL VERIFIED.

/** An AppHost that throws on every call — the safety refusal must fire first. */
const throwingHost: AppHost = new Proxy({} as AppHost, {
	get(_t, prop) {
		return () => {
			throw new Error(`AppHost.${String(prop)} was called — publish safety did not refuse first`);
		};
	},
});

/** True when the thrown message is the publish-safety unsafe refusal. */
function isUnsafeMessage(message: string): boolean {
	return /can't be published yet|cannot be published yet|saved key/i.test(message);
}

describe('part G: the publish call site scans the saved key VALUES (deployOutput path)', () => {
	let sqlite: Database;
	let db: D1Database;
	let scope: Scope;
	let keyring: Keyring;
	let deps: PublishDeps;
	let planId: string;
	let runId: string;

	const SECRET_VALUE = 'ow-live-SECRET-value-abc123';
	const CLEAN_JS = 'console.log("farm log")';
	const CSS = 'body{color:green}';
	const INIT = { name: '0001_init.sql', sql: 'create table notes (id integer primary key, body text not null);' };

	async function readyProject(name = 'Farm Log') {
		const home = await ensureHomeProject(db, 'alice');
		const homeScope = await projectScopeForUser(db, 'alice', home.id);
		const homeRun = await createRun(db, homeScope, { modelRouteId: 'nemotron-3-super', payerId: 'alice', conversationId: `conv-${crypto.randomUUID()}` });
		const started = await startProjectFromChat(db, homeScope, {
			name,
			description: 'Log feed',
			brief: 'Build a farm log with a database. Show me the plan first.',
			operationKey: `create-${crypto.randomUUID()}`,
			sourceConversationId: homeRun.conversationId,
		});
		const projectScope = await projectScopeForUser(db, 'alice', started.project.id);
// Fixture models a project from before the default-on quality policy (see fixtureLegacyQualityPolicy).
fixtureLegacyQualityPolicy(sqlite, projectScope.projectId);
		const plan = await createPlanDocRevision(db, projectScope, { kind: 'prd', body: '# Farm log\n\nLog feed.' });
		await workflowSnapshot(db, projectScope);
		await decideWorkflow(db, projectScope, { planId: plan.id, decision: 'approved' });
		const design = await createPlanDocRevision(db, projectScope, { kind: 'design', body: '# Design\n\nOne screen.' });
		await workflowSnapshot(db, projectScope);
		await decideDesign(db, projectScope, { designId: design.id, decision: 'approved' });
		return { scope: projectScope, planId: plan.id, runId: started.workflow.runId as string };
	}

	async function storeOutput(js: string, server: string | null): Promise<string> {
		sqlite.prepare('update build_workflows set phase = ? where projectId = ?').run('building', scope.projectId);
		const output = await storeBuildOutput(db, scope, {
			html: '<!doctype html><html><body>preview</body></html>',
			image: `sha256:img-${crypto.randomUUID()}`,
			planId,
			runId,
			bundle: { server, migrations: [INIT], client: { js, css: CSS } },
		});
		return output.outputId;
	}

	beforeEach(async () => {
		({ sqlite, db } = migratedDatabase());
		addUser(sqlite, 'alice', 'alice@example.com');
		keyring = await parseKeyring(`k1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`);
		deps = {
			host: throwingHost,
			appsDomain: 'caddieapps.test',
			keyring,
			probe: async () => 200,
			authSecret: 'caddie-master-secret-for-tests-0123',
			sleep: async () => undefined,
		};
		const ready = await readyProject();
		scope = ready.scope;
		planId = ready.planId;
		runId = ready.runId;
		// A saved key whose value must never ship to the browser.
		await requestAppSecret(db, scope, { name: 'WEATHER_API_KEY', description: 'Forecast.' });
		await setAppSecret(db, keyring, scope, { name: 'WEATHER_API_KEY', value: SECRET_VALUE });
	});

	afterEach(() => sqlite.close());

	test('a bundle that ships the saved key VALUE is refused through publishApp', async () => {
		const outputId = await storeOutput(`const K = ${JSON.stringify(SECRET_VALUE)}; fetch("/x?k=" + K)`, null);
		let code: string | null = null;
		try {
			await publishApp(db, deps, scope, { outputId });
		} catch (error) {
			expect(error).toBeInstanceOf(ScopeError);
			code = (error as ScopeError).code;
		}
		expect(code, 'a bundle carrying a saved key value should be refused as unsafe').toBe('PUBLISH_UNSAFE');
	});

	test('MUTATION: the SAME setup with a clean bundle is NOT refused for the value reason', async () => {
		// Proves the refusal above is the value scan, not an unrelated gate: a clean
		// bundle gets PAST publish safety (then fails loudly at the throwing host).
		const outputId = await storeOutput(CLEAN_JS, null);
		let message = '';
		try {
			await publishApp(db, deps, scope, { outputId });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(isUnsafeMessage(message), `a clean bundle must not be refused as unsafe (got: ${message})`).toBe(false);
	});
});
