import type { D1Database } from './auth.ts';
import { ArtifactsCodeStore, type ArtifactsBinding } from './adapters/cloudflare-artifacts.ts';
import type { CodeStore } from './code-store.ts';
import { LocalCodeStore } from './code-versions.ts';

/**
 * Where an app's code versions live: Cloudflare Artifacts (one git repo per
 * project) when the ARTIFACTS binding is configured — an owner input, Workers
 * Paid, open beta — and otherwise the D1-backed local store, which keeps the
 * same history in Caddie's own database. Both pass the same contract tests.
 */
export function codeStoreFor(env: { DB: D1Database; ARTIFACTS?: ArtifactsBinding }): CodeStore {
	return env.ARTIFACTS ? new ArtifactsCodeStore(env.ARTIFACTS) : new LocalCodeStore(env.DB);
}
