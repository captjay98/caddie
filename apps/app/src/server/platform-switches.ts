/**
 * Platform switches (plan section 4, lane 1 foundations).
 *
 * Five switches gate software-team mode without a redeploy:
 *   team_mode, big_apps, app_features   — off | owner | on
 *   spend_enforcement, publish_safety   — on | off
 *
 * Environment variables give the DEFAULT (unset: the first three default off,
 * the last two on). A stored row in `platform_switches` overrides the env
 * default. `big_apps` and `app_features` cannot be `on`/`owner` while
 * `team_mode` is off — a set that would break that is refused with a plain
 * message. Every set writes a `platform_switch_log` row (who, old, new, when).
 *
 * `owner` means every account except a judge account: the first three switches
 * are stamped onto a project's workflow when it is created, with `owner`
 * resolving to true for an ordinary account and false for a judge. Flutter /
 * Android projects stay on today's pipeline, so all three are false for them.
 *
 * The real source of truth for the key/value names is
 * `@caddie/contracts` (team-mode.ts); this module validates against it and the
 * migration's CHECK constraints are the floor beneath both.
 */

import {
	SWITCH_KEYS,
	SWITCH_ALLOWED_VALUES,
	type SwitchKey,
	type SwitchSource,
	type SwitchValue,
} from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { isJudgeAccount } from './judge-access.ts';
import type { AppStackId } from './stacks.ts';

/** The env var that gives each switch its default, and that default. */
const SWITCH_ENV: Record<SwitchKey, { envVar: string; fallback: SwitchValue }> = {
	team_mode: { envVar: 'TEAM_MODE', fallback: 'off' },
	big_apps: { envVar: 'BIG_APPS', fallback: 'off' },
	app_features: { envVar: 'APP_FEATURES', fallback: 'off' },
	spend_enforcement: { envVar: 'SPEND_ENFORCEMENT', fallback: 'on' },
	publish_safety: { envVar: 'PUBLISH_SAFETY', fallback: 'on' },
};

/**
 * The env inputs this module reads. Deliberately `unknown` (the same shape
 * `flutterAppsEnabled` in stacks.ts takes) so any worker-env object is
 * accepted: the module only ever reads the five named vars through
 * {@link envVarValue}, and an env that lacks them falls back to the defaults.
 */
export type SwitchEnv = unknown;

/** Read one env var as a string, defensively, from an env of unknown shape. */
function envVarValue(env: SwitchEnv, name: string): string | undefined {
	const value = (env as Record<string, unknown> | null | undefined)?.[name];
	return typeof value === 'string' ? value : undefined;
}

export class SwitchError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** A switch's resolved value and where it came from. */
export interface SwitchReading {
	key: SwitchKey;
	value: SwitchValue;
	source: SwitchSource;
}

function isSwitchKey(key: unknown): key is SwitchKey {
	return typeof key === 'string' && (SWITCH_KEYS as readonly string[]).includes(key);
}

/** Whether `value` is allowed for `key` (off/owner/on, narrowed per switch). */
function allowsValue(key: SwitchKey, value: unknown): value is SwitchValue {
	return typeof value === 'string' && (SWITCH_ALLOWED_VALUES[key] as readonly string[]).includes(value);
}

/** The env default for a key, falling back when the env var is unset or invalid. */
function envDefault(env: SwitchEnv | null | undefined, key: SwitchKey): SwitchValue {
	const { envVar, fallback } = SWITCH_ENV[key];
	const raw = envVarValue(env, envVar);
	return allowsValue(key, raw) ? raw : fallback;
}

async function storedValue(db: D1Database, key: SwitchKey): Promise<SwitchValue | null> {
	const row = (await db.prepare('select "value" from "platform_switches" where "key" = ?').bind(key).all<{ value: string }>()).results?.[0];
	if (!row) return null;
	// A row that somehow holds a value no longer allowed for this key is ignored
	// in favour of the env default (fail safe), never returned as truth.
	return allowsValue(key, row.value) ? row.value : null;
}

/** The current value of one switch: the stored row if present, else the env default. */
export async function readSwitch(db: D1Database, env: SwitchEnv | null | undefined, key: SwitchKey): Promise<SwitchValue> {
	if (!isSwitchKey(key)) throw new SwitchError(400, 'unknown_switch', `No such switch: ${String(key)}.`);
	return (await storedValue(db, key)) ?? envDefault(env, key);
}

