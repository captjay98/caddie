/**
 * Lane 8, step 6 — the campaign RUN MODE.
 *
 * The run is either `team` (team mode on) or `baseline` (switch off). The owner
 * picks the default for a run with the `TEAM_MODE` env var; `--mode team` /
 * `--mode baseline` on the command line overrides it. Whatever is resolved is
 * recorded in the ledger (see ./ledger.ts), so a run's mode is never guessed
 * after the fact.
 *
 * `TEAM_MODE` matches the platform switch name in plan section 4
 * (`team_mode` off | owner | on). Here it only decides the DEFAULT the runner
 * starts a project under: `on`/`owner`/`1`/`true` → team, anything else →
 * baseline. The project's own stamped mode is still read back from D1.
 */

export type RunMode = 'team' | 'baseline';

/** Does this `TEAM_MODE` env value mean "team mode on" as a default? */
export function teamModeEnvDefault(teamModeEnv: string | undefined): RunMode {
	const v = (teamModeEnv ?? '').trim().toLowerCase();
	return v === 'on' || v === 'owner' || v === '1' || v === 'true' ? 'team' : 'baseline';
}

/**
 * Resolve the run mode: an explicit `--mode team|baseline` from argv wins;
 * otherwise the `TEAM_MODE` env default decides. A `--mode` with any other
 * value is an error — the runner never silently falls back to a mode the owner
 * did not choose.
 */
export function resolveRunMode(opts: {
	argv: string[];
	teamModeEnv: string | undefined;
}): RunMode {
	const { argv, teamModeEnv } = opts;
	const i = argv.indexOf('--mode');
	if (i >= 0) {
		const value = (argv[i + 1] ?? '').trim().toLowerCase();
		if (value === 'team' || value === 'baseline') return value;
		throw new Error(
			`--mode must be "team" or "baseline" (got ${JSON.stringify(argv[i + 1] ?? '')})`,
		);
	}
	return teamModeEnvDefault(teamModeEnv);
}

/** Whether a resolved run mode means the project is started with team mode on. */
export function isTeamMode(mode: RunMode): boolean {
	return mode === 'team';
}
