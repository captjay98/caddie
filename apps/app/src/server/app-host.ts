/**
 * The app-hosting port: everything the publish service asks of Cloudflare.
 *
 * Implemented by `adapters/cloudflare.ts` (`CloudflareAppHost`, REST API v4)
 * and exercised in tests against `tests/fixtures/cloudflare-stub.ts`. The
 * publish service never builds Cloudflare requests itself.
 *
 * Resources (all on Caddie's OWN account):
 *   - user Workers in one Workers for Platforms dispatch namespace,
 *   - one D1 database per published app,
 *   - route records in a KV namespace read by the dispatch Worker,
 *   - Cloudflare for SaaS custom hostnames on the apps zone,
 *   - URL Scanner scans.
 */
import type { AppRoute } from '@caddie/contracts';

export interface AppHostFile {
	/** Absolute asset path as served, e.g. `/index.html`, `/main.js`. */
	path: string;
	bytes: Uint8Array;
	contentType: string;
}

export type AppHostBinding =
	| { type: 'd1'; name: string; databaseId: string }
	| { type: 'secret_text'; name: string; text: string }
	| { type: 'plain_text'; name: string; text: string }
	| { type: 'service'; name: string; service: string; entrypoint?: string };

export interface AppHostDeployInput {
	/** Script name in the dispatch namespace: [a-z0-9-], at most 63 chars. */
	script: string;
	/** Static assets. Must include `/index.html`. */
	assets: AppHostFile[];
	/**
	 * ES module source of the app's server (`dist/server.js`), or null for a
	 * static-only app (the adapter then uploads a minimal assets-only module).
	 */
	serverModule: string | null;
	/**
	 * More ES modules the main module imports, by file name (e.g. `app.js`:
	 * the app's own server under Caddie's published entry). Never `index.js`.
	 */
	modules?: Readonly<Record<string, string>>;
	bindings: AppHostBinding[];
	/** e.g. `project:<id>`, `owner:<userId>`; used for bulk cleanup. */
	tags: string[];
	compatibilityDate: string;
	compatibilityFlags: string[];
}

export interface CustomHostnameState {
	id: string;
	hostname: string;
	/** Cloudflare's hostname status: pending | active | moved | deleted | blocked | ... */
	status: string;
	/** Certificate status: initializing | pending_validation | active | ... */
	sslStatus: string;
	/** DNS records the user may still need (TXT / CNAME), as Cloudflare reports them. */
	validationRecords: { type: string; name: string; value: string }[];
	/** Human-readable problems Cloudflare reports (verification_errors). */
	errors: string[];
}

export type ScanResult =
	| { state: 'pending' }
	| { state: 'done'; malicious: boolean; categories: string[]; reportUrl: string | null };

export type AppHostErrorCode =
	| 'NOT_CONFIGURED'
	| 'UNAUTHORIZED'
	| 'NOT_FOUND'
	| 'CONFLICT'
	| 'RATE_LIMITED'
	| 'INVALID_INPUT'
	| 'UPSTREAM'
	| 'TIMEOUT';

export class AppHostError extends Error {
	constructor(
		readonly code: AppHostErrorCode,
		message: string,
		readonly status = 502,
		/** Cloudflare's own error code, when it sent one. */
		readonly upstreamCode?: number,
	) {
		super(message);
		this.name = 'AppHostError';
	}
}

export interface AppHost {
	/** Upload (create or replace) a user Worker with its assets and bindings. */
	deploy(input: AppHostDeployInput): Promise<{ script: string }>;
	/** Delete a user Worker; NOT_FOUND is treated as already deleted. */
	removeScript(script: string): Promise<void>;
	createDatabase(name: string): Promise<{ id: string }>;
	deleteDatabase(id: string): Promise<void>;
	/** Run statements in order in ONE request; returns each statement's rows. */
	query(databaseId: string, statements: { sql: string; params?: unknown[] }[]): Promise<Record<string, unknown>[][]>;
	putRoute(hostname: string, route: AppRoute): Promise<void>;
	deleteRoute(hostname: string): Promise<void>;
	createHostname(hostname: string): Promise<CustomHostnameState>;
	getHostname(id: string): Promise<CustomHostnameState>;
	deleteHostname(id: string): Promise<void>;
	scanUrl(url: string): Promise<{ scanId: string }>;
	scanResult(scanId: string): Promise<ScanResult>;
}
