/**
 * Encryption at rest for app keys (the keys a generated app needs for outside
 * services). A key is pasted once, sealed here, and only ever opened again
 * server-side to inject it into that app's preview runtime or published
 * Worker. It is never shown again, never given to the AI model, never put in
 * the build sandbox.
 *
 * Scheme: AES-256-GCM via WebCrypto (same code under workerd and Bun), a
 * fresh random 96-bit IV per seal, a 128-bit tag, and additional
 * authenticated data that binds the envelope to its project and key name, so
 * an envelope copied to another project or renamed does not open.
 *
 *   envelope = "v1.<kid>.<base64url iv>.<base64url ciphertext+tag>"
 *
 * Keyring: env APP_SECRETS_KEYS = "kid:base64key[,kid:base64key...]". Every
 * key is exactly 32 bytes (e.g. `openssl rand -base64 32`). The FIRST entry
 * seals; every entry can open. Rotation = put a new key first, keep the old
 * one after it, re-seal (rotateAppSecrets), then drop the old key.
 *
 * Errors never carry key material or plaintext.
 */

export type SecretBoxErrorCode = 'NOT_CONFIGURED' | 'BAD_KEYRING' | 'UNKNOWN_KEY' | 'DECRYPT_FAILED' | 'BAD_ENVELOPE';

export class SecretBoxError extends Error {
	constructor(
		readonly code: SecretBoxErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'SecretBoxError';
	}
}

export interface KeyringEntry {
	readonly kid: string;
	readonly key: CryptoKey;
}

export interface Keyring {
	/** The entry new envelopes are sealed with (the first one configured). */
	readonly active: KeyringEntry;
	/** Every configured entry by key id, active included. */
	readonly byId: ReadonlyMap<string, KeyringEntry>;
}

const ENVELOPE_VERSION = 'v1';
const KID = /^[a-z0-9]{1,16}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function utf8(text: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(text);
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	if (!BASE64URL.test(text)) return null;
	const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
	try {
		const binary = atob(padded);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	if (!BASE64.test(text) || text.length % 4 !== 0) return null;
	try {
		const binary = atob(text);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

/**
 * Parse APP_SECRETS_KEYS into a keyring. Empty or absent -> NOT_CONFIGURED;
 * any malformed entry -> BAD_KEYRING (the message names the entry by position
 * or by its key id, never by its key).
 */
export async function parseKeyring(raw: string | null | undefined): Promise<Keyring> {
	const text = (raw ?? '').trim();
	if (text.length === 0) throw new SecretBoxError('NOT_CONFIGURED', 'App keys are not set up on this server (APP_SECRETS_KEYS is empty).');
	const entries: KeyringEntry[] = [];
	const seen = new Set<string>();
	const parts = text.split(',');
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index]!.trim();
		const colon = part.indexOf(':');
		const position = `entry ${index + 1}`;
		if (colon <= 0) throw new SecretBoxError('BAD_KEYRING', `APP_SECRETS_KEYS ${position} must look like kid:base64key.`);
		const kid = part.slice(0, colon);
		if (!KID.test(kid)) throw new SecretBoxError('BAD_KEYRING', `APP_SECRETS_KEYS ${position} has a key id that is not 1-16 lowercase letters or digits.`);
		if (seen.has(kid)) throw new SecretBoxError('BAD_KEYRING', `APP_SECRETS_KEYS lists key id "${kid}" more than once.`);
		const bytes = fromBase64(part.slice(colon + 1));
		if (!bytes) throw new SecretBoxError('BAD_KEYRING', `APP_SECRETS_KEYS key "${kid}" is not valid base64.`);
		if (bytes.length !== KEY_BYTES) throw new SecretBoxError('BAD_KEYRING', `APP_SECRETS_KEYS key "${kid}" must be exactly ${KEY_BYTES} bytes.`);
		const key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
		bytes.fill(0);
		seen.add(kid);
		entries.push({ kid, key });
	}
	return { active: entries[0]!, byId: new Map(entries.map((entry) => [entry.kid, entry])) };
}

let cachedRaw: string | null = null;
let cachedKeyring: Promise<Keyring> | null = null;

/** The keyring for this isolate's env, imported once per distinct configuration. */
export function keyringFromEnv(env: { APP_SECRETS_KEYS?: string }): Promise<Keyring> {
	const raw = env.APP_SECRETS_KEYS ?? '';
	if (cachedKeyring && cachedRaw === raw) return cachedKeyring;
	const pending = parseKeyring(raw);
	cachedRaw = raw;
	cachedKeyring = pending;
	// A failed parse must not stick: the next call re-reads the configuration.
	pending.catch(() => {
		if (cachedKeyring === pending) {
			cachedKeyring = null;
			cachedRaw = null;
		}
	});
	return pending;
}

/** The additional data that binds an app key's envelope to its project and name. */
export function appSecretAad(projectId: string, name: string): string {
	return `caddie-app-secret:v1|${projectId}|${name}`;
}

interface ParsedEnvelope {
	kid: string;
	iv: Uint8Array<ArrayBuffer>;
	sealed: Uint8Array<ArrayBuffer>;
}

function parseEnvelope(envelope: string): ParsedEnvelope {
	const parts = typeof envelope === 'string' ? envelope.split('.') : [];
	if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION || !KID.test(parts[1]!)) {
		throw new SecretBoxError('BAD_ENVELOPE', 'The stored key is not in a format this server can read.');
	}
	const iv = fromBase64Url(parts[2]!);
	const sealed = fromBase64Url(parts[3]!);
	if (!iv || iv.length !== IV_BYTES || !sealed || sealed.length < TAG_BYTES) {
		throw new SecretBoxError('BAD_ENVELOPE', 'The stored key is not in a format this server can read.');
	}
	return { kid: parts[1]!, iv, sealed };
}

/** Seal plaintext under the keyring's active key, bound to `aad`. */
export async function seal(keyring: Keyring, plaintext: string, aad: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const sealed = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: utf8(aad), tagLength: TAG_BYTES * 8 },
		keyring.active.key,
		utf8(plaintext),
	);
	return `${ENVELOPE_VERSION}.${keyring.active.kid}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
}

/** Open an envelope. Wrong key, wrong `aad` or any tampering -> DECRYPT_FAILED. */
export async function open(keyring: Keyring, envelope: string, aad: string): Promise<string> {
	const parsed = parseEnvelope(envelope);
	const entry = keyring.byId.get(parsed.kid);
	if (!entry) throw new SecretBoxError('UNKNOWN_KEY', `The stored key was sealed with key id "${parsed.kid}", which this server no longer has.`);
	let plain: ArrayBuffer;
	try {
		plain = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: parsed.iv, additionalData: utf8(aad), tagLength: TAG_BYTES * 8 },
			entry.key,
			parsed.sealed,
		);
	} catch {
		throw new SecretBoxError('DECRYPT_FAILED', 'The stored key could not be opened (it was changed, or belongs to something else).');
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(plain);
	} catch {
		throw new SecretBoxError('DECRYPT_FAILED', 'The stored key could not be opened (it was changed, or belongs to something else).');
	}
}

/** The key id an envelope was sealed with. */
export function envelopeKeyId(envelope: string): string {
	return parseEnvelope(envelope).kid;
}

/** True when the envelope was sealed with a key other than the active one. */
export function needsRotation(keyring: Keyring, envelope: string): boolean {
	return envelopeKeyId(envelope) !== keyring.active.kid;
}
