/**
 * Interface icon set — UI review board screen 16. One 16px inline SVG set at
 * the token stroke weight, replacing the raw Unicode glyphs (▸ ⟳ ☀ ☾ ⇤ ⇥ ▌)
 * whose size, weight and baseline drifted with the system font. Every icon
 * carries an accessible name (title), is currentColor, and draws with
 * stroke-width 2 on a 16×16 viewBox. Nothing is fetched at runtime.
 */

import type { ReactElement } from 'react';

export type IconName =
	| 'play'
	| 'check'
	| 'alert'
	| 'stop'
	| 'refresh'
	| 'sun'
	| 'moon'
	| 'panel'
	| 'settings'
	| 'plus'
	| 'user'
	| 'sparkCheck'
	| 'clock'
	| 'calendar'
	| 'search'
	| 'shield'
	| 'link'
	| 'trophy'
	| 'users'
	| 'globe'
	| 'box'
	| 'diff'
	| 'doc'
	| 'download'
	| 'github'
	| 'arrowLeft'
	| 'target'
	| 'x'
	| 'info'
	| 'repo'
	| 'memory'
	| 'plug'
	| 'send'
	| 'chat'
	| 'home'
	| 'image'
	| 'file'
	| 'paperclip'
	| 'mic'
	| 'camera'
	| 'chevronDown'
	| 'expand'
	| 'collapse'
	| 'key';

interface IconProps {
	name: IconName;
	/** Accessible name — required so the set is never decorative-only. */
	title: string;
	className?: string;
}

