import { expect, test } from 'bun:test';
import { FlueApiError } from '../apps/app/node_modules/@flue/sdk';
import { quotaRefusalMessage } from '../apps/app/src/client/conversation/send-failure.ts';

test('quota refusals show the public explanation carried by the SDK body', () => {
	for (const code of ['JUDGE_LIMIT_MESSAGES', 'JUDGE_LIMIT_BUILDS', 'JUDGE_LIMIT_DISCOVERY']) {
		expect(quotaRefusalMessage(new FlueApiError(403, { error: code, message: 'Your allowance is used.' }))).toBe('Your allowance is used.');
	}
});

test('network failures, private runtime errors and malformed refusals keep the generic fallback', () => {
	for (const error of [undefined, new Error('private implementation detail'), new FlueApiError(500, { error: 'internal_error', message: 'private runtime detail' }), new FlueApiError(403, { error: 'unknown_error', message: 'private detail' }), new FlueApiError(403, { error: 'JUDGE_LIMIT_MESSAGES', message: '' })]) {
		expect(quotaRefusalMessage(error)).toBeNull();
	}
});
