/**
 * Web Push (RFC 8030 / 8291 / 8292) for Cloudflare Workers — pure WebCrypto, no
 * Node 'web-push' library (which needs Node crypto and will not run on workerd).
 *
 * Two pieces:
 *   - VAPID (RFC 8292): an ES256 JWT signed with the server's VAPID private key,
 *     asserting who is sending, plus the public key, sent as the Authorization
 *     header so the push service accepts the request.
 *   - aes128gcm payload encryption (RFC 8291): the message body is encrypted to
 *     the subscription's p256dh + auth keys so only that browser can read it.
 *
 * Keys are base64url. The VAPID keypair is the server's (one per deployment,
 * held as Worker secrets); p256dh/auth are the browser's, from its PushManager
 * subscription. Nothing here reads process.env — the caller threads the keys in.
 */

// --- base64url helpers -------------------------------------------------------

export function b64urlToBytes(s: string): Uint8Array {
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function bytesToB64url(bytes: Uint8Array | ArrayBuffer): string {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = '';
	for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

// --- VAPID (RFC 8292): the signed Authorization header -----------------------

export interface VapidKeys {
	/** base64url uncompressed P-256 public key (65 bytes, 0x04 prefix). */
	publicKey: string;
	/** base64url raw P-256 private scalar (32 bytes). */
	privateKey: string;
	/** `mailto:…` identifying the sender. */
	subject: string;
}

/**
 * Import the VAPID private key (a raw 32-byte scalar) + public key as a JWK
 * ECDSA P-256 signing key. web-push generate-vapid-keys gives exactly these.
 */
async function importVapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
	const pub = b64urlToBytes(keys.publicKey); // 65 bytes: 0x04 || X(32) || Y(32)
	if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key must be an uncompressed P-256 point');
	const x = bytesToB64url(pub.slice(1, 33));
	const y = bytesToB64url(pub.slice(33, 65));
	const d = keys.privateKey; // already base64url of the 32-byte scalar
	return crypto.subtle.importKey(
		'jwk',
		{ kty: 'EC', crv: 'P-256', x, y, d, ext: true },
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign'],
	);
}

/** Build the `vapid t=<jwt>, k=<publicKey>` Authorization header for an endpoint. */
export async function vapidAuthHeader(endpoint: string, keys: VapidKeys, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
	const aud = new URL(endpoint).origin;
	const enc = new TextEncoder();
	const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	// 12h expiry (RFC 8292 caps it at 24h); subject identifies the sender.
	const payload = bytesToB64url(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 60 * 60, sub: keys.subject })));
	const signingInput = `${header}.${payload}`;
	const key = await importVapidSigningKey(keys);
	const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput) as BufferSource);
	const jwt = `${signingInput}.${bytesToB64url(sig)}`;
	return `vapid t=${jwt}, k=${keys.publicKey}`;
}

// --- aes128gcm payload encryption (RFC 8291) ---------------------------------

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
		key,
		length * 8,
	);
	return new Uint8Array(bits);
}

const UTF8 = new TextEncoder();

/**
 * Encrypt a plaintext body to a subscription's keys, aes128gcm (RFC 8291).
 * Returns the full body the push POST sends (header block + ciphertext).
 */
export async function encryptPayload(
	plaintext: Uint8Array,
	p256dhB64: string,
	authB64: string,
): Promise<Uint8Array> {
	const uaPublic = b64urlToBytes(p256dhB64); // 65 bytes
	const authSecret = b64urlToBytes(authB64); // 16 bytes

	// An ephemeral server ECDH keypair; the shared secret is with the UA key.
	const asKeyPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
	const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey)); // 65 bytes
	const uaKey = await crypto.subtle.importKey('raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const ecdhBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeyPair.privateKey, 256));

	// RFC 8291 §3.3: PRK_key = HKDF(auth, ecdh, "WebPush: info"||ua||as, 32)
	const keyInfo = concatBytes(UTF8.encode('WebPush: info\0'), uaPublic, asPublicRaw);
	const ikm = await hkdf(authSecret, ecdhBits, keyInfo, 32);

	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, UTF8.encode('Content-Encoding: aes128gcm\0'), 16);
	const nonce = await hkdf(salt, ikm, UTF8.encode('Content-Encoding: nonce\0'), 12);

	// aes128gcm content: plaintext || 0x02 (last-record delimiter), no padding.
	const record = concatBytes(plaintext, new Uint8Array([0x02]));
	const aesKey = await crypto.subtle.importKey('raw', cek as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, aesKey, record as BufferSource));

	// aes128gcm header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(as public, 65).
	const rs = 4096;
	const header = new Uint8Array(16 + 4 + 1 + asPublicRaw.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, rs, false);
	header[20] = asPublicRaw.length;
	header.set(asPublicRaw, 21);
	return concatBytes(header, ciphertext);
}

export interface PushSubscriptionKeys {
	endpoint: string;
	p256dh: string;
	auth: string;
}

export interface PushSendResult {
	ok: boolean;
	status?: number;
	/** true when the push service says the subscription is gone (404/410) and
	 *  the caller should delete it. */
	expired?: boolean;
	error?: string;
}

/**
 * Send one web-push message. NEVER throws: a transport or crypto failure comes
 * back as { ok: false }. A 404/410 marks the subscription expired so the caller
 * can prune it.
 */
export async function sendWebPush(
	sub: PushSubscriptionKeys,
	payload: { title: string; body: string; url?: string; tag?: string },
	keys: VapidKeys,
): Promise<PushSendResult> {
	try {
		const body = await encryptPayload(UTF8.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
		const auth = await vapidAuthHeader(sub.endpoint, keys);
		const res = await fetch(sub.endpoint, {
			method: 'POST',
			headers: {
				authorization: auth,
				'content-encoding': 'aes128gcm',
				'content-type': 'application/octet-stream',
				ttl: '86400',
			},
			body: body as unknown as BodyInit,
		});
		if (res.ok) return { ok: true, status: res.status };
		if (res.status === 404 || res.status === 410) return { ok: false, status: res.status, expired: true };
		return { ok: false, status: res.status, error: `push HTTP ${res.status}` };
	} catch (error) {
		return { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 200) };
	}
}

/** Read the VAPID keys from the Worker env (threaded in, never process.env). */
export function vapidFromEnv(env?: Record<string, unknown>): VapidKeys | null {
	const get = (k: string) => (env && typeof env[k] === 'string' ? (env[k] as string) : undefined);
	const publicKey = get('CADDIE_VAPID_PUBLIC');
	const privateKey = get('CADDIE_VAPID_PRIVATE');
	const subject = get('CADDIE_VAPID_SUBJECT') ?? 'mailto:caddie@example.com';
	if (!publicKey || !privateKey) return null;
	return { publicKey, privateKey, subject };
}