const PATHS: Record<IconName, ReactElement> = {
	play: <path d="M6 4.5v7l5.5-3.5L6 4.5z" fill="currentColor" stroke="none" />,
	check: <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />,
	alert: <path d="M8 2.5L14.5 13.5h-13L8 2.5z" fill="none" stroke="currentColor" strokeLinejoin="round" />,
	stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />,
	refresh: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />,
	sun: (
		<>
			<path d="M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z" fill="none" stroke="currentColor" strokeLinecap="round" />
			<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	moon: <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />,
	settings: (
		<>
			<path d="M2.5 4.5h4M9.5 4.5h4M2.5 11.5h7M12.5 11.5h1" fill="none" stroke="currentColor" strokeLinecap="round" />
			<circle cx="8" cy="4.5" r="1.5" fill="none" stroke="currentColor" />
			<circle cx="11" cy="11.5" r="1.5" fill="none" stroke="currentColor" />
		</>
	),
	panel: (
		<>
			<rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" />
			<path d="M6.5 3.5v9" fill="none" stroke="currentColor" />
		</>
	),
	plus: <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeLinecap="round" />,
	user: (
		<>
			<circle cx="8" cy="5.8" r="2.3" fill="none" stroke="currentColor" />
			<path d="M3.5 13.5c.6-2.4 2.4-3.6 4.5-3.6s3.9 1.2 4.5 3.6" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	sparkCheck: (
		<>
			<path d="M8 2.5l1.2 2.7 2.9.4-2.1 2 .5 2.9L8 9.3l-2.5 1.2.5-2.9-2.1-2 2.9-.4L8 2.5z" fill="none" stroke="currentColor" strokeLinejoin="round" />
			<path d="M12.8 12.8l.8.8M12.8 13.6l1.6-1.6" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	clock: (
		<>
			<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" />
			<path d="M8 4.8V8l2.2 1.6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
		</>
	),
	calendar: (
		<>
			<rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" />
			<path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	search: (
		<>
			<circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" />
			<path d="M10.5 10.5L13.5 13.5" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	shield: (
		<>
			<path d="M8 2.5l5 1.8v3.9c0 3-2 5.4-5 6.3-3-.9-5-3.3-5-6.3V4.3L8 2.5z" fill="none" stroke="currentColor" strokeLinejoin="round" />
			<path d="M5.8 8l1.6 1.6 2.8-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
		</>
	),
	link: (
		<path
			d="M6.5 9.5l3-3M5.5 11.5l-.8.8a2.6 2.6 0 0 1-3.7-3.7l2-2a2.6 2.6 0 0 1 3.7 0M10.5 4.5l.8-.8a2.6 2.6 0 0 1 3.7 3.7l-2 2a2.6 2.6 0 0 1-3.7 0"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	),
	trophy: (
		<>
			<path d="M4.5 3.5h7v3a3.5 3.5 0 0 1-7 0v-3z" fill="none" stroke="currentColor" strokeLinejoin="round" />
			<path d="M4.5 4.5h-2v1a2 2 0 0 0 2 2M11.5 4.5h2v1a2 2 0 0 1-2 2M8 10v2M5.5 13.5h5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
		</>
	),
	users: (
		<>
			<circle cx="6" cy="6" r="2.3" fill="none" stroke="currentColor" />
			<path d="M2.5 13c0-2 1.6-3.3 3.5-3.3S9.5 11 9.5 13" fill="none" stroke="currentColor" strokeLinecap="round" />
			<path d="M10.5 4.2a2.3 2.3 0 0 1 0 4.4M11 9.9c1.6.3 2.8 1.5 2.8 3.1" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	globe: (
		<>
			<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" />
			<path d="M2.5 8h11M8 2.5c1.8 1.6 2.8 3.6 2.8 5.5S9.8 11.9 8 13.5C6.2 11.9 5.2 9.9 5.2 8S6.2 4.1 8 2.5z" fill="none" stroke="currentColor" strokeLinejoin="round" />
		</>
	),
	box: (
		<>
			<path d="M2.5 5L8 2.5 13.5 5v6L8 13.5 2.5 11V5z" fill="none" stroke="currentColor" strokeLinejoin="round" />
			<path d="M2.5 5L8 7.5 13.5 5M8 7.5v6" fill="none" stroke="currentColor" strokeLinejoin="round" />
		</>
	),
	diff: (
		<>
			<path d="M5.5 5.5v5M3.5 8h4" fill="none" stroke="currentColor" strokeLinecap="round" />
			<path d="M10.5 10.5v-5M8.5 8h4" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	doc: (
		<>
			<path d="M4 2.5h5l3 3v8H4v-11z" fill="none" stroke="currentColor" strokeLinejoin="round" />
			<path d="M9 2.5v3h3M6 8.5h4M6 11h4" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	download: (
		<>
			<path d="M8 2.5v6M5.5 6L8 8.5 10.5 6" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M2.5 11.5v1.5h11v-1.5" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	github: (
		<path
			d="M8 2.5a5.5 5.5 0 0 0-1.7 10.7c.3 0 .4-.1.4-.4v-1.5c-1.7.4-2-.8-2-.8-.3-.7-.7-.9-.7-.9-.6-.4 0-.4 0-.4.6 0 1 .7 1 .7.6 1 1.5.7 1.9.5a1.4 1.4 0 0 1 .4-.9c-1.4-.2-2.8-.7-2.8-3a2.3 2.3 0 0 1 .6-1.6c-.1-.1-.3-.8.1-1.6 0 0 .5-.2 1.6.6a5.5 5.5 0 0 1 2.9 0c1.1-.8 1.6-.6 1.6-.6.4.8.2 1.5.1 1.6a2.3 2.3 0 0 1 .6 1.6c0 2.3-1.4 2.8-2.8 3a1.4 1.4 0 0 1 .4 1.1v1.7c0 .3.1.4.4.4A5.5 5.5 0 0 0 8 2.5z"
			fill="currentColor"
			stroke="none"
		/>
	),
	arrowLeft: <path d="M13 8H3.5M7 4.5L3.5 8 7 11.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />,
	target: (
		<>
			<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" />
			<circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" />
			<circle cx="8" cy="8" r="0.7" fill="currentColor" stroke="none" />
		</>
	),
	x: <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeLinecap="round" />,
	info: (
		<>
			<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" />
			<path d="M8 7.5V11M8 5.2v.1" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	repo: (
		<>
			<path d="M3.5 2.5h6.5l2.5 2.5v8.5h-9V2.5z" fill="none" stroke="currentColor" strokeLinejoin="round" />
			<path d="M10 2.5v2.5h2.5M6 8h4M6 10.5h4" fill="none" stroke="currentColor" strokeLinecap="round" />
		</>
	),
	memory: (
		<>
			<rect x="2.5" y="4" width="11" height="8" rx="1.5" fill="none" stroke="currentColor" />
			<path d="M5.5 4v8M10.5 4v8" fill="none" stroke="currentColor" />
		</>
	),
	plug: <path d="M9 2.5v3M7 2.5v3M5.5 5.5h5V8l1 3H5.5l1-3V5.5z" fill="none" stroke="currentColor" strokeLinejoin="round" />,
	image: (
		<>
			<rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" />
			<circle cx="6" cy="6.5" r="1" fill="currentColor" stroke="none" />
			<path d="M3 11l3-3 2.5 2.5L10.5 8l2.5 3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
		</>
	),
	file: <path d="M4 2.5h5l3 3V13.5H4V2.5zM9 2.5v3h3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />,
	paperclip: <path d="M11.5 7.5l-4 4a2.5 2.5 0 0 1-3.5-3.5l5-5a1.6 1.6 0 0 1 2.3 2.3l-5 5a0.8 0.8 0 0 1-1.1-1.1l4.3-4.3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />,
	mic: (
		<>
			<rect x="6" y="2" width="4" height="7" rx="2" fill="none" stroke="currentColor" />
			<path d="M4 7.5a4 4 0 0 0 8 0M8 11.5v2M6 13.5h4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
		</>
	),
	camera: (
		<>
			<path d="M2.5 5.5h2l1-1.5h5l1 1.5h2v7h-11v-7z" fill="none" stroke="currentColor" strokeLinejoin="round" />
			<circle cx="8" cy="9" r="2.3" fill="none" stroke="currentColor" />
		</>
	),
	send: <path d="M8 13V3.5M3.5 8 8 3.5 12.5 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />,
	chat: (
		<path
			d="M4 5.5A1.5 1.5 0 0 1 5.5 4h7A1.5 1.5 0 0 1 14 5.5v3A1.5 1.5 0 0 1 12.5 10H8.6l-2.4 2.1V10H5.5A1.5 1.5 0 0 1 4 8.5v-3z"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	),
	home: (
		<path
			d="M2.8 7.5L8 3l5.2 4.5M4 6.8V13h8V6.8M6.8 13v-3.4h2.4V13"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	),
	expand: (
		<>
			<path d="M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5 9.5 6.5M2.5 13.5l4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
		</>
	),
	collapse: (
		<>
			<path d="M14 6h-3.5V2.5M2 10h3.5v3.5M10.5 6.5 14 2.5M5.5 9.5 2 13.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
		</>
	),
	chevronDown: <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />,
	key: (
		<>
			<circle cx="5.5" cy="10.5" r="3" fill="none" stroke="currentColor" />
			<path d="M7.6 8.4 13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.2 1.2" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
		</>
	),
};

export function Icon({ name, title, className }: IconProps): ReactElement {
	return (
		<svg
			className={className}
			width="16"
			height="16"
			viewBox="0 0 16 16"
			aria-hidden="false"
			role="img"
			focusable="false"
		>
			<title>{title}</title>
			{PATHS[name]}
		</svg>
	);
}