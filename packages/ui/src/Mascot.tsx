import { useId, type ReactElement } from 'react';

/**
 * Mascot — the Caddie character (Caddie v2, HANDOFF §7, flag block).
 *
 * One SVG drawing; only the eyes, mouth and flag change. The mood is always
 * driven by REAL state by the caller — never set to look lively:
 *
 *   ready      idle, nothing running            (prototype "idle")
 *   listening  composer focused / awaiting user
 *   thinking   request in flight, page loading
 *   building   a build is running               (prototype "working")
 *   needs      something waits for the user's OK
 *   done       a step just finished (brief, then back to ready)
 *   stuck      error, can't reach Caddie, not found
 *   paused     routines paused / spending cap reached (prototype "sleep")
 *
 * The mascot appears only where Caddie itself appears (chat header, ask bar,
 * closed rail, mobile Caddie tab, sign-in, welcome, empty/error states) —
 * never on buttons or headings. `prefers-reduced-motion` renders static faces
 * (see mascot.css). The animated "live" variant is reserved for spots that
 * represent Caddie itself being present.
 */

export type MascotMood =
	| 'ready'
	| 'listening'
	| 'thinking'
	| 'building'
	| 'needs'
	| 'done'
	| 'stuck'
	| 'paused';

/** Prototype state names the CSS rig keys on. */
const STATE_ATTR: Record<MascotMood, string> = {
	ready: 'idle',
	listening: 'listening',
	thinking: 'thinking',
	building: 'working',
	needs: 'needs',
	done: 'done',
	stuck: 'stuck',
	paused: 'sleep',
};

export function Mascot(props: { mood: MascotMood; size?: number; live?: boolean; className?: string }): ReactElement {
	const size = props.size ?? 32;
	const state = STATE_ATTR[props.mood];
	// Per-instance gradient id: every mascot used to define the SAME
	// `caddie-mascot-fill` id, and with several mascots on one page Chromium's
	// paint-server lookup could bind to an instance it refuses to render from,
	// leaving every body unfilled. Unique ids make each svg self-contained.
	const gradientId = `caddie-grad${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
	return (
		<svg
			className={`mascot${props.className ? ` ${props.className}` : ''}`}
			viewBox="0 0 64 64"
			width={size}
			height={size}
			data-state={state}
			data-mood={props.mood}
			{...(size <= 24 ? { 'data-size': 's' } : {})}
			{...(props.live ? { 'data-live': '' } : {})}
			aria-hidden="true"
			focusable="false"
		>
			<defs>
				<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" style={{ stopColor: 'var(--m-blue, #4d9fff)' }} />
					<stop offset="1" style={{ stopColor: 'var(--m-deep, #2f7ddd)' }} />
				</linearGradient>
			</defs>
			<g className="m-dots" fill="currentColor">
				<circle cx="11" cy="13" r="1.7" />
				<circle cx="6.5" cy="8" r="2.1" />
				<circle cx="12.5" cy="3" r="2.5" />
			</g>
			<g className="m-z" fontFamily="var(--font-mono, monospace)" fontWeight="600" fill="currentColor">
				<text x="5" y="14" fontSize="9">z</text>
				<text x="11" y="7" fontSize="7">z</text>
			</g>
			<g className="m-all">
				<g className="m-flag">
					<path d="M43 18V4.5" stroke="var(--m-deep, #2f7ddd)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
					<path
						d="M43.6 4.6 53 8.1l-9.4 3.5z"
						fill="var(--m-flag, #f0a83c)"
						stroke="var(--m-flag, #f0a83c)"
						strokeWidth="1.4"
						strokeLinejoin="round"
					/>
				</g>
				<rect className="m-body" x="9" y="16.5" width="46" height="41.5" rx="18" fill={`url(#${gradientId})`} />
				<path className="m-gloss" d="M14.4 31.1A13 13 0 0 1 21.5 22.7" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" opacity=".32" />
				<g className="m-look">
					<g className="m-open" fill="var(--m-ink, #090b10)">
						<rect x="21" y="30" width="6.5" height="11" rx="3.25" />
						<rect x="36.5" y="30" width="6.5" height="11" rx="3.25" />
						<circle cx="25.4" cy="32.7" r="1.3" fill="#fff" />
						<circle cx="40.9" cy="32.7" r="1.3" fill="#fff" />
					</g>
					<g className="m-happy" fill="none" stroke="var(--m-ink, #090b10)" strokeWidth="2.6" strokeLinecap="round">
						<path d="M20.5 37.5q3.75-5 7.5 0" />
						<path d="M36 37.5q3.75-5 7.5 0" />
					</g>
					<g className="m-closed" fill="none" stroke="var(--m-ink, #090b10)" strokeWidth="2.4" strokeLinecap="round">
						<path d="M20.5 35.5q3.75 3.6 7.5 0" />
						<path d="M36 35.5q3.75 3.6 7.5 0" />
					</g>
					<g className="m-flat" fill="none" stroke="var(--m-ink, #090b10)" strokeWidth="2.6" strokeLinecap="round">
						<path d="M21 36.5h6.5" />
						<path d="M36.5 36.5H43" />
					</g>
				</g>
				<g className="m-cheek" fill="var(--m-cheek, #ff7a83)" opacity=".42">
					<ellipse cx="17.2" cy="44.6" rx="3.2" ry="2" />
					<ellipse cx="46.8" cy="44.6" rx="3.2" ry="2" />
				</g>
				<path className="m-mouth" d="M28.6 46.6q3.4 3 6.8 0" fill="none" stroke="var(--m-ink, #090b10)" strokeWidth="2.2" strokeLinecap="round" />
				<ellipse className="m-mo" cx="32" cy="47.6" rx="2" ry="2.3" fill="var(--m-ink, #090b10)" />
				<path className="m-mflat" d="M29 48h6" fill="none" stroke="var(--m-ink, #090b10)" strokeWidth="2.2" strokeLinecap="round" />
			</g>
			<g className="m-badge">
				<circle cx="53" cy="21" r="7" fill="var(--m-flag, #f0a83c)" stroke="var(--color-panel, #101319)" strokeWidth="2.5" />
				<path d="M53 17.6v4" stroke="var(--m-ink, #090b10)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
				<circle cx="53" cy="24.7" r="1.2" fill="var(--m-ink, #090b10)" />
			</g>
		</svg>
	);
}
