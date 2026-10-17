/**
 * Caddie-owned Worker classes behind backend previews (see preview-runtime.ts).
 *
 *   PreviewDatabase          one SQLite-backed Durable Object per project: the
 *                            app's TEST data while the user tries a preview.
 *                            Never the published app's data (that is the app's
 *                            own D1 database).
 *   PreviewDatabaseGateway   the RPC entrypoint handed to the app's isolate as
 *                            env.CADDIE_DB. Created per request with
 *                            props.projectId, so an app can only ever reach
 *                            its own project's preview database.
 *
 * Exported as top-level Worker exports from src/cloudflare.ts; the Durable
 * Object binding PREVIEW_DB and its migration tag live in wrangler.jsonc.
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import {
	applyPreviewMigrations,
	runPreviewScript,
	runPreviewStatements,
	type PreviewStatementResult,
} from './preview-runtime.ts';

export interface PreviewDatabaseStub {
	query(statements: unknown, transaction: boolean): Promise<PreviewStatementResult[]>;
	execScript(script: unknown): Promise<{ count: number; duration: number }>;
	applyMigrations(files: unknown): Promise<{ applied: string[] }>;
	reset(): Promise<void>;
}

export interface PreviewDatabaseNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): PreviewDatabaseStub;
}

export interface PreviewDatabaseEnv {
	PREVIEW_DB?: PreviewDatabaseNamespace;
}

export class PreviewDatabase extends DurableObject<PreviewDatabaseEnv> {
	async query(statements: unknown, transaction: boolean): Promise<PreviewStatementResult[]> {
		return runPreviewStatements(this.ctx.storage, statements, Boolean(transaction));
	}

	async execScript(script: unknown): Promise<{ count: number; duration: number }> {
		return runPreviewScript(this.ctx.storage, script);
	}

	async applyMigrations(files: unknown): Promise<{ applied: string[] }> {
		return applyPreviewMigrations(this.ctx.storage, files);
	}

	/** "Reset test data": forget every table the app created. */
	async reset(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}

export function previewDatabaseFor(env: PreviewDatabaseEnv, projectId: string): PreviewDatabaseStub {
	const namespace = env.PREVIEW_DB;
	if (!namespace) throw new Error('The preview database is not configured.');
	return namespace.get(namespace.idFromName(`project:${projectId}`));
}

export class PreviewDatabaseGateway extends WorkerEntrypoint<PreviewDatabaseEnv, { projectId: string }> {
	query(statements: unknown, transaction: boolean): Promise<PreviewStatementResult[]> {
		return previewDatabaseFor(this.env, this.ctx.props.projectId).query(statements, Boolean(transaction));
	}

	execScript(script: unknown): Promise<{ count: number; duration: number }> {
		return previewDatabaseFor(this.env, this.ctx.props.projectId).execScript(script);
	}
}
