/**
 * Lane 8, item 2 — the pure parts of the two-app-user browser check.
 *
 * Two Caddie accounts are the WRONG design for "B can't see A's record": a
 * second Caddie account cannot even open the first account's preview, so the
 * isolation would pass for the wrong reason. Instead the check uses two users
 * OF THE BUILT APP, inside the preview of the run's project, both driven from
 * the owner's ONE Caddie session. Each signs in through the generated app's own
 * email-code sign-in (request a code for a@campaign.test / b@campaign.test, read
 * it from the project's test inbox, enter it).
 *
 * This module is the data-only parts, kept out of the browser flow so they are
 * unit-tested against the REAL shapes:
 *   - `pickRecordTarget(block)` finds the first PERSON-owned table that has a
 *     create route AND a screen showing it — the record the check exercises.
 *     An app with no such table is "not applicable" (never "passed").
 *   - `readInboxCode(inbox, email)` reads the newest sign-in code for an email
 *     from the test-inbox shape the route returns ({ messages:[{to,code,
 *     createdAt}], emails:[…] }; see apps/app/src/client/project/TestInbox.tsx).
 *   - `firstTextField(route)` is the create form's first text field — where the
 *     unique marker is typed (mirrors contract-files step 8, which finds a
 *     record's text through the first text field).
 */
import {
	parseArchitectureBlock,
	type ArchitectureBlock,
	type ArchitectureRoute,
	type ArchitectureScreen,
	type ArchitectureTable,
} from '@caddie/contracts';

/** The app@test email addresses the two app users sign in with (plan item 2). */
export const APP_USER_A_EMAIL = 'a@campaign.test';
export const APP_USER_B_EMAIL = 'b@campaign.test';

/** The record the browser check will create, read back and check for isolation. */
export interface RecordTarget {
	table: ArchitectureTable;
	/** The create route (op 'create') for the table. */
	createRoute: ArchitectureRoute;
	/** A screen whose `shows` includes the table. */
	screen: ArchitectureScreen;
	/** The first text request-field of the create route — where the marker goes. */
	markerField: string;
}

/** The outcome of choosing a target: a target, or "not applicable" with a reason. */
export type TargetChoice =
	| { applicable: true; target: RecordTarget }
	| { applicable: false; reason: string };

/** The first text-typed request field of a create route (the marker field). */
export function firstTextField(route: ArchitectureRoute): string | null {
	const field = route.request.find((f) => f.type === 'text');
	return field ? field.name : null;
}

/**
 * Pick the record the check exercises: the FIRST person-owned table that has a
 * create route and a screen showing it, and whose create route has a text field
 * to carry the marker. Tables are considered in declaration order, so the
 * choice is deterministic. Returns "not applicable" (never a pass) when no such
 * table exists — exactly the plan's rule for an app with no person-owned table
 * that has a screen.
 */
export function pickRecordTarget(block: ArchitectureBlock): TargetChoice {
	const personTables = block.tables.filter((t) => t.owner === 'person');
	if (personTables.length === 0) {
		return { applicable: false, reason: 'the app declares no person-owned table, so there is no private record to check' };
	}
	for (const table of personTables) {
		const createRoute = block.routes.find((r) => r.table === table.name && r.op === 'create');
		if (!createRoute) continue;
		// A screen whose hash path has a `:param` (e.g. `#/notes/:id`) can't be
		// opened without the id that names, so the browser check can't drive it.
		// Skip those — only a param-free screen is openable with `location.hash`.
		const screen = block.screens.find((s) => s.shows.includes(table.name) && screenIsOpenable(s.path));
		if (!screen) continue;
		const markerField = firstTextField(createRoute);
		if (!markerField) continue;
		return { applicable: true, target: { table, createRoute, screen, markerField } };
	}
	return {
		applicable: false,
		reason: 'no person-owned table has both a create route (with a text field) and a param-free screen showing it',
	};
}

/**
 * A screen's hash path is openable by the browser check only when it has no
 * `:param` segment: a path like `#/notes/:id` needs an id the check does not
 * have, so `location.hash = path` would land on a broken route. A param-free
 * path like `#/notes` is openable.
 */
export function screenIsOpenable(path: string): boolean {
	return !path.split('/').some((segment) => segment.startsWith(':'));
}

/** Choose the target from a DESIGN document (the /workflow design doc). */
export function pickRecordTargetFromDesign(designMarkdown: string): TargetChoice {
	const parsed = parseArchitectureBlock(designMarkdown);
	if (!parsed.ok) return { applicable: false, reason: `could not read the design's architecture block: ${parsed.error}` };
	return pickRecordTarget(parsed.block);
}

/** The test-inbox shape the route returns (apps/app TestInbox.tsx). */
export interface TestInbox {
	messages: Array<{ to: string; code: string; createdAt: string }>;
	emails?: Array<{ to: string; subject: string; text: string; template: string | null; createdAt: string }>;
}

/**
 * Read the NEWEST sign-in code for `email` from the test inbox. The inbox holds
 * every code the app sent; a run requests a fresh code immediately before, so
 * the newest matching message is the one just sent. Returns null while none has
 * arrived yet, so the browser flow can poll. Matching is case-insensitive on
 * the address, mirroring the app's own lower-casing of emails.
 */
/** A test-inbox message's identity (two sends of the same code differ by time). */
export function inboxMessageKey(message: { code: string; createdAt: string }): string {
	return `${message.createdAt}|${message.code}`;
}

