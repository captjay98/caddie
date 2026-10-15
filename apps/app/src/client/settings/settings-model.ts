/**
 * Pure model for the Settings page: the grouped sections, the plain-language
 * labels, and the small mappings the UI needs. No React, no I/O — unit-tested
 * in tests/settings-model.test.ts.
 */

export type SettingsTab = 'profile' | 'interests' | 'tools' | 'knows' | 'routines' | 'accounts' | 'spending' | 'appearance';

export interface SettingsSection {
	readonly id: SettingsTab;
	/** Rail label and the page title for this section. */
	readonly label: string;
	/** One-line intro under the title. */
	readonly lede: string;
}

/** The rail, grouped: You / Caddie / Account. Order here is the rail order. */
export const SETTINGS_GROUPS: readonly { readonly label: string; readonly sections: readonly SettingsSection[] }[] = [
	{
		label: 'You',
		sections: [
			{ id: 'profile', label: 'Profile', lede: 'What Caddie uses to check who can enter and to suggest the right size of project.' },
			{ id: 'interests', label: 'Interests', lede: 'What you’d enjoy building, and what you’re good at. Caddie ranks hackathons with both.' },
			{ id: 'tools', label: 'Build tools', lede: 'What Caddie can build your project with. More are added once they’re tested end to end.' },
		],
	},
	{
		label: 'Caddie',
		sections: [
			{ id: 'knows', label: 'What Caddie knows', lede: 'Things Caddie remembers about you. Confirm, correct or remove any of them.' },
			{ id: 'routines', label: 'Routines', lede: 'Checks Caddie runs for your projects on a schedule.' },
		],
	},
	{
		label: 'Account',
		sections: [
			{ id: 'accounts', label: 'Connected accounts', lede: 'The accounts you sign in with, and what Caddie can reach for you.' },
			{ id: 'spending', label: 'Spending', lede: 'Your spending limit and what Caddie has spent on builds.' },
			{ id: 'appearance', label: 'Appearance', lede: 'How Caddie looks on this device. Changes save as you pick them.' },
		],
	},
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = SETTINGS_GROUPS.flatMap((g) => g.sections);

/** The section for a `?tab=` value; unknown or missing falls back to Profile. */
export function sectionFor(tab: string | undefined): SettingsSection {
	return SETTINGS_SECTIONS.find((s) => s.id === tab) ?? SETTINGS_SECTIONS[0]!;
}

/**
 * Weekly hours as choices. The profile keeps a number (used elsewhere), so
 * each choice stores a representative value; a stored number maps back to
 * the choice whose range contains it.
 */
export const HOURS_CHOICES: readonly { readonly value: string; readonly label: string; readonly hours: number }[] = [
	{ value: 'under5', label: 'Under 5', hours: 3 },
	{ value: '5to10', label: '5–10', hours: 8 },
	{ value: '10to20', label: '10–20', hours: 15 },
	{ value: '20plus', label: '20+', hours: 25 },
];

export function hoursChoiceFor(hours: number | null | undefined): string {
	if (hours == null || !Number.isFinite(hours)) return '';
	if (hours < 5) return 'under5';
	if (hours <= 10) return '5to10';
	if (hours <= 20) return '10to20';
	return '20plus';
}

export function hoursForChoice(choice: string): number | null {
	return HOURS_CHOICES.find((c) => c.value === choice)?.hours ?? null;
}

/** Plain names for the stack ids the server reports; an unknown id shows as itself. */
const STACK_LABELS: Record<string, { readonly name: string; readonly detail: string }> = {
	'react-hono': { name: 'React + Hono', detail: 'Web app with a small API' },
	'tanstack-start': { name: 'TanStack Start', detail: 'Full-stack React app' },
	'fastapi-react': { name: 'FastAPI + React', detail: 'Python API with a web front end' },
	'laravel-inertia': { name: 'Laravel + Inertia', detail: 'PHP web app' },
	flutter: { name: 'Flutter', detail: 'Mobile app' },
};

export function stackLabel(id: string): { name: string; detail: string } {
	return STACK_LABELS[id] ?? { name: id, detail: '' };
}

/**
 * One-line service summary for Connected accounts. Server configuration is
 * the operator's concern, so the user sees a single status line; details
 * (which variables are missing) only matter when something needs attention.
 */
export function serviceStatus(health: {
	auth: { providers: { google: boolean; github: boolean } };
	sandbox: { configured: boolean };
}): { ok: boolean; summary: string } {
	const signIn = health.auth.providers.google || health.auth.providers.github;
	if (signIn && health.sandbox.configured) return { ok: true, summary: 'Sign-in and project builds are working.' };
	const broken = [!signIn ? 'sign-in' : null, !health.sandbox.configured ? 'project builds' : null].filter(Boolean).join(' and ');
	return { ok: false, summary: `This server isn’t set up for ${broken} yet.` };
}

/**
 * Money stored in MINOR units (cents) shown as money: 2000 USD → "$20.00".
 * The currency's own decimal count is used (JPY has none), so the division is
 * never hard-coded to 100. An unknown currency code falls back to "2000 XYZ".
 */
export function formatMinorUnits(minor: number, currency: string, locale = 'en-US'): string {
	try {
		const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() });
		const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
		return fmt.format(minor / 10 ** digits);
	} catch {
		return `${minor.toLocaleString(locale)} ${currency.toUpperCase()}`;
	}
}

/**
 * When a routine next runs, in plain words in the viewer's time zone:
 * "Today, 11:00", "Tomorrow, 09:30", or "Wed 22 Oct, 11:00". `timeZone` and
 * `now` are injectable for tests; an unparseable instant returns null.
 */
export function formatNextRun(iso: string, now: Date = new Date(), timeZone?: string, locale = 'en-GB'): string | null {
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return null;
	const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
	const time = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
	const today = dayKey(now);
	const tomorrow = dayKey(new Date(now.getTime() + 86_400_000));
	const target = dayKey(at);
	if (target === today) return `Today, ${time}`;
	if (target === tomorrow) return `Tomorrow, ${time}`;
	const date = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(at).replace(',', '');
	return `${date}, ${time}`;
}
