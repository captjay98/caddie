import { describe, test, expect } from "bun:test";
import { capabilityReport, capabilitySignals } from "../apps/app/src/server/coordinator-context.ts";
import { isSpeechRecognitionSupported } from "../apps/app/src/client/conversation/useSpeechRecognition.ts";

/**
 * Stage 4 — voice input is LOCAL browser dictation, never a server speech
 * model (Token Factory serves none). These pin the honesty of that claim and
 * the graceful unsupported path.
 */

describe("Stage 4 voice capability honesty", () => {
	test("the voice-input capability is reported as LOCAL dictation, not a server model", () => {
		const report = capabilityReport(capabilitySignals({}));
		const voice = report.find((c) => c.id === "voice-input")!;
		expect(voice.enabled).toBe(true);
		expect(voice.reason.toLowerCase()).toContain("local");
		expect(voice.reason.toLowerCase()).toContain("browser");
		// It must explicitly deny being a server speech/ASR model.
		expect(voice.reason.toLowerCase()).toContain("not a server speech model");
		// And the next-action must forbid claiming server-side transcription.
		expect(voice.nextAction.toLowerCase()).toContain("do not claim to transcribe audio server-side");
	});
});

describe("Stage 4 speech-recognition support detection", () => {
	test("reports unsupported when no SpeechRecognition global exists (graceful fallback)", () => {
		const w = globalThis as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
		const hadStd = "SpeechRecognition" in w;
		const hadWebkit = "webkitSpeechRecognition" in w;
		delete w.SpeechRecognition;
		delete w.webkitSpeechRecognition;
		try {
			expect(isSpeechRecognitionSupported()).toBe(false);
		} finally {
			if (hadStd) w.SpeechRecognition = w.SpeechRecognition;
			if (hadWebkit) w.webkitSpeechRecognition = w.webkitSpeechRecognition;
		}
	});

	test("reports supported when a SpeechRecognition global is present", () => {
		const w = globalThis as unknown as { SpeechRecognition?: unknown };
		const had = "SpeechRecognition" in w;
		w.SpeechRecognition = class {};
		try {
			expect(isSpeechRecognitionSupported()).toBe(true);
		} finally {
			if (!had) delete w.SpeechRecognition;
		}
	});
});
