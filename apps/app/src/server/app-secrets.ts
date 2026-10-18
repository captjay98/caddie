import type { Scope } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError, assertProjectOwner, assertProjectScope } from './scope.ts';
import { SecretBoxError, appSecretAad, envelopeKeyId, open, seal, type Keyring } from './secret-box.ts';

/**
 * App keys: the keys a generated app needs for outside services (a weather
 * API, a payments provider). Table `app_secrets` (migration 0027).
 *
 *   - The builder can ASK for a key it needs (requestAppSecret): a name, a
 *     plain description, an optional https help link. No value.
 *   - The project owner pastes the value once (setAppSecret). It is sealed
 *     with secret-box.ts and bound to (project, name).
 *   - Nothing here ever returns a value or an envelope to a caller outside the
 *     server: listAppSecrets is metadata only. resolveAppSecrets is the ONE
 *     opener, used only to inject keys into the app's own preview runtime and
 *     its published Worker.
 *
 * Authority: members may list and request; only the project owner may set or
 * remove (assertProjectOwner).
 */

export type AppSecretStatus = 'requested' | 'set';

export interface AppSecretSummary {
	readonly name: string;
	readonly status: AppSecretStatus;
	readonly description: string | null;
	readonly helpUrl: string | null;
	/** True when the builder asked for this key (removing the value keeps the request). */
	readonly requested: boolean;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ResolvedAppSecrets {
	/** name -> plaintext, for runtime injection only. */
	readonly values: Record<string, string>;
	/** Keys the builder asked for that have no value yet. */
	readonly missing: string[];
	/** Keys whose stored value can no longer be opened (paste them again). */
	readonly unreadable: string[];
}

export const APP_SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
export const APP_SECRET_MAX_BYTES = 8 * 1024;
export const APP_SECRETS_PER_PROJECT = 50;
const DESCRIPTION_MAX = 300;
const HELP_URL_MAX = 500;
/** Names the app's runtime already uses for Caddie's own bindings. */
const RESERVED = new Set(['DB', 'ASSETS', 'CADDIE']);

function invalid(message: string): never {
	throw new ScopeError(400, 'invalid_input', message);
}

export function checkAppSecretName(name: unknown): string {
	if (typeof name !== 'string' || !APP_SECRET_NAME.test(name)) {
		invalid('A key name uses capital letters, digits and underscores, like WEATHER_API_KEY.');
	}
	if (RESERVED.has(name) || name.startsWith('CADDIE_')) invalid(`${name} is used by Caddie itself. Pick another name.`);
	return name;
}

function checkValue(value: unknown): string {
	if (typeof value !== 'string') invalid('Paste the key as text.');
	const trimmed = value.trim();
	if (trimmed.length === 0) invalid('The key is empty.');
	if (new TextEncoder().encode(trimmed).length > APP_SECRET_MAX_BYTES) invalid('That key is too long (8 KB at most).');
	return trimmed;
}

function checkDescription(value: unknown): string {
	if (typeof value !== 'string' || value.trim().length === 0) invalid('Say what the key is for.');
	const trimmed = value.trim().replace(/\s+/g, ' ');
	return trimmed.length > DESCRIPTION_MAX ? `${trimmed.slice(0, DESCRIPTION_MAX - 1)}…` : trimmed;
}

function checkHelpUrl(value: unknown): string | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string' || value.length > HELP_URL_MAX) invalid('The help link must be an https link.');
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		invalid('The help link must be an https link.');
	}
	if (url.protocol !== 'https:' || url.username || url.password) invalid('The help link must be an https link.');
	return url.toString();
}

const nowIso = () => new Date().toISOString();

type Row = Record<string, unknown>;

function toSummary(row: Row): AppSecretSummary {
	return {
		name: String(row['name']),
		status: row['status'] === 'set' ? 'set' : 'requested',
		description: (row['description'] as string | null) ?? null,
		helpUrl: (row['helpUrl'] as string | null) ?? null,
		requested: row['requestedBy'] !== null && row['requestedBy'] !== undefined,
		createdAt: String(row['createdAt']),
		updatedAt: String(row['updatedAt']),
	};
}

const SUMMARY_COLUMNS = '"name","status","description","helpUrl","requestedBy","createdAt","updatedAt"';

