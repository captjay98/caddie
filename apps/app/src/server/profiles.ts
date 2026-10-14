import * as v from 'valibot';
import { STACK_IDS } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

/**
 * P14 profile services — the per-user profile (feature-ledger C8).
 *
 * Authorization model: the profile is USER-scoped, not project-scoped. Every
 * service takes the `userId` that came from the verified session (the route
 * layer passes `sessionUserId(...)`; services re-check it via
 * {@link requireUserId}). There is deliberately NO function here that accepts
 * an arbitrary user id from a request body — no cross-user access path
 * exists, and the strict input schema rejects smuggled identity keys.
 *
 * Validation model (audit-defect class "no silent defaults"):
 *   - country: free-form but strictly validated 2-letter ISO-3166 alpha-2
 *     (uppercase A-Z). A small embedded list cannot be complete, so any real
 *     alpha-2 code is accepted and nothing else.
 *   - timezone: validated as an IANA zone with Intl (full ICU in workerd).
 *   - weeklyHours: integer 0–80, nullable.
 *   - experienceLevel: beginner | intermediate | senior, nullable.
 *   - stackIds: array restricted to the five frozen StackId values from
 *     @caddie/contracts, deduplicated — kept DISTINCT from free text.
 *   - freeTextInterests: array of strings capped at 12 items of ≤60 chars.
 *     Free text is never interpreted as a stack id and vice versa.
 *   - formatPreference: online | in_person | either, nullable (event
 *     attendance filter).
 *   - skills: same shape as freeTextInterests (12 × 60) but DISTINCT from it
 *     and from stackIds — skills describe the builder, not the stack.
 *   - projectHighlight: one previous build, ≤280 chars, nullable.
 *   - budget: { mode, amount, currency } | null. amount/currency are only
 *     accepted with mode 'set'; other modes store them as null. The budget
 *     records comfort for planning — it never authorises spending.
 *
 * All fields are optional/nullable — the profile is never a wall before
 * useful work (P14 acceptance).
 */

const MAX_FREE_TEXT_ITEMS = 12;
const MAX_FREE_TEXT_LENGTH = 60;

/** Runtime guard: the profile user id must come from a verified session. */
function requireUserId(userId: unknown): string {
	if (typeof userId !== 'string' || userId.length === 0) {
		throw new ScopeError(
			500,
			'missing_actor',
			'profile user id is mandatory and must come from a verified session',
		);
	}
	return userId;
}

// --- validation ------------------------------------------------------------------

/** ISO-3166 alpha-2: exactly two uppercase ASCII letters (e.g. "CL", "DE"). */
const CountrySchema = v.pipe(
	v.string(),
	v.regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO-3166 alpha-2 code (uppercase)'),
);

/** IANA time zone, validated with Intl (throws RangeError for unknown zones). */
const TimezoneSchema = v.pipe(
	v.string(),
	v.check(
		(value) => {
			try {
				new Intl.DateTimeFormat('en-US', { timeZone: value });
				return true;
			} catch {
				return false;
			}
		},
		'timezone must be a valid IANA time zone name',
	),
);

const WeeklyHoursSchema = v.pipe(
	v.number(),
	v.integer('weeklyHours must be a whole number of hours'),
	v.minValue(0, 'weeklyHours must be between 0 and 80'),
	v.maxValue(80, 'weeklyHours must be between 0 and 80'),
);

const ExperienceLevelSchema = v.picklist(
	['beginner', 'intermediate', 'senior'],
	'experienceLevel must be beginner, intermediate or senior',
);

const StackIdsSchema = v.pipe(
	v.array(v.picklist([...STACK_IDS], 'unknown stack id — use one of the 5 supported stacks')),
	v.maxLength(5, 'at most 5 stack ids'),
	v.check(
		(ids) => new Set(ids).size === ids.length,
		'stackIds must not contain duplicates',
	),
);

const FreeTextInterestsSchema = v.pipe(
	v.array(
		v.pipe(
			v.string(),
			v.trim(),
			v.minLength(1, 'interest entries must not be empty'),
			v.maxLength(MAX_FREE_TEXT_LENGTH, `interest entries must be at most ${MAX_FREE_TEXT_LENGTH} characters`),
		),
	),
	v.maxLength(MAX_FREE_TEXT_ITEMS, `at most ${MAX_FREE_TEXT_ITEMS} free-text interests`),
);

/** Same constraints as interests, but a distinct field: builder skills. */
const SkillsSchema = v.pipe(
	v.array(
		v.pipe(
			v.string(),
			v.trim(),
			v.minLength(1, 'skill entries must not be empty'),
			v.maxLength(MAX_FREE_TEXT_LENGTH, `skill entries must be at most ${MAX_FREE_TEXT_LENGTH} characters`),
		),
	),
	v.maxLength(MAX_FREE_TEXT_ITEMS, `at most ${MAX_FREE_TEXT_ITEMS} skills`),
);

