/**
 * Lane 8 — an injectable clock, so the build-wait timeout (step 2) is tested
 * without real time. `now()` is milliseconds; `sleep(ms)` resolves after a
 * delay. The real clock uses Date.now + setTimeout; tests inject a fake that
 * advances deterministically.
 */
export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A deterministic fake clock for tests. `sleep` advances virtual time instead
 * of waiting, so a 90-minute poll loop runs instantly. Each sleep also runs an
 * optional per-tick hook, letting a test change what the next poll sees.
 */
export class FakeClock implements Clock {
	private t: number;
	constructor(
		startMs = 0,
		private readonly onSleep?: (elapsedMs: number) => void,
	) {
		this.t = startMs;
	}
	now(): number {
		return this.t;
	}
	async sleep(ms: number): Promise<void> {
		this.t += ms;
		this.onSleep?.(ms);
	}
}