async function readRow(db: D1Database, projectId: string, name: string): Promise<Row | null> {
	return (await db
		.prepare(`select ${SUMMARY_COLUMNS} from "app_secrets" where "projectId" = ? and "name" = ?`)
		.bind(projectId, name)
		.first()) as Row | null;
}

async function countKeys(db: D1Database, projectId: string): Promise<number> {
	const row = (await db.prepare('select count(*) as "n" from "app_secrets" where "projectId" = ?').bind(projectId).first()) as Row | null;
	return Number(row?.['n'] ?? 0);
}

/** Every key of the project, metadata only (never a value or an envelope). */
export async function listAppSecrets(db: D1Database, scope: Scope): Promise<AppSecretSummary[]> {
	const verified = await assertProjectScope(db, scope);
	const res = await db
		.prepare(`select ${SUMMARY_COLUMNS} from "app_secrets" where "projectId" = ? order by "status" asc, "name" asc`)
		.bind(verified.projectId)
		.all();
	return ((res.results ?? []) as Row[]).map(toSummary);
}

/**
 * The builder asks for a key the app needs. Creates a 'requested' row, or
 * refreshes the wording of an existing request; a key that is already set is
 * left exactly as it is.
 */
export async function requestAppSecret(
	db: D1Database,
	scope: Scope,
	input: { name: unknown; description: unknown; helpUrl?: unknown },
): Promise<AppSecretSummary> {
	const verified = await assertProjectScope(db, scope);
	const name = checkAppSecretName(input.name);
	const description = checkDescription(input.description);
	const helpUrl = checkHelpUrl(input.helpUrl);
	const existing = await readRow(db, verified.projectId, name);
	if (existing?.['status'] === 'set') return toSummary(existing);
	const now = nowIso();
	if (existing) {
		await db
			.prepare('update "app_secrets" set "description" = ?, "helpUrl" = ?, "requestedBy" = coalesce("requestedBy", ?), "updatedAt" = ? where "projectId" = ? and "name" = ? and "status" = \'requested\'')
			.bind(description, helpUrl, verified.actorId, now, verified.projectId, name)
			.run();
	} else {
		if ((await countKeys(db, verified.projectId)) >= APP_SECRETS_PER_PROJECT) invalid(`An app can have at most ${APP_SECRETS_PER_PROJECT} keys.`);
		await db
			.prepare(
				'insert into "app_secrets" ("projectId","name","status","envelope","keyId","description","helpUrl","requestedBy","updatedBy","createdAt","updatedAt") values (?,?,\'requested\',null,null,?,?,?,null,?,?) on conflict ("projectId","name") do nothing',
			)
			.bind(verified.projectId, name, description, helpUrl, verified.actorId, now, now)
			.run();
	}
	return toSummary((await readRow(db, verified.projectId, name))!);
}

/** The owner pastes a key: sealed, bound to (project, name), status 'set'. Replaces any earlier value. */
export async function setAppSecret(
	db: D1Database,
	keyring: Keyring,
	scope: Scope,
	input: { name: unknown; value: unknown },
): Promise<AppSecretSummary> {
	const verified = await assertProjectOwner(db, scope);
	const name = checkAppSecretName(input.name);
	const value = checkValue(input.value);
	const envelope = await seal(keyring, value, appSecretAad(verified.projectId, name));
	const now = nowIso();
	const existing = await readRow(db, verified.projectId, name);
	if (!existing && (await countKeys(db, verified.projectId)) >= APP_SECRETS_PER_PROJECT) {
		invalid(`An app can have at most ${APP_SECRETS_PER_PROJECT} keys.`);
	}
	await db
		.prepare(
			`insert into "app_secrets" ("projectId","name","status","envelope","keyId","description","helpUrl","requestedBy","updatedBy","createdAt","updatedAt")
			 values (?,?,'set',?,?,null,null,null,?,?,?)
			 on conflict ("projectId","name") do update set "status" = 'set', "envelope" = excluded."envelope", "keyId" = excluded."keyId", "updatedBy" = excluded."updatedBy", "updatedAt" = excluded."updatedAt"`,
		)
		.bind(verified.projectId, name, envelope, keyring.active.kid, verified.actorId, now, now)
		.run();
	return toSummary((await readRow(db, verified.projectId, name))!);
}

/**
 * Remove a key's value. A key the builder asked for goes back to 'requested'
 * (the app still needs it); any other key, or a request nobody has answered,
 * is removed outright. Returns what remains, or null when nothing does.
 */
