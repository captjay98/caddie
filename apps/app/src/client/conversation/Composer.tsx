import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, KeyboardEvent } from 'react';
import { Icon } from '../icons.tsx';
import { COMPOSER_PLACEHOLDER } from '../copy.ts';
import { useSpeechRecognition } from './useSpeechRecognition.ts';
import {
	type InputAttachment,
	type ImageMediaType,
	type FileMediaType,
	MAX_IMAGE_BYTES,
	MAX_FILE_BYTES,
} from '@caddie/contracts';

/**
 * Composer — Enter sends, Shift+Enter breaks a line, visible pending state.
 * Stage 3: an attach button lets the user add images (routed to a vision
 * model) and text files (.txt/.md/.csv, read directly). Each pick is guarded
 * client-side (allowed MIME + size ceiling) BEFORE it becomes an attachment;
 * the server re-validates against the same contract (never trusts the client).
 * Attachments ride the send alongside text; a message may carry text, an
 * attachment, or both — never nothing.
 */

const IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const FILE_TYPES: readonly FileMediaType[] = ['application/pdf', 'text/plain', 'text/markdown', 'text/csv'];
const ACCEPT = [...IMAGE_TYPES, ...FILE_TYPES, '.md', '.markdown', '.csv', '.txt'].join(',');
const MAX_ATTACHMENTS = 6;

/** A picked file plus its object URL + the typed attachment the send carries. */
interface PickedAttachment {
	readonly id: string;
	readonly attachment: InputAttachment;
	readonly isImage: boolean;
}