/** The keys of every message for `email` now in the inbox (the "already there" set). */
export function inboxKeysFor(inbox: TestInbox, email: string): Set<string> {
	const want = email.trim().toLowerCase();
	return new Set((inbox.messages ?? []).filter((m) => m.to.trim().toLowerCase() === want).map(inboxMessageKey));
}

export function readInboxCode(inbox: TestInbox, email: string, exclude: ReadonlySet<string> = new Set()): string | null {
	const want = email.trim().toLowerCase();
	let newest: { code: string; createdAt: string } | null = null;
	for (const message of inbox.messages ?? []) {
		if (message.to.trim().toLowerCase() !== want) continue;
		if (exclude.has(inboxMessageKey(message))) continue;
		if (!newest || message.createdAt > newest.createdAt) newest = { code: message.code, createdAt: message.createdAt };
	}
	return newest ? newest.code : null;
}

// --- form planning (item 2) --------------------------------------------------

/**
 * One form control the browser check discovered on the target screen. The DOM
 * reader reports these (never the real Element) so the planning stays pure and
 * unit-testable. `kind` is the tag; `type` is an <input>'s type attribute
 * (lower-cased); `required` and `hasValue` come from the live control; `options`
 * are a <select>'s non-empty option values in document order.
 */
export interface FormField {
	kind: 'input' | 'textarea' | 'select';
	/** An <input>'s type (text, number, date, email, …); undefined for others. */
	type?: string;
	required: boolean;
	/** The control already holds a value (don't overwrite it). */
	hasValue: boolean;
	/** A <select>'s non-empty option values, in order (first is chosen). */
	options?: string[];
}

/** One planned action against a form control, addressed by its index. */
export interface FormFillStep {
	index: number;
	action: 'fill' | 'check' | 'select';
	value: string;
	/** True for the one field the unique marker goes in (the first text field). */
	marker?: boolean;
}

/** A field counts as a free-text field (where the marker goes). */
export function isTextLikeField(field: FormField): boolean {
	if (field.kind === 'textarea') return true;
	if (field.kind !== 'input') return false;
	const type = (field.type ?? 'text').toLowerCase();
	// `text`, `search`, and a typeless input all take free text; a specific
	// type (number/date/email/url/…) is filled by its own rule, not the marker.
	return type === 'text' || type === 'search' || type === '';
}

/**
 * The today's-date value for a date/datetime control, as the control's own
 * format needs it: `YYYY-MM-DD` for `date`, `YYYY-MM-DDТHH:MM` for
 * `datetime-local`. Pure over an injected `now` so a test pins the day.
 */
export function todayValue(type: string, now: Date): string {
	const yyyy = now.getFullYear().toString().padStart(4, '0');
	const mm = (now.getMonth() + 1).toString().padStart(2, '0');
	const dd = now.getDate().toString().padStart(2, '0');
	const date = `${yyyy}-${mm}-${dd}`;
	if (type === 'datetime-local') {
		const hh = now.getHours().toString().padStart(2, '0');
		const min = now.getMinutes().toString().padStart(2, '0');
		return `${date}T${hh}:${min}`;
	}
	return date;
}

/**
 * Plan how to fill a create form so its submit will succeed (item 2). The
 * UNIQUE MARKER goes in the FIRST text-like field (an <input type=text/search>
 * or a <textarea>). Every OTHER empty field that is required is filled by its
 * type so the form validates:
 *   - number/range → "1"; date → today; datetime-local → today + time;
 *   - email → x@campaign.test; url → https://example.com;
 *   - a <select> → its first non-empty option; a checkbox → checked.
 * A field that already holds a value is left alone, and a non-required field
 * with no rule is skipped (an empty optional field never blocks submit). A text
 * field AFTER the first is only filled when it is required (so a second text box
 * doesn't swallow a stray copy of the marker).
 *
 * `now` is injected so the date values are deterministic in a test.
 */
export function planFormFill(fields: FormField[], marker: string, now: Date): FormFillStep[] {
	const steps: FormFillStep[] = [];
	const firstTextIndex = fields.findIndex((f) => isTextLikeField(f));
	fields.forEach((field, index) => {
		if (index === firstTextIndex) {
			steps.push({ index, action: 'fill', value: marker, marker: true });
			return;
		}
		if (field.hasValue) return; // never overwrite a value already there
		const type = field.kind === 'input' ? (field.type ?? 'text').toLowerCase() : field.kind;
		if (field.kind === 'select') {
			if (!field.required) return;
			const option = (field.options ?? []).find((value) => value !== '');
			if (option !== undefined) steps.push({ index, action: 'select', value: option });
			return;
		}
		if (field.kind === 'input' && type === 'checkbox') {
			if (field.required) steps.push({ index, action: 'check', value: 'on' });
			return;
		}
		// A free-text field after the first: fill only when required.
		if (isTextLikeField(field)) {
			if (field.required) steps.push({ index, action: 'fill', value: marker });
			return;
		}
		if (!field.required) return; // an optional typed field never blocks submit
		const value = typedFieldValue(type, now);
		if (value !== null) steps.push({ index, action: 'fill', value });
	});
	return steps;
}

/** The value for a required typed input, or null when there is no rule. */
function typedFieldValue(type: string, now: Date): string | null {
	switch (type) {
		case 'number':
		case 'range':
			return '1';
		case 'date':
		case 'datetime-local':
			return todayValue(type, now);
		case 'email':
			return 'x@campaign.test';
		case 'url':
			return 'https://example.com';
		case 'tel':
			return '1';
		default:
			return null;
	}
}