const FormatPreferenceSchema = v.picklist(
	['online', 'in_person', 'either'],
	'formatPreference must be online, in_person or either',
);

const ProjectHighlightSchema = v.pipe(
	v.string(),
	v.trim(),
	v.minLength(1, 'projectHighlight must not be empty'),
	v.maxLength(280, 'projectHighlight must be at most 280 characters'),
);

const BudgetModeSchema = v.picklist(
	['free_only', 'set', 'not_sure'],
	'budget.mode must be free_only, set or not_sure',
);

const BudgetSchema = v.pipe(
	v.strictObject({
		mode: BudgetModeSchema,
		amount: v.optional(
			v.union([
				v.pipe(
					v.number(),
					v.integer('budget.amount must be a whole number of currency units'),
					v.minValue(0, 'budget.amount must not be negative'),
					v.maxValue(1_000_000, 'budget.amount must be at most 1,000,000'),
				),
				v.null(),
			]),
		),
		currency: v.optional(v.union([v.pipe(v.string(), v.regex(/^[A-Z]{3}$/, 'budget.currency must be a 3-letter ISO-4217 code (uppercase)')), v.null()])),
	}),
	v.check(
		(budget) => {
			if (budget.mode === 'set') {
				return typeof budget.amount === 'number' && typeof budget.currency === 'string';
			}
			return (budget.amount ?? null) === null && (budget.currency ?? null) === null;
		},
		'budget.amount and budget.currency are required only when budget.mode is "set"',
	),
);

export type ProfileBudget = NonNullable<ProfileRecord['budget']>;

export const ProfileUpsertInputSchema = v.strictObject({
	country: v.optional(v.union([CountrySchema, v.null()])),
	timezone: v.optional(v.union([TimezoneSchema, v.null()])),
	weeklyHours: v.optional(v.union([WeeklyHoursSchema, v.null()])),
	experienceLevel: v.optional(v.union([ExperienceLevelSchema, v.null()])),
	stackIds: v.optional(StackIdsSchema),
	freeTextInterests: v.optional(FreeTextInterestsSchema),
	formatPreference: v.optional(v.union([FormatPreferenceSchema, v.null()])),
	skills: v.optional(SkillsSchema),
	projectHighlight: v.optional(v.union([ProjectHighlightSchema, v.null()])),
	budget: v.optional(v.union([BudgetSchema, v.null()])),
});

export type ProfileUpsertInput = v.InferOutput<typeof ProfileUpsertInputSchema>;

export interface ProfileRecord {
	userId: string;
	country: string | null;
	timezone: string | null;
	weeklyHours: number | null;
	experienceLevel: 'beginner' | 'intermediate' | 'senior' | null;
	stackIds: string[];
	freeTextInterests: string[];
	formatPreference: 'online' | 'in_person' | 'either' | null;
	skills: string[];
	projectHighlight: string | null;
	budget: { mode: 'free_only' | 'set' | 'not_sure'; amount: number | null; currency: string | null } | null;
	createdAt: string;
	updatedAt: string;
}

// --- persistence -------------------------------------------------------------------

function parseOr400(input: unknown): ProfileUpsertInput {
	const result = v.safeParse(ProfileUpsertInputSchema, input);
	if (!result.success) {
		const first = result.issues[0];
		const path = first?.path?.map((p) => String(p.key)).join('.') ?? '(body)';
		throw new ScopeError(
			400,
			'invalid_input',
			`invalid input at ${path}: ${first?.message ?? 'validation failed'}`,
		);
	}
	return result.output;
}

function profileFromRow(row: Record<string, unknown>): ProfileRecord {
	const budgetMode = row['budgetMode'] == null ? null : String(row['budgetMode']);
	return {
		userId: String(row['userId']),
		country: row['country'] == null ? null : String(row['country']),
		timezone: row['timezone'] == null ? null : String(row['timezone']),
		weeklyHours: row['weeklyHours'] == null ? null : Number(row['weeklyHours']),
		experienceLevel:
			row['experienceLevel'] == null
				? null
				: (String(row['experienceLevel']) as ProfileRecord['experienceLevel']),
		stackIds: safeParseJsonArray(row['stackIds']),
		freeTextInterests: safeParseJsonArray(row['freeTextInterests']),
		formatPreference:
			row['formatPreference'] == null
				? null
				: (String(row['formatPreference']) as ProfileRecord['formatPreference']),
		skills: safeParseJsonArray(row['skills']),
		projectHighlight: row['projectHighlight'] == null ? null : String(row['projectHighlight']),
		budget:
			budgetMode === null || budgetMode === ''
				? null
				: {
						mode: budgetMode as NonNullable<ProfileRecord['budget']>['mode'],
						amount: budgetMode === 'set' && row['budgetAmount'] != null ? Number(row['budgetAmount']) : null,
						currency: budgetMode === 'set' && row['budgetCurrency'] != null ? String(row['budgetCurrency']) : null,
					},
		createdAt: String(row['createdAt']),
		updatedAt: String(row['updatedAt']),
	};
}

