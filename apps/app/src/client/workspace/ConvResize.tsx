import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react';

/**
 * ConvResize — the resizable Caddie panel (v2 shell, HANDOFF §3.2).
 *
 * The panel width persists as a FRACTION of the window: the default is a 50/50
 * split (CONV_DEFAULT_FRAC, owner direction 2026-10-23 revised — the Brief shows
 * ONE standard-width card centred in its section, no two-up), minimum 340px,
 * maximum min(60% of the window, window − CONTENT_MIN_PX) where CONTENT_MIN_PX
 * is a Brief card at its minimum width plus the section padding, so a resize can
 * never crush the card. A width the person set persists per browser
 * (localStorage, rounded to 4 decimals) and is re-clamped on every window
 * resize, so a saved fraction never means an off-screen panel.
 *
 * The handle is a real ARIA separator: focusable, arrow keys ±2% (Shift ±10%),
 * Home = minimum, End = maximum, Enter/double-click = reset to the default.
 * Dragging the chat PAST its max (which would starve the Brief card) snaps the
 * chat to full screen instead of clamping to a too-narrow split.
 * While dragging (or while the handle is focused) a small tip shows the live
 * percentage, marked "· default" at the 50/50 default.
 *
 * Storage key `caddie:conv-frac` is a plain number string — same `caddie:`
 * prefix family as `caddie-theme` and `caddie:last-dest:*`, never the
 * prototype's `caddie2.*` demo keys.
 */

/**
 * The default chat width. Owner direction 2026-10-23 (revised): the chat opens
 * at 50% of the window (a 50/50 split). The Brief shows ONE standard-width card
 * centred in its section (no two-up), so the split no longer has to fit two
 * columns. CONV_DEFAULT_FRAC is the flat half; the resize bounds below keep the
 * Brief section wide enough for a card at its minimum width.
 */
export const CONV_DEFAULT_FRAC = 0.5;
export const CONV_MIN_PX = 340;
/**
 * The Brief section always keeps at least this much of the window — a card at
 * its MINIMUM width (BRIEF_CARD_MIN_PX) plus the section's own horizontal
 * padding. The chat's MAX width is `window − CONTENT_MIN_PX`, so a drag can
 * never crush the card below its minimum: it clamps here, and a push past this
 * is what sends the chat to full screen (Chrome.tsx), hiding the Brief rather
 * than squeezing it.
 */
export const BRIEF_CARD_MIN_PX = 420;
export const BRIEF_SECTION_PADDING_PX = 40; // aside-scroll 16·2 + a little room
export const CONTENT_MIN_PX = BRIEF_CARD_MIN_PX + BRIEF_SECTION_PADDING_PX; // 460
export const CONV_FRAC_KEY = 'caddie:conv-frac';

