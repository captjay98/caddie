import { describe, expect, test } from 'bun:test';
import {
	SecretBoxError,
	appSecretAad,
	envelopeKeyId,
	keyringFromEnv,
	needsRotation,
	open,
	parseKeyring,
	seal,
} from '../apps/app/src/server/secret-box.ts';

/**
 * App-key encryption at rest. LOCAL VERIFIED: WebCrypto AES-256-GCM under
 * Bun (workerd exposes the same SubtleCrypto API).
 */

function randomKey(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
}

async function codeOf(promise: Promise<unknown> | (() => unknown)): Promise<string> {
	try {
		await (typeof promise === 'function' ? promise() : promise);
	} catch (error) {
		if (error instanceof SecretBoxError) return error.code;
		throw error;
	}
	return 'no error';
}

/** Flip one character of an envelope segment (index 2 = iv, 3 = ciphertext+tag). */
function tamper(envelope: string, segment: number, at: 'start' | 'end'): string {
	const parts = envelope.split('.');
	const value = parts[segment]!;
	const index = at === 'start' ? 0 : value.length - 2;
	const flipped = value[index] === 'A' ? 'B' : 'A';
	parts[segment] = value.slice(0, index) + flipped + value.slice(index + 1);
	return parts.join('.');
}

const SECRET = 'sk_live_51HxExampleNotARealKey';
const AAD = appSecretAad('project-1', 'PAYMENTS_KEY');