/** JSON array columns: a corrupt value must never crash a read. */
function safeParseJsonArray(raw: unknown): string[] {
	if (typeof raw !== 'string') return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === 'string');
	} catch {
		return [];
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

/** Read the session user's profile, or null when they never saved one. */
export async function getProfile(db: D1Database, userId: string): Promise<ProfileRecord | null> {
	const verified = requireUserId(userId);
	const res = await db
		.prepare('select * from "user_profiles" where "userId" = ?')
		.bind(verified)
		.all();
	const row = (res.results ?? [])[0] as Record<string, unknown> | undefined;
	return row ? profileFromRow(row) : null;
}

/**
 * Upsert the session user's profile. Merge semantics: fields absent from the
 * input keep their stored values; explicit nulls clear nullable fields;
 * stackIds/freeTextInterests/skills are replaced only when provided, and
 * `budget` is replaced as a unit only when provided. Returns the full
 * profile after the write.
 */
export async function upsertProfile(
	db: D1Database,
	userId: string,
	input: unknown,
): Promise<ProfileRecord> {
	const verified = requireUserId(userId);
	const parsed = parseOr400(input);
	const existing = await getProfile(db, verified);
	const base: ProfileRecord = existing ?? {
		userId: verified,
		country: null,
		timezone: null,
		weeklyHours: null,
		experienceLevel: null,
		stackIds: [],
		freeTextInterests: [],
		formatPreference: null,
		skills: [],
		projectHighlight: null,
		budget: null,
		createdAt: nowIso(),
		updatedAt: nowIso(),
	};
	const next: ProfileRecord = {
		...base,
		country: parsed.country !== undefined ? parsed.country : base.country,
		timezone: parsed.timezone !== undefined ? parsed.timezone : base.timezone,
		weeklyHours: parsed.weeklyHours !== undefined ? parsed.weeklyHours : base.weeklyHours,
		experienceLevel:
			parsed.experienceLevel !== undefined ? parsed.experienceLevel : base.experienceLevel,
		stackIds: parsed.stackIds !== undefined ? parsed.stackIds : base.stackIds,
		freeTextInterests:
			parsed.freeTextInterests !== undefined ? parsed.freeTextInterests : base.freeTextInterests,
		formatPreference:
			parsed.formatPreference !== undefined ? parsed.formatPreference : base.formatPreference,
		skills: parsed.skills !== undefined ? parsed.skills : base.skills,
		projectHighlight:
			parsed.projectHighlight !== undefined ? parsed.projectHighlight : base.projectHighlight,
		budget: parsed.budget !== undefined ? budgetFromInput(parsed.budget) : base.budget,
		updatedAt: nowIso(),
	};
	await db
		.prepare(
			`insert into "user_profiles"
				("userId","country","timezone","weeklyHours","experienceLevel","stackIds","freeTextInterests","formatPreference","skills","projectHighlight","budgetMode","budgetAmount","budgetCurrency","createdAt","updatedAt")
			 values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
			 on conflict ("userId") do update set
				"country" = excluded."country",
				"timezone" = excluded."timezone",
				"weeklyHours" = excluded."weeklyHours",
				"experienceLevel" = excluded."experienceLevel",
				"stackIds" = excluded."stackIds",
				"freeTextInterests" = excluded."freeTextInterests",
				"formatPreference" = excluded."formatPreference",
				"skills" = excluded."skills",
				"projectHighlight" = excluded."projectHighlight",
				"budgetMode" = excluded."budgetMode",
				"budgetAmount" = excluded."budgetAmount",
				"budgetCurrency" = excluded."budgetCurrency",
				"updatedAt" = excluded."updatedAt"`,
		)
		.bind(
			next.userId,
			next.country,
			next.timezone,
			next.weeklyHours,
			next.experienceLevel,
			JSON.stringify(next.stackIds),
			JSON.stringify(next.freeTextInterests),
			next.formatPreference,
			JSON.stringify(next.skills),
			next.projectHighlight,
			next.budget?.mode ?? null,
			next.budget?.amount ?? null,
			next.budget?.currency ?? null,
			base.createdAt,
			next.updatedAt,
		)
		.run();
	return next;
}

/**
 * Normalize a validated budget input for storage: amount/currency survive
 * only with mode 'set'; explicit null clears the whole budget.
 */
function budgetFromInput(input: ProfileUpsertInput['budget']): ProfileRecord['budget'] {
	if (input === null || input === undefined) return null;
	if (input.mode !== 'set') return { mode: input.mode, amount: null, currency: null };
	return { mode: 'set', amount: input.amount ?? null, currency: input.currency ?? null };
}