function windowWidth(): number {
	return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

/** The default fraction at the current window width: a 50/50 split, clamped. */
export function defaultFrac(width = windowWidth()): number {
	return clampFrac(CONV_DEFAULT_FRAC, width);
}

/** The widest the panel may ever be at the current window width (px). */
export function convMaxPx(width = windowWidth()): number {
	return Math.max(CONV_MIN_PX, Math.min(width * 0.6, width - CONTENT_MIN_PX));
}

/** Clamp a fraction into the legal range at the current window width. */
export function clampFrac(frac: number, width = windowWidth()): number {
	const minFrac = CONV_MIN_PX / width;
	const maxFrac = convMaxPx(width) / width;
	return Math.min(maxFrac, Math.max(minFrac, frac));
}

function loadFrac(): number {
	try {
		const raw = localStorage.getItem(CONV_FRAC_KEY);
		const parsed = raw === null ? NaN : Number(raw);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultFrac();
	} catch {
		return defaultFrac();
	}
}

export interface ConvWidth {
	/** The live, clamped fraction (re-clamped on window resize). */
	frac: number;
	/** The rendered panel width in whole pixels. */
	widthPx: number;
	/** The current legal minimum/maximum panel width in pixels. */
	minPx: number;
	maxPx: number;
	/** Set the fraction (clamped). `persist=false` keeps the drag ephemeral. */
	setFrac: (frac: number, persist?: boolean) => void;
	/** Back to the default, half the window (persists). */
	reset: () => void;
}

/**
 * Panel-width state for the desktop two-panel shell. Attach the returned
 * `widthPx` to the panel's inline width only while the panel is the sized
 * side column (not the full-screen chat, not the rail, not an overlay).
 */
export function useConvWidth(enabled: boolean): ConvWidth {
	const [fracState, setFracState] = useState(() => (enabled ? loadFrac() : CONV_DEFAULT_FRAC));

	// The width is derived per render from the live window size; a resize
	// listener only triggers re-renders so the clamp re-evaluates.
	const [, setResizeTick] = useState(0);
	useEffect(() => {
		if (!enabled) return;
		const onResize = () => setResizeTick((tick) => tick + 1);
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	}, [enabled]);

	const frac = enabled ? clampFrac(fracState) : CONV_DEFAULT_FRAC;

	const setFrac = useCallback(
		(next: number, persist = true) => {
			const clamped = clampFrac(next);
			setFracState(clamped);
			if (persist) {
				try {
					localStorage.setItem(CONV_FRAC_KEY, String(Number(clamped.toFixed(4))));
				} catch {
					// private mode: width stays session-only
				}
			}
		},
		[],
	);

	const reset = useCallback(() => setFrac(defaultFrac()), [setFrac]);

	// Computed per render (not memoized): the width must track the window even
	// when the fraction is unchanged — the resize listener re-renders, and the
	// clamp/px re-derive from the live windowWidth().
	const width = windowWidth();
	return {
		frac,
		widthPx: Math.round(frac * width),
		minPx: CONV_MIN_PX,
		maxPx: convMaxPx(width),
		setFrac,
		reset,
	};
}

/**
 * The panel's left-edge resize handle. Rendered inside the panel itself
 * (absolute at its left edge), so it only exists when the panel is the sized
 * desktop column.
 */
export function ConvResizeHandle(props: { width: ConvWidth; onEnterFull?: () => void }): ReactElement {
	const { width } = props;
	const [dragging, setDragging] = useState(false);
	const [focused, setFocused] = useState(false);
	const draggingRef = useRef(false);
	const pendingFrac = useRef<number | null>(null);
	const frame = useRef<number | null>(null);
	// How far PAST the chat's max the pointer must go before we stop clamping
	// the Brief to its minimum and send the chat to full screen instead
	// (owner 2026-10-23: a resize that would starve the Brief card goes full).
	const SNAP_TO_FULL_PX = 72;
	useEffect(() => () => {
        if (frame.current !== null) window.cancelAnimationFrame(frame.current);
        document.body.classList.remove('conv-resizing');
    }, []);

	const onPointerDown = useCallback(
		(event: ReactPointerEvent) => {
			event.preventDefault();
			event.currentTarget.setPointerCapture(event.pointerId);
			draggingRef.current = true;
			pendingFrac.current = null;
			setDragging(true);
			document.body.classList.add('conv-resizing');
		},
		[],
	);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent) => {
			if (!draggingRef.current) return;
			// The panel's LEFT edge follows the pointer: distance from the right
			// edge of the window is the requested panel width.
			const requestedPx = windowWidth() - event.clientX;
			// Pushed well past the max (so the Brief would drop below a card's
			// minimum)? Go full screen instead of clamping to a starved split.
			if (props.onEnterFull && requestedPx > width.maxPx + SNAP_TO_FULL_PX) {
				draggingRef.current = false;
				setDragging(false);
				document.body.classList.remove('conv-resizing');
				if (frame.current !== null) window.cancelAnimationFrame(frame.current);
				frame.current = null;
				pendingFrac.current = null;
				try {
					event.currentTarget.releasePointerCapture(event.pointerId);
				} catch {
					// pointer already released
				}
				props.onEnterFull();
				return;
			}
			pendingFrac.current = requestedPx / windowWidth();
            if (frame.current !== null) return;
            frame.current = window.requestAnimationFrame(() => {
                frame.current = null;
                if (pendingFrac.current !== null) width.setFrac(pendingFrac.current, false);
            });
		},
		[width, props],
	);

	const endDrag = useCallback(
		(event: ReactPointerEvent) => {
			if (!draggingRef.current) return;
			draggingRef.current = false;
			setDragging(false);
			document.body.classList.remove('conv-resizing');
            if (frame.current !== null) window.cancelAnimationFrame(frame.current);
            frame.current = null;
			try {
				event.currentTarget.releasePointerCapture(event.pointerId);
			} catch {
				// pointer already released (e.g. pointercancel) — nothing to do
			}
			// Persist the fraction the drag landed on.
			width.setFrac(pendingFrac.current ?? width.frac, true);
            pendingFrac.current = null;
		},
		[width],
	);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			const step = event.shiftKey ? 0.1 : 0.02;
			if (event.key === 'ArrowLeft') {
				// Moving the edge left widens the panel.
				event.preventDefault();
				width.setFrac(width.frac + step);
			} else if (event.key === 'ArrowRight') {
				event.preventDefault();
				width.setFrac(width.frac - step);
			} else if (event.key === 'Home') {
				event.preventDefault();
				width.setFrac(0);
			} else if (event.key === 'End') {
				event.preventDefault();
				width.setFrac(1);
			} else if (event.key === 'Enter') {
				event.preventDefault();
				width.reset();
			}
		},
		[width],
	);

	const pct = Math.round((width.widthPx / windowWidth()) * 100);
	const isDefault = Math.abs(width.frac - defaultFrac()) < 0.005;
	const showTip = dragging || focused;

	return (
		<>
			<div
				className="conv-resize-handle"
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize the Caddie panel"
				tabIndex={0}
				data-testid="conv-resize-handle"
				data-dragging={dragging ? 'true' : 'false'}
				aria-valuenow={pct}
				aria-valuemin={Math.round((CONV_MIN_PX / windowWidth()) * 100)}
				aria-valuemax={Math.round((convMaxPx() / windowWidth()) * 100)}
				aria-valuetext={`Caddie takes ${pct}% of the window`}
				title={`Drag to resize · double-click resets to ${Math.round(defaultFrac() * 100)}%`}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				onDoubleClick={width.reset}
				onKeyDown={onKeyDown}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
			>
				<span className="conv-resize-grip" aria-hidden="true">
					<i />
					<i />
					<i />
				</span>
			</div>
			{showTip ? (
				<span className="conv-width-tip" data-testid="conv-width-tip" aria-hidden="true">
					{pct}%{isDefault ? ' · default' : ''}
				</span>
			) : null}
		</>
	);
}
