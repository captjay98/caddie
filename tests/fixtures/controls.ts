import type { AuthEnv, D1Database } from '../../apps/app/src/server/auth.ts';
import { ScopeError } from '../../apps/app/src/server/scope.ts';
import { createControlsApp } from '../../apps/app/src/server/routes/approvals.ts';
import { checkApprovalForEffect } from '../../apps/app/src/server/approvals.ts';
import {
	findOperationByProviderKey,
	getOperation,
	markCancelled,
	markDispatched,
	markReconciliationRequired,
	prepareOperation,
	recordReceipt,
	requestCancel,
} from '../../apps/app/src/server/operations.ts';
import {
	getReservation,
	releaseReservation,
	reservedMinorUnits,
	reserveBudget,
	setBudgetLimit,
	setPrice,
	settleReservation,
} from '../../apps/app/src/server/budgets.ts';
import { registerCredentialHandle } from '../../apps/app/src/server/credentials.ts';

/**
 * Minimal local workerd fixture for P03 (REAL workerd via `wrangler dev`, real
 * local SQLite-backed D1 — never deployed).
 *
 * It mounts the exact production /api composition (createControlsApp — the
 * auth router plus the P02 projects router plus the P03 approvals router, the
 * same mount app.ts uses) and adds /__test/* control routes used only by
 * tests/controls.integration.test.ts and tests/budget-races.integration.test.ts:
 *
 *   /__test/gate/check        execution-side approval gate — calls the
 *                             production checkApprovalForEffect service with
 *                             an explicit actor + injectable clock. In
 *                             production, adapters (P04/P05/P08) call the
 *                             service directly; this route exists ONLY in
 *                             this fixture.
 *   /__test/provider/*        the counting FAKE provider: every "external
 *                             effect" the tests simulate goes through here
 *                             and is counted in D1, so "zero provider calls"
 *                             is database truth, not a JS closure.
 *   /__test/operations/*      external-effects ledger service calls.
 *   /__test/budget/*          budget reserve/settle/release service calls.
 *   /__test/credentials/*     BYOK handle registration (redaction-only).
 *   /__test/ddl, /__test/d1   schema + database-truth probes.
 *
 * These control routes are NOT part of the app Worker.
 */

interface FixtureEnv extends AuthEnv {
	[key: string]: unknown;
}

