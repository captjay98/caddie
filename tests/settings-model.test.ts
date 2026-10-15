import { describe, expect, test } from 'bun:test';
import {
	HOURS_CHOICES,
	SETTINGS_GROUPS,
	SETTINGS_SECTIONS,
	hoursChoiceFor,
	hoursForChoice,
	sectionFor,
	serviceStatus,
	stackLabel,
} from '../apps/app/src/client/settings/settings-model.ts';

describe('settings model', () => {
	test('the rail keeps every existing ?tab= link reachable, grouped You / Caddie / Account', () => {
		expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(['You', 'Caddie', 'Account']);
		// Links elsewhere in the app use these ids (account menu, search, redirects).
		for (const id of ['profile', 'interests', 'tools', 'knows', 'accounts', 'routines', 'spending', 'appearance']) {
			expect(sectionFor(id).id).toBe(id as never);
		}
		expect(SETTINGS_SECTIONS).toHaveLength(8);
		expect(sectionFor(undefined).id).toBe('profile');
		expect(sectionFor('nonsense').id).toBe('profile');
		for (const s of SETTINGS_SECTIONS) expect(s.lede.length).toBeLessThanOrEqual(100);
	});

	test('weekly hours: ranges map to a stored number and back', () => {
		expect(HOURS_CHOICES.map((c) => c.label)).toEqual(['Under 5', '5–10', '10–20', '20+']);
		expect(hoursChoiceFor(null)).toBe('');
		expect(hoursChoiceFor(0)).toBe('under5');
		expect(hoursChoiceFor(5)).toBe('5to10');
		expect(hoursChoiceFor(10)).toBe('5to10');
		expect(hoursChoiceFor(12)).toBe('10to20');
		expect(hoursChoiceFor(40)).toBe('20plus');
		for (const c of HOURS_CHOICES) expect(hoursChoiceFor(hoursForChoice(c.value))).toBe(c.value);
		expect(hoursForChoice('')).toBeNull();
	});

	test('stack labels are plain; an unknown id is shown as itself', () => {
		expect(stackLabel('react-hono').name).toBe('React + Hono');
		expect(stackLabel('flutter').detail).toBe('Mobile app');
		expect(stackLabel('zig-htmx')).toEqual({ name: 'zig-htmx', detail: '' });
	});

	test('service status is one honest line', () => {
		const ok = serviceStatus({ auth: { providers: { google: true, github: false } }, sandbox: { configured: true } });
		expect(ok.ok).toBe(true);
		const none = serviceStatus({ auth: { providers: { google: false, github: false } }, sandbox: { configured: false } });
		expect(none.ok).toBe(false);
		expect(none.summary).toContain('sign-in and project builds');
		expect(serviceStatus({ auth: { providers: { google: true, github: true } }, sandbox: { configured: false } }).summary).toContain('project builds');
	});
});

describe('settings money and times', () => {
	test('minor units become money in the currency’s own decimals (the old page showed cents as dollars)', async () => {
		const { formatMinorUnits } = await import('../apps/app/src/client/settings/settings-model.ts');
		expect(formatMinorUnits(2000, 'usd')).toBe('$20.00');
		expect(formatMinorUnits(345, 'USD')).toBe('$3.45');
		expect(formatMinorUnits(100000, 'USD')).toBe('$1,000.00');
		expect(formatMinorUnits(0, 'USD')).toBe('$0.00');
		expect(formatMinorUnits(500, 'JPY')).toBe('¥500');
		expect(formatMinorUnits(2000, 'NOTACODE')).toBe('2,000 NOTACODE');
	});

	test('next run reads as Today / Tomorrow / a short date, in the given time zone', async () => {
		const { formatNextRun } = await import('../apps/app/src/client/settings/settings-model.ts');
		const now = new Date('2026-10-15T08:00:00.000Z');
		expect(formatNextRun('2026-10-15T10:00:00.000Z', now, 'Africa/Lagos')).toBe('Today, 11:00');
		expect(formatNextRun('2026-10-16T08:30:00.000Z', now, 'Africa/Lagos')).toBe('Tomorrow, 09:30');
		expect(formatNextRun('2026-10-22T10:00:00.000Z', now, 'Africa/Lagos')).toBe('Thu 22 Oct, 11:00');
		expect(formatNextRun('not a date', now)).toBeNull();
	});
});
