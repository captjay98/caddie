import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Stage 4 — browser speech-to-text (local dictation).
 *
 * This uses the browser's built-in Web Speech API (`SpeechRecognition` /
 * `webkitSpeechRecognition`). It is LOCAL DICTATION, not a server ASR model:
 * Token Factory serves no speech model, so voice is deliberately a client
 * capability. Where the browser does not implement the API (Firefox, some
 * embedded webviews) the hook reports `supported: false` and the UI hides the
 * mic rather than offering a dead button.
 *
 * Honesty + privacy: nothing is sent to our server for transcription — the
 * recognition runs in the browser. The transcript lands in the composer as
 * EDITABLE text the user reviews before sending; voice never auto-sends.
 */

/** The minimal shape of the Web Speech API we rely on (typed locally — it is
 *  not in the standard DOM lib and we must not assume `any`). */
interface SpeechRecognitionLike {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	start(): void;
	stop(): void;
	abort(): void;
	onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
	onerror: ((event: { error?: string }) => void) | null;
	onend: (() => void) | null;
}
interface SpeechRecognitionResultEventLike {
	resultIndex: number;
	results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
	// Read from globalThis (defined in every environment, and typed) rather than
	// a bare `window` reference — the browser sets SpeechRecognition /
	// webkitSpeechRecognition on the global, and this keeps the module typeable
	// under the DOM-less root tsc project too.
	const g = globalThis as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

/** Is local dictation available in this browser? Pure, no side effects. */
export function isSpeechRecognitionSupported(): boolean {
	return getRecognitionCtor() !== null;
}

export interface SpeechRecognitionState {
	readonly supported: boolean;
	readonly listening: boolean;
	/** The final transcript accumulated this session (committed phrases). */
	readonly transcript: string;
	/** The in-progress phrase not yet finalized (shown faintly while speaking). */
	readonly interim: string;
	readonly error: string | null;
}

export interface UseSpeechRecognition extends SpeechRecognitionState {
	/** Begin listening. No-op when unsupported or already listening. */
	start: () => void;
	/** Stop listening (keeps the transcript). */
	stop: () => void;
	/** Clear the accumulated transcript + interim (e.g. after it was consumed). */
	reset: () => void;
}

/**
 * React hook over the Web Speech API. `onFinal` is called with each committed
 * phrase so the caller can append it to the composer in real time; the hook
 * also keeps the accumulated transcript for callers that prefer to pull it.
 */
export function useSpeechRecognition(options?: {
	lang?: string;
	onFinal?: (phrase: string) => void;
}): UseSpeechRecognition {
	const [supported] = useState(isSpeechRecognitionSupported);
	const [listening, setListening] = useState(false);
	const [transcript, setTranscript] = useState('');
	const [interim, setInterim] = useState('');
	const [error, setError] = useState<string | null>(null);
	const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
	const onFinalRef = useRef(options?.onFinal);
	onFinalRef.current = options?.onFinal;

	// Tear down any live recognition on unmount so the mic is released.
	useEffect(() => {
		return () => {
			recognitionRef.current?.abort();
			recognitionRef.current = null;
		};
	}, []);

	const start = useCallback(() => {
		if (!supported || listening) return;
		const Ctor = getRecognitionCtor();
		if (!Ctor) return;
		setError(null);
		const recognition = new Ctor();
		const nav = (globalThis as unknown as { navigator?: { language?: string } }).navigator;
		recognition.lang = options?.lang ?? nav?.language ?? 'en-US';
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.onresult = (event) => {
			let finalChunk = '';
			let interimChunk = '';
			for (let i = event.resultIndex; i < event.results.length; i += 1) {
				const result = event.results[i]!;
				const text = result[0].transcript;
				if (result.isFinal) finalChunk += text;
				else interimChunk += text;
			}
			if (finalChunk) {
				setTranscript((prev) => (prev ? `${prev} ${finalChunk.trim()}` : finalChunk.trim()));
				onFinalRef.current?.(finalChunk.trim());
			}
			setInterim(interimChunk);
		};
		recognition.onerror = (event) => {
			// 'no-speech' / 'aborted' are benign; surface a real permission/other error.
			const code = event.error ?? 'unknown';
			if (code !== 'no-speech' && code !== 'aborted') {
				setError(code === 'not-allowed' ? 'Microphone access was blocked.' : `Dictation error: ${code}`);
			}
			setListening(false);
			setInterim('');
		};
		recognition.onend = () => {
			setListening(false);
			setInterim('');
		};
		recognitionRef.current = recognition;
		try {
			recognition.start();
			setListening(true);
		} catch {
			// start() throws if called twice; treat as already-listening.
			setListening(true);
		}
	}, [supported, listening, options?.lang]);

	const stop = useCallback(() => {
		recognitionRef.current?.stop();
		setListening(false);
		setInterim('');
	}, []);

	const reset = useCallback(() => {
		setTranscript('');
		setInterim('');
		setError(null);
	}, []);

	return { supported, listening, transcript, interim, error, start, stop, reset };
}