describe('secret box', () => {
	test('seals and opens a key; every seal uses a fresh IV', async () => {
		const keyring = await parseKeyring(`main:${randomKey()}`);
		const a = await seal(keyring, SECRET, AAD);
		const b = await seal(keyring, SECRET, AAD);
		expect(a).toMatch(/^v1\.main\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
		expect(a).not.toBe(b);
		expect(await open(keyring, a, AAD)).toBe(SECRET);
		expect(await open(keyring, b, AAD)).toBe(SECRET);
		expect(await open(keyring, await seal(keyring, 'ünïcødé ✓', AAD), AAD)).toBe('ünïcødé ✓');
	});

	test('the envelope never contains the key in readable or base64 form', async () => {
		const keyring = await parseKeyring(`main:${randomKey()}`);
		const envelope = await seal(keyring, SECRET, AAD);
		expect(envelope).not.toContain(SECRET);
		expect(envelope).not.toContain(Buffer.from(SECRET).toString('base64').slice(0, 12));
		expect(envelope).not.toContain(Buffer.from(SECRET).toString('base64url').slice(0, 12));
	});

	test('an envelope bound to one project or key name does not open for another', async () => {
		const keyring = await parseKeyring(`main:${randomKey()}`);
		const envelope = await seal(keyring, SECRET, AAD);
		expect(await codeOf(open(keyring, envelope, appSecretAad('project-2', 'PAYMENTS_KEY')))).toBe('DECRYPT_FAILED');
		expect(await codeOf(open(keyring, envelope, appSecretAad('project-1', 'OTHER_KEY')))).toBe('DECRYPT_FAILED');
	});

	test('any tampering with the IV, the ciphertext or the tag is refused', async () => {
		const keyring = await parseKeyring(`main:${randomKey()}`);
		const envelope = await seal(keyring, SECRET, AAD);
		expect(await codeOf(open(keyring, tamper(envelope, 2, 'start'), AAD))).toBe('DECRYPT_FAILED');
		expect(await codeOf(open(keyring, tamper(envelope, 3, 'start'), AAD))).toBe('DECRYPT_FAILED');
		expect(await codeOf(open(keyring, tamper(envelope, 3, 'end'), AAD))).toBe('DECRYPT_FAILED');
		// Truncation below the 16-byte tag, a wrong version, or junk segments are a bad format.
		const parts = envelope.split('.');
		expect(await codeOf(open(keyring, `${parts[0]}.${parts[1]}.${parts[2]}.AAAA`, AAD))).toBe('BAD_ENVELOPE');
		expect(await codeOf(open(keyring, envelope.replace(/^v1\./, 'v2.'), AAD))).toBe('BAD_ENVELOPE');
		expect(await codeOf(open(keyring, 'not-an-envelope', AAD))).toBe('BAD_ENVELOPE');
		expect(await codeOf(open(keyring, `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}.extra`, AAD))).toBe('BAD_ENVELOPE');
	});

	test('an envelope from a key the server no longer has is UNKNOWN_KEY, a different key with the same id fails to open', async () => {
		const sealedWithOld = await seal(await parseKeyring(`old:${randomKey()}`), SECRET, AAD);
		expect(await codeOf(open(await parseKeyring(`new:${randomKey()}`), sealedWithOld, AAD))).toBe('UNKNOWN_KEY');
		expect(await codeOf(open(await parseKeyring(`old:${randomKey()}`), sealedWithOld, AAD))).toBe('DECRYPT_FAILED');
	});

	test('rotation: the new key seals, the old one still opens, and old envelopes are flagged', async () => {
		const oldKey = randomKey();
		const before = await parseKeyring(`k1:${oldKey}`);
		const envelope = await seal(before, SECRET, AAD);
		expect(envelopeKeyId(envelope)).toBe('k1');
		expect(needsRotation(before, envelope)).toBe(false);

		const after = await parseKeyring(`k2:${randomKey()}, k1:${oldKey}`);
		expect(after.active.kid).toBe('k2');
		expect(needsRotation(after, envelope)).toBe(true);
		expect(await open(after, envelope, AAD)).toBe(SECRET);
		const resealed = await seal(after, await open(after, envelope, AAD), AAD);
		expect(envelopeKeyId(resealed)).toBe('k2');
		expect(needsRotation(after, resealed)).toBe(false);
	});

	test('keyring configuration errors are explicit and never echo key bytes', async () => {
		const short = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
		const good = randomKey();
		const cases: Array<[string | undefined, string]> = [
			[undefined, 'NOT_CONFIGURED'],
			['   ', 'NOT_CONFIGURED'],
			[good, 'BAD_KEYRING'], // a bare key with no id
			[`main:${short}`, 'BAD_KEYRING'], // 16 bytes, not 32
			[`main:${good},main:${randomKey()}`, 'BAD_KEYRING'], // duplicate id
			[`main:not*base64!`, 'BAD_KEYRING'],
			[`Main:${good}`, 'BAD_KEYRING'], // ids are lowercase
			[`averyveryverylongid:${good}`, 'BAD_KEYRING'],
		];
		for (const [raw, code] of cases) {
			let caught: unknown = null;
			try {
				await parseKeyring(raw);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(SecretBoxError);
			expect(String((caught as SecretBoxError).code)).toBe(code);
			const message = (caught as SecretBoxError).message;
			expect(message).not.toContain(good);
			expect(message).not.toContain(short);
		}
	});

	test('open errors never contain the plaintext or the key', async () => {
		const key = randomKey();
		const keyring = await parseKeyring(`main:${key}`);
		const envelope = await seal(keyring, SECRET, AAD);
		for (const attempt of [open(keyring, envelope, 'wrong'), open(keyring, tamper(envelope, 3, 'start'), AAD)]) {
			try {
				await attempt;
				throw new Error('expected a failure');
			} catch (error) {
				expect(String((error as Error).message)).not.toContain(SECRET);
				expect(String((error as Error).message)).not.toContain(key);
				expect(String((error as Error).stack ?? '')).not.toContain(SECRET);
			}
		}
	});

	test('keyringFromEnv imports once per configuration and does not cache a failure', async () => {
		const raw = `main:${randomKey()}`;
		const first = keyringFromEnv({ APP_SECRETS_KEYS: raw });
		expect(keyringFromEnv({ APP_SECRETS_KEYS: raw })).toBe(first);
		expect((await first).active.kid).toBe('main');
		expect(await codeOf(keyringFromEnv({}))).toBe('NOT_CONFIGURED');
		const again = await keyringFromEnv({ APP_SECRETS_KEYS: raw });
		expect(again.active.kid).toBe('main');
	});
});