export async function deleteAppSecret(db: D1Database, scope: Scope, nameInput: unknown): Promise<AppSecretSummary | null> {
	const verified = await assertProjectOwner(db, scope);
	const name = checkAppSecretName(nameInput);
	const existing = await readRow(db, verified.projectId, name);
	if (!existing) throw new ScopeError(404, 'key_not_found', 'This app has no key with that name.');
	if (existing['status'] === 'set' && existing['requestedBy'] !== null && existing['requestedBy'] !== undefined) {
		await db
			.prepare('update "app_secrets" set "status" = \'requested\', "envelope" = null, "keyId" = null, "updatedBy" = ?, "updatedAt" = ? where "projectId" = ? and "name" = ?')
			.bind(verified.actorId, nowIso(), verified.projectId, name)
			.run();
		return toSummary((await readRow(db, verified.projectId, name))!);
	}
	await db.prepare('delete from "app_secrets" where "projectId" = ? and "name" = ?').bind(verified.projectId, name).run();
	return null;
}

/**
 * SERVER-INTERNAL. Open every set key of a project for injection into that
 * project's own runtime (preview isolate vars, published Worker secret_text).
 * Callers must already have authorized the project; this takes a project id,
 * not a scope, because the publish/preview services are the authority here.
 * Never pass the result to a model, a log, a response body or the sandbox.
 */
export async function resolveAppSecrets(db: D1Database, keyring: Keyring, projectId: string): Promise<ResolvedAppSecrets> {
	if (typeof projectId !== 'string' || projectId.length === 0) throw new ScopeError(500, 'missing_scope', 'resolveAppSecrets needs a project id');
	const res = await db
		.prepare('select "name","status","envelope" from "app_secrets" where "projectId" = ? order by "name" asc')
		.bind(projectId)
		.all();
	const values: Record<string, string> = {};
	const missing: string[] = [];
	const unreadable: string[] = [];
	for (const row of (res.results ?? []) as Row[]) {
		const name = String(row['name']);
		if (row['status'] !== 'set' || typeof row['envelope'] !== 'string') {
			missing.push(name);
			continue;
		}
		try {
			values[name] = await open(keyring, row['envelope'], appSecretAad(projectId, name));
		} catch (error) {
			if (!(error instanceof SecretBoxError)) throw error;
			unreadable.push(name);
		}
	}
	return { values, missing, unreadable };
}

/**
 * Operator maintenance after a new key is put first in APP_SECRETS_KEYS:
 * re-seal envelopes sealed with an older key, a bounded batch per call. The
 * write is compare-and-set on the old envelope, so a value the owner changes
 * meanwhile is never overwritten with the stale one. `updatedAt` is left alone
 * (the owner did not change anything).
 */
export async function rotateAppSecrets(
	db: D1Database,
	keyring: Keyring,
	options: { projectId?: string; limit?: number } = {},
): Promise<{ resealed: number; failed: number; remaining: boolean }> {
	const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
	const projectFilter = options.projectId ? ' and "projectId" = ?' : '';
	const binds: unknown[] = [keyring.active.kid, ...(options.projectId ? [options.projectId] : []), limit + 1];
	const res = await db
		.prepare(`select "projectId","name","envelope" from "app_secrets" where "status" = 'set' and "keyId" != ?${projectFilter} order by "projectId","name" limit ?`)
		.bind(...binds)
		.all();
	const rows = (res.results ?? []) as Row[];
	let resealed = 0;
	let failed = 0;
	for (const row of rows.slice(0, limit)) {
		const projectId = String(row['projectId']);
		const name = String(row['name']);
		const envelope = String(row['envelope']);
		try {
			if (envelopeKeyId(envelope) === keyring.active.kid) continue;
			const aad = appSecretAad(projectId, name);
			const next = await seal(keyring, await open(keyring, envelope, aad), aad);
			const result = await db
				.prepare('update "app_secrets" set "envelope" = ?, "keyId" = ? where "projectId" = ? and "name" = ? and "envelope" = ?')
				.bind(next, keyring.active.kid, projectId, name, envelope)
				.run();
			if (Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0) resealed++;
		} catch (error) {
			if (!(error instanceof SecretBoxError)) throw error;
			failed++;
		}
	}
	return { resealed, failed, remaining: rows.length > limit };
}
