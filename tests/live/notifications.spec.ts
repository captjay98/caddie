import { describe, expect, test } from 'bun:test';
import { mailerFromEnv } from '../../apps/app/src/server/notifications.ts';

/**
 * P12 live email — ONE real Resend send, to the owner's own address only.
 *
 * Honesty contract:
 *   - BLOCKED (a thrown, clearly-labeled failure — never a silent pass)
 *     unless ALL of: CADDIE_LIVE_AUTHORIZED=1 (explicit owner authorization
 *     for the external effect), RESEND_API_KEY and RESEND_FROM are present.
 *     verify-packet.ts already refuses to run live specs without the
 *     authorization env; this spec re-checks so a bare `bun test` cannot
 *     spend either.
 *   - When authorized, exactly ONE email leaves this process per run: a
 *     single mailer.send() with no retry loop, pass or fail. The recipient
 *     is DERIVED from RESEND_FROM (the owner's own configured sender
 *     address) — never any other address, never scraped from preferences.
 *   - The pass asserts the provider accepted the message (HTTP 2xx — the
 *     mailer maps any non-2xx to ok:false with the status text) and that a
 *     receipt id came back; the receipt is printed for the evidence ledger.
 *   - Credentials are loaded from .dev.vars by scripts/verify-packet.ts and
 *     are never printed or committed here.
 */

const apiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.RESEND_FROM;
const authorized = process.env.CADDIE_LIVE_AUTHORIZED === '1';

function blocked(reason: string): never {
	throw new Error(
		`BLOCKED: live P12 email requires ${reason}. ` +
			'Set CADDIE_LIVE_AUTHORIZED=1 plus RESEND_API_KEY/RESEND_FROM (.dev.vars, owner authorization). ' +
			'This suite never fakes a send and never falls back to mocks.',
	);
}

describe('P12 live notifications (Resend)', () => {
	test('exactly one real email to the owner address (derived from RESEND_FROM), receipt asserted and printed', async () => {
		if (!authorized) blocked('CADDIE_LIVE_AUTHORIZED=1 (explicit owner authorization for the external send)');
		if (!apiKey) blocked('RESEND_API_KEY (the Resend delivery credential)');
		if (!fromAddress) blocked('RESEND_FROM (the configured sender/owner address)');

		const mailer = mailerFromEnv(process.env);
		// The selection must be the REAL provider: with the env above present,
		// anything else would be a faked pass.
		expect(mailer.name).toBe('resend');

		const result = await mailer.send({
			to: fromAddress, // the owner's own address — the ONLY permitted recipient
			subject: 'Caddie P12 live email verification',
			textBody:
				`Real-delivery probe from tests/live/notifications.spec.ts at ${new Date().toISOString()}. ` +
				'One authorized verification email to the owner address (derived from RESEND_FROM).',
		});

		// No retry on failure — this run has already spent its exactly-one send;
		// a provider rejection is an honest FAILED, never a second attempt.
		expect(result.ok).toBe(true); // HTTP 2xx from api.resend.com (non-2xx → ok:false + status text)
		const receiptId = (result as { id?: string }).id;
		expect(typeof receiptId).toBe('string');
		expect(receiptId!.length).toBeGreaterThan(0);

		console.log(`[P12 live email] status=sent provider=resend to=${fromAddress} receipt_id=${receiptId}`);
	});
});