async function d1All(db: D1Database, sql: string): Promise<{ results: unknown[] }> {
	const res = await db.prepare(sql).all();
	return { results: (res.results ?? []) as unknown[] };
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
	try {
		return (await request.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Map typed ScopeErrors from the service layer to { status, { error, message } }. */
function errorResponse(error: unknown): Response {
	if (error instanceof ScopeError) {
		return Response.json({ error: error.code, message: error.message }, { status: error.status });
	}
	console.error('fixture control route error:', error);
	return Response.json({ error: 'internal_error' }, { status: 500 });
}

const apiApp = createControlsApp();

export default {
	async fetch(request: Request, env: FixtureEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/__test/health') {
			try {
				await d1All(env.DB, 'select 1 as one');
				return Response.json({ ok: true, d1: true, betterAuthUrl: env.BETTER_AUTH_URL ?? null });
			} catch (error) {
				return Response.json({ ok: false, error: String(error) }, { status: 500 });
			}
		}
		if (url.pathname === '/__test/ddl' && request.method === 'POST') {
			const body = (await request.json()) as { statements?: string[] };
			try {
				for (const statement of body.statements ?? []) {
					await env.DB.prepare(statement).run();
				}
				return Response.json({ applied: (body.statements ?? []).length });
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 500 });
			}
		}
		if (url.pathname === '/__test/d1' && request.method === 'POST') {
			const body = (await request.json()) as { sql?: string };
			if (!body.sql) return Response.json({ error: 'sql required' }, { status: 400 });
			try {
				return Response.json(await d1All(env.DB, body.sql));
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 500 });
			}
		}

		// --- execution-side approval gate (production service, injectable clock) ---
		if (url.pathname === '/__test/gate/check' && request.method === 'POST') {
			try {
				const body = await jsonBody(request);
				const approval = await checkApprovalForEffect(env.DB, {
					actorId: String(body['actorId'] ?? ''),
					projectId: String(body['projectId'] ?? ''),
					action: body['action'] as never,
					resourceId: String(body['resourceId'] ?? ''),
					revisionHash: String(body['revisionHash'] ?? ''),
					policyVersion: String(body['policyVersion'] ?? ''),
					now: body['now'] === undefined ? undefined : String(body['now']),
				});
				return Response.json({ ok: true, approval });
			} catch (error) {
				return errorResponse(error);
			}
		}

		// --- counting fake provider (every simulated external effect lands here) ---
		if (url.pathname === '/__test/provider/invoke' && request.method === 'POST') {
			try {
				const body = await jsonBody(request);
				await env.DB.prepare(
					'insert into "provider_calls" ("kind","createdAt") values (?,?)',
				)
					.bind(String(body['kind'] ?? 'unspecified'), new Date().toISOString())
					.run();
				return Response.json({ ok: true });
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 500 });
			}
		}
		if (url.pathname === '/__test/provider/count' && request.method === 'GET') {
			try {
				const res = await d1All(env.DB, 'select count(*) as n from "provider_calls"');
				return Response.json({ count: Number((res.results[0] as { n: number })?.n ?? -1) });
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 500 });
			}
		}

		// --- external operations ledger ---------------------------------------------
		if (url.pathname === '/__test/operations/prepare' && request.method === 'POST') {
			try {
				const operation = await prepareOperation(env.DB, await jsonBody(request));
				return Response.json({ operation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/operations/dispatch' && request.method === 'POST') {
			try {
				const body = await jsonBody(request);
				const operation = await markDispatched(
					env.DB,
					String(body['operationKey'] ?? ''),
					String(body['remoteId'] ?? ''),
				);
				return Response.json({ operation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/operations/receipt' && request.method === 'POST') {
			try {
				const body = await jsonBody(request);
				const operation = await recordReceipt(env.DB, String(body['operationKey'] ?? ''), {
					receiptId: String(body['receiptId'] ?? ''),
					outcome: body['outcome'] as 'succeeded' | 'failed',
					remoteId: body['remoteId'] === undefined ? undefined : String(body['remoteId']),
				});
				return Response.json({ operation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/operations/reconciliation-required' && request.method === 'POST') {
			try {
				const body = await jsonBody(request);
				const operation = await markReconciliationRequired(
					env.DB,
					String(body['operationKey'] ?? ''),
				);
				return Response.json({ operation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/operations/cancel-request' && request.method === 'POST') {
			try {
				const body = await jsonBody(request);
				const operation = await requestCancel(env.DB, String(body['operationKey'] ?? ''));
				return Response.json({ operation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/operations/cancel-confirm' && request.method === 'POST') {
			try {
				const body = await jsonBody(request);
				const operation = await markCancelled(
					env.DB,
					String(body['operationKey'] ?? ''),
					String(body['receiptId'] ?? ''),
				);
				return Response.json({ operation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname?.startsWith('/__test/operations/get/') && request.method === 'GET') {
			try {
				const operationKey = decodeURIComponent(
					url.pathname.slice('/__test/operations/get/'.length),
				);
				const operation = await getOperation(env.DB, operationKey);
				return Response.json({ operation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/operations/correlate' && request.method === 'GET') {
			try {
				const provider = url.searchParams.get('provider') ?? '';
				const operationKey = url.searchParams.get('operationKey') ?? '';
				const operation = await findOperationByProviderKey(env.DB, provider, operationKey);
				return Response.json({ operation });
			} catch (error) {
				return errorResponse(error);
			}
		}

		// --- budgets ------------------------------------------------------------------
		if (url.pathname === '/__test/budget/limit' && request.method === 'POST') {
			try {
				const payer = await setBudgetLimit(env.DB, await jsonBody(request));
				return Response.json({ payer });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/budget/price' && request.method === 'POST') {
			try {
				const price = await setPrice(env.DB, await jsonBody(request));
				return Response.json({ price });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/budget/reserve' && request.method === 'POST') {
			try {
				const reservation = await reserveBudget(env.DB, await jsonBody(request));
				return Response.json({ reservation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/budget/settle' && request.method === 'POST') {
			try {
				const body = await jsonBody(request);
				const reservation = await settleReservation(
					env.DB,
					String(body['reservationKey'] ?? ''),
					body['actualAmountMinorUnits'] as number,
				);
				return Response.json({ reservation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/budget/release' && request.method === 'POST') {
			try {
				const body = await jsonBody(request);
				const reservation = await releaseReservation(env.DB, String(body['reservationKey'] ?? ''));
				return Response.json({ reservation });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname === '/__test/budget/reserved' && request.method === 'GET') {
			try {
				const payerId = url.searchParams.get('payerId') ?? '';
				return Response.json({ reservedMinorUnits: await reservedMinorUnits(env.DB, payerId) });
			} catch (error) {
				return errorResponse(error);
			}
		}
		if (url.pathname?.startsWith('/__test/budget/reservation/') && request.method === 'GET') {
			try {
				const reservationKey = decodeURIComponent(
					url.pathname.slice('/__test/budget/reservation/'.length),
				);
				const reservation = await getReservation(env.DB, reservationKey);
				return Response.json({ reservation });
			} catch (error) {
				return errorResponse(error);
			}
		}

		// --- credentials (redaction-only BYOK handles) ----------------------------------
		if (url.pathname === '/__test/credentials/register' && request.method === 'POST') {
			try {
				const handle = await registerCredentialHandle(env.DB, await jsonBody(request));
				return Response.json({ handle });
			} catch (error) {
				return errorResponse(error);
			}
		}

		return apiApp.fetch(request, env);
	},
};
