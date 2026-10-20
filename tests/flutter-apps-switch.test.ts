import { describe, expect, test } from 'bun:test';
import { STACK_CATALOG, flutterAppsEnabled, stackCatalog } from '../apps/app/src/server/stacks.ts';

/**
 * Track 3: Android apps (Flutter) ship dark behind FLUTTER_APPS_ENABLED=1, so
 * the chat's list_stacks answer and the Settings stack panel say "planned"
 * until the owner switches them on after the live check.
 */
describe('the Android-apps switch', () => {
	test('only the exact value 1 turns it on', () => {
		expect(flutterAppsEnabled({ FLUTTER_APPS_ENABLED: '1' })).toBe(true);
		for (const env of [{}, { FLUTTER_APPS_ENABLED: '0' }, { FLUTTER_APPS_ENABLED: 'true' }, null, undefined]) expect(flutterAppsEnabled(env)).toBe(false);
	});

	test('the catalog says planned while it is off, and enabled once it is on', () => {
		expect(stackCatalog({}).find((s) => s.id === 'flutter')?.status).toBe('planned');
		expect(stackCatalog({ FLUTTER_APPS_ENABLED: '1' }).find((s) => s.id === 'flutter')?.status).toBe('enabled');
		// Nothing else changes, and the static catalog (used for "notify me") is untouched.
		expect(stackCatalog({ FLUTTER_APPS_ENABLED: '1' }).filter((s) => s.id !== 'flutter')).toEqual(STACK_CATALOG.filter((s) => s.id !== 'flutter'));
		expect(STACK_CATALOG.find((s) => s.id === 'flutter')?.status).toBe('planned');
	});
});