/** Every switch's value and source (env default or a stored override). */
export async function readSwitches(db: D1Database, env: SwitchEnv | null | undefined): Promise<SwitchReading[]> {
	const readings: SwitchReading[] = [];
	for (const key of SWITCH_KEYS) {
		const stored = await storedValue(db, key);
		readings.push(
			stored !== null
				? { key, value: stored, source: 'set' }
				: { key, value: envDefault(env, key), source: 'env' },
		);
	}
	return readings;
}

/**
 * Set a switch, recording the flip. Validates the value for the key, enforces
 * the team-mode dependency, writes the override and a log row. The old value in
 * the log is the value in force BEFORE the set (a stored row if one existed,
 * otherwise null — not the env default, which was never a deliberate choice).
 */
export async function setSwitch(
	db: D1Database,
	env: SwitchEnv | null | undefined,
	actorId: string,
	key: SwitchKey,
	value: SwitchValue,
	now: string = new Date().toISOString(),
): Promise<SwitchReading> {
	if (!isSwitchKey(key)) throw new SwitchError(400, 'unknown_switch', `No such switch: ${String(key)}.`);
	if (!allowsValue(key, value)) {
		throw new SwitchError(400, 'invalid_value', `${key} can only be ${(SWITCH_ALLOWED_VALUES[key] as readonly string[]).join(', ')}.`);
	}

	// big_apps and app_features can't be on/owner while team_mode is off.
	if ((key === 'big_apps' || key === 'app_features') && value !== 'off') {
		if ((await readSwitch(db, env, 'team_mode')) === 'off') {
			throw new SwitchError(409, 'team_mode_required', 'Turn team mode on first; big apps and app features need it.');
		}
	}
	// Turning team_mode off while a dependent is on would leave the dependent
	// stranded; refuse, so the owner turns the dependents off first.
	if (key === 'team_mode' && value === 'off') {
		for (const dependent of ['big_apps', 'app_features'] as const) {
			if ((await readSwitch(db, env, dependent)) !== 'off') {
				throw new SwitchError(409, 'dependents_on', `Turn ${dependent} off first; it needs team mode.`);
			}
		}
	}

	const oldValue = await storedValue(db, key);
	await db
		.prepare(
			'insert into "platform_switches" ("key","value","updatedAt") values (?,?,?) on conflict ("key") do update set "value" = excluded."value", "updatedAt" = excluded."updatedAt"',
		)
		.bind(key, value, now)
		.run();
	await db
		.prepare('insert into "platform_switch_log" ("id","key","oldValue","newValue","actorId","createdAt") values (?,?,?,?,?,?)')
		.bind(`psl_${crypto.randomUUID()}`, key, oldValue, value, actorId, now)
		.run();
	return { key, value, source: 'set' };
}

/** The three per-project booleans stamped on a workflow when it is created. */
export interface ProjectModes {
	teamMode: boolean;
	bigApps: boolean;
	appFeatures: boolean;
}

/**
 * Resolve team_mode, big_apps and app_features to booleans for one project:
 *   on    -> true;
 *   owner -> true, unless the actor is a judge account (then false);
 *   off   -> false.
 * A Flutter / Android project stays on today's pipeline: all three are false.
 */
export async function stampProjectModes(
	db: D1Database,
	env: SwitchEnv | null | undefined,
	actorId: string,
	stack: AppStackId | string | null | undefined,
): Promise<ProjectModes> {
	if (stack === 'flutter') return { teamMode: false, bigApps: false, appFeatures: false };
	const judge = await isJudgeAccount(db, actorId);
	const resolve = async (key: SwitchKey): Promise<boolean> => {
		const value = await readSwitch(db, env, key);
		if (value === 'on') return true;
		if (value === 'owner') return !judge;
		return false;
	};
	return {
		teamMode: await resolve('team_mode'),
		bigApps: await resolve('big_apps'),
		appFeatures: await resolve('app_features'),
	};
}

/**
 * Whether app features (part M's photo input among them) are on for one
 * project's app, at call time. The project's stamped `appFeatures` decides (it
 * was stamped when the workflow was created, so a judge's project stays off),
 * and the switch set to `off` is a global stop on top, so the owner can halt
 * every app's use at once without a redeploy. No workflow row means off.
 */
export async function projectAppFeaturesOn(db: D1Database, env: SwitchEnv | null | undefined, projectId: string): Promise<boolean> {
	const row = (
		await db.prepare('select "appFeatures" from "build_workflows" where "projectId" = ?').bind(projectId).all<{ appFeatures: number }>()
	).results?.[0];
	if (!row || Number(row.appFeatures) !== 1) return false;
	return (await readSwitch(db, env, 'app_features')) !== 'off';
}
