import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react';

/**
 * ConvResize — the resizable Caddie panel (v2 shell, HANDOFF §3.2).
 *
 * The panel width persists as a FRACTION of the window: the default is a
 * target pixel width CONV_DEFAULT_PX (520px, owner direction 2026-10-23 —
 * narrow enough that the Brief column fits TWO cards side by side, replacing
 * the earlier half-window that only fit one), minimum 340px, maximum min(60%
 * of the window, window − 560px) so the content column never drops under
 * 560px. A width the person set persists per browser (localStorage, rounded to
 * 4 decimals) and is re-clamped on every window resize, so a saved fraction
 * never means an off-screen panel after the window changes.
 *
 * The handle is a real ARIA separator: focusable, arrow keys ±2% (Shift ±10%),
 * Home = minimum, End = maximum, Enter/double-click = reset to the default.
 * While dragging (or while the handle is focused) a small tip shows the live
 * percentage, marked "· default" at the width-aware default (CONV_DEFAULT_PX).
 *
 * Storage key `caddie:conv-frac` is a plain number string — same `caddie:`
 * prefix family as `caddie-theme` and `caddie:last-dest:*`, never the
 * prototype's `caddie2.*` demo keys.
 */

/**
 * The default chat width. Owner direction 2026-10-23: the chat should be narrow
 * enough that the Brief column fits TWO cards side by side (each card wants
 * ~420px, so the column needs ~900px), not the half-window that only ever fit
 * one. Expressed as a target PIXEL width (clamped to the legal range per window)
 * so it holds across laptop sizes instead of a flat fraction that grows the chat
 * on a big screen and squeezes the cards. The person can still widen the chat —
 * doing so drops the Brief column to one card, which is the intended choice.
 */
export const CONV_DEFAULT_PX = 520;
export const CONV_MIN_PX = 340;
/** The page always keeps at least this much of the window, so the chat's
 *  MAX width can never crush the content column. Kept moderate (one-card
 *  readable) — the two-up default comes from CONV_DEFAULT_PX, not this floor. */
export const CONTENT_MIN_PX = 560;
export const CONV_FRAC_KEY = 'caddie:conv-frac';

function windowWidth(): number {
	return typeof window === 'undefined' ? 1280 : window.innerWidth;
}

/** The default fraction at the current window width: CONV_DEFAULT_PX, clamped. */
export function defaultFrac(width = windowWidth()): number {
	return clampFrac(CONV_DEFAULT_PX / width, width);
}

/** Back-compat alias; callers prefer defaultFrac() which is width-aware. */
export const CONV_DEFAULT_FRAC = 0.4;

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
export function ConvResizeHandle(props: { width: ConvWidth }): ReactElement {
	const { width } = props;
	const [dragging, setDragging] = useState(false);
	const [focused, setFocused] = useState(false);
	const draggingRef = useRef(false);
	const pendingFrac = useRef<number | null>(null);
	const frame = useRef<number | null>(null);
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
			// edge of the window is the panel width.
			pendingFrac.current = (windowWidth() - event.clientX) / windowWidth();
            if (frame.current !== null) return;
            frame.current = window.requestAnimationFrame(() => {
                frame.current = null;
                if (pendingFrac.current !== null) width.setFrac(pendingFrac.current, false);
            });
		},
		[width],
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