function classifyMediaType(file: File): { ok: true; isImage: boolean; attachment: Omit<InputAttachment, 'url'> } | { ok: false; reason: string } {
	const type = file.type;
	if ((IMAGE_TYPES as readonly string[]).includes(type)) {
		if (file.size > MAX_IMAGE_BYTES) return { ok: false, reason: `${file.name} is too large (images max ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB)` };
		if (file.size === 0) return { ok: false, reason: `${file.name} is empty` };
		return { ok: true, isImage: true, attachment: { kind: 'image', mediaType: type as ImageMediaType, filename: file.name, sizeBytes: file.size } };
	}
	// Some browsers report '' or 'application/octet-stream' for .md/.csv — map by extension.
	const byExt: Record<string, FileMediaType> = { md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', txt: 'text/plain' };
	const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
	const resolved: FileMediaType | undefined = (FILE_TYPES as readonly string[]).includes(type) ? (type as FileMediaType) : byExt[ext];
	if (!resolved) return { ok: false, reason: `${file.name} is not a supported type (images, PDF, .txt, .md, .csv)` };
	if (file.size > MAX_FILE_BYTES) return { ok: false, reason: `${file.name} is too large (files max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB)` };
	if (file.size === 0) return { ok: false, reason: `${file.name} is empty` };
	return { ok: true, isImage: false, attachment: { kind: 'file', mediaType: resolved, filename: file.name, sizeBytes: file.size } };
}

export function Composer(props: {
	onSend: (text: string, attachments: readonly InputAttachment[]) => void;
	/** Transport busy (submitted/streaming) or no project selected. */
	disabled?: boolean;
	disabledReason?: string;
	placeholder?: string;
	/** Controlled text (audit F01): when provided, unsent typing is owned by
	 *  the scoped channel store and survives navigation/reload. Uncontrolled
	 *  (local state) remains the fallback for standalone use. */
	value?: string;
	onValueChange?: (text: string) => void;
	/** A restored leftover draft (§3.6): labelled until it is sent or cleared. */
	draftNote?: string;
}): ReactElement {
	const [localValue, setLocalValue] = useState('');
	const value = props.value ?? localValue;
	const setValue = props.onValueChange ?? setLocalValue;
	const disabled = Boolean(props.disabled);
	// The field grows with its text, up to the CSS max-height (then it
	// scrolls), so a pasted or shared second line is never cut off.
	const textRef = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		const field = textRef.current;
		if (!field) return;
		field.style.height = 'auto';
		field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
	}, [value]);
	const [picked, setPicked] = useState<PickedAttachment[]>([]);
	const [attachError, setAttachError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const cameraRef = useRef<HTMLInputElement>(null);
	// The attach/mic/camera actions collapse behind one "+" toggle so they stop
	// eating two button slots before the user has typed. The menu opens on
	// click, closes on pick, on Escape, and on an outside click.
	const [menuOpen, setMenuOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menuOpen) return;
		function onDocPointer(event: PointerEvent) {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
		}
		function onDocKey(event: globalThis.KeyboardEvent) {
			if (event.key === 'Escape') setMenuOpen(false);
		}
		document.addEventListener('pointerdown', onDocPointer);
		document.addEventListener('keydown', onDocKey);
		return () => {
			document.removeEventListener('pointerdown', onDocPointer);
			document.removeEventListener('keydown', onDocKey);
		};
	}, [menuOpen]);

	// Stage 4 — local voice dictation. Each committed phrase is appended to the
	// composer text (editable before send); voice NEVER auto-sends. Hidden
	// entirely when the browser has no SpeechRecognition.
	const speech = useSpeechRecognition({
		onFinal: (phrase) => {
			if (!phrase) return;
			const current = props.value ?? localValue;
			const next = current ? `${current} ${phrase}` : phrase;
			setValue(next);
		},
	});
	function toggleDictation() {
		if (speech.listening) speech.stop();
		else speech.start();
	}

	function addFiles(files: FileList | null) {
		if (!files || files.length === 0) return;
		setAttachError(null);
		const next: PickedAttachment[] = [];
		for (const file of Array.from(files)) {
			if (picked.length + next.length >= MAX_ATTACHMENTS) {
				setAttachError(`At most ${MAX_ATTACHMENTS} attachments per message`);
				break;
			}
			const classified = classifyMediaType(file);
			if (!classified.ok) {
				setAttachError(classified.reason);
				continue;
			}
			const url = URL.createObjectURL(file);
			next.push({
				id: crypto.randomUUID(),
				isImage: classified.isImage,
				attachment: { ...classified.attachment, url } as InputAttachment,
			});
		}
		if (next.length) setPicked((existing) => [...existing, ...next]);
	}

	function removePicked(id: string) {
		setPicked((existing) => {
			const target = existing.find((p) => p.id === id);
			if (target) URL.revokeObjectURL(target.attachment.url);
			return existing.filter((p) => p.id !== id);
		});
	}

	function submit() {
		const text = value.trim();
		const attachments = picked.map((p) => p.attachment);
		if ((!text && attachments.length === 0) || disabled) return;
		if (speech.listening) speech.stop();
		props.onSend(text, attachments);
		setValue('');
		setPicked([]);
		setAttachError(null);
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	}

	const canSend = !disabled && (value.trim() !== '' || picked.length > 0);

	return (
		<div className="composer-wrap">
			{picked.length > 0 ? (
				<div className="composer-attachments" data-testid="composer-attachments">
					{picked.map((p) => (
						<span className="attachment-chip" data-testid="attachment-chip" data-kind={p.isImage ? 'image' : 'file'} key={p.id}>
							<Icon name={p.isImage ? 'image' : 'file'} title={p.isImage ? 'image' : 'file'} />
							<span className="attachment-name">{p.attachment.filename}</span>
							<button
								type="button"
								className="attachment-remove"
								aria-label={`Remove ${p.attachment.filename}`}
								data-testid="attachment-remove"
								onClick={() => removePicked(p.id)}
							>
								<Icon name="x" title="remove" />
							</button>
						</span>
					))}
				</div>
			) : null}
			{attachError ? (
				<p className="composer-attach-error" role="alert" data-testid="composer-attach-error">
					{attachError}
				</p>
			) : null}
			{speech.listening ? (
				<p className="composer-dictation" role="status" data-testid="composer-dictation">
					<span className="composer-dictation-dot" aria-hidden="true" /> Listening…
					{speech.interim ? <span className="composer-dictation-interim"> {speech.interim}</span> : null}
				</p>
			) : null}
			{speech.error ? (
				<p className="composer-attach-error" role="alert" data-testid="composer-dictation-error">
					{speech.error}
				</p>
			) : null}
			<form
				className="composer"
				data-testid="composer"
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<input
					ref={fileRef}
					type="file"
					className="composer-file-input"
					accept={ACCEPT}
					multiple
					hidden
					data-testid="composer-file-input"
					onChange={(event) => {
						addFiles(event.target.files);
						event.target.value = ''; // allow re-picking the same file
					}}
				/>
				{/* Camera capture — same validation path, but asks the device for its
				    camera (environment-facing). Falls back to a normal image picker on
				    a desktop that has no camera-capture support. */}
				<input
					ref={cameraRef}
					type="file"
					className="composer-file-input"
					accept={IMAGE_TYPES.join(',')}
					capture="environment"
					hidden
					data-testid="composer-camera-input"
					onChange={(event) => {
						addFiles(event.target.files);
						event.target.value = '';
					}}
				/>
				{/* One "+" toggle in place of the old attach + mic pair. It opens a
				    small menu with the available input options (dictate, camera,
				    media upload). */}
				<div className="composer-tools" ref={menuRef}>
					<button
						type="button"
						className={menuOpen ? 'composer-tools-toggle open' : 'composer-tools-toggle'}
						disabled={disabled}
						aria-label="Add to message"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						title="Add — camera, media, or dictation"
						data-testid="composer-tools-toggle"
						onClick={() => setMenuOpen((open) => !open)}
					>
						<Icon name="plus" title="add" />
					</button>
					{menuOpen ? (
						<div className="composer-tools-menu" role="menu" data-testid="composer-tools-menu">
							{speech.supported ? (
								<button
									type="button"
									role="menuitem"
									className={speech.listening ? 'composer-tool-item listening' : 'composer-tool-item'}
									data-testid="composer-mic"
									data-listening={speech.listening}
									aria-pressed={speech.listening}
									onClick={() => {
										setMenuOpen(false);
										toggleDictation();
									}}
								>
									<Icon name="mic" title="" />
									<span>{speech.listening ? 'Stop dictation' : 'Dictate'}</span>
								</button>
							) : null}
							<button
								type="button"
								role="menuitem"
								className="composer-tool-item"
								data-testid="composer-camera"
								onClick={() => {
									setMenuOpen(false);
									cameraRef.current?.click();
								}}
							>
								<Icon name="camera" title="" />
								<span>Camera</span>
							</button>
							<button
								type="button"
								role="menuitem"
								className="composer-tool-item"
								data-testid="composer-attach"
								onClick={() => {
									setMenuOpen(false);
									fileRef.current?.click();
								}}
							>
								<Icon name="image" title="" />
								<span>Upload media</span>
							</button>
						</div>
					) : null}
				</div>
				<textarea
					ref={textRef}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={onKeyDown}
					disabled={disabled}
					enterKeyHint="send"
					rows={1}
					aria-label="Message Caddie"
					placeholder={props.disabledReason ? undefined : (props.placeholder ?? COMPOSER_PLACEHOLDER)}
					data-testid="composer-input"
				/>
				<button
					type="submit"
					className="composer-send"
					disabled={!canSend}
					data-testid="composer-send"
					aria-label={disabled ? 'Send — held' : 'Send message'}
					title={props.disabledReason ?? 'Send message'}
				>
					<Icon name="send" title="" />
				</button>
			</form>
			<p className={props.draftNote ? 'composer-hint draft-note' : 'composer-hint'}>
				{props.draftNote ?? 'Enter to send · Shift + Enter for a new line'}
			</p>
		</div>
	);
}
