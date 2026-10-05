import * as v from 'valibot';
import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

/**
 * P03 credentials — BYOK handles, REDACTION-ONLY (honest placeholder).
 *
 * What this module does TODAY:
 *   - registers a per-project BYOK handle as a NON-REVERSIBLE fingerprint
 *     (SHA-256 over a tagged secret) plus an envelope MARKER; the secret value
 *     itself is never persisted and never logged;
 *   - redactCredential() derives display-safe descriptors (fingerprint + a
 *     last-4 preview) without exposing the secret.
 *
 * What it deliberately does NOT do yet: envelope encryption at rest and key
 * rotation. Real key management (encrypted ciphertext handles, rotation, and
 * the adapter-only reveal path) lands with P04/P08 when a provider actually
 * consumes the key. Until then:
 *   - the store persists NO secret material (fail closed by construction),
 *   - this module exports NO function that returns secret values — the type
 *     surface is the guarantee (tests assert it),
 *   - `envelope` records the placeholder honestly instead of pretending
 *     ciphertext exists.
 */

const CredentialRegisterInputSchema = v.pipe(
	v.strictObject({
		projectId: v.pipe(v.string(), v.nonEmpty()),
		provider: v.pipe(v.string(), v.nonEmpty()),
		secret: v.pipe(v.string(), v.nonEmpty()),
	}),
	v.readonly(),
);

export interface CredentialHandleRecord {
	id: string;
	projectId: string;
	provider: string;
	fingerprint: string;
	envelope: string;
	createdAt: string;
}

/** Honest marker: no ciphertext-at-rest exists until P04/P08 key management. */
export const ENVELOPE_PLACEHOLDER =
	'external-only:fingerprint-no-ciphertext:key-management-pending-P04/P08';

async function sha256Tagged(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `sha256-${hex}`;
}

/** Redact a secret into display-safe descriptors. Never returns the secret. */
export async function redactCredential(
	secret: string,
): Promise<{ fingerprint: string; preview: string }> {
	if (typeof secret !== 'string' || secret.length === 0) {
		throw new ScopeError(400, 'invalid_input', 'secret is required');
	}
	const fingerprint = await sha256Tagged(`caddie-byok-v1:${secret}`);
	const preview = secret.length >= 8 ? `…${secret.slice(-4)}` : '••••';
	return { fingerprint, preview };
}

/**
 * Register a BYOK handle for a project. Only the fingerprint + envelope marker
 * are persisted; the unique (projectId, provider, fingerprint) index makes the
 * registration idempotent per secret (duplicate → 409).
 */
export async function registerCredentialHandle(
	db: D1Database,
	input: unknown,
): Promise<CredentialHandleRecord> {
	const parsed = v.parse(CredentialRegisterInputSchema, input);
	const { fingerprint } = await redactCredential(parsed.secret);
	const id = `credh_${crypto.randomUUID()}`;
	const createdAt = new Date().toISOString();
	try {
		await db
			.prepare(
				'insert into "credential_handles" ("id","projectId","provider","fingerprint","envelope","createdAt") values (?,?,?,?,?,?)',
			)
			.bind(id, parsed.projectId, parsed.provider, fingerprint, ENVELOPE_PLACEHOLDER, createdAt)
			.run();
	} catch (error) {
		const message = String(error);
		if (message.includes('UNIQUE constraint failed')) {
			throw new ScopeError(
				409,
				'credential_handle_conflict',
				'this exact BYOK handle is already registered for the project/provider',
			);
		}
		if (message.includes('FOREIGN KEY')) {
			throw new ScopeError(404, 'project_not_found', 'no such project for the credential handle');
		}
		throw error;
	}
	return {
		id,
		projectId: parsed.projectId,
		provider: parsed.provider,
		fingerprint,
		envelope: ENVELOPE_PLACEHOLDER,
		createdAt,
	};
}
