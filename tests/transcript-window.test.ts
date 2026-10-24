import { describe, expect, test } from "bun:test";
import { windowMessages, TRANSCRIPT_WINDOW } from "../apps/app/src/client/conversation/Channel.tsx";

/**
 * The transcript windowing fix (slowness / hangs on long project
 * conversations): only the recent slice is rendered unless the person opens
 * the whole history. LOCAL VERIFIED.
 */

type Msg = { id: string; role: "user" | "assistant" };
const msg = (id: string, role: "user" | "assistant"): Msg => ({ id, role });

// A realistic alternating transcript: user, assistant, user, assistant, …
function transcript(turns: number): Msg[] {
	const out: Msg[] = [];
	for (let i = 0; i < turns; i++) {
		out.push(msg(`u${i}`, "user"));
		out.push(msg(`a${i}`, "assistant"));
	}
	return out;
}

describe("windowMessages", () => {
	test("a short history is shown whole, nothing hidden", () => {
		const m = transcript(3); // 6 messages, under the window
		const { shown, hiddenCount } = windowMessages(m as never, TRANSCRIPT_WINDOW);
		expect(shown).toHaveLength(6);
		expect(hiddenCount).toBe(0);
	});

	test("a long history is trimmed to the recent slice and reports what it hid", () => {
		const m = transcript(60); // 120 messages
		const { shown, hiddenCount } = windowMessages(m as never, 40);
		// It never shows MORE than the window plus the pull-back to a user turn.
		expect(shown.length).toBeLessThanOrEqual(41);
		expect(shown.length + hiddenCount).toBe(120);
		expect(hiddenCount).toBeGreaterThan(0);
		// The newest message is always kept.
		expect(shown.at(-1)).toEqual(m.at(-1) as never);
	});

	test("the window opens on a user message, never mid-reply", () => {
		const m = transcript(60); // [u0,a0,u1,a1,…]; even index = user
		// limit 41 => raw cut = 120-41 = 79, which is a0..a (odd = assistant).
		// Without the pull-back to the next user message the window would open
		// mid-reply; with it, it opens on the following user turn.
		const { shown } = windowMessages(m as never, 41);
		expect((shown[0] as Msg).role).toBe("user");
	});

	test("showAll returns the whole history with nothing hidden", () => {
		const m = transcript(60);
		const { shown, hiddenCount } = windowMessages(m as never, 40, true);
		expect(shown).toHaveLength(120);
		expect(hiddenCount).toBe(0);
	});
});
