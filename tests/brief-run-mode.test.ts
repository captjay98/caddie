import { describe, expect, test } from 'bun:test';
import { isTeamMode, resolveRunMode, teamModeEnvDefault } from '../scripts/brief-run/mode.ts';

/** LANE 8 STEP 6 — `--mode team|baseline`, defaulted by the TEAM_MODE env. */
describe('run mode (step 6)', () => {
	test('TEAM_MODE on/owner/1/true default to team', () => {
		for (const v of ['on', 'owner', '1', 'true', 'ON', 'Owner']) {
			expect(teamModeEnvDefault(v)).toBe('team');
		}
	});

	test('TEAM_MODE off/unset/other default to baseline', () => {
		for (const v of ['off', '', undefined, 'no', 'baseline']) {
			expect(teamModeEnvDefault(v)).toBe('baseline');
		}
	});

	test('--mode team overrides a baseline env default', () => {
		expect(resolveRunMode({ argv: ['--mode', 'team'], teamModeEnv: 'off' })).toBe('team');
	});

	test('--mode baseline overrides an on env default', () => {
		expect(resolveRunMode({ argv: ['--mode', 'baseline'], teamModeEnv: 'on' })).toBe('baseline');
	});

	test('with no --mode, the TEAM_MODE env default decides', () => {
		expect(resolveRunMode({ argv: [], teamModeEnv: 'on' })).toBe('team');
		expect(resolveRunMode({ argv: [], teamModeEnv: 'off' })).toBe('baseline');
	});

	test('an invalid --mode value is an error (never a silent fallback)', () => {
		expect(() => resolveRunMode({ argv: ['--mode', 'turbo'], teamModeEnv: 'on' })).toThrow(/--mode/);
	});

	test('isTeamMode reflects the resolved mode', () => {
		expect(isTeamMode('team')).toBe(true);
		expect(isTeamMode('baseline')).toBe(false);
	});
});
